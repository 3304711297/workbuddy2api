//! 跨域共享工具：路径与环境变量解析、多账号状态持久化。
//! 供 auth/billing/agents/proxy 等子模块复用；对兄弟子模块以 pub(super) 暴露，不对 crate 其他部分泄露。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 路径与环境变量解析工具（禁止在业务代码里硬编码开发机绝对路径）
// 约定：环境变量覆盖 → 通用派生路径 → 原路径作最终回退（保证既有环境行为不变）
// ---------------------------------------------------------------------------

/// 读取环境变量，未设置或为空时返回 None
pub(super) fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// 读取环境变量（带项目改名兼容）：新名 `WORKBUDDY2API_<suffix>` 优先，
/// 回退旧名 `C2O_<suffix>`（CodeBuddy2OpenAI 时代前缀）。
///
/// 项目更名后保留旧前缀，避免既有用户环境行为静默失效。
pub(super) fn env_compat(suffix: &str) -> Option<String> {
    env_nonempty(&format!("WORKBUDDY2API_{suffix}")).or_else(|| env_nonempty(&format!("C2O_{suffix}")))
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
    let p = local_appdata().join("workbuddy2api");
    if !p.exists() {
        let legacy = local_appdata().join("codebuddy2openai");
        if legacy.exists() {
            let _ = std::fs::create_dir_all(&p);
            if let Ok(entries) = std::fs::read_dir(&legacy) {
                for entry in entries.flatten() {
                    let dest = p.join(entry.file_name());
                    if !dest.exists() {
                        let _ = std::fs::copy(entry.path(), dest);
                    }
                }
            }
            return p;
        }
    }
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

/// 安全原子写入文件（Windows 平台安全替换）：
/// 1. 先写入稳定且可识别的临时文件（`<file_name>.tmp`）；
/// 2. sync_all 确保数据完全刷入磁盘介质后关闭文件句柄；
/// 3. rename 原子替换目标文件（Windows 上目标文件已存在时会安全覆盖）；
/// 4. 若写入或替换失败，自动清理临时文件，确保原文件保留完整且无 .tmp 残留。
pub(crate) fn atomic_write_file(target: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp_path = target.with_file_name(format!("{file_name}.tmp"));

    // 1. 完整写入临时文件并落盘
    {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    } // 离开作用域关闭文件句柄，Windows 下释放锁后方可执行 rename

    // 2. 将临时文件替换到目标文件
    // 若 rename 失败，立即清理临时文件并向上抛错，原文件完好无损
    if let Err(err) = std::fs::rename(&tmp_path, target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    Ok(())
}

pub(super) fn save_accounts_state(st: &AccountsState) -> Result<(), String> {
    let p = accounts_db_path();
    let raw = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    atomic_write_file(&p, &raw).map_err(|e| e.to_string())?;

    // 如果有活跃账号，同步写回到 workbuddy-desktop.info 保证外部 converter 无缝可用
    if !st.active_uid.is_empty() {
        if let Some(active_val) = st.accounts.get(&st.active_uid) {
            let target_path = desktop_auth_info_path();
            if let Ok(out) = serde_json::to_string_pretty(active_val) {
                let _ = atomic_write_file(&target_path, &out);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_write_file_normal() {
        let dir = std::env::temp_dir().join(format!("c2o_test_atomic_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("accounts.json");
        let tmp_file = dir.join("accounts.json.tmp");

        // 确保初态清理
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(&tmp_file);

        let content = "{\"active_uid\":\"123\",\"accounts\":{}}";
        assert!(atomic_write_file(&target, content).is_ok());

        assert!(target.exists());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), content);
        assert!(!tmp_file.exists(), "成功后不得遗留 .tmp 文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_file_overwrite() {
        let dir = std::env::temp_dir().join(format!("c2o_test_overwrite_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("accounts.json");
        let tmp_file = dir.join("accounts.json.tmp");

        // 先写入初版
        std::fs::write(&target, "old_version").unwrap();

        let new_content = "{\"active_uid\":\"new_uid\",\"accounts\":{}}";
        assert!(atomic_write_file(&target, new_content).is_ok());

        assert_eq!(std::fs::read_to_string(&target).unwrap(), new_content);
        assert!(!tmp_file.exists(), "覆盖保存成功后不得遗留 .tmp 文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_file_failure_preserves_original() {
        let dir = std::env::temp_dir().join(format!("c2o_test_fail_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("accounts.json");
        let tmp_file = dir.join("accounts.json.tmp");

        let original = "original_protected_content";
        std::fs::write(&target, original).unwrap();

        // 在 Windows 上以排他且无共享删除权限打开目标文件，制造 rename 失败
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // share_mode = 0 表示不给任何共享读/写/删除权限
            let lock_guard = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&target);

            if let Ok(_guard) = lock_guard {
                let res = atomic_write_file(&target, "corrupt_data");
                assert!(res.is_err(), "目标文件被独占锁定时应报错");
                // 释放锁验证原文件是否完好
                drop(_guard);
            }
        }

        // 验证原文件未被破坏
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            original,
            "保存失败时原文件必须保持完整"
        );
        assert!(!tmp_file.exists(), "失败时临时文件必须被清理");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
