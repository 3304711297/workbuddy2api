// Tauri v2 主进程：生命周期、多账号管理、系统托盘与关闭策略控制
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
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
    /// 反代监听端口；serde default 保证旧 settings.json 缺字段时反序列化兼容
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    /// 是否对上游响应做脱敏处理；serde default 保证旧 settings.json 缺字段时反序列化兼容
    #[serde(default = "default_desensitize")]
    pub desensitize: bool,
}

fn default_proxy_port() -> u16 {
    8787
}

fn default_desensitize() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            close_action: CloseAction::HideToTray,
            auto_start_proxy: false,
            show_debug_console: false, // 默认为静默不显示窗口
            port: default_proxy_port(),
            desensitize: default_desensitize(),
        }
    }
}

pub struct AppConfigState(pub Mutex<AppConfig>);

fn config_file_path() -> PathBuf {
    // 复用 commands 的路径工具：LOCALAPPDATA 环境变量优先，避免硬编码用户目录
    let dir = commands::local_app_dir();
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

pub fn update_tray_status<R: tauri::Runtime>(
    proxy_handle: &ProxyHandle,
    status_item: &MenuItem<R>,
    toggle_item: &MenuItem<R>,
) {
    let mut is_running = false;
    if let Ok(mut guard) = proxy_handle.0.lock() {
        if let Some(child) = guard.as_mut() {
            if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                is_running = true;
            }
        }
    }

    if is_running {
        let _ = status_item.set_text("内核状态：运行中");
        let _ = toggle_item.set_text("停止内核");
    } else {
        let _ = status_item.set_text("内核状态：已停止");
        let _ = toggle_item.set_text("启动内核");
    }
}

pub fn run_app() {
    let initial_config = load_app_config();

    tauri::Builder::default()
        // 单实例锁必须最先注册：第二次启动进程会把参数转发给首个实例后自动退出，
        // 此回调在首个实例内触发，把已存在的主窗口带到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyHandle(Mutex::new(None)))
        .manage(AppConfigState(Mutex::new(initial_config)))
        .setup(|app| {
            // 系统托盘右键菜单（完全对齐代理内核标准交互）
            let open_item = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let status_item = MenuItem::with_id(app, "status", "内核状态：已停止", false, None::<&str>)?;
            let toggle_item = MenuItem::with_id(app, "toggle_core", "启动内核", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart_core", "重启内核", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &sep1,
                    &status_item,
                    &toggle_item,
                    &restart_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            let status_item_menu = status_item.clone();
            let toggle_item_menu = toggle_item.clone();

            let status_item_click = status_item.clone();
            let toggle_item_click = toggle_item.clone();

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("应用图标缺失"))
                .tooltip("CodeBuddy2OpenAI 桌面控制台")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app_handle, event| {
                    let proxy_opt = app_handle.try_state::<ProxyHandle>();
                    match event.id().as_ref() {
                        "open" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "toggle_core" => {
                            if let Some(handle) = proxy_opt {
                                let mut is_running = false;
                                if let Ok(mut guard) = handle.0.lock() {
                                    if let Some(child) = guard.as_mut() {
                                        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                                            is_running = true;
                                        }
                                    }
                                }
                                if is_running {
                                    let _ = commands::proxy_stop(handle.clone(), app_handle.clone());
                                } else {
                                    // 每次触发时从磁盘现读 settings.json，确保托盘与 UI 最新设置一致（不用启动时缓存）
                                    let cfg = load_app_config();
                                    let _ = commands::proxy_start(
                                        handle.clone(),
                                        app_handle.clone(),
                                        Some(cfg.port),
                                        Some(cfg.desensitize),
                                    );
                                }
                                update_tray_status(&handle, &status_item_menu, &toggle_item_menu);
                            }
                        }
                        "restart_core" => {
                            if let Some(handle) = proxy_opt {
                                // 每次触发时从磁盘现读 settings.json，确保托盘与 UI 最新设置一致（不用启动时缓存）
                                let cfg = load_app_config();
                                let _ = commands::proxy_stop(handle.clone(), app_handle.clone());
                                std::thread::sleep(std::time::Duration::from_millis(350));
                                let _ = commands::proxy_start(
                                    handle.clone(),
                                    app_handle.clone(),
                                    Some(cfg.port),
                                    Some(cfg.desensitize),
                                );
                                update_tray_status(&handle, &status_item_menu, &toggle_item_menu);
                            }
                        }
                        "quit" => {
                            // 退出前停止反代
                            if let Some(handle) = proxy_opt {
                                let _ = commands::proxy_stop(handle, app_handle.clone());
                            }
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    let app_handle = tray.app_handle();
                    // 每次触发托盘事件时刷新状态项
                    if let Some(handle) = app_handle.try_state::<ProxyHandle>() {
                        update_tray_status(&handle, &status_item_click, &toggle_item_click);
                    }

                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
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
                            let _ = commands::proxy_stop(handle, app.clone());
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
            // 模型全量获取与配置
            commands::models_fetch_all,
            commands::model_save_config,
            // Agent 一键集成
            commands::agent_detect,
            commands::agent_configure,
            commands::agent_remove,
            // 反代控制与测试
            commands::proxy_start,
            commands::proxy_get_logs,
            commands::proxy_clear_logs,
            commands::proxy_stop,
            commands::proxy_restart,
            commands::proxy_health,
            commands::proxy_test_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
