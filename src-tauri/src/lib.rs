// Tauri v2 主进程：生命周期、多账号管理、系统托盘与关闭策略控制
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State, WindowEvent,
};

pub mod commands;

pub struct ProxyHandle(pub Mutex<Option<Child>>);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CloseAction {
    Quit,       // 关闭窗口退出程序并停止服务
    HideToTray, // 关闭窗口不停用服务，隐藏至系统托盘后台运行
}

impl Default for CloseAction {
    fn default() -> Self {
        CloseAction::HideToTray
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct AppConfig {
    pub close_action: CloseAction,
    pub auto_start_proxy: bool,
    pub show_debug_console: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            close_action: CloseAction::HideToTray,
            auto_start_proxy: false,
            show_debug_console: false, // 默认为静默不显示窗口
        }
    }
}

pub struct AppConfigState(pub Mutex<AppConfig>);

fn config_file_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| "C:\\Users\\<username>\\AppData\\Local".into());
    let dir = Path::new(&base).join("codebuddy2openai");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

pub fn load_app_config() -> AppConfig {
    let p = config_file_path();
    if p.exists() {
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                return cfg;
            }
        }
    }
    AppConfig::default()
}

pub fn save_app_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_file_path();
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_app_settings(state: State<'_, AppConfigState>) -> Result<AppConfig, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn save_app_settings(
    settings: AppConfig,
    state: State<'_, AppConfigState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = settings.clone();
    save_app_config(&settings)?;
    Ok("设置已成功保存".into())
}

pub fn run_app() {
    let initial_config = load_app_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyHandle(Mutex::new(None)))
        .manage(AppConfigState(Mutex::new(initial_config)))
        .setup(|app| {
            // 系统托盘菜单
            let open_item = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("应用图标缺失"))
                .tooltip("CodeBuddy2OpenAI 桌面控制台")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        // 退出前停止反代
                        if let Some(handle) = app_handle.try_state::<ProxyHandle>() {
                            let _ = commands::proxy_stop(handle);
                        }
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app_handle = tray.app_handle();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let config = if let Some(st) = app.try_state::<AppConfigState>() {
                    st.0.lock().map(|c| c.clone()).unwrap_or_default()
                } else {
                    AppConfig::default()
                };

                match config.close_action {
                    CloseAction::HideToTray => {
                        // 阻止默认关闭行为，仅隐藏窗口到系统托盘
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    CloseAction::Quit => {
                        // 关闭窗口且自动停用反代服务并退出应用
                        if let Some(handle) = app.try_state::<ProxyHandle>() {
                            let _ = commands::proxy_stop(handle);
                        }
                        // 允许正常关闭与退出
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            save_app_settings,
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
            commands::proxy_open_console,
            commands::proxy_stop,
            commands::proxy_restart,
            commands::proxy_health,
            commands::proxy_test_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
