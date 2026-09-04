//! Tauri commands：对标 EasyCLIProxyAPI 核心能力
//! 1. 反代生命周期 (start/stop/restart/health/test_chat)
//! 2. 多账号体系与登录流程 (auth_begin/auth_poll/accounts_list/accounts_switch/accounts_delete/accounts_refresh)
//! 3. 账户真实积分与资源包查询 (usage_query)
//! 4. Agent 一键检测与配置写入 (agent_detect/agent_configure/agent_remove)

use crate::ProxyHandle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Manager, State};

// ---------------------------------------------------------------------------
// 基础数据模型
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LoginState {
    pub state: String,
    pub auth_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenPollResult {
    pub code: i64,
    pub msg: String,
    pub data: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountItem {
    pub uid: String,
    pub nickname: String,
    pub phone_number: Option<String>,
    pub enterprise_name: Option<String>,
    pub token_expires_at: i64,
    pub token_expired: bool,
    pub is_active: bool,
    pub last_updated: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountsState {
    pub active_uid: String,
    pub accounts: HashMap<String, serde_json::Value>, // uid -> full session object
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentStatus {
    pub hermes_installed: bool,
    pub hermes_configured: bool,
    pub hermes_config_path: String,
    pub zcode_installed: bool,
    pub zcode_configured: bool,
    pub zcode_cli_path: String,
    pub zcode_v2_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TestChatResult {
    pub success: bool,
    pub model: String,
    pub response: String,
    pub latency_ms: u64,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 辅助路径函数
// ---------------------------------------------------------------------------

fn local_app_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| "C:\\Users\\<username>\\AppData\\Local".into());
    let p = Path::new(&base).join("codebuddy2openai");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn accounts_db_path() -> PathBuf {
    local_app_dir().join("accounts.json")
}

fn desktop_auth_info_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| "C:\\Users\\<username>\\AppData\\Local".into());
    Path::new(&base).join("CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info")
}

fn hermes_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .unwrap_or_else(|_| "C:\\Users\\<username>".into());
    let user_p = Path::new(&home).join(".hermes\\config.yaml");
    if user_p.exists() {
        return user_p;
    }
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| "C:\\Users\\<username>\\AppData\\Local".into());
    Path::new(&base).join("hermes\\config.yaml")
}

fn zcode_cli_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .unwrap_or_else(|_| "C:\\Users\\<username>".into());
    Path::new(&home).join(".zcode\\cli\\config.json")
}

fn zcode_v2_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .unwrap_or_else(|_| "C:\\Users\\<username>".into());
    Path::new(&home).join(".zcode\\v2\\config.json")
}

// ---------------------------------------------------------------------------
// 多账号存取与持久化逻辑
// ---------------------------------------------------------------------------

fn load_accounts_state() -> AccountsState {
    let p = accounts_db_path();
    if p.exists() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(st) = serde_json::from_str::<AccountsState>(&raw) {
                return st;
            }
        }
    }

    // 若 accounts.json 尚不存在，尝试从 workbuddy-desktop.info 初始化
    let mut state = AccountsState {
        active_uid: String::new(),
        accounts: HashMap::new(),
    };

    let desktop_info = desktop_auth_info_path();
    if desktop_info.exists() {
        if let Ok(raw) = std::fs::read_to_string(&desktop_info) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(uid) = val.pointer("/account/uid").and_then(|v| v.as_str()) {
                    let uid_str = uid.to_string();
                    state.active_uid = uid_str.clone();
                    state.accounts.insert(uid_str, val);
                    save_accounts_state(&state).ok();
                }
            }
        }
    }

    state
}

fn save_accounts_state(st: &AccountsState) -> Result<(), String> {
    let p = accounts_db_path();
    let raw = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| e.to_string())?;

    // 如果有活跃账号，同步写回到 workbuddy-desktop.info 保证外部 converter 无缝可用
    if !st.active_uid.is_empty() {
        if let Some(active_val) = st.accounts.get(&st.active_uid) {
            let target_path = desktop_auth_info_path();
            if let Some(parent) = target_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(out) = serde_json::to_string_pretty(active_val) {
                let _ = std::fs::write(target_path, out);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 登录与授权 (OAuth)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_begin(platform: String) -> Result<LoginState, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/state?platform={platform}");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-No-Authorization", "true")
        .header("X-No-User-Id", "true")
        .header("X-No-Enterprise-Id", "true")
        .header("X-No-Department-Info", "true")
        .body("")
        .send()
        .await
        .map_err(|e| format!("auth/state 请求失败: {e}"))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = body
        .get("data")
        .ok_or_else(|| format!("auth/state 响应异常: {body}"))?;
    Ok(LoginState {
        state: data
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        auth_url: data
            .get("authUrl")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[tauri::command]
pub async fn auth_poll(state: String) -> Result<TokenPollResult, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/token?state={state}");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-No-Authorization", "true")
        .header("X-No-User-Id", "true")
        .header("X-No-Enterprise-Id", "true")
        .header("X-No-Department-Info", "true")
        .send()
        .await
        .map_err(|e| format!("auth/token 轮询失败: {e}"))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    
    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let msg = body.get("msg").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let data = body.get("data").cloned().filter(|v| !v.is_null());

    // 如果拿到完整 Token 数据，自动保存入多账号库并设为活跃账号
    if let Some(ref d) = data {
        if let Some(auth_val) = d.get("auth").or(Some(d)) {
            let token = auth_val.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default();
            if !token.is_empty() {
                // 请求 account 接口以获取详细资料 (nickname, uid 等)
                let acct_url = "https://copilot.tencent.com/v2/plugin/account";
                let acct_resp = client
                    .get(acct_url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "codebuddy2openai/2.0")
                    .send()
                    .await;

                if let Ok(acct_r) = acct_resp {
                    if let Ok(acct_json) = acct_r.json::<serde_json::Value>().await {
                        if let Some(acct_data) = acct_json.get("data") {
                            let uid = acct_data.get("uid").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                            if !uid.is_empty() {
                                let full_session = serde_json::json!({
                                    "account": acct_data,
                                    "auth": auth_val
                                });
                                let mut st = load_accounts_state();
                                st.active_uid = uid.clone();
                                st.accounts.insert(uid, full_session);
                                let _ = save_accounts_state(&st);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(TokenPollResult { code, msg, data })
}

// ---------------------------------------------------------------------------
// 多账号管理 (Accounts Management)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn accounts_list() -> Result<Vec<AccountItem>, String> {
    let st = load_accounts_state();
    let mut list = Vec::new();
    let now_ms = chrono::Utc::now().timestamp_millis();

    for (uid, val) in &st.accounts {
        let nickname = val.pointer("/account/nickname").and_then(|v| v.as_str()).unwrap_or("—").to_string();
        let phone = val.pointer("/account/phoneNumber").and_then(|v| v.as_str()).map(|s| s.to_string());
        let enterprise = val.pointer("/account/enterpriseName").and_then(|v| v.as_str()).map(|s| s.to_string());
        let exp = val.pointer("/auth/expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let expired = now_ms >= (exp - 60_000);
        let is_active = uid == &st.active_uid;

        list.push(AccountItem {
            uid: uid.clone(),
            nickname,
            phone_number: phone,
            enterprise_name: enterprise,
            token_expires_at: exp,
            token_expired: expired,
            is_active,
            last_updated: now_ms,
        });
    }

    // 活跃账号排在最前面
    list.sort_by(|a, b| b.is_active.cmp(&a.is_active));
    Ok(list)
}

#[tauri::command]
pub fn accounts_switch(uid: String) -> Result<String, String> {
    let mut st = load_accounts_state();
    if !st.accounts.contains_key(&uid) {
        return Err(format!("未找到账号: {uid}"));
    }
    st.active_uid = uid.clone();
    save_accounts_state(&st)?;
    Ok(format!("已切换活跃账号至 {uid}"))
}

#[tauri::command]
pub fn accounts_delete(uid: String) -> Result<String, String> {
    let mut st = load_accounts_state();
    st.accounts.remove(&uid);
    if st.active_uid == uid {
        st.active_uid = st.accounts.keys().next().cloned().unwrap_or_default();
    }
    save_accounts_state(&st)?;
    Ok(format!("已删除账号 {uid}"))
}

#[tauri::command]
pub async fn accounts_refresh_token(uid: Option<String>) -> Result<String, String> {
    let mut st = load_accounts_state();
    let target_uid = uid.unwrap_or_else(|| st.active_uid.clone());
    let session = st.accounts.get_mut(&target_uid).ok_or_else(|| format!("未找到指定账号: {target_uid}"))?;

    let auth = session.get("auth").ok_or("缺少 auth 节点")?;
    let refresh_token = auth.get("refreshToken").and_then(|v| v.as_str()).ok_or("缺少 refreshToken")?;
    let access_token = auth.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default();
    let acct = session.get("account").ok_or("缺少 account 节点")?;
    let uid_str = acct.get("uid").and_then(|v| v.as_str()).unwrap_or_default();

    let client = reqwest::Client::new();
    let resp = client
        .post("https://copilot.tencent.com/v2/plugin/auth/token/refresh")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("X-Refresh-Token", refresh_token)
        .header("X-Auth-Refresh-Source", "plugin")
        .header("X-User-Id", uid_str)
        .header("User-Agent", "codebuddy2openai/2.0")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("刷新网络错误: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("刷新失败: {}", body.get("msg").unwrap_or(&body)));
    }

    if let Some(new_data) = body.get("data") {
        if let Some(auth_mut) = session.get_mut("auth") {
            if let Some(obj) = auth_mut.as_object_mut() {
                for (k, v) in new_data.as_object().unwrap_or(&serde_json::Map::new()) {
                    obj.insert(k.clone(), v.clone());
                }
                obj.insert("lastRefreshTime".into(), serde_json::json!(chrono::Utc::now().timestamp_millis()));
            }
        }
    }

    save_accounts_state(&st)?;
    Ok("Token 刷新成功".into())
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

    let client = reqwest::Client::new();
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

// ---------------------------------------------------------------------------
// Agent 一键集成与配置 (Hermes & ZCode)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_detect() -> Result<AgentStatus, String> {
    // Hermes 真实配置文件在 %LOCALAPPDATA%\hermes\config.yaml
    let mut hermes_p = PathBuf::from("C:\\Users\\<username>\\AppData\\Local\\hermes\\config.yaml");
    if !hermes_p.exists() {
        let alt = PathBuf::from("C:\\Users\\<username>\\.hermes\\config.yaml");
        if alt.exists() {
            hermes_p = alt;
        }
    }
    let hermes_installed = hermes_p.exists();
    let mut hermes_configured = false;
    if hermes_installed {
        if let Ok(raw) = std::fs::read_to_string(&hermes_p) {
            hermes_configured = raw.contains("WorkBuddy (127.0.0.1:8787)") || raw.contains("8787");
        }
    }

    let zcode_c = zcode_cli_path();
    let zcode_v = zcode_v2_path();
    let zcode_installed = zcode_c.exists() || zcode_v.exists();
    let mut zcode_configured = false;
    if zcode_c.exists() {
        if let Ok(raw) = std::fs::read_to_string(&zcode_c) {
            zcode_configured = raw.contains("workbuddy") && raw.contains("8787");
        }
    }

    Ok(AgentStatus {
        hermes_installed,
        hermes_configured,
        hermes_config_path: hermes_p.to_string_lossy().to_string(),
        zcode_installed,
        zcode_configured,
        zcode_cli_path: zcode_c.to_string_lossy().to_string(),
        zcode_v2_path: zcode_v.to_string_lossy().to_string(),
    })
}

#[tauri::command]
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
    let mut p = PathBuf::from("C:\\Users\\<username>\\AppData\\Local\\hermes\\config.yaml");
    if !p.exists() {
        let alt = PathBuf::from("C:\\Users\\<username>\\.hermes\\config.yaml");
        if alt.exists() {
            p = alt;
        }
    }
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
    let mut p = PathBuf::from("C:\\Users\\<username>\\AppData\\Local\\hermes\\config.yaml");
    if !p.exists() {
        let alt = PathBuf::from("C:\\Users\\<username>\\.hermes\\config.yaml");
        if alt.exists() {
            p = alt;
        }
    }
    if !p.exists() { return Ok("文件不存在".into()); }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut val: serde_yaml::Value = serde_yaml::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(map) = val.as_mapping_mut() {
        if let Some(seq) = map.get_mut(&serde_yaml::Value::String("custom_providers".into())).and_then(|v| v.as_sequence_mut()) {
            seq.retain(|item| {
                let s = serde_yaml::to_string(item).unwrap_or_default();
                !s.contains("WorkBuddy") && !s.contains("codebuddy2openai")
            });
        }
    }
    let out = serde_yaml::to_string(&val).map_err(|e| e.to_string())?;
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok("已从 Hermes 移除 WorkBuddy 配置".into())
}

fn configure_zcode(port: u16) -> Result<String, String> {
    let models_list = vec![
        "auto", "hy4-preview", "hy3", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1",
        "glm-5v-turbo", "kimi-k3", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
        "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3"
    ];
    let mut models_obj = serde_json::Map::new();
    for m in models_list {
        let ctx = if m.contains("glm") || m == "auto" { 1048576 } else { 200000 };
        models_obj.insert(m.into(), serde_json::json!({
            "name": m,
            "limit": { "context": ctx }
        }));
    }

    let wb_provider = serde_json::json!({
        "apiFormat": "openai-compatible",
        "defaultKind": "openai",
        "enabled": true,
        "kind": "openai",
        "models": models_obj,
        "name": "WorkBuddy (codebuddy2openai)",
        "npm": "@ai-sdk/openai-compatible",
        "options": {
            "apiKey": "local",
            "baseURL": format!("http://127.0.0.1:{port}/v1")
        },
        "source": "custom"
    });

    for path in [zcode_cli_path(), zcode_v2_path()] {
        if path.exists() {
            let bak = path.with_extension("json.bak-codebuddy-gui");
            let _ = std::fs::copy(&path, bak);

            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = cfg.as_object_mut() {
                    let provs = obj.entry("provider").or_insert(serde_json::json!({}));
                    if let Some(p_obj) = provs.as_object_mut() {
                        p_obj.insert("workbuddy".into(), wb_provider.clone());
                    }
                }
                let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
                let _ = std::fs::write(&path, out);
            }
        }
    }

    Ok("ZCode 配置一键写入成功！".into())
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
    Ok("已从 ZCode 移除 WorkBuddy 配置".into())
}

// ---------------------------------------------------------------------------
// 反代控制与测试
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn proxy_start(
    handle: State<'_, ProxyHandle>,
    app: tauri::AppHandle,
    port: u16,
    desensitize: Option<bool>,
) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(format!("already-running(port {port})"));
        }
    }

    let python = std::path::PathBuf::from(
        "C:/Users/<username>/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
    );
    let resource_script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("converter.py");
    let script = if resource_script.exists() {
        resource_script
    } else {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default();
        let direct_script = exe_dir.join("../../../converter.py");
        if direct_script.exists() {
            direct_script
        } else {
            let desktop_script = PathBuf::from("C:/Users/<username>/Desktop/codebuddy2openai/converter.py");
            if desktop_script.exists() {
                desktop_script
            } else {
                std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join("converter.py")
            }
        }
    };

    let mut cmd = Command::new(python);
    cmd.arg(script).arg("--port").arg(port.to_string());
    if desensitize.unwrap_or(true) {
        cmd.arg("--desensitize");
    }

    // Windows 平台静默模式设置：如果不开启 debug console，则彻底隐藏黑框
    let show_console = if let Some(cfg_state) = app.try_state::<crate::AppConfigState>() {
        cfg_state.0.lock().map(|c| c.show_debug_console).unwrap_or(false)
    } else {
        false
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if !show_console {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }

    let child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动反代失败: {e}"))?;
    *guard = Some(child);
    Ok(format!("started(port {port})"))
}

#[tauri::command]
pub fn proxy_open_console(port: u16, desensitize: Option<bool>) -> Result<String, String> {
    let python = "C:\\Users\\<username>\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";
    let script = "C:\\Users\\<username>\\Desktop\\codebuddy2openai\\converter.py";
    let mut args = format!("\"{python}\" \"{script}\" --port {port}");
    if desensitize.unwrap_or(true) {
        args.push_str(" --desensitize");
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd.exe")
            .args(["/c", "start", "WorkBuddy to OpenAI Console", "cmd.exe", "/k", &args])
            .spawn()
            .map_err(|e| format!("打开控制台失败: {e}"))?;
    }

    Ok("控制台窗口已打开".into())
}

#[tauri::command]
pub fn proxy_stop(handle: State<'_, ProxyHandle>) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.kill().is_ok() {
            *guard = None;
            return Ok("stopped".into());
        }
    }
    Ok("not-running".into())
}

#[tauri::command]
pub async fn proxy_restart(
    handle: State<'_, ProxyHandle>,
    app: tauri::AppHandle,
    port: u16,
    desensitize: Option<bool>,
) -> Result<String, String> {
    let _ = proxy_stop(handle.clone());
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    proxy_start(handle, app, port, desensitize)
}

#[tauri::command]
pub async fn proxy_health(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn proxy_test_chat(port: u16, model: Option<String>) -> Result<TestChatResult, String> {
    let target_model = model.unwrap_or_else(|| "glm-5.3-flash".into());
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let start = std::time::Instant::now();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "model": target_model,
        "messages": [
            {"role": "user", "content": "Ping: 请仅回答 PONG"}
        ],
        "max_tokens": 100,
        "chat_template_kwargs": {"enable_thinking": false}
    });

    let resp = match client.post(&url).json(&payload).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(TestChatResult {
                success: false,
                model: target_model,
                response: String::new(),
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some(e.to_string()),
            });
        }
    };

    let latency_ms = start.elapsed().as_millis() as u64;
    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(TestChatResult {
                success: false,
                model: target_model,
                response: String::new(),
                latency_ms,
                error: Some(e.to_string()),
            });
        }
    };

    let content = body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(TestChatResult {
        success: !content.is_empty(),
        model: target_model,
        response: content,
        latency_ms,
        error: None,
    })
}
