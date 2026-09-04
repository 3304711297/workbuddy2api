// Tauri v2 主进程：负责反代生命周期管理 + 登录流程编排。
// 前端（Gemini 负责）通过 @tauri-apps/api invoke 调用这些命令。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};

/// 反代子进程句柄（converter.py 的托管实例）
struct ProxyHandle(Mutex<Option<Child>>);

#[derive(Serialize, Deserialize, Clone)]
struct LoginState {
    state: String,
    auth_url: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct TokenPollResult {
    code: i64,
    msg: String,
    /// 登录成功时后端返回完整凭据（accessToken/refreshToken/...）
    data: Option<serde_json::Value>,
}

/// 发起独立登录：请求后端 auth/state，返回 state + authUrl（前端打开浏览器或展示二维码）。
#[tauri::command]
async fn auth_begin(platform: String) -> Result<LoginState, String> {
    let url = format!(
        "https://copilot.tencent.com/v2/plugin/auth/state?platform={platform}"
    );
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

/// 轮询登录结果：登录成功返回完整凭据（写入 auth 文件由 Python 侧完成，或此处直接写）。
#[tauri::command]
async fn auth_poll(state: String) -> Result<TokenPollResult, String> {
    let url = format!(
        "https://copilot.tencent.com/v2/plugin/auth/token?state={state}"
    );
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
    Ok(TokenPollResult {
        code: body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1),
        msg: body
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        data: body.get("data").cloned().filter(|v| !v.is_null()),
    })
}

/// 启动 Python 反代（converter.py sidecar）。幂等：已在跑则直接返回。
#[tauri::command]
fn proxy_start(
    handle: State<ProxyHandle>,
    app: tauri::AppHandle,
    port: u16,
) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(format!("already-running(port {port})"));
        }
    }
    // 定位 venv python：打包后放在资源目录；开发期用绝对路径
    let python = {
        let dev = std::path::PathBuf::from(
            "C:/Users/<username>/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
        );
        dev
    };
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("converter.py");
    let script = if script.exists() {
        script
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("../converter.py")
    };
    let child = Command::new(python)
        .arg(script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--desensitize")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动反代失败: {e}"))?;
    *guard = Some(child);
    Ok(format!("started(port {port})"))
}

/// 停止反代。
#[tauri::command]
fn proxy_stop(handle: State<ProxyHandle>) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.kill().is_ok() {
            *guard = None;
            return Ok("stopped".into());
        }
    }
    Ok("not-running".into())
}

/// 反代健康检查。
#[tauri::command]
async fn proxy_health(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            auth_begin,
            auth_poll,
            proxy_start,
            proxy_stop,
            proxy_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
