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
/// **口径**：上游给了完整 `supportedEfforts` 就以上游为准（`efforts_source=upstream`）；
/// 只有缺失时才落到本表（`catalog=catalog`）。本表由 2026-09-11 官方客户端
/// `cloud_product_config_cache` 实测提取，仅作缺失时兜底，不做强制覆盖。
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
];

fn lookup_effort_catalog(model_id: &str) -> Option<&'static EffortCatalog> {
    EFFORT_CATALOG.iter().find(|c| c.id == model_id)
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
    let resp = client
        .get("https://copilot.tencent.com/v2/enterprises/personal/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-User-Id", acct_uid)
        .header("User-Agent", "codebuddy2openai/2.0")
        .send()
        .await
        .map_err(|e| format!("获取模型列表失败: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw_models = body.pointer("/data/models").and_then(|v| v.as_array()).ok_or("模型数据格式异常")?;

    let custom_settings = load_model_settings();
    let mut list = Vec::new();

    for m in raw_models {
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if id.is_empty() || id == "hunyuan-image-v3.0" {
            continue;
        }
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

        let mut supported_efforts = Vec::new();
        if let Some(arr) = reasoning_obj.and_then(|r| r.get("supportedEfforts")).and_then(|v| v.as_array()) {
            for ef in arr {
                if let Some(s) = ef.as_str() {
                    supported_efforts.push(s.to_string());
                }
            }
        }

        // 档位矩阵来源判定：上游完整下发 > 内置覆盖表 > 扁平 effort 字段兜底
        let efforts_source: String;
        if !supported_efforts.is_empty() {
            efforts_source = "upstream".to_string();
        } else if let Some(c) = catalog {
            supported_efforts = c.efforts.iter().map(|s| s.to_string()).collect();
            efforts_source = "catalog".to_string();
        } else {
            if let Some(ef) = reasoning_obj.and_then(|r| r.get("effort")).and_then(|v| v.as_str()) {
                supported_efforts.push(ef.to_string());
            }
            efforts_source = "upstream".to_string();
        }

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
        if let Some(tag_arr) = m.get("tags").and_then(|v| v.as_array()) {
            for t in tag_arr {
                if let Some(ts) = t.as_str() {
                    if !ts.starts_with("badge:") {
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
        .header("User-Agent", "codebuddy2openai/2.0")
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
