//! Agent 状态检测与手动接入引导（Hermes & ZCode）。
//!
//! Hermes 不再由 WorkBuddy2API 自动改写 config.yaml；这里只读当前端点并生成
//! 用户可复制的手动配置说明。ZCode 同样只返回手动接入引导。

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::shared::{env_nonempty, local_appdata, user_home};

/// 对 127.0.0.1:<port> 做带超时的 TCP 连通性探测（800ms 上限，避免 UI 卡顿）。
fn loopback_port_open(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentStatus {
    pub hermes_installed: bool,
    pub hermes_configured: bool,
    pub hermes_config_path: String,
    pub zcode_installed: bool,
    /// provider.workbuddy 是否仍写在旧版 ZCode JSON 配置里（仅作残留提示）。
    pub zcode_provider_registered: bool,
    /// 对 c2o 服务端口的真实可达性探测。
    pub zcode_service_online: bool,
    pub zcode_cli_path: String,
    pub zcode_v2_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct HermesEndpointSnapshot {
    provider: String,
    model: String,
    base_url: String,
    api_key_configured: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HermesEndpointGuide {
    pub installed: bool,
    pub config_path: String,
    pub current_provider: String,
    pub current_model: String,
    pub current_base_url: String,
    pub current_api_key_configured: bool,
    pub target_base_url: String,
    pub target_api_key: String,
    pub target_model: String,
    pub yaml_snippet: String,
    pub steps: Vec<String>,
}

/// Hermes 配置文件候选列表：HERMES_HOME → %LOCALAPPDATA%\hermes → %USERPROFILE%\.hermes。
fn hermes_config_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(home) = env_nonempty("HERMES_HOME") {
        list.push(PathBuf::from(home).join("config.yaml"));
    }
    list.push(local_appdata().join("hermes").join("config.yaml"));
    list.push(user_home().join(".hermes").join("config.yaml"));
    list
}

/// 解析当前实际生效的 Hermes 配置文件路径。
fn resolve_hermes_config() -> PathBuf {
    hermes_config_candidates()
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| local_appdata().join("hermes").join("config.yaml"))
}

fn zcode_cli_path() -> PathBuf {
    user_home().join(".zcode").join("cli").join("config.json")
}

fn zcode_v2_path() -> PathBuf {
    user_home().join(".zcode").join("v2").join("config.json")
}

fn yaml_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn map_string(map: &Mapping, key: &str) -> String {
    yaml_string(map.get(Value::String(key.to_string())))
}

fn map_first_non_empty(map: &Mapping, keys: &[&str]) -> String {
    for key in keys {
        let val = map_string(map, key);
        if !val.is_empty() {
            return val;
        }
    }
    String::new()
}

fn map_value<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
    map.get(Value::String(key.to_string()))
}

fn provider_entry_snapshot(entry: &Mapping) -> HermesEndpointSnapshot {
    HermesEndpointSnapshot {
        provider: map_string(entry, "provider"),
        model: map_first_non_empty(entry, &["default", "model", "name"]),
        base_url: map_first_non_empty(entry, &["base_url", "url", "api"]),
        api_key_configured: !map_string(entry, "api_key").is_empty()
            || !map_string(entry, "key_env").is_empty()
            || !map_string(entry, "api_key_env").is_empty(),
    }
}

fn merge_provider_fallback(mut current: HermesEndpointSnapshot, root: &Mapping) -> HermesEndpointSnapshot {
    let wanted = current.provider.to_ascii_lowercase();

    if let Some(Value::Sequence(entries)) = map_value(root, "custom_providers") {
        for value in entries {
            let Some(entry) = value.as_mapping() else { continue };
            let name = map_string(entry, "name");
            let name_lc = name.to_ascii_lowercase();
            let matches = !wanted.is_empty()
                && (wanted == "custom" || wanted == name_lc || wanted == format!("custom:{name_lc}"));
            if matches || (wanted.is_empty() && !name.is_empty()) {
                let fallback = provider_entry_snapshot(entry);
                if current.provider.is_empty() {
                    current.provider = fallback.provider;
                }
                if current.model.is_empty() {
                    current.model = fallback.model;
                }
                if current.base_url.is_empty() {
                    current.base_url = fallback.base_url;
                }
                current.api_key_configured |= fallback.api_key_configured;
                if matches {
                    return current;
                }
            }
        }
    }

    if let Some(Value::Mapping(providers)) = map_value(root, "providers") {
        for (key, value) in providers {
            let Some(entry) = value.as_mapping() else { continue };
            let key_name = yaml_string(Some(key));
            if !wanted.is_empty() && wanted != key_name.to_ascii_lowercase() {
                continue;
            }
            let fallback = provider_entry_snapshot(entry);
            if current.provider.is_empty() {
                current.provider = key_name;
            }
            if current.model.is_empty() {
                current.model = fallback.model;
            }
            if current.base_url.is_empty() {
                current.base_url = fallback.base_url;
            }
            current.api_key_configured |= fallback.api_key_configured;
            break;
        }
    }

    current
}

fn read_hermes_endpoint(path: &Path) -> HermesEndpointSnapshot {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HermesEndpointSnapshot::default();
    };
    let Ok(Value::Mapping(root)) = serde_yaml::from_str::<Value>(&raw) else {
        return HermesEndpointSnapshot::default();
    };

    let current = match map_value(&root, "model").and_then(Value::as_mapping) {
        Some(model) => provider_entry_snapshot(model),
        None => HermesEndpointSnapshot::default(),
    };
    merge_provider_fallback(current, &root)
}

fn hermes_is_configured(snapshot: &HermesEndpointSnapshot) -> bool {
    !snapshot.base_url.is_empty() && (!snapshot.provider.is_empty() || !snapshot.model.is_empty())
}

// ---------------------------------------------------------------------------
// 只读状态与手动引导
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_detect(port: Option<u16>) -> Result<AgentStatus, String> {
    let hermes_p = resolve_hermes_config();
    let hermes_installed = hermes_p.exists();
    let hermes_configured = hermes_installed && hermes_is_configured(&read_hermes_endpoint(&hermes_p));

    let zcode_c = zcode_cli_path();
    let zcode_v = zcode_v2_path();
    let zcode_installed = zcode_c.exists() || zcode_v.exists();
    let mut zcode_provider_registered = false;
    if zcode_c.exists() {
        if let Ok(raw) = std::fs::read_to_string(&zcode_c) {
            zcode_provider_registered = raw.contains("workbuddy") && raw.contains("8787");
        }
    }

    Ok(AgentStatus {
        hermes_installed,
        hermes_configured,
        hermes_config_path: hermes_p.to_string_lossy().to_string(),
        zcode_installed,
        zcode_provider_registered,
        zcode_service_online: loopback_port_open(port.unwrap_or(8787)),
        zcode_cli_path: zcode_c.to_string_lossy().to_string(),
        zcode_v2_path: zcode_v.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn hermes_endpoint_guide(port: u16) -> Result<HermesEndpointGuide, String> {
    let path = resolve_hermes_config();
    let snapshot = read_hermes_endpoint(&path);
    let target_base_url = format!("http://127.0.0.1:{port}/v1");
    let target_model = "auto".to_string();
    let yaml_snippet = format!(
        "model:\n  provider: custom\n  default: {target_model}\n  base_url: {target_base_url}\n  api_key: local"
    );

    Ok(HermesEndpointGuide {
        installed: path.exists(),
        config_path: path.to_string_lossy().to_string(),
        current_provider: snapshot.provider,
        current_model: snapshot.model,
        current_base_url: snapshot.base_url,
        current_api_key_configured: snapshot.api_key_configured,
        target_base_url: target_base_url.clone(),
        target_api_key: "local".to_string(),
        target_model,
        yaml_snippet,
        steps: vec![
            format!("打开 Hermes 配置文件：{}", path.display()),
            "在顶层 model: 节中填写或修改 provider、default、base_url、api_key；不要删除其它配置。".into(),
            format!("base_url 填：{target_base_url}"),
            "api_key 填：local（WorkBuddy2API 回环端点使用固定本地密钥）".into(),
            "default 可填 auto，也可填 /v1/models 返回的具体模型 ID。".into(),
            "保存后重启 Hermes，或在模型选择器中刷新模型列表；刷新前请先启动 WorkBuddy2API 服务。".into(),
        ],
    })
}

// ---------------------------------------------------------------------------
// ZCode 手动接入
// ---------------------------------------------------------------------------

/// 静态回退模型列表：ZCode 引导在反代不可达时仍应能展示可复制的模型名。
const WORKBUDDY_FALLBACK_MODELS: &[&str] = &[
    "auto", "hy4-preview", "hy3", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1",
    "glm-5v-turbo", "kimi-k3", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro",
    "deepseek-v4-flash", "minimax-m3",
];

#[tauri::command]
pub fn zcode_guide(port: u16) -> Result<String, String> {
    let payload = serde_json::json!({
        "mode": "manual-guide",
        "base_url": format!("http://127.0.0.1:{port}/v1"),
        "api_format": "Chat Completions (/chat/completions)",
        "api_key": "local",
        "models": WORKBUDDY_FALLBACK_MODELS,
        "steps": [
            "1. 打开 ZCode Desktop → 模型设置 → 添加供应商",
            "2. Base URL / API Key 粘贴下方对应值，API 格式选 Chat Completions",
            "3. 在模型列表里逐个添加上方模型名（至少加一个，推荐 glm-5.3-flash）",
            "4. 保存后确认本控制台服务已启动（端口在线），即可在聊天中选择 WorkBuddy 模型"
        ],
        "note": "ZCode Desktop 只认界面内添加的供应商；此前写入配置文件的 workbuddy 残留可用清理按钮移除"
    });
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zcode_remove() -> Result<String, String> {
    for path in [zcode_cli_path(), zcode_v2_path()] {
        if !path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(obj) = cfg.as_object_mut() {
                if let Some(provs) = obj.get_mut("provider").and_then(|v| v.as_object_mut()) {
                    provs.remove("workbuddy");
                }
            }
            let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
            std::fs::write(&path, out).map_err(|e| e.to_string())?;
        }
    }
    Ok("已清理配置文件中的 workbuddy 残留。注意：ZCode Desktop 模型设置里手动添加的 WorkBuddy 条目存储在其内部数据库，需在界面中手动删除".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_current_model_endpoint_without_exposing_key() {
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: custom\n  default: deepseek-v4.1-flash\n  base_url: http://127.0.0.1:8787/v1\n  api_key: local\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let model = root.get(Value::String("model".into())).unwrap().as_mapping().unwrap();
        let snapshot = provider_entry_snapshot(model);
        assert_eq!(snapshot.provider, "custom");
        assert_eq!(snapshot.model, "deepseek-v4.1-flash");
        assert_eq!(snapshot.base_url, "http://127.0.0.1:8787/v1");
        assert!(snapshot.api_key_configured);
    }

    #[test]
    fn falls_back_to_matching_custom_provider() {
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: cpa-gui\n  default: gemini\ncustom_providers:\n  - name: cpa-gui\n    base_url: http://127.0.0.1:18080/v1\n    api_key: local\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let model = root.get(Value::String("model".into())).unwrap().as_mapping().unwrap();
        let current = provider_entry_snapshot(model);
        let snapshot = merge_provider_fallback(current, root);
        assert_eq!(snapshot.base_url, "http://127.0.0.1:18080/v1");
        assert!(snapshot.api_key_configured);
    }
}
