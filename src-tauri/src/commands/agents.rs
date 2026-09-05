//! Agent 一键检测与配置写入 (Hermes & ZCode)

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use super::shared::{env_nonempty, local_appdata, user_home};

/// 对 127.0.0.1:<port> 做带超时的 TCP 连通性探测（800ms 上限，避免 UI 卡顿）
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
    /// provider.workbuddy 仍写在 ZCode 的 JSON 配置里（ZCode Desktop 不读取，仅作残留提示）
    pub zcode_provider_registered: bool,
    /// 对 c2o 服务端口的真实可达性探测（这才是 ZCode 里能不能拉到模型的决定条件）
    pub zcode_service_online: bool,
    pub zcode_cli_path: String,
    pub zcode_v2_path: String,
}

/// Hermes 配置文件候选列表：
/// 1. `HERMES_HOME` 环境变量（hermes 本身使用的约定）
/// 2. %LOCALAPPDATA%\hermes\config.yaml（原默认）
/// 3. %USERPROFILE%\.hermes\config.yaml（原备选）
fn hermes_config_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(home) = env_nonempty("HERMES_HOME") {
        list.push(PathBuf::from(home).join("config.yaml"));
    }
    list.push(local_appdata().join("hermes\\config.yaml"));
    list.push(user_home().join(".hermes\\config.yaml"));
    list
}

/// 解析当前实际生效的 Hermes 配置文件路径
fn resolve_hermes_config() -> PathBuf {
    let candidates = hermes_config_candidates();
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        // 全部不存在时保持原行为：回退到 %LOCALAPPDATA% 默认路径
        .unwrap_or_else(|| local_appdata().join("hermes\\config.yaml"))
}

fn zcode_cli_path() -> PathBuf {
    user_home().join(".zcode\\cli\\config.json")
}

fn zcode_v2_path() -> PathBuf {
    user_home().join(".zcode\\v2\\config.json")
}

// ---------------------------------------------------------------------------
// Agent 一键集成与配置 (Hermes & ZCode)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_detect(port: Option<u16>) -> Result<AgentStatus, String> {
    // Hermes 真实配置文件：HERMES_HOME 环境变量优先 → %LOCALAPPDATA%\hermes → %USERPROFILE%\.hermes
    let hermes_p = resolve_hermes_config();
    let hermes_installed = hermes_p.exists();
    let mut hermes_configured = false;
    if hermes_installed {
        if let Ok(raw) = std::fs::read_to_string(&hermes_p) {
            hermes_configured = raw.contains("WorkBuddy (127.0.0.1:");
        }
    }

    let zcode_c = zcode_cli_path();
    let zcode_v = zcode_v2_path();
    let zcode_installed = zcode_c.exists() || zcode_v.exists();
    // provider.workbuddy 是否仍写在 JSON 配置里（ZCode Desktop 不读这份文件，仅作残留提示）
    let mut zcode_provider_registered = false;
    if zcode_c.exists() {
        if let Ok(raw) = std::fs::read_to_string(&zcode_c) {
            zcode_provider_registered = raw.contains("workbuddy") && raw.contains("8787");
        }
    }
    // 关键状态：c2o 服务端口真实可达性（决定 ZCode 里能否拉到模型）
    let zcode_service_online = loopback_port_open(port.unwrap_or(8787));

    Ok(AgentStatus {
        hermes_installed,
        hermes_configured,
        hermes_config_path: hermes_p.to_string_lossy().to_string(),
        zcode_installed,
        zcode_provider_registered,
        zcode_service_online,
        zcode_cli_path: zcode_c.to_string_lossy().to_string(),
        zcode_v2_path: zcode_v.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_configure(agent_type: String, port: u16) -> Result<String, String> {
    match agent_type.as_str() {
        "hermes" => configure_hermes(port),
        "zcode" => configure_zcode(port),
        _ => Err(format!("不支持的 agent 类型: {agent_type}")),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_remove(agent_type: String) -> Result<String, String> {
    match agent_type.as_str() {
        "hermes" => remove_hermes(),
        "zcode" => remove_zcode(),
        _ => Err(format!("不支持的 agent 类型: {agent_type}")),
    }
}

fn configure_hermes(port: u16) -> Result<String, String> {
    let p = resolve_hermes_config();
    if !p.exists() {
        return Err(format!("Hermes 配置文件未找到: {}", p.display()));
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut val: serde_yaml::Value = serde_yaml::from_str(&raw).map_err(|e| format!("解析 YAML 失败: {e}"))?;

    // 备份
    let bak = p.with_extension("yaml.bak-codebuddy-gui");
    let _ = std::fs::copy(&p, bak);

    // 1. 注入 custom_providers
    let provider_entry = serde_yaml::from_str::<serde_yaml::Value>(&format!(r#"
name: "WorkBuddy (127.0.0.1:{port})"
base_url: "http://127.0.0.1:{port}/v1"
api_key: "local"
model: "auto"
models:
  auto: {{}}
  hy4-preview: {{}}
  hy3: {{}}
  glm-5.3: {{}}
  glm-5.3-flash: {{}}
  glm-5.2: {{}}
  glm-5.1: {{}}
  glm-5v-turbo: {{}}
  kimi-k3: {{}}
  kimi-k2.7: {{}}
  kimi-k2.6: {{}}
  kimi-k2.5: {{}}
  deepseek-v4-pro: {{}}
  deepseek-v4-flash: {{}}
  minimax-m3: {{}}
models_discovered: true
"#)).map_err(|e| e.to_string())?;

    if let Some(map) = val.as_mapping_mut() {
        let providers_key = serde_yaml::Value::String("custom_providers".into());
        let list = map.entry(providers_key).or_insert(serde_yaml::Value::Sequence(vec![]));
        if let Some(seq) = list.as_sequence_mut() {
            // 移除旧条目
            seq.retain(|item| {
                let s = serde_yaml::to_string(item).unwrap_or_default();
                !s.contains("WorkBuddy") && !s.contains("codebuddy2openai")
            });
            seq.push(provider_entry);
        }

        // 2. 注入 model_aliases
        let aliases_key = serde_yaml::Value::String("model_aliases".into());
        let aliases_map = map.entry(aliases_key).or_insert(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
        if let Some(am) = aliases_map.as_mapping_mut() {
            let aliases_yaml = serde_yaml::from_str::<serde_yaml::Mapping>(&format!(r#"
workbuddy:
  model: "auto"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-glm:
  model: "glm-5.2"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-glm53:
  model: "glm-5.3-flash"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-kimi:
  model: "kimi-k2.7"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-kimi3:
  model: "kimi-k3"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-deepseek:
  model: "deepseek-v4-pro"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
workbuddy-hy4:
  model: "hy4-preview"
  provider: "custom"
  base_url: "http://127.0.0.1:{port}/v1"
"#)).map_err(|e| e.to_string())?;
            for (k, v) in aliases_yaml {
                am.insert(k, v);
            }
        }
    }

    let out = serde_yaml::to_string(&val).map_err(|e| e.to_string())?;
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok("Hermes Agent 配置一键写入成功！".into())
}

fn remove_hermes() -> Result<String, String> {
    let p = resolve_hermes_config();
    if !p.exists() { return Ok("文件不存在".into()); }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut val: serde_yaml::Value = serde_yaml::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(map) = val.as_mapping_mut() {
        // 1. 移除 providers
        if let Some(seq) = map.get_mut(&serde_yaml::Value::String("custom_providers".into())).and_then(|v| v.as_sequence_mut()) {
            seq.retain(|item| {
                let s = serde_yaml::to_string(item).unwrap_or_default();
                !s.contains("WorkBuddy") && !s.contains("codebuddy2openai")
            });
        }
        // 2. 移除 model_aliases
        if let Some(am) = map.get_mut(&serde_yaml::Value::String("model_aliases".into())).and_then(|v| v.as_mapping_mut()) {
            am.retain(|k, v| {
                let ks = k.as_str().unwrap_or_default();
                let vs = serde_yaml::to_string(v).unwrap_or_default();
                !ks.contains("workbuddy") && !vs.contains("8787")
            });
        }
    }
    let out = serde_yaml::to_string(&val).map_err(|e| e.to_string())?;
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok("已从 Hermes 移除 WorkBuddy 配置".into())
}

fn configure_zcode(port: u16) -> Result<String, String> {
    // ZCode Desktop 的自定义供应商列表存放在其内部压缩数据库里，只认界面内添加，
    // 直接写 JSON 配置文件不会被读取（实测确认）。因此这里不再写文件，
    // 而是返回引导信息由前端复制到剪贴板，引导用户在 Desktop 界面内添加。
    let models_list = [
        "auto", "hy4-preview", "hy3", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1",
        "glm-5v-turbo", "kimi-k3", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
        "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3",
    ];
    let payload = serde_json::json!({
        "mode": "manual-guide",
        "base_url": format!("http://127.0.0.1:{port}/v1"),
        "api_format": "Chat Completions (/chat/completions)",
        "api_key": "local",
        "models": models_list,
        "steps": [
            "1. 打开 ZCode Desktop → 模型设置 → 添加供应商",
            "2. Base URL / API Key 粘贴下方对应值，API 格式选 Chat Completions",
            "3. 在模型列表里逐个添加上方模型名（至少加一个，推荐 glm-5.3-flash）",
            "4. 保存后确认本控制台服务已启动（端口在线），即可在聊天中选择 WorkBuddy 模型"
        ],
        "note": "ZCode Desktop 只认界面内添加的供应商；此前写入配置文件的 workbuddy 残留可用『清理文件残留』按钮移除"
    });
    Ok(serde_json::to_string(&payload).map_err(|e| e.to_string())?)
}

fn remove_zcode() -> Result<String, String> {
    for path in [zcode_cli_path(), zcode_v2_path()] {
        if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = cfg.as_object_mut() {
                    if let Some(provs) = obj.get_mut("provider").and_then(|v| v.as_object_mut()) {
                        provs.remove("workbuddy");
                    }
                }
                let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
                let _ = std::fs::write(&path, out);
            }
        }
    }
    Ok("已清理配置文件中的 workbuddy 残留。注意：ZCode Desktop 模型设置里手动添加的 WorkBuddy 条目存储在其内部数据库，需在界面中手动删除".into())
}
