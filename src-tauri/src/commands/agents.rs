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
    /// 配置里命中的回环反代 base_url（空 = 未接入本工具）。
    pub hermes_proxy_base_url: String,
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
    /// 配置中是否存在指向**本工具回环反代**的 provider（providers.<name> / model_aliases
    /// / custom_providers / 顶层 model 任一命中即 true）。
    ///
    /// 与 `base_url` 的区别：`base_url` 表示「顶层 model 段当前生效的端点」，
    /// 而本字段表示「用户**已经**把反代接进来了」——两者不等价。典型场景：
    /// 用户把反代登记为 `providers.workbuddy2api`（含全部模型），但 `model.provider`
    /// 指向另一个订阅；此时顶层 `base_url` 为空，旧逻辑据此判定「未配置」，
    /// 而实际反代早已可用（本机聊天就在走它）。
    proxy_registered: bool,
    /// 命中的那个反代 base_url（用于 UI 展示，便于用户核对）。
    proxy_base_url: String,
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

/// 一个 base_url 是否指向**本工具的回环反代**。
///
/// 判据 = 回环主机 + `http` + 路径含 `/v1` + **端口与本工具当前端口一致**。
///   - 必须校验端口：本机常有多个回环 `/v1` 服务（如其它网关跑在 18080），
///     仅凭「回环 + /v1」会把它们误认成本工具（实测踩到过）。
///   - 端口取自本工具配置而非写死 8787——端口可配置，写死会漏判。
///   - 不按 provider 名字匹配：用户可任意命名，且「名字像但地址指向外网」不该算接入。
fn is_our_proxy_url(raw: &str, our_port: Option<u16>) -> bool {
    let url = raw.trim();
    if url.is_empty() {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("http://") else {
        return false; // 仅 http：回环反代不提供 https
    };
    let host_port = rest.split('/').next().unwrap_or("");
    if host_port.is_empty() {
        return false;
    }
    // 拆主机与端口。IPv6 写作 [::1]:port，故从右侧首个 ':' 且右侧全为数字时才算端口。
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            (h, p.parse::<u16>().ok())
        }
        _ => (host_port, None),
    };
    let is_loopback_host =
        host == "localhost" || host == "::1" || host == "[::1]" || host.starts_with("127.");
    if !is_loopback_host {
        return false;
    }
    // 端口比对：未写端口时按 http 默认 80 计。
    let Some(our_port) = our_port else {
        // 调用方未提供端口（理论上不会）→ 退化为「回环 + /v1 即算」，
        // 保持旧行为而不是全部判否，避免 UI 彻底失去判断力。
        return rest
            .splitn(2, '/')
            .nth(1)
            .is_some_and(|p| p.split('/').any(|seg| seg == "v1"));
    };
    if port.unwrap_or(80) != our_port {
        return false;
    }
    // 路径需含 /v1（OpenAI 兼容端点惯例），排除同端口上的其它服务。
    rest.splitn(2, '/')
        .nth(1)
        .is_some_and(|p| p.split('/').any(|seg| seg == "v1"))
}

/// 从一条 provider 条目里抽出 base_url，命中本工具反代时返回它。
fn our_proxy_url_in(entry: &Mapping, our_port: Option<u16>) -> Option<String> {
    let url = map_first_non_empty(entry, &["base_url", "url", "api"]);
    if is_our_proxy_url(&url, our_port) {
        Some(url)
    } else {
        None
    }
}

fn provider_entry_snapshot(entry: &Mapping) -> HermesEndpointSnapshot {
    HermesEndpointSnapshot {
        provider: map_string(entry, "provider"),
        model: map_first_non_empty(entry, &["default", "model", "name"]),
        base_url: map_first_non_empty(entry, &["base_url", "url", "api"]),
        api_key_configured: !map_string(entry, "api_key").is_empty()
            || !map_string(entry, "key_env").is_empty()
            || !map_string(entry, "api_key_env").is_empty(),
        proxy_registered: false,
        proxy_base_url: String::new(),
    }
}

/// 扫描配置的四个可能落点，判断用户是否**已经**把本工具反代接了进来。
///
/// 覆盖的写法（任一命中即算已接入）：
///   1. 顶层 `model:` 段自身的 base_url
///   2. `providers.<name>`（现代写法；**不要求** name 与 `model.provider` 一致）
///   3. `model_aliases.<alias>`（别名写法，本项目提供 7 条 workbuddy* 别名）
///   4. `custom_providers[]`（旧写法）
///
/// 之所以不按 provider 名字匹配：真实场景中用户会把反代登记为 `providers.workbuddy2api`
/// 而让 `model.provider` 指向另一个订阅（本机即为该形态），此时按名字找必然找不到。
fn detect_proxy_registration(
    root: &Mapping,
    current: &HermesEndpointSnapshot,
    our_port: Option<u16>,
) -> (bool, String) {
    // 1) 顶层 model 段
    if is_our_proxy_url(&current.base_url, our_port) {
        return (true, current.base_url.clone());
    }

    // 2) providers.<name>
    if let Some(Value::Mapping(providers)) = map_value(root, "providers") {
        for value in providers.values() {
            let Some(entry) = value.as_mapping() else { continue };
            if let Some(url) = our_proxy_url_in(entry, our_port) {
                return (true, url);
            }
        }
    }

    // 3) model_aliases.<alias>
    if let Some(Value::Mapping(aliases)) = map_value(root, "model_aliases") {
        for value in aliases.values() {
            let Some(entry) = value.as_mapping() else { continue };
            if let Some(url) = our_proxy_url_in(entry, our_port) {
                return (true, url);
            }
        }
    }

    // 4) custom_providers[]
    if let Some(Value::Sequence(entries)) = map_value(root, "custom_providers") {
        for value in entries {
            let Some(entry) = value.as_mapping() else { continue };
            if let Some(url) = our_proxy_url_in(entry, our_port) {
                return (true, url);
            }
        }
    }

    (false, String::new())
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

fn read_hermes_endpoint(path: &Path, our_port: Option<u16>) -> HermesEndpointSnapshot {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HermesEndpointSnapshot::default();
    };
    let Ok(Value::Mapping(root)) = serde_yaml::from_str::<Value>(&raw) else {
        return HermesEndpointSnapshot::default();
    };
    read_hermes_endpoint_from_mapping(&root, our_port)
}

/// 从已解析的顶层 mapping 提取端点快照（与 `read_hermes_endpoint` 拆分，
/// 便于单测直接构造配置而无需落盘临时文件）。
fn read_hermes_endpoint_from_mapping(root: &Mapping, our_port: Option<u16>) -> HermesEndpointSnapshot {
    let mut current = match map_value(root, "model").and_then(Value::as_mapping) {
        Some(model) => provider_entry_snapshot(model),
        None => HermesEndpointSnapshot::default(),
    };
    current = merge_provider_fallback(current, root);
    let (proxy_registered, proxy_base_url) = detect_proxy_registration(root, &current, our_port);
    current.proxy_registered = proxy_registered;
    current.proxy_base_url = proxy_base_url;
    current
}

/// Hermes 是否已接入本工具。
///
/// 判据是「用户已经把反代接进来了」而非「顶层 model 段当前指向反代」：
/// 后者在「反代挂在 providers.<name> 下、model.provider 指向别的订阅」时
/// 会误判为未配置（真实线上场景，2026-09-16 修）。回环反代地址出现在配置的
/// 四个落点中任意一个，即视为已接入。
fn hermes_is_configured(snapshot: &HermesEndpointSnapshot) -> bool {
    if snapshot.proxy_registered {
        return true;
    }
    !snapshot.base_url.is_empty() && (!snapshot.provider.is_empty() || !snapshot.model.is_empty())
}

// ---------------------------------------------------------------------------
// 只读状态与手动引导
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_detect(port: Option<u16>) -> Result<AgentStatus, String> {
    let hermes_p = resolve_hermes_config();
    let hermes_installed = hermes_p.exists();
    // 端口必须来自本工具配置：本机可能有多个回环 /v1 服务（如另一网关跑在 18080），
    // 仅凭「回环 + /v1」会把它们误认成本工具。
    let our_port = port.or_else(|| Some(crate::load_app_config().port));
    let hermes_snapshot = read_hermes_endpoint(&hermes_p, our_port);
    let hermes_configured = hermes_installed && hermes_is_configured(&hermes_snapshot);
    let hermes_proxy_url = hermes_snapshot.proxy_base_url.clone();

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
        hermes_proxy_base_url: hermes_proxy_url,
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
    let snapshot = read_hermes_endpoint(&path, Some(port));
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

    // ---- 反代挂在 providers.<name> 下、而 model.provider 指向别处（2026-09-16 修） ----
    //
    // 真实场景：用户在 Hermes 里把反代登记为 providers.workbuddy2api（含 42 个模型），
    // 但 model.provider 指向另一个订阅（如 opencode-free）。旧实现按 provider 名去
    // providers 找同名键，找不到就回退不到 base_url → 状态错误显示「未配置」。
    // 判定一个 provider 是否就是本工具，判据必须是 base_url 指向回环反代端口。

    #[test]
    fn detects_proxy_registered_under_providers_even_if_model_provider_differs() {
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: opencode-free\n  default: muse-spark-1.3-contributor-free\nproviders:\n  workbuddy2api:\n    name: workbuddy2api\n    base_url: http://127.0.0.1:8787/v1\n    model: deepseek-v4.1-flash\n    models:\n      auto: {}\n      deepseek-v4.1-flash: {}\n    key_env: HERMES_CUSTOM_WORKBUDDY2API_API_KEY\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(
            snapshot.proxy_registered,
            "providers.<name>.base_url 指向回环反代端口时必须判定为已接入"
        );
        assert_eq!(snapshot.proxy_base_url, "http://127.0.0.1:8787/v1");
        // 顶层 model.provider 指向别处不应影响「本工具已接入」的判定
        assert_eq!(snapshot.provider, "opencode-free");
    }

    #[test]
    fn detects_proxy_via_model_aliases() {
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: opencode-free\n  default: x\nmodel_aliases:\n  workbuddy:\n    model: auto\n    provider: custom\n    base_url: http://127.0.0.1:8787/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(snapshot.proxy_registered, "model_aliases 里的回环反代地址同样应被识别");
        assert_eq!(snapshot.proxy_base_url, "http://127.0.0.1:8787/v1");
    }

    #[test]
    fn proxy_detection_requires_loopback_base_url_not_just_a_name() {
        // 反向保障：仅名字里含 workbuddy 但 base_url 指向外网的 provider 不算「已接入」——
        // 否则会把仅作展示、并未真正接反代的配置误报为已配置。
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: x\n  default: y\nproviders:\n  workbuddy2api:\n    name: workbuddy2api\n    base_url: https://api.example.com/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(
            !snapshot.proxy_registered,
            "非回环 base_url 不得被判定为「已接入本工具反代」"
        );
    }

    #[test]
    fn proxy_detection_rejects_non_loopback_http_even_on_matching_port() {
        // 这条专门覆盖「回环主机校验」这一步：用 http:// 前缀（能通过 scheme 检查）
        // 且端口与本工具一致，但主机是外部域名 —— 必须仍被拒绝。
        // （前一条用例走的是 https://，在 scheme 检查处就返回了，覆盖不到主机校验。）
        for host in ["api.example.com", "192.168.1.50", "10.0.0.7", "[2001:db8::1]"] {
            let yaml = format!("providers:\n  wb:\n    base_url: http://{host}:8787/v1\n");
            let value: Value = serde_yaml::from_str(&yaml).unwrap();
            let root = value.as_mapping().unwrap();
            let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
            assert!(
                !snapshot.proxy_registered,
                "http://{host}:8787/v1 不是回环地址，不得算作已接入本工具"
            );
        }
    }

    #[test]
    fn proxy_detection_ignores_other_loopback_services_on_different_ports() {
        // 实测踩到的误报：本机另有网关跑在 18080（回环 + /v1），
        // 仅凭「回环 + /v1」会把它认成本工具的反代。
        // 判据必须带端口比对，否则「命中」的 base_url 会是别人的地址。
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: opencode-free\n  default: x\nproviders:\n  cpa:\n    base_url: http://127.0.0.1:18080/v1\n  workbuddy2api:\n    base_url: http://127.0.0.1:8787/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(snapshot.proxy_registered, "本工具端口命中时须判定已接入");
        assert_eq!(
            snapshot.proxy_base_url, "http://127.0.0.1:8787/v1",
            "必须命中本工具端口，而不是先撞上的其它回环服务（18080）"
        );
    }

    #[test]
    fn proxy_detection_reports_not_registered_when_only_other_services_present() {
        // 反向：配置里只有别的回环服务（18080），本工具端口未出现 → 不得判定已接入。
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: opencode-free\n  default: x\nproviders:\n  cpa:\n    base_url: http://127.0.0.1:18080/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(
            !snapshot.proxy_registered,
            "仅有其它回环服务时不得误报「已接入本工具」"
        );
    }

    #[test]
    fn proxy_detection_honours_configurable_port() {
        // 端口可配置：本工具跑在 19000 时，18080 与 8787 都不算命中。
        let value: Value = serde_yaml::from_str(
            "providers:\n  wb:\n    base_url: http://127.0.0.1:19000/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snap_hit = read_hermes_endpoint_from_mapping(root, Some(19000));
        assert!(snap_hit.proxy_registered);
        let snap_miss = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(!snap_miss.proxy_registered, "端口不匹配时不得命中");
    }

    #[test]
    fn proxy_detection_accepts_localhost_and_any_loopback_host_with_matching_port() {
        for url in [
            "http://localhost:8787/v1",
            "http://127.0.0.1:8787/v1",
            "http://127.0.0.55:8787/v1",
        ] {
            let yaml = format!("providers:\n  wb:\n    base_url: {url}\n");
            let value: Value = serde_yaml::from_str(&yaml).unwrap();
            let root = value.as_mapping().unwrap();
            let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
            assert!(snapshot.proxy_registered, "{url} 应被识别为已接入");
        }
    }

    #[test]
    fn configured_flag_is_true_when_proxy_registered_even_without_top_level_base_url() {
        // 这是本次线上问题的直接回归断言：顶层 model 段没有 base_url，
        // 但 providers 里有回环反代 → hermes_is_configured 必须为 true。
        let value: Value = serde_yaml::from_str(
            "model:\n  provider: opencode-free\n  default: muse-spark-1.3-contributor-free\n  key_env: HERMES_CUSTOM_WORKBUDDY2API_API_KEY\nproviders:\n  workbuddy2api:\n    base_url: http://127.0.0.1:8787/v1\n",
        )
        .unwrap();
        let root = value.as_mapping().unwrap();
        let snapshot = read_hermes_endpoint_from_mapping(root, Some(8787));
        assert!(
            hermes_is_configured(&snapshot),
            "providers 里存在本工具反代时，「已接入配置」徽章必须点亮"
        );
    }
}
