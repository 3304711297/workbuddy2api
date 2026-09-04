// Tauri v2 主进程：生命周期、多账号管理、配额查询与 Agent 一键配置
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Child;
use std::sync::Mutex;

mod commands;

pub struct ProxyHandle(pub Mutex<Option<Child>>);

pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // 登录与授权
            commands::auth_begin,
            commands::auth_poll,
            // 多账号管理
            commands::accounts_list,
            commands::accounts_switch,
            commands::accounts_delete,
            commands::accounts_refresh_token,
            // 配额与积分
            commands::usage_query,
            // Agent 一键集成
            commands::agent_detect,
            commands::agent_configure,
            commands::agent_remove,
            // 反代控制与测试
            commands::proxy_start,
            commands::proxy_stop,
            commands::proxy_restart,
            commands::proxy_health,
            commands::proxy_test_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
