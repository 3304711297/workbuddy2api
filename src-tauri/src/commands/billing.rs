//! 配额与积分查询、模型元数据获取与配置命令

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::shared::{local_app_dir, load_accounts_state};

// ---------------------------------------------------------------------------
// 积分与模型数据模型
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelBadge {
    pub text: String,
    pub color: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelMetaItem {
    pub id: String,
    pub name: String,
    pub credits: String,
    /// 客户端默认上下文窗口（上游 `contextWindow.defaultLength` 优先，缺失时回退硬上限）。
    /// ⚠️ 刻意**不**取 `maxInputTokens`：那是硬上限，把它当默认窗口会替客户端虚报窗口
    /// （实测 12 个模型把客户端默认 300000 谎报成 1000000）。
    pub max_input_tokens: i64,
    pub max_output_tokens: i64,
    /// 上游硬上限（`maxInputTokens` / `maxAllowedSize`），缺失为 None。
    /// 与 `max_input_tokens` 并存以便 UI 同时展示「默认窗口 / 硬上限」。
    #[serde(default)]
    pub upstream_max_input_tokens: Option<i64>,
    pub supports_reasoning: bool,
    pub can_disable_thinking: bool,
    pub supported_efforts: Vec<String>,
    pub default_effort: String,
    pub description: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub badges: Vec<ModelBadge>,
    // 用户自定义覆盖项
    pub custom_context_window: Option<i64>,
    pub custom_reasoning_effort: Option<String>,
    // 档位矩阵来源：upstream=上游下发 / catalog=内置覆盖表兜底
    pub efforts_source: String,
    // 可用性：available | unavailable（运行时学习 + GPT_FALLBACK_MAP 预标记）
    #[serde(default = "default_availability")]
    pub availability: String,
}

fn default_availability() -> String {
    "available".to_string()
}

// ---------------------------------------------------------------------------
// 模型条目字段解析（纯函数，便于单测）
// ---------------------------------------------------------------------------

/// 描述文本长度上限：上游描述偶有超长（部分模型带整段宣传文案），
/// 截断到 512 个**字符**（非字节，避免在多字节字符中间切开）。
const DESCRIPTION_MAX_CHARS: usize = 512;

/// 内置兜底窗口：上游两个字段都缺失时使用（既有行为，勿改）。
const FALLBACK_CONTEXT_WINDOW: i64 = 200_000;

/// 从模型条目取上游硬上限：`maxInputTokens` 优先，回退 `maxAllowedSize`。
/// 每一档都要求正数（上游偶发下发 0 / 负数占位）——0 不是有效窗口，应继续回退，
/// 否则控制台会出现「/ 0k」这类无意义展示。
fn upstream_hard_limit(m: &serde_json::Value) -> Option<i64> {
    fn positive(v: Option<i64>) -> Option<i64> {
        v.filter(|x| *x > 0)
    }
    positive(m.get("maxInputTokens").and_then(|v| v.as_i64()))
        .or_else(|| positive(m.get("maxAllowedSize").and_then(|v| v.as_i64())))
}

/// 从模型条目取最高可用窗口：
/// 取 supportedLengths 数组、maxLength、defaultLength、maxInputTokens、maxAllowedSize 的最大值。
/// 确保 12 个 1M 档模型对客户端报出真实 1,000,000 窗口，避免早早被压缩。
fn upstream_highest_available_window(m: &serde_json::Value) -> Option<i64> {
    let mut max_val: Option<i64> = None;
    let mut check = |v: Option<i64>| {
        if let Some(x) = v.filter(|n| *n > 0) {
            max_val = Some(max_val.map_or(x, |curr| curr.max(x)));
        }
    };

    if let Some(cw) = m.get("contextWindow").and_then(|v| v.as_object()) {
        if let Some(arr) = cw.get("supportedLengths").and_then(|v| v.as_array()) {
            for item in arr {
                check(item.as_i64());
            }
        }
        check(cw.get("maxLength").and_then(|v| v.as_i64()));
        check(cw.get("defaultLength").and_then(|v| v.as_i64()));
    }
    check(m.get("maxInputTokens").and_then(|v| v.as_i64()));
    check(m.get("maxAllowedSize").and_then(|v| v.as_i64()));

    max_val
}

/// 组装对外字段：`(max_input_tokens, upstream_max_input_tokens)`。
/// max_input_tokens 取最高可用上下文窗口。
fn resolve_context_windows(m: &serde_json::Value) -> (i64, Option<i64>) {
    let hard = upstream_hard_limit(m);
    let highest = upstream_highest_available_window(m).unwrap_or(FALLBACK_CONTEXT_WINDOW);
    (highest, hard)
}

/// 是否应从控制台模型表中剔除该条目：
/// ① 无 id（脏数据）；② 上游显式标记 `disabled === true`；
/// ③ 历史遗留的名字黑名单（`hunyuan-image-v3.0`，上游曾以未置 disabled 的形态下发）。
fn is_model_entry_dropped(m: &serde_json::Value) -> bool {
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if id.is_empty() || id == "hunyuan-image-v3.0" {
        return true;
    }
    m.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 描述截断（按字符，避免切开多字节字符）。
fn truncate_description(raw: &str) -> String {
    if raw.chars().count() <= DESCRIPTION_MAX_CHARS {
        return raw.to_string();
    }
    raw.chars().take(DESCRIPTION_MAX_CHARS).collect()
}

/// 已知模型的完整思考档位矩阵（兜底覆盖表）。
///
/// **为什么需要**：上游 `/v2/enterprises/personal/models` 对部分模型只下发扁平
/// `reasoning: {"effort": "high"}`（无 `supportedEfforts` / `canDisableThinking`），
/// 而官方客户端另一路 `/v3/config` 下发的是完整矩阵。若只按上游扁平值渲染，
/// 控制台会把 `deepseek-v4.1-flash` 等模型误显示为「仅 high、不可关闭思考」。
///
/// **口径**：上游下发了**非子集**矩阵就以上游为准（`efforts_source=upstream`）；
/// 上游只给了本表的严格子集（半截矩阵）→ 按本表补全（`efforts_source=merged`）；
/// 上游完全没给 → 落到本表（`efforts_source=catalog`）。本表由 2026-09-11 官方
/// 客户端两处实测提取（`cloud_product_config_cache` 与客户端基线 `product.json`），
/// 来源逐项标注在 `tests/test_model_effort_matrix.py` 的 `CATALOG_SOURCES`。
struct EffortCatalog {
    id: &'static str,
    efforts: &'static [&'static str],
    default_effort: &'static str,
    can_disable_thinking: bool,
}

const EFFORT_CATALOG: &[EffortCatalog] = &[
    EffortCatalog { id: "deepseek-v4.1-flash", efforts: &["low", "high", "max"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "deepseek-v4-pro", efforts: &["low", "high", "xhigh"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "deepseek-v4-flash", efforts: &["high", "xhigh"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "glm-5.3", efforts: &["low", "high", "max"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "glm-5.3-flash", efforts: &["low", "high", "max"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "glm-5.2", efforts: &["high", "xhigh"], default_effort: "high", can_disable_thinking: true },
    EffortCatalog { id: "hy3", efforts: &["low", "high"], default_effort: "high", can_disable_thinking: false },
    EffortCatalog { id: "hy3-x", efforts: &["low", "high"], default_effort: "high", can_disable_thinking: false },
    EffortCatalog { id: "hy4-preview", efforts: &["high"], default_effort: "high", can_disable_thinking: false },
    EffortCatalog { id: "gpt-6-astra", efforts: &["low", "medium", "high", "xhigh", "max"], default_effort: "high", can_disable_thinking: true },
];

fn lookup_effort_catalog(model_id: &str) -> Option<&'static EffortCatalog> {
    EFFORT_CATALOG.iter().find(|c| c.id == model_id)
}

/// 解析思考档位矩阵，返回 `(档位列表, 来源标记)`。
///
/// 判定顺序：
/// 1. 上游下发了**非子集**矩阵 → `upstream`（上游权威，含上游新增的未知档位）
/// 2. 上游只下发了覆盖表的**严格子集** → 判为半截矩阵，按覆盖表补全 → `merged`
///    （防上游偶发丢档位把已确认的能力压回去；控制台选项仅作显式覆盖用）
/// 3. 上游完全没下发 → 覆盖表 → `catalog`
/// 4. 覆盖表也没有 → 退回扁平 `effort` 字段 → `upstream`
fn resolve_reasoning_matrix(
    upstream_efforts: Vec<String>,
    flat_effort: Option<&str>,
    catalog: Option<&EffortCatalog>,
) -> (Vec<String>, String) {
    if !upstream_efforts.is_empty() {
        if let Some(c) = catalog {
            let all_known = upstream_efforts.iter().all(|e| c.efforts.contains(&e.as_str()));
            if all_known && c.efforts.len() > upstream_efforts.len() {
                let full = c.efforts.iter().map(|s| s.to_string()).collect();
                return (full, "merged".to_string());
            }
        }
        return (upstream_efforts, "upstream".to_string());
    }

    if let Some(c) = catalog {
        return (c.efforts.iter().map(|s| s.to_string()).collect(), "catalog".to_string());
    }

    if let Some(ef) = flat_effort {
        return (vec![ef.to_string()], "upstream".to_string());
    }

    (Vec::new(), "upstream".to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UsageSummary {
    pub uid: String,
    pub nickname: String,
    pub total: f64,
    pub remain: f64,
    pub used: f64,
    pub is_paid_user: bool,
    pub packages: Vec<UsagePackage>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UsagePackage {
    pub code: String,
    pub total: f64,
    pub remain: f64,
    pub used: f64,
    pub unit: String,
}

// ---------------------------------------------------------------------------
// 模型个性化配置存取
// ---------------------------------------------------------------------------

fn model_settings_db_path() -> PathBuf {
    local_app_dir().join("model_settings.json")
}

pub fn load_model_settings() -> HashMap<String, serde_json::Value> {
    let p = model_settings_db_path();
    if p.exists() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(m) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&raw) {
                return m;
            }
        }
    }
    HashMap::new()
}

pub fn save_model_settings(settings: &HashMap<String, serde_json::Value>) -> Result<(), String> {
    let p = model_settings_db_path();
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 模型可用性：预标记（GPT_FALLBACK_MAP 键 = 需海外套餐）+ 运行时学习证据
// ---------------------------------------------------------------------------

/// GPT_FALLBACK_MAP 键（与 converter.py 同步维护）：需海外套餐授权的 GPT 模型。
const GPT_PREMARKED: &[&str] = &[
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
];

fn availability_db_path() -> PathBuf {
    local_app_dir().join("model_availability.json")
}

/// 有效不可用集合 = GPT_FALLBACK_MAP 预标记 + 活跃账号的运行时证据
/// （runtime-200 覆盖预标记；runtime-11102 追加）。
fn load_unavailable_models(active_uid: &str) -> std::collections::HashSet<String> {
    let mut unavailable: std::collections::HashSet<String> = GPT_PREMARKED
        .iter()
        .map(|s| s.to_string())
        .collect();
    let p = availability_db_path();
    if !p.exists() {
        return unavailable;
    }
    let raw = match std::fs::read_to_string(&p) {
        Ok(r) => r,
        Err(_) => return unavailable,
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return unavailable;
    };
    let Some(entry) = root
        .pointer("/accounts")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(active_uid))
        .and_then(|v| v.as_object())
    else {
        return unavailable;
    };
    for (model, rec) in entry {
        if let Some(src) = rec.get("source").and_then(|v| v.as_str()) {
            match src {
                "runtime-11102" => {
                    unavailable.insert(model.clone());
                }
                "runtime-200" => {
                    unavailable.remove(model);
                }
                _ => {}
            }
        }
    }
    unavailable
}

pub fn parse_model_tags_and_badges(raw_tags: Option<&Vec<serde_json::Value>>, source_tag: &str) -> (Vec<String>, Vec<ModelBadge>) {
    let mut tags = Vec::new();
    tags.push(source_tag.to_string());
    let mut badges: Vec<ModelBadge> = Vec::new();

    if let Some(arr) = raw_tags {
        for t in arr {
            if let Some(ts) = t.as_str() {
                let ts_trimmed = ts.trim();
                if ts_trimmed.is_empty() || ts_trimmed.to_lowercase() == "craft" {
                    continue;
                }
                if ts_trimmed.starts_with("badge:") {
                    let parts: Vec<&str> = ts_trimmed.splitn(3, ':').collect();
                    if parts.len() >= 2 {
                        let badge_text = parts[1].trim();
                        let raw_color = if parts.len() >= 3 { parts[2].trim() } else { "" };
                        let is_valid_hex = raw_color.starts_with('#')
                            && raw_color.len() == 7
                            && raw_color[1..].chars().all(|c| c.is_ascii_hexdigit());

                        let kind = if badge_text.contains("限时免费") {
                            "limited_free"
                        } else if badge_text.contains("夜间免费") {
                            "night_free"
                        } else if badge_text.contains("夜间折扣") {
                            "night_discount"
                        } else if badge_text.contains("优惠") {
                            "exclusive"
                        } else {
                            "general"
                        };

                        let color = if is_valid_hex {
                            raw_color.to_uppercase()
                        } else {
                            match kind {
                                "night_free" | "night_discount" => "#1E90FF".to_string(),
                                "limited_free" | "exclusive" => "#FF0000".to_string(),
                                _ => "#3B82F6".to_string(),
                            }
                        };

                        if !badge_text.is_empty() {
                            if !tags.contains(&badge_text.to_string()) && badge_text != source_tag {
                                tags.push(badge_text.to_string());
                            }
                            if !badges.iter().any(|b| b.text == badge_text) {
                                badges.push(ModelBadge {
                                    text: badge_text.to_string(),
                                    color,
                                    kind: kind.to_string(),
                                });
                            }
                        }
                    }
                } else if ts_trimmed == "CodeBuddy" || ts_trimmed == "WorkBuddy" || ts_trimmed == "双端" {
                    if ts_trimmed != source_tag && !tags.contains(&ts_trimmed.to_string()) {
                        tags.push(ts_trimmed.to_string());
                    }
                } else if ts.to_lowercase() != "craft" && ts_trimmed.to_lowercase() != "craft" {
                    if !tags.contains(&ts_trimmed.to_string()) && ts_trimmed != source_tag {
                        tags.push(ts_trimmed.to_string());
                    }
                }
            }
        }
    }
    (tags, badges)
}

// ---------------------------------------------------------------------------
// 模型全量获取与配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn models_fetch_all() -> Result<Vec<ModelMetaItem>, String> {
    let st = load_accounts_state();
    let session = st.accounts.get(&st.active_uid).ok_or_else(|| "当前未登录任何账号".to_string())?;
    let auth = session.get("auth").ok_or("auth 数据不存在")?;
    let account = session.get("account").ok_or("account 数据不存在")?;
    let token = auth.get("accessToken").and_then(|v| v.as_str()).ok_or("缺少 accessToken")?;
    let acct_uid = account.get("uid").and_then(|v| v.as_str()).unwrap_or_default();

    // 腾讯上游国内直连即可，绕过环境代理，避免受 Karing 节点故障影响
    let client = super::shared::upstream_client(30);

    // 双端并发请求：CodeBuddy 国内端 + WorkBuddy 国际/前沿端
    let cb_future = client
        .get("https://copilot.tencent.com/v2/enterprises/personal/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-User-Id", acct_uid)
        .header("User-Agent", "WorkBuddy/2.0.0")
        .send();

    let wb_future = client
        .get("https://www.codebuddy.ai/v3/config")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-User-Id", acct_uid)
        .header("User-Agent", "WorkBuddy/2.0.0")
        .send();

    let (res_cb, res_wb) = futures_util::join!(cb_future, wb_future);

    let mut cb_models = Vec::new();
    if let Ok(resp) = res_cb {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = body.pointer("/data/models").and_then(|v| v.as_array()) {
                    cb_models = arr.clone();
                }
            }
        }
    }

    let mut wb_models = Vec::new();
    if let Ok(resp) = res_wb {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = body.pointer("/data/models").and_then(|v| v.as_array()) {
                    wb_models = arr.clone();
                }
            }
        }
    }

    if cb_models.is_empty() && wb_models.is_empty() {
        return Err("双端获取模型列表均失败".to_string());
    }

    let custom_settings = load_model_settings();
    // 可用性：活跃账号运行时证据 + GPT_FALLBACK_MAP 预标记
    let unavailable = load_unavailable_models(&st.active_uid);
    let mut list = Vec::new();

    let cb_id_set: std::collections::HashSet<String> = cb_models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let wb_id_set: std::collections::HashSet<String> = wb_models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    // 合并列表（P1-4）：保持顺序（CB 优先，WB 补充独有），同 ID 模型并集融合 tags 与 badges
    let mut ordered_ids = Vec::new();
    let mut primary_map = std::collections::HashMap::new();
    let mut raw_tags_map: std::collections::HashMap<String, Vec<serde_json::Value>> = std::collections::HashMap::new();

    let mut all_models = Vec::new();
    for m in cb_models {
        all_models.push(m);
    }
    for m in wb_models {
        all_models.push(m);
    }

    for m in all_models {
        if is_model_entry_dropped(&m) {
            continue;
        }
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if id.is_empty() {
            continue;
        }
        if !primary_map.contains_key(&id) {
            ordered_ids.push(id.clone());
            primary_map.insert(id.clone(), m.clone());
        }
        if let Some(arr) = m.get("tags").and_then(|v| v.as_array()) {
            raw_tags_map.entry(id).or_default().extend(arr.iter().cloned());
        }
    }

    for id in ordered_ids {
        let m = match primary_map.get(&id) {
            Some(v) => v,
            None => continue,
        };

        let in_cb = cb_id_set.contains(&id);
        let in_wb = wb_id_set.contains(&id);

        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
        let credits = m.get("credits").and_then(|v| v.as_str()).unwrap_or("—").to_string();
        // 上下文窗口两个字段并存：
        //   max_input_tokens           = 客户端默认窗口（contextWindow.defaultLength 优先）
        //   upstream_max_input_tokens  = 上游硬上限（maxInputTokens / maxAllowedSize）
        // 旧实现只读后者当默认窗口上报，导致 12 个模型把默认 300000 谎报成 1000000。
        let (max_input, upstream_max_input) = resolve_context_windows(&m);
        let max_output = m.get("maxOutputTokens").and_then(|v| v.as_i64()).unwrap_or(32000);

        let reasoning_obj = m.get("reasoning");
        let supports_reasoning = m.get("supportsReasoning").and_then(|v| v.as_bool()).unwrap_or(false);
        let catalog = lookup_effort_catalog(&id);

        // 上游显式下发的 canDisableThinking 优先；缺失时先看内置覆盖表，再退回 onlyReasoning 推断
        let upstream_can_disable = reasoning_obj
            .and_then(|r| r.get("canDisableThinking"))
            .and_then(|v| v.as_bool());
        let can_disable_thinking = upstream_can_disable.unwrap_or_else(|| {
            catalog
                .map(|c| c.can_disable_thinking)
                .unwrap_or_else(|| !m.get("onlyReasoning").and_then(|v| v.as_bool()).unwrap_or(false))
        });

        let mut upstream_efforts = Vec::new();
        if let Some(arr) = reasoning_obj.and_then(|r| r.get("supportedEfforts")).and_then(|v| v.as_array()) {
            for ef in arr {
                if let Some(s) = ef.as_str() {
                    upstream_efforts.push(s.to_string());
                }
            }
        }
        let flat_effort = reasoning_obj
            .and_then(|r| r.get("effort"))
            .and_then(|v| v.as_str());

        // 档位矩阵来源判定：上游非子集矩阵 > 半截矩阵按覆盖表补全(merged) > 覆盖表 > 扁平值
        let (supported_efforts, efforts_source) =
            resolve_reasoning_matrix(upstream_efforts, flat_effort, catalog);

        let default_effort = reasoning_obj.and_then(|r| r.get("defaultEffort"))
            .or_else(|| reasoning_obj.and_then(|r| r.get("effort")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| catalog.map(|c| c.default_effort.to_string()))
            .unwrap_or_else(|| "auto".to_string());

        let desc = truncate_description(
            m.get("descriptionZh").and_then(|v| v.as_str())
                .or_else(|| m.get("descriptionEn").and_then(|v| v.as_str()))
                .unwrap_or(""),
        );

        let source_tag = if in_cb && in_wb {
            "双端"
        } else if in_wb {
            "WorkBuddy"
        } else {
            "CodeBuddy"
        };
        let (tags, badges) = parse_model_tags_and_badges(raw_tags_map.get(&id), source_tag);

        // 读取用户个性化覆盖设置（上下文手改已废除，仅保留思考强度）
        let mut custom_effort = None;
        if let Some(cfg) = custom_settings.get(&id) {
            custom_effort = cfg.get("reasoning_effort").and_then(|v| v.as_str()).map(|s| s.to_string());
        }

        list.push(ModelMetaItem {
            id: id.clone(),
            name,
            credits,
            max_input_tokens: max_input,
            max_output_tokens: max_output,
            upstream_max_input_tokens: upstream_max_input,
            supports_reasoning,
            can_disable_thinking,
            supported_efforts,
            default_effort,
            description: desc,
            tags,
            badges,
            custom_context_window: None,
            custom_reasoning_effort: custom_effort,
            efforts_source,
            availability: if unavailable.contains(&id) { "unavailable".to_string() } else { "available".to_string() },
        });
    }

    Ok(list)
}

#[tauri::command]
pub fn model_save_config(model_id: String, _context_window: Option<i64>, reasoning_effort: Option<String>) -> Result<String, String> {
    let mut settings = load_model_settings();
    let entry = settings.entry(model_id.clone()).or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = entry.as_object_mut() {
        // 上下文手改功能已废除：始终移除 context_window，不再保存手改窗口
        obj.remove("context_window");

        if let Some(ref re) = reasoning_effort {
            if re == "default" || re.is_empty() {
                obj.remove("reasoning_effort");
            } else {
                obj.insert("reasoning_effort".into(), serde_json::json!(re));
            }
        } else {
            obj.remove("reasoning_effort");
        }
    }

    save_model_settings(&settings)?;
    Ok(format!("模型 {model_id} 配置已保存"))
}

// ---------------------------------------------------------------------------
// 积分查询 (Usage & Quota)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn usage_query(uid: Option<String>) -> Result<UsageSummary, String> {
    let st = load_accounts_state();
    let target_uid = uid.unwrap_or_else(|| st.active_uid.clone());
    let session = st.accounts.get(&target_uid).ok_or_else(|| "当前未登录任何账号".to_string())?;

    let auth = session.get("auth").ok_or("auth 数据不存在")?;
    let account = session.get("account").ok_or("account 数据不存在")?;
    let token = auth.get("accessToken").and_then(|v| v.as_str()).ok_or("缺少 accessToken")?;
    let acct_uid = account.get("uid").and_then(|v| v.as_str()).unwrap_or_default();
    let nickname = account.get("nickname").and_then(|v| v.as_str()).unwrap_or("—").to_string();

    // 腾讯上游国内直连即可，绕过环境代理，避免受 Karing 节点故障影响
    let client = super::shared::upstream_client(30);
    let resp = client
        .post("https://copilot.tencent.com/billing/meter/get-user-resource-summary")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-User-Id", acct_uid)
        .header("Content-Type", "application/json")
        .header("User-Agent", "workbuddy2api/2.0")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("积分接口连接失败: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("积分查询失败: {}", body.get("msg").unwrap_or(&body)));
    }
    let data = body.get("data").ok_or("积分响应缺少 data 字段")?;

    let mut total = 0.0f64;
    let mut remain = 0.0f64;
    let mut used = 0.0f64;
    let mut packages = Vec::new();

    if let Some(list) = data.get("Packages").and_then(|v| v.as_array()) {
        for p in list {
            let pt: f64 = p.get("CycleTotalCapacity").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let pr: f64 = p.get("CycleRemainCapacity").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let pu: f64 = p.get("CycleUsedCapacity").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            total += pt;
            remain += pr;
            used += pu;
            packages.push(UsagePackage {
                code: p.get("PackageCode").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                total: pt,
                remain: pr,
                used: pu,
                unit: p.get("CapacityUnit").and_then(|v| v.as_str()).unwrap_or("credits").to_string(),
            });
        }
    }

    Ok(UsageSummary {
        uid: target_uid,
        nickname,
        total,
        remain,
        used,
        is_paid_user: data.get("IsPaidUser").and_then(|v| v.as_bool()).unwrap_or(false),
        packages,
    })
}


// ---------------------------------------------------------------------------
// 单元测试：思考档位矩阵解析口径
// ---------------------------------------------------------------------------

#[cfg(test)]
mod model_entry_parsing_tests {
    use super::*;

    fn entry(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    /// 核心回归：上报给客户端的窗口必须是最高可用（supportedLengths / maxLength / maxInputTokens / maxAllowedSize 最大值），
    /// 确保 12 个 1M 档模型对客户端报出真实 1,000,000 窗口，避免早早被压缩。
    #[test]
    fn default_window_resolves_to_highest_available() {
        let m = entry(r#"{"id":"a","maxInputTokens":1000000,
                         "contextWindow":{"defaultLength":300000,"supportedLengths":[300000,1000000]}}"#);
        let (ctx, hard) = resolve_context_windows(&m);
        assert_eq!(ctx, 1_000_000, "必须取最高可用作为默认窗口");
        assert_eq!(hard, Some(1_000_000), "硬上限应保留在独立字段");

        let m_max = entry(r#"{"id":"a","maxInputTokens":1000000,
                             "contextWindow":{"defaultLength":300000,"maxLength":1000000}}"#);
        let (ctx_max, _) = resolve_context_windows(&m_max);
        assert_eq!(ctx_max, 1_000_000, "maxLength 存在时也应计入最高可用");

        // 若只有 defaultLength 且无其他更高候选，取 defaultLength
        let m_only_dl = entry(r#"{"id":"a","contextWindow":{"defaultLength":300000}}"#);
        let (ctx_dl, _) = resolve_context_windows(&m_only_dl);
        assert_eq!(ctx_dl, 300_000, "仅有 defaultLength 时取该值");
    }

    /// `contextWindow.defaultLength` 缺失 → 回退 `maxInputTokens`（兼容老条目）。
    #[test]
    fn default_window_falls_back_to_hard_limit_when_default_missing() {
        let m = entry(r#"{"id":"a","maxInputTokens":1000000}"#);
        let (ctx, hard) = resolve_context_windows(&m);
        assert_eq!(ctx, 1_000_000);
        assert_eq!(hard, Some(1_000_000));

        // contextWindow 存在但 defaultLength 缺失/非法（0/负数/非整数）同样回退
        for json in [
            r#"{"id":"a","maxInputTokens":64000,"contextWindow":{}}"#,
            r#"{"id":"a","maxInputTokens":64000,"contextWindow":{"defaultLength":0}}"#,
            r#"{"id":"a","maxInputTokens":64000,"contextWindow":{"defaultLength":-5}}"#,
            r#"{"id":"a","maxInputTokens":64000,"contextWindow":{"defaultLength":"300000"}}"#,
            r#"{"id":"a","maxInputTokens":64000,"contextWindow":null}"#,
        ] {
            let (ctx, _) = resolve_context_windows(&entry(json));
            assert_eq!(ctx, 64_000, "非法/缺失的 defaultLength 应回退硬上限：{json}");
        }
    }

    /// 硬上限取值口径保持既有：`maxInputTokens` 优先，回退 `maxAllowedSize`；非正数视为缺失。
    #[test]
    fn hard_limit_prefers_max_input_tokens_then_max_allowed_size() {
        assert_eq!(upstream_hard_limit(&entry(r#"{"maxInputTokens":10,"maxAllowedSize":20}"#)), Some(10));
        assert_eq!(upstream_hard_limit(&entry(r#"{"maxAllowedSize":20}"#)), Some(20));
        assert_eq!(upstream_hard_limit(&entry(r#"{"maxInputTokens":0,"maxAllowedSize":20}"#)), Some(20));
        assert_eq!(upstream_hard_limit(&entry(r#"{"maxInputTokens":-1}"#)), None);
        assert_eq!(upstream_hard_limit(&entry(r#"{}"#)), None);
    }

    /// 两个字段都缺失 → 内置兜底 200000（既有行为，勿改）。
    #[test]
    fn missing_windows_fall_back_to_builtin_default() {
        let (ctx, hard) = resolve_context_windows(&entry(r#"{"id":"a"}"#));
        assert_eq!(ctx, FALLBACK_CONTEXT_WINDOW);
        assert_eq!(ctx, 200_000);
        assert_eq!(hard, None);
    }

    /// 剔除口径：无 id / `disabled === true` / 历史黑名单。
    #[test]
    fn drop_rules_cover_disabled_and_legacy_blacklist() {
        assert!(is_model_entry_dropped(&entry(r#"{"id":""}"#)));
        assert!(is_model_entry_dropped(&entry(r#"{}"#)));
        assert!(is_model_entry_dropped(&entry(r#"{"id":"hunyuan-image-v3.0"}"#)));
        assert!(is_model_entry_dropped(&entry(r#"{"id":"x","disabled":true}"#)));
        // disabled 非 true（false / 缺失 / 非布尔）不剔除
        assert!(!is_model_entry_dropped(&entry(r#"{"id":"x"}"#)));
        assert!(!is_model_entry_dropped(&entry(r#"{"id":"x","disabled":false}"#)));
        assert!(!is_model_entry_dropped(&entry(r#"{"id":"x","disabled":"true"}"#)));
    }

    /// 描述截断到 512 字符；短文本原样保留；多字节字符不得被切开。
    #[test]
    fn description_is_truncated_to_512_chars_on_char_boundary() {
        let short = "短描述";
        assert_eq!(truncate_description(short), short);

        let exactly = "a".repeat(DESCRIPTION_MAX_CHARS);
        assert_eq!(truncate_description(&exactly), exactly);

        let long = "a".repeat(DESCRIPTION_MAX_CHARS + 100);
        assert_eq!(truncate_description(&long).chars().count(), DESCRIPTION_MAX_CHARS);
        assert_eq!(truncate_description(&long), exactly);

        // 全中文（每字符 3 字节）：按字符截断，结果仍是合法 UTF-8 且长度正确
        let cn = "中".repeat(DESCRIPTION_MAX_CHARS + 10);
        let got = truncate_description(&cn);
        assert_eq!(got.chars().count(), DESCRIPTION_MAX_CHARS);
        assert_eq!(got, "中".repeat(DESCRIPTION_MAX_CHARS));
    }
}

#[cfg(test)]
mod reasoning_matrix_tests {
    use super::*;

    fn cat(id: &str) -> Option<&'static EffortCatalog> {
        lookup_effort_catalog(id)
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// 上游下发完整矩阵（含覆盖表未知的档位）→ 以上游为准，不判为半截。
    #[test]
    fn upstream_superset_wins() {
        let (efforts, source) = resolve_reasoning_matrix(
            s(&["low", "high", "max", "ultra"]), None, cat("deepseek-v4.1-flash"));
        assert_eq!(efforts, s(&["low", "high", "max", "ultra"]));
        assert_eq!(source, "upstream");
    }

    /// 上游档位与覆盖表等长且完全相同 → 上游（非半截）。
    #[test]
    fn upstream_equal_matrix_stays_upstream() {
        let (efforts, source) = resolve_reasoning_matrix(
            s(&["low", "high", "max"]), None, cat("deepseek-v4.1-flash"));
        assert_eq!(efforts, s(&["low", "high", "max"]));
        assert_eq!(source, "upstream");
    }

    /// 上游只给覆盖表的严格子集 → 判为半截矩阵，按覆盖表补全。
    #[test]
    fn upstream_subset_merges_to_catalog() {
        let (efforts, source) = resolve_reasoning_matrix(
            s(&["high"]), None, cat("deepseek-v4.1-flash"));
        assert_eq!(efforts, s(&["low", "high", "max"]));
        assert_eq!(source, "merged");
    }

    /// 上游子集但含覆盖表未知档位 → 不是子集，以上游为准（不丢未知档位）。
    #[test]
    fn upstream_subset_with_unknown_effort_wins() {
        let (efforts, source) = resolve_reasoning_matrix(
            s(&["high", "turbo"]), None, cat("deepseek-v4.1-flash"));
        assert_eq!(efforts, s(&["high", "turbo"]));
        assert_eq!(source, "upstream");
    }

    /// 上游完全没下发 → 覆盖表。
    #[test]
    fn no_upstream_matrix_falls_back_to_catalog() {
        let (efforts, source) = resolve_reasoning_matrix(
            Vec::new(), None, cat("deepseek-v4.1-flash"));
        assert_eq!(efforts, s(&["low", "high", "max"]));
        assert_eq!(source, "catalog");
    }

    /// 上游没下发、覆盖表也没有 → 退回扁平 effort 字段。
    #[test]
    fn no_upstream_no_catalog_uses_flat_effort() {
        let (efforts, source) = resolve_reasoning_matrix(
            Vec::new(), Some("high"), None);
        assert_eq!(efforts, s(&["high"]));
        assert_eq!(source, "upstream");
    }

    /// 三处都空 → 空矩阵，不 panic。
    #[test]
    fn all_empty_yields_empty_matrix() {
        let (efforts, source) = resolve_reasoning_matrix(Vec::new(), None, None);
        assert!(efforts.is_empty());
        assert_eq!(source, "upstream");
    }

    /// 覆盖表与官方实测矩阵逐项一致（防止 Rust 侧与测试注释漂移）。
    #[test]
    fn catalog_entries_are_present_and_shaped() {
        for id in ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash",
                   "glm-5.3", "glm-5.3-flash", "glm-5.2",
                   "hy3", "hy3-x", "hy4-preview", "gpt-6-astra"] {
            let c = cat(id).unwrap_or_else(|| panic!("覆盖表缺少 {id}"));
            assert!(!c.efforts.is_empty(), "{id} 档位为空");
            assert!(c.efforts.contains(&c.default_effort),
                "{id} 默认档 {} 不在档位列表里", c.default_effort);
        }
    }

    /// onlyReasoning 的模型不得开放关闭思考。
    #[test]
    fn only_reasoning_models_deny_disable() {
        for id in ["hy3", "hy3-x", "hy4-preview"] {
            assert!(!cat(id).unwrap().can_disable_thinking,
                "{id} 是 onlyReasoning 模型，不应允许关闭思考");
        }
    }

    /// 标签与 badge 解析测试
    #[test]
    fn test_parse_model_tags_and_badges() {
        let raw = vec![
            serde_json::Value::String("  craft  ".to_string()),
            serde_json::Value::String("badge:限时免费:#FF0000".to_string()),
            serde_json::Value::String("badge:夜间免费:#1E90FF".to_string()),
            serde_json::Value::String("badge:夜间免费:#1E90FF".to_string()), // 重复项应被自动去重
            serde_json::Value::String("badge:夜间折扣:#1E90FF".to_string()),
            serde_json::Value::String("badge:独家优惠:#FF0000".to_string()),
            serde_json::Value::String("badge:未知活动:invalid-color".to_string()),
        ];
        let (tags, badges) = parse_model_tags_and_badges(Some(&raw), "双端");
        assert_eq!(tags, vec!["双端", "限时免费", "夜间免费", "夜间折扣", "独家优惠", "未知活动"]);
        assert_eq!(badges.len(), 5);
        assert_eq!(badges[0], ModelBadge {
            text: "限时免费".to_string(),
            color: "#FF0000".to_string(),
            kind: "limited_free".to_string(),
        });
        assert_eq!(badges[1], ModelBadge {
            text: "夜间免费".to_string(),
            color: "#1E90FF".to_string(),
            kind: "night_free".to_string(),
        });
        assert_eq!(badges[2], ModelBadge {
            text: "夜间折扣".to_string(),
            color: "#1E90FF".to_string(),
            kind: "night_discount".to_string(),
        });
        assert_eq!(badges[3], ModelBadge {
            text: "独家优惠".to_string(),
            color: "#FF0000".to_string(),
            kind: "exclusive".to_string(),
        });
        assert_eq!(badges[4], ModelBadge {
            text: "未知活动".to_string(),
            color: "#3B82F6".to_string(),
            kind: "general".to_string(),
        });
    }

    #[test]
    fn test_merge_models_union_tags_and_badges() {
        // 模拟 CodeBuddy 有 tags A，WorkBuddy 有 tags B，双端融合必须保留两端 badge 与 tag
        let cb_tags = vec![serde_json::Value::String("badge:夜间免费:#1E90FF".to_string())];
        let wb_tags = vec![serde_json::Value::String("badge:夜间折扣:#1E90FF".to_string())];
        let mut combined = cb_tags;
        combined.extend(wb_tags);
        let (tags, badges) = parse_model_tags_and_badges(Some(&combined), "双端");
        assert_eq!(tags, vec!["双端", "夜间免费", "夜间折扣"]);
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[0].kind, "night_free");
        assert_eq!(badges[1].kind, "night_discount");
    }
}
