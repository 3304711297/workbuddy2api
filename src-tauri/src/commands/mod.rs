//! Tauri commands：对标 EasyCLIProxyAPI 核心能力
//! 1. 反代生命周期 (start/stop/restart/health/test_chat)
//! 2. 多账号体系与登录流程 (auth_begin/auth_poll/accounts_list/accounts_switch/accounts_delete/accounts_refresh)
//! 3. 账户真实积分与资源包查询 (usage_query)
//! 4. Agent 一键检测与配置写入 (agent_detect/agent_configure/agent_remove)
//!
//! 模块划分（纯机械拆分，`commands::xxx` 调用路径保持不变）：
//! - shared:  跨域路径工具 + 多账号状态持久化（供各功能子模块复用）
//! - auth:    登录授权 (OAuth) 与多账号管理
//! - billing: 配额积分查询与模型元数据获取/配置
//! - agents:  Agent 一键检测与配置写入 (Hermes & ZCode)
//! - proxy:   反代生命周期、日志管理与用量统计
//! - update:  应用更新检查

mod agents;
mod auth;
mod billing;
mod proxy;
mod shared;
mod update;

// 功能子模块按原始可见性整体再导出。
// glob 同时把 tauri 宏生成的隐藏宏（__cmd__xxx / __tauri_command_name_xxx）一并带上，
// 使 lib.rs 的 generate_handler![commands::xxx] 无需改动即可解析。
pub use self::agents::*;
pub use self::auth::*;
pub use self::billing::*;
pub use self::proxy::*;
pub use self::update::*;

// shared 仅再导出原本就具备 pub/pub(crate) 可达性且有实际消费者的项；其余项保持子模块内私有
pub use self::shared::AccountsState;
pub(crate) use self::shared::local_app_dir;
