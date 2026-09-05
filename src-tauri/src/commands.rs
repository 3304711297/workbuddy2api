//! Tauri commands：对标 EasyCLIProxyAPI 核心能力
//! 1. 反代生命周期 (start/stop/restart/health/test_chat)
//! 2. 多账号体系与登录流程 (auth_begin/auth_poll/accounts_list/accounts_switch/accounts_delete/accounts_refresh)
//! 3. 账户真实积分与资源包查询 (usage_query)
//! 4. Agent 一键检测与配置写入 (agent_detect/agent_configure/agent_remove)

use crate::ProxyHandle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{Manager, State};

/// 对 127.0.0.1:<port> 做带超时的 TCP 连通性探测（800ms 上限，避免 UI 卡顿）
fn loopback_port_open(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

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
    /// provider.workbuddy 仍写在 ZCode 的 JSON 配置里（ZCode Desktop 不读取，仅作残留提示）
    pub zcode_provider_registered: bool,
    /// 对 c2o 服务端口的真实可达性探测（这才是 ZCode 里能不能拉到模型的决定条件）
    pub zcode_service_online: bool,
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
// 路径与环境变量解析工具（禁止在业务代码里硬编码开发机绝对路径）
// 约定：环境变量覆盖 → 通用派生路径 → 原路径作最终回退（保证既有环境行为不变）
// ---------------------------------------------------------------------------

/// 读取环境变量，未设置或为空时返回 None
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// %LOCALAPPDATA%（优先环境变量；缺省时从 USERPROFILE 派生；最终回退系统已知目录，不再硬编码用户目录）
pub(crate) fn local_appdata() -> PathBuf {
    if let Some(v) = env_nonempty("LOCALAPPDATA") {
        return PathBuf::from(v);
    }
    if let Some(home) = env_nonempty("USERPROFILE") {
        return Path::new(&home).join("AppData\\Local");
    }
    // 通用回退：读取系统已知目录 FOLDERID_LocalAppData；再失败则退到临时目录保证有可写路径
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir)
}

/// 用户主目录（优先 USERPROFILE 环境变量 → 系统已知主目录 → 当前工作目录，不再硬编码用户目录）
fn user_home() -> PathBuf {
    env_nonempty("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

pub(crate) fn local_app_dir() -> PathBuf {
    let p = local_appdata().join("codebuddy2openai");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn accounts_db_path() -> PathBuf {
    local_app_dir().join("accounts.json")
}

fn desktop_auth_info_path() -> PathBuf {
    local_appdata().join("CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info")
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

/// Python 解释器定位：`C2O_PYTHON` 环境变量优先 → 用户主目录下 .workbuddy 内置解释器（按 USERPROFILE 派生，保留现机行为）→ PATH 中的 python
fn resolve_python_interpreter() -> PathBuf {
    if let Some(p) = env_nonempty("C2O_PYTHON").map(PathBuf::from).filter(|p| p.exists()) {
        return p;
    }
    // 内置解释器路径从用户主目录派生，等价于原开发机绝对路径但不再硬编码用户名
    let bundled = user_home().join(".workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe");
    if bundled.exists() {
        return bundled;
    }
    PathBuf::from("python")
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
}

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

#[tauri::command]
pub async fn models_fetch_all() -> Result<Vec<ModelMetaItem>, String> {
    let st = load_accounts_state();
    let session = st.accounts.get(&st.active_uid).ok_or_else(|| "当前未登录任何账号".to_string())?;
    let auth = session.get("auth").ok_or("auth 数据不存在")?;
    let account = session.get("account").ok_or("account 数据不存在")?;
    let token = auth.get("accessToken").and_then(|v| v.as_str()).ok_or("缺少 accessToken")?;
    let acct_uid = account.get("uid").and_then(|v| v.as_str()).unwrap_or_default();

    let client = reqwest::Client::new();
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
        let can_disable_thinking = reasoning_obj.and_then(|r| r.get("canDisableThinking")).and_then(|v| v.as_bool())
            .unwrap_or_else(|| !m.get("onlyReasoning").and_then(|v| v.as_bool()).unwrap_or(false));
        
        let mut supported_efforts = Vec::new();
        if let Some(arr) = reasoning_obj.and_then(|r| r.get("supportedEfforts")).and_then(|v| v.as_array()) {
            for ef in arr {
                if let Some(s) = ef.as_str() {
                    supported_efforts.push(s.to_string());
                }
            }
        }
        if supported_efforts.is_empty() {
            if let Some(ef) = reasoning_obj.and_then(|r| r.get("effort")).and_then(|v| v.as_str()) {
                supported_efforts.push(ef.to_string());
            }
        }
        let default_effort = reasoning_obj.and_then(|r| r.get("defaultEffort"))
            .or_else(|| reasoning_obj.and_then(|r| r.get("effort")))
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();

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

// ---------------------------------------------------------------------------
// 反代控制与测试
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn proxy_start(
    handle: State<'_, ProxyHandle>,
    app: tauri::AppHandle,
    port: Option<u16>,
    desensitize: Option<bool>,
) -> Result<String, String> {
    // 参数缺省（None）时回退到设置值：每次现读磁盘 settings.json，保证与 UI 最新设置一致；
    // 显式传值时行为不变
    let cfg = crate::load_app_config();
    let port = port.unwrap_or(cfg.port);
    let desensitize = desensitize.unwrap_or(cfg.desensitize);

    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(format!("already-running(port {port})"));
        }
    }

    let python = resolve_python_interpreter();

    // converter.py 定位：`C2O_CONVERTER` 环境变量优先 → 资源目录 → 可执行文件目录逐级向上 → 当前工作目录兜底
    let script = match env_nonempty("C2O_CONVERTER")
        .map(PathBuf::from)
        .filter(|p| p.exists())
    {
        Some(p) => p,
        None => {
            let resource_script = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("converter.py");
            if resource_script.exists() {
                resource_script
            } else {
                // 通用回退：沿可执行文件所在目录逐级向上查找 converter.py
                // （覆盖 target/debug 等开发布局与便携安装布局，不再硬编码开发机路径）
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_default();
                let mut candidates: Vec<PathBuf> = exe_dir
                    .ancestors()
                    .take(6)
                    .map(|dir| dir.join("converter.py"))
                    .collect();
                // 最终回退：当前工作目录下的 converter.py（不存在则由启动报错暴露，保持原语义）
                if let Ok(cwd) = std::env::current_dir() {
                    candidates.push(cwd.join("converter.py"));
                }
                candidates
                    .into_iter()
                    .find(|p| p.exists())
                    .unwrap_or_else(|| {
                        std::env::current_dir()
                            .map(|d| d.join("converter.py"))
                            .unwrap_or_else(|_| PathBuf::from("converter.py"))
                    })
            }
        }
    };

    let mut cmd = Command::new(python);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.arg(script).arg("--port").arg(port.to_string());
    if desensitize {
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

    // 重定向标准输出与错误输出到本地日志文件，供控制台实时查看
    let log_path = log_file_path();
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法创建日志文件: {e}"))?;

    let log_err = log_file.try_clone().map_err(|e| e.to_string())?;

    let child = cmd
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("启动反代失败: {e}"))?;
    *guard = Some(child);

    // 广播服务状态变更事件
    use tauri::Emitter;
    let _ = app.emit("proxy-status-changed", serde_json::json!({ "running": true, "port": port }));

    Ok(format!("started(port {port})"))
}

fn log_file_path() -> PathBuf {
    let dir = local_app_dir();
    dir.join("proxy_stdout.log")
}

#[tauri::command]
pub fn proxy_get_logs() -> Result<String, String> {
    let p = log_file_path();
    if p.exists() {
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        let raw = String::from_utf8_lossy(&bytes);
        // 如果日志太大，仅截取最后 80KB 保持平滑
        if raw.len() > 80_000 {
            // 日志含中文/emoji 时，字节偏移可能落在多字节字符中间，
            // 直接切片会 panic "byte index is not a char boundary"。
            // 这里把 start 向后调整到最近的字符边界。
            let mut start = raw.len() - 80_000;
            while start < raw.len() && !raw.is_char_boundary(start) {
                start += 1;
            }
            return Ok(raw[start..].to_string());
        }
        return Ok(raw.to_string());
    }
    Ok("暂无日志输出，请启动反代服务".into())
}

#[tauri::command]
pub fn proxy_clear_logs() -> Result<String, String> {
    let p = log_file_path();
    if p.exists() {
        std::fs::write(&p, "").map_err(|e| e.to_string())?;
    }
    Ok("日志已清空".into())
}

#[tauri::command]
pub fn proxy_stop(handle: State<'_, ProxyHandle>, app: tauri::AppHandle) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    let mut stopped = false;
    if let Some(child) = guard.as_mut() {
        if child.kill().is_ok() {
            *guard = None;
            stopped = true;
        }
    }

    // 兜底清理可能残留的 converter.py 进程
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*converter.py*' -and $_.Name -eq 'python.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
            ])
            .output();
    }

    use tauri::Emitter;
    let _ = app.emit("proxy-status-changed", serde_json::json!({ "running": false }));

    if stopped {
        Ok("stopped".into())
    } else {
        Ok("not-running".into())
    }
}

#[tauri::command]
pub async fn proxy_restart(
    handle: State<'_, ProxyHandle>,
    app: tauri::AppHandle,
    port: Option<u16>,
    desensitize: Option<bool>,
) -> Result<String, String> {
    let _ = proxy_stop(handle.clone(), app.clone());
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
