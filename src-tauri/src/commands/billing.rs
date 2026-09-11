//! 配额与积分查询、模型元数据获取与配置命令

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::shared::{local_app_dir, load_accounts_state};

// ---------------------------------------------------------------------------
// 积分与模型数据模型
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelMetaItem {
    pub id: String,
    pub name: String,
    pub credits: String,
    pub max_input_tokens: i64,
    pub max_output_tokens: i64,
    pub supports_reasoning: bool,
    pub can_disable_thinking: bool,
    pub supported_efforts: Vec<String>,
    pub default_effort: String,
    pub description: String,
    pub tags: Vec<String>,
    // 用户自定义覆盖项
    pub custom_context_window: Option<i64>,
    pub custom_reasoning_effort: Option<String>,
    // 档位矩阵来源：upstream=上游下发 / catalog=内置覆盖表兜底
    pub efforts_source: String,
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
    let mut list = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let cb_id_set: std::collections::HashSet<String> = cb_models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let wb_id_set: std::collections::HashSet<String> = wb_models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    // 合并列表：先遍历 cb_models，再遍历 wb_models 补充独有模型
    let mut all_models = Vec::new();
    for m in cb_models {
        all_models.push(m);
    }
    for m in wb_models {
        all_models.push(m);
    }

    for m in all_models {
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if id.is_empty() || id == "hunyuan-image-v3.0" {
            continue;
        }
        if seen_ids.contains(&id) {
            continue;
        }
        seen_ids.insert(id.clone());

        let in_cb = cb_id_set.contains(&id);
        let in_wb = wb_id_set.contains(&id);

        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
        let credits = m.get("credits").and_then(|v| v.as_str()).unwrap_or("—").to_string();
        let max_input = m.get("maxInputTokens").and_then(|v| v.as_i64())
            .or_else(|| m.get("maxAllowedSize").and_then(|v| v.as_i64()))
            .unwrap_or(200000);
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

        let desc = m.get("descriptionZh").and_then(|v| v.as_str())
            .or_else(|| m.get("descriptionEn").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();

        let mut tags = Vec::new();
        let source_tag = if in_cb && in_wb {
            "双端"
        } else if in_wb {
            "WorkBuddy"
        } else {
            "CodeBuddy"
        };
        tags.push(source_tag.to_string());

        if let Some(tag_arr) = m.get("tags").and_then(|v| v.as_array()) {
            for t in tag_arr {
                if let Some(ts) = t.as_str() {
                    if !ts.starts_with("badge:") && ts != source_tag && ts.to_lowercase() != "craft" {
                        tags.push(ts.to_string());
                    }
                }
            }
        }

        // 读取用户个性化覆盖设置
        let mut custom_ctx = None;
        let mut custom_effort = None;
        if let Some(cfg) = custom_settings.get(&id) {
            custom_ctx = cfg.get("context_window").and_then(|v| v.as_i64());
            custom_effort = cfg.get("reasoning_effort").and_then(|v| v.as_str()).map(|s| s.to_string());
        }

        list.push(ModelMetaItem {
            id,
            name,
            credits,
            max_input_tokens: max_input,
            max_output_tokens: max_output,
            supports_reasoning,
            can_disable_thinking,
            supported_efforts,
            default_effort,
            description: desc,
            tags,
            custom_context_window: custom_ctx,
            custom_reasoning_effort: custom_effort,
            efforts_source,
        });
    }

    Ok(list)
}

#[tauri::command]
pub fn model_save_config(model_id: String, context_window: Option<i64>, reasoning_effort: Option<String>) -> Result<String, String> {
    let mut settings = load_model_settings();
    let entry = settings.entry(model_id.clone()).or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = entry.as_object_mut() {
        if let Some(cw) = context_window {
            obj.insert("context_window".into(), serde_json::json!(cw));
        } else {
            obj.remove("context_window");
        }

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
}
