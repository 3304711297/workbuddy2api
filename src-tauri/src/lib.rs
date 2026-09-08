// Tauri v2 主进程：生命周期、多账号管理、系统托盘与关闭策略控制
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Child;
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
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

// ---------------------------------------------------------------------------
// 窗口尺寸记忆（对标上游 MainWindowSizeState 的简化版）
// 独立存储于 window.json，避免与 AppConfig 契约纠缠；记录的是逻辑尺寸
// ---------------------------------------------------------------------------

/// 主窗口尺寸状态：采用单后台 Worker + 通知 Channel 模型做 500ms 去抖。
/// 关键保证：
/// 1. `latest` Mutex 是落盘尺寸的唯一真源；
/// 2. Channel 仅传递通知信号 `()`，绝不由信道队列决定最终尺寸；
/// 3. 高频 resize 导致 channel 满丢弃通知时，静默期满后落盘的仍 100% 必定是最后一次 update() 的尺寸。
pub struct WindowSizeState {
    tx: SyncSender<()>,
    latest: std::sync::Arc<Mutex<(f64, f64)>>,
}

impl Default for WindowSizeState {
    fn default() -> Self {
        Self::new(500)
    }
}

impl WindowSizeState {
    pub fn new(debounce_ms: u64) -> Self {
        // 容量为 64 的同步信道仅传递信号 ()，配合 try_send 确保极高频事件不会阻塞 UI
        let (tx, rx) = sync_channel::<()>(64);
        let latest = std::sync::Arc::new(Mutex::new((0.0, 0.0)));
        let latest_worker = latest.clone();

        std::thread::Builder::new()
            .name("window-resize-debouncer".into())
            .spawn(move || {
                run_resize_worker_with_sink(
                    rx,
                    latest_worker,
                    std::time::Duration::from_millis(debounce_ms),
                    save_window_size,
                );
            })
            .expect("failed to spawn window-resize-debouncer");

        Self { tx, latest }
    }

    pub fn update(&self, width: f64, height: f64) {
        // 先写唯一真源 latest
        if let Ok(mut l) = self.latest.lock() {
            *l = (width, height);
        }
        // 仅触发通知；即使队列满丢弃通知，由于已有通知处于等待中，静默期后必读 latest 最新尺寸
        let _ = self.tx.try_send(());
    }

    pub fn get_latest(&self) -> (f64, f64) {
        self.latest.lock().map(|v| *v).unwrap_or((0.0, 0.0))
    }
}

pub(crate) fn run_resize_worker_with_sink<F>(
    rx: Receiver<()>,
    latest: std::sync::Arc<Mutex<(f64, f64)>>,
    debounce_duration: std::time::Duration,
    sink: F,
) where
    F: Fn(f64, f64),
{
    while let Ok(()) = rx.recv() {
        loop {
            match rx.recv_timeout(debounce_duration) {
                Ok(()) => {
                    // 防抖窗口内收到新事件通知，重置倒计时继续等待静默
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 静默期满，严格从唯一真源 latest 中读取最新真实尺寸落盘
                    let (w, h) = latest.lock().map(|v| *v).unwrap_or((0.0, 0.0));
                    sink(w, h);
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // Sender 释放（程序退出），落盘最新真实尺寸并安全退出 worker
                    let (w, h) = latest.lock().map(|v| *v).unwrap_or((0.0, 0.0));
                    sink(w, h);
                    return;
                }
            }
        }
    }
}

fn window_state_path() -> PathBuf {
    // 复用 commands 的路径工具：%LOCALAPPDATA%\codebuddy2openai
    commands::local_app_dir().join("window.json")
}

fn save_window_size(width: f64, height: f64) {
    if width < 200.0 || height < 200.0 {
        return;
    }
    let path = window_state_path();
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::json!({ "width": width, "height": height });
    if let Ok(raw) = serde_json::to_string_pretty(&payload) {
        if std::fs::write(&tmp, raw).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// 读取记忆的窗口逻辑尺寸；值 ≥ 400×300 才返回，读取失败静默跳过
fn load_window_size() -> Option<(f64, f64)> {
    let raw = std::fs::read_to_string(window_state_path()).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let w = val.get("width").and_then(|v| v.as_f64())?;
    let h = val.get("height").and_then(|v| v.as_f64())?;
    if w >= 400.0 && h >= 300.0 {
        Some((w, h))
    } else {
        None
    }
}

/// 事件去抖：向单一后台 worker 投递最新尺寸，500ms 内无新事件才最终落盘
fn track_window_resize(app: &tauri::AppHandle, logical_w: f64, logical_h: f64) {
    if let Some(state) = app.try_state::<WindowSizeState>() {
        state.update(logical_w, logical_h);
    }
}

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
        .manage(WindowSizeState::default())
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

            // 窗口在 setup 前已按 tauri.conf.json 创建，此处恢复上次记忆的逻辑尺寸
            // （≥ 400×300 才生效；读取失败/无记录时保持配置默认值，静默跳过）
            if let Some(window) = app.get_webview_window("main") {
                if let Some((w, h)) = load_window_size() {
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // —— 主窗口尺寸记忆：逻辑尺寸 = 物理尺寸 ÷ 缩放系数，500ms 去抖后写 window.json ——
            if window.label() == "main" {
                let (phys, scale) = match event {
                    WindowEvent::Resized(size) => (
                        (size.width as f64, size.height as f64),
                        window.scale_factor().unwrap_or(1.0),
                    ),
                    // DPI 变化（跨显示器拖动）时用新物理尺寸 + 新缩放系数换算
                    WindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                        ..
                    } => (
                        (
                            new_inner_size.width as f64,
                            new_inner_size.height as f64,
                        ),
                        *scale_factor,
                    ),
                    _ => ((0.0, 0.0), 0.0),
                };
                if scale > 0.0 && phys.0 > 0.0 && phys.1 > 0.0 {
                    track_window_resize(window.app_handle(), phys.0 / scale, phys.1 / scale);
                }
            }

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
            commands::proxy_rate_limit,
            commands::proxy_test_chat,
            // 日志目录打开（前端 invoke）
            commands::open_logs_dir,
            // 用量统计聚合与版本更新检查（前端 invoke）
            commands::usage_summary,
            commands::check_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod window_resize_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn test_resize_worker_single_debounce() {
        let (tx, rx) = sync_channel::<()>(16);
        let latest = Arc::new(Mutex::new((0.0, 0.0)));
        let latest_clone = latest.clone();
        let sink_calls = Arc::new(Mutex::new(Vec::<(f64, f64)>::new()));
        let sink_calls_clone = sink_calls.clone();

        let handle = std::thread::spawn(move || {
            run_resize_worker_with_sink(
                rx,
                latest_clone,
                std::time::Duration::from_millis(50),
                move |w, h| {
                    sink_calls_clone.lock().unwrap().push((w, h));
                },
            );
        });

        *latest.lock().unwrap() = (800.0, 600.0);
        tx.send(()).unwrap();
        // 睡眠大于 50ms 静默窗口，触发落盘
        std::thread::sleep(std::time::Duration::from_millis(80));

        drop(tx);
        handle.join().unwrap();

        let calls = sink_calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "单次 resize 在静默后应恰好触发一次落盘");
        assert_eq!(calls[0], (800.0, 600.0));
    }

    #[test]
    fn test_resize_worker_continuous_rapid_resizes() {
        let (tx, rx) = sync_channel::<()>(64);
        let latest = Arc::new(Mutex::new((0.0, 0.0)));
        let latest_clone = latest.clone();
        let sink_calls = Arc::new(Mutex::new(Vec::<(f64, f64)>::new()));
        let sink_calls_clone = sink_calls.clone();

        let handle = std::thread::spawn(move || {
            run_resize_worker_with_sink(
                rx,
                latest_clone,
                std::time::Duration::from_millis(50),
                move |w, h| {
                    sink_calls_clone.lock().unwrap().push((w, h));
                },
            );
        });

        // 模拟连续快速拖拽：发送 30 次，每次间隔 5ms（均远小于 50ms debounce 窗口）
        for i in 1..=30 {
            *latest.lock().unwrap() = (100.0 + i as f64, 200.0 + i as f64);
            let _ = tx.try_send(());
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        // 停止拖动，等待 80ms 触发静默期落盘
        std::thread::sleep(std::time::Duration::from_millis(80));

        drop(tx);
        handle.join().unwrap();

        let calls = sink_calls.lock().unwrap();
        // 连续快速拖拽期间不应触发中间写入，最终落盘应恰好 1 次且等于最后一次尺寸
        assert_eq!(calls.len(), 1, "高频连续拖拽在静默期结束前不应多次落盘");
        assert_eq!(calls[0], (130.0, 230.0), "落盘尺寸必须为拖拽序列的最终尺寸");
    }

    #[test]
    fn test_resize_worker_channel_overflow_latest_source_of_truth() {
        // 关键压力测试：故意使用极小容量信道（capacity = 1），高频发送 100 次事件
        // 大量通知信号会被 try_send 丢弃，但 Worker 在静默期满后必须严格从 latest 读取最终尺寸
        let (tx, rx) = sync_channel::<()>(1);
        let latest = Arc::new(Mutex::new((0.0, 0.0)));
        let latest_clone = latest.clone();
        let sink_calls = Arc::new(Mutex::new(Vec::<(f64, f64)>::new()));
        let sink_calls_clone = sink_calls.clone();

        let handle = std::thread::spawn(move || {
            run_resize_worker_with_sink(
                rx,
                latest_clone,
                std::time::Duration::from_millis(50),
                move |w, h| {
                    sink_calls_clone.lock().unwrap().push((w, h));
                },
            );
        });

        // 连续密集更新 100 次，最后一次尺寸为 (999.0, 888.0)
        let mut dropped_signals = 0;
        for i in 1..=100 {
            *latest.lock().unwrap() = (100.0 + i as f64, 200.0 + i as f64);
            if tx.try_send(()).is_err() {
                dropped_signals += 1;
            }
        }
        // 确保确有信号因队列满被丢弃，构成压力测试场景
        assert!(dropped_signals > 0, "capacity=1 下应有事件通知被丢弃");

        // 最后一次显式更新最终尺寸
        *latest.lock().unwrap() = (999.0, 888.0);
        let _ = tx.try_send(());

        // 停止操作，等待 80ms 超越 50ms 静默窗口期
        std::thread::sleep(std::time::Duration::from_millis(80));

        drop(tx);
        handle.join().unwrap();

        let calls = sink_calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "静默期结束后必须恰好触发 1 次最终落盘");
        assert_eq!(
            calls[0],
            (999.0, 888.0),
            "无论通知队列丢弃多少次信号，最终落盘必须严格等于 latest 的最后一次尺寸"
        );
    }

    #[test]
    fn test_window_size_state_api() {
        let state = WindowSizeState::new(30);
        state.update(1024.0, 768.0);
        assert_eq!(state.get_latest(), (1024.0, 768.0));
    }
}
