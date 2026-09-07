//! 跨域共享工具：路径与环境变量解析、多账号状态持久化。
//! 供 auth/billing/agents/proxy 等子模块复用；对兄弟子模块以 pub(super) 暴露，不对 crate 其他部分泄露。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 路径与环境变量解析工具（禁止在业务代码里硬编码开发机绝对路径）
// 约定：环境变量覆盖 → 通用派生路径 → 原路径作最终回退（保证既有环境行为不变）
// ---------------------------------------------------------------------------

/// 读取环境变量，未设置或为空时返回 None
pub(super) fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------
// 统一 HTTP 客户端构造：本机环回直连优先
// ---------------------------------------------------------------------------

/// 构造「绕过一切系统/环境代理」的 reqwest 客户端，专用于访问本机环回地址（127.0.0.1 等）。
///
/// 背景：reqwest 默认 `trust_env` 会读取 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`。
/// 用户环境全局设置了 `ALL_PROXY=http://127.0.0.1:3067`（Karing 混合端口），
/// 导致访问本机反代 `/health`、`/v1/chat/completions` 时也被送去 3067；
/// 一旦 Karing 未连接节点，3067 虽在监听但上游超时，健康检查就会挂起，
/// 表现为「必须开代理才能启动内核」。绕过代理即可彻底摆脱该依赖。
pub(super) fn local_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 构造访问腾讯上游（copilot.tencent.com）的客户端。
///
/// 该域名国内可直连，无需也不应经过代理；同样显式绕过环境代理，
/// 避免因代理节点故障导致账号刷新 / 配额查询失败。
pub(super) fn upstream_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
pub(super) fn user_home() -> PathBuf {
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

// ---------------------------------------------------------------------------
// 多账号存取与持久化逻辑
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountsState {
    pub active_uid: String,
    pub accounts: HashMap<String, serde_json::Value>, // uid -> full session object
}

fn accounts_db_path() -> PathBuf {
    local_app_dir().join("accounts.json")
}

fn desktop_auth_info_path() -> PathBuf {
    local_appdata().join("CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info")
}

pub(super) fn load_accounts_state() -> AccountsState {
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

pub(super) fn save_accounts_state(st: &AccountsState) -> Result<(), String> {
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
