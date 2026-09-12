//! 反代控制与测试、日志管理与用量统计聚合

use crate::ProxyHandle;
use futures_util::StreamExt; // 流式读取 SSE 字节块（配合 reqwest "stream" feature）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{Manager, State};

use super::shared::{env_compat, local_app_dir, user_home};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TestChatResult {
    pub success: bool,
    pub model: String,
    pub response: String,
    pub latency_ms: u64,
    /// 首字时延（毫秒）：请求发出到第一个非空 delta.content 的耗时；None 序列化为 null 表示未测得
    pub ttft_ms: Option<u64>,
    pub error: Option<String>,
    /// 本次测试实际使用的协议：chat | messages | responses
    #[serde(default)]
    pub protocol: String,
}

/// Python 解释器定位：`WORKBUDDY2API_PYTHON`（兼容旧名 `C2O_PYTHON`）环境变量优先 → 用户主目录下 .workbuddy 内置解释器（按 USERPROFILE 派生，保留现机行为）→ PATH 中的 python
fn resolve_python_interpreter() -> PathBuf {
    if let Some(p) = env_compat("PYTHON").map(PathBuf::from).filter(|p| p.exists()) {
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

    // converter.py 定位：`WORKBUDDY2API_CONVERTER`（兼容旧名 `C2O_CONVERTER`）环境变量优先 → 资源目录 → 可执行文件目录逐级向上 → 当前工作目录兜底
    let script = match env_compat("CONVERTER")
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
    // 监听地址：默认回环。非回环（如 0.0.0.0）时内核要求必须带 api_key，
    // 否则 exit 1 拒绝启动——此处提前守卫并给出可操作的错误信息，
    // 避免用户只看到「内核启动后立刻退出」而无从判断原因。
    let listen_host = {
        let h = cfg.listen_host.trim();
        if h.is_empty() { "127.0.0.1".to_string() } else { h.to_string() }
    };
    let is_loopback = listen_host == "127.0.0.1" || listen_host == "localhost" || listen_host == "::1";
    // api_key 先算出来，供监听地址守卫与后续参数追加共用
    let api_key = cfg.api_key.trim().to_string();
    if !is_loopback && api_key.is_empty() {
        return Err("非回环监听（如 0.0.0.0）必须先在设置页配置客户端鉴权密钥，\
                    否则服务将无鉴权暴露给网络。内核也会拒绝启动。"
            .to_string());
    }
    cmd.arg("--host").arg(&listen_host);
    if desensitize {
        cmd.arg("--desensitize");
    }
    // 多账号调度：内核会在每次请求时热读 settings.json 决定实际行为，
    // 这里透传参数仅作为「settings.json 不可读时」的启动默认值兜底，
    // 因此始终传递（即便 off），保证行为可预期。
    let rotate_mode = if cfg.rotate_mode.is_empty() { "off".to_string() } else { cfg.rotate_mode.clone() };
    cmd.arg("--rotate-mode").arg(&rotate_mode);
    cmd.arg("--rotate-count").arg(cfg.rotate_count.to_string());
    // 模型清单模式：内核每次 /v1/models 请求热读 settings.json，这里透传仅作启动兜底
    let list_mode = if cfg.model_list_mode.is_empty() { "all".to_string() } else { cfg.model_list_mode.clone() };
    cmd.arg("--model-list-mode").arg(&list_mode);
    // 客户端鉴权：密钥非空时追加（空值不下发，见上方守卫）
    if !api_key.is_empty() {
        cmd.arg("--api-key").arg(&api_key);
    }
    // 用量统计：每次聊天请求完成后由 converter 向该文件追加一行 JSONL，供 usage_summary 聚合
    let usage_dir = local_app_dir().join("usage");
    let _ = std::fs::create_dir_all(&usage_dir);
    cmd.arg("--usage-log").arg(usage_dir.join("usage.jsonl"));

    // 结构化日志：内核 _log() 在 log_path 为空时直接丢弃——不传 --log 则丢失
    // 请求摘要/耗时/错误详情等结构化行（日志页只能看到 uvicorn 原始 stdout）。
    // 级别由设置控制（info/debug/trace）；payload 开关需显式开启（会落盘完整正文）。
    let log_file = local_app_dir().join("converter.log");
    cmd.arg("--log").arg(&log_file);
    let log_level = match cfg.log_level.trim() {
        "debug" => "debug",
        "trace" => "trace",
        _ => "info",
    };
    cmd.arg("--log-level").arg(log_level);
    if cfg.log_payloads {
        // 双闸门：内核仍要求 trace 级才实际落盘正文，此处仅表达用户意图
        cmd.arg("--log-payloads");
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

    // 旧进程句柄已在此处关闭（上方 already-running 检查排除了运行中状态），
    // 启动新子进程前做日志轮转：超过 1MB 的旧日志整体改名为 .1，避免无限增长；
    // rename 失败（文件被占用）静默跳过，不影响本次启动
    rotate_proxy_log_if_oversized();

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

/// 日志轮转：proxy_stdout.log 超过 1MB 时整体重命名为 proxy_stdout.log.1（覆盖旧备份）。
/// 只允许在反代子进程确定未运行（旧句柄已关闭）的时机调用，进程运行中绝不截断/移动；
/// rename 失败（Windows 文件占用等）时静默跳过，不阻断启动/停止流程。
fn rotate_proxy_log_if_oversized() {
    const ROTATE_THRESHOLD_BYTES: u64 = 1024 * 1024;
    let log = log_file_path();
    if let Ok(meta) = std::fs::metadata(&log) {
        if meta.len() > ROTATE_THRESHOLD_BYTES {
            let backup = log.with_file_name("proxy_stdout.log.1");
            let _ = std::fs::rename(&log, &backup);
        }
    }
}

/// 读取文件尾部并裁剪到 max_bytes（从字符边界起切，防多字节字符 panic）。
/// 文件不存在/读取失败返回 None。
fn read_file_tail_clipped(p: &std::path::Path, max_bytes: usize) -> Option<String> {
    if !p.exists() {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    let raw = String::from_utf8_lossy(&bytes).to_string();
    if raw.len() <= max_bytes {
        return Some(raw);
    }
    // 日志含中文/emoji 时，字节偏移可能落在多字节字符中间，
    // 直接切片会 panic "byte index is not a char boundary"，需向后对齐。
    let mut start = raw.len() - max_bytes;
    while start < raw.len() && !raw.is_char_boundary(start) {
        start += 1;
    }
    Some(raw[start..].to_string())
}

/// 结构化日志文件路径（内核 --log 指向此文件，含请求摘要/耗时/级别过滤后的行）
fn structured_log_path() -> PathBuf {
    local_app_dir().join("converter.log")
}

#[tauri::command]
pub fn proxy_get_logs() -> Result<String, String> {
    // 两级日志合并展示：
    // 1) 结构化日志（converter.log）——内核 _log() 输出，受 --log-level 控制，
    //    含请求摘要/耗时/错误详情，是调整级别后用户最需要看到的内容；
    // 2) 原始 stdout（proxy_stdout.log）——uvicorn 启动信息与未被结构化捕获的输出。
    // 各自配额（48KB / 32KB）防止其中一方把另一方挤出预算。
    const STRUCTURED_QUOTA: usize = 48_000;
    const STDOUT_QUOTA: usize = 32_000;
    let structured = read_file_tail_clipped(&structured_log_path(), STRUCTURED_QUOTA);
    let stdout = read_file_tail_clipped(&log_file_path(), STDOUT_QUOTA);

    match (structured, stdout) {
        (Some(s), Some(o)) => {
            if s.trim().is_empty() && o.trim().is_empty() {
                return Ok("暂无日志输出，请启动反代服务".into());
            }
            Ok(format!(
                "===== 结构化日志（--log-level 控制） =====\n{s}\n===== 进程 stdout =====\n{o}"
            ))
        }
        (Some(s), None) => Ok(s),
        (None, Some(o)) => {
            if o.trim().is_empty() {
                return Ok("暂无日志输出，请启动反代服务".into());
            }
            Ok(o)
        }
        (None, None) => Ok("暂无日志输出，请启动反代服务".into()),
    }
}

#[tauri::command]
pub fn proxy_clear_logs() -> Result<String, String> {
    // 两个日志文件都要清：只清 stdout 会让用户以为清空失败（旧结构化日志仍在展示）
    for p in [log_file_path(), structured_log_path()] {
        if p.exists() {
            std::fs::write(&p, "").map_err(|e| e.to_string())?;
        }
    }
    Ok("日志已清空".into())
}

/// 打开应用数据目录（%LOCALAPPDATA%\workbuddy2api，即日志文件所在目录）。
/// 目录不存在时先创建（local_app_dir 内部已保证），再用资源管理器打开；失败返回错误信息。
#[tauri::command]
pub fn open_logs_dir() -> Result<(), String> {
    let dir = local_app_dir();
    Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打开日志目录失败: {e}"))?;
    Ok(())
}

/// 局域网 IPv4 探测（对标 EasyCLIProxyAPI 的 get_lan_ipv4）：
/// 通过向公网地址发一个「不会真正发包」的 UDP connect 让内核选出默认出口网卡，
/// 从而拿到本机在局域网中的地址，用于向用户展示可连接的地址（如 http://192.168.x.x:8787）。
/// connect 不产生流量，也不依赖外网可达性——只为让路由表选择出口接口。
/// 失败时返回 None（前端优雅降级，不显示地址行）。
#[tauri::command]
pub fn lan_ipv4() -> Option<String> {
    let sock = match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return None,
    };
    // 8.8.8.8:80 仅作路由查询用（UDP connect 不握手、不发包）
    if sock.connect("8.8.8.8:80").is_err() {
        return None;
    }
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// 按 PID 精确杀死进程树（Windows 下使用 taskkill /F /T /PID，连同子孙进程彻底拔起）。
/// 彻底取缔 WMI/PowerShell 全机进程枚举与命令行模糊匹配。非零退出码明确视为失败返回 Err。
pub(crate) fn kill_process_tree_by_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("启动 taskkill 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let err_msg = format!(
                "taskkill PID {pid} 失败 (退出码 {:?}): {}",
                output.status.code(),
                stderr.trim()
            );
            eprintln!("[proxy_stop] {err_msg}");
            return Err(err_msg);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Ok(())
    }
}

/// 在有限时间内等待子进程退出，杜绝无限阻塞。
/// 每 30ms 轮询一次 try_wait()，超时后返回是否已退出。
pub(crate) fn wait_timeout(child: &mut std::process::Child, timeout: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    child.try_wait().map(|s| s.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn proxy_stop(handle: State<'_, ProxyHandle>, app: tauri::AppHandle) -> Result<String, String> {
    let mut guard = handle.0.lock().map_err(|e| e.to_string())?;

    if let Some(child) = guard.as_mut() {
        let pid = child.id();

        // 1. 检查是否早已自行退出：若已退出，直接回收句柄
        if let Ok(Some(_)) = child.try_wait() {
            let _ = guard.take();
            rotate_proxy_log_if_oversized();
            use tauri::Emitter;
            let _ = app.emit("proxy-status-changed", serde_json::json!({ "running": false }));
            return Ok("stopped".into());
        }

        // 2. 进程仍在运行，执行精确进程树查杀
        let kill_result = kill_process_tree_by_pid(pid);

        // 3. 有界等待确认退出（最多 600ms），绝不无限阻塞 child.wait()
        let mut exited = wait_timeout(child, std::time::Duration::from_millis(600));

        // 4. 安全 Fallback：若 taskkill 失败或未在时限内退出，触发原生 child.kill() 二次确认
        if !exited {
            eprintln!("[proxy_stop] taskkill 未能确认退出 (PID {pid})，触发 fallback child.kill()");
            let _ = child.kill();
            exited = wait_timeout(child, std::time::Duration::from_millis(300));
        }

        if exited {
            // 确认已终止，安全回收句柄
            let _ = guard.take();
            rotate_proxy_log_if_oversized();
            use tauri::Emitter;
            let _ = app.emit("proxy-status-changed", serde_json::json!({ "running": false }));
            Ok("stopped".into())
        } else {
            // 进程仍在存活：保持状态自洽，保留 child 句柄在 guard 中避免失控，并抛出明确错误
            let err = match kill_result {
                Err(e) => format!("停止反代进程 (PID {pid}) 失败: {e}"),
                Ok(_) => format!("停止反代进程 (PID {pid}) 超时，进程仍未退出"),
            };
            eprintln!("[proxy_stop] {err}");
            Err(err)
        }
    } else {
        use tauri::Emitter;
        let _ = app.emit("proxy-status-changed", serde_json::json!({ "running": false }));
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
    // 本机环回直连，绕过环境代理：否则 ALL_PROXY 指向 3067 时，
    // Karing 未连节点会让健康检查挂起，误报「内核未启动」
    let resp = super::shared::local_client(10)
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

/// 拉取反代自曝的上游频率限制状态（GET /api/rate_limit，code 6004 冷却与滚动用量）。
/// 老版内核无该端点时返回 Ok(null)，由前端按「数据不可用」优雅降级。
#[tauri::command]
pub async fn proxy_rate_limit(port: u16) -> Result<Option<serde_json::Value>, String> {
    let url = format!("http://127.0.0.1:{port}/api/rate_limit");
    let resp = super::shared::local_client(8).get(&url).send().await;
    match resp {
        Ok(r) if r.status() == reqwest::StatusCode::OK => {
            let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
            Ok(Some(v))
        }
        // 404 = 老版内核（无此端点）；连接失败 = 内核未运行。两者都属「不可用」而非错误。
        Ok(_) | Err(_) => Ok(None),
    }
}

/// 每日签到：转发 POST /api/checkin/claim 到本地反代内核（绕开 CSP connect-src 限制）。
/// 内核负责注入 X-Device-Token（与桌面端一致），这里只做透明转发。
#[tauri::command]
pub async fn proxy_checkin_claim(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/checkin/claim");
    let resp = super::shared::local_client(20)
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

/// 每日签到状态查询：转发 GET /api/checkin/status 到本地反代内核（绕开 CSP connect-src 限制）。
/// 内核返回 {ok, data:{today_checked_in, active, end_time, ...}}；失败时 ok=false + error。
#[tauri::command]
pub async fn proxy_checkin_status(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/checkin/status");
    let resp = super::shared::local_client(20)
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 连通性测试探针（纯函数，便于单测；proxy_test_chat 调用）
// ---------------------------------------------------------------------------

/// 协议归一：chat（默认）| messages（Anthropic）| responses（Codex）
fn test_chat_proto(protocol: Option<&str>) -> &'static str {
    match protocol {
        Some("messages") => "messages",
        Some("responses") => "responses",
        _ => "chat",
    }
}

/// 各协议的探测 URL。chat 必须用完整路由 /v1/chat/completions——
/// 内核只有这三个路由，/v1/chat 不存在（曾致 GUI 连通性测试 404 {"detail":"Not Found"}）。
fn test_chat_url(port: u16, proto: &str) -> String {
    let path = match proto {
        "chat" => "chat/completions",
        other => other,
    };
    format!("http://127.0.0.1:{port}/v1/{path}")
}

/// 各协议的探测请求体形态不同，但都在服务端被转换为同一 Chat 语义后再回译为对应协议：
///   chat      -> OpenAI chat/completions
///   messages  -> Anthropic Messages（max_tokens 必填）
///   responses -> OpenAI Responses（input 数组）
fn test_chat_payload(model: &str, proto: &str) -> serde_json::Value {
    // 探测预算 512：glm-5.3-flash 等模型默认带 reasoning（实测约 60~120 token，
    // 见 converter.log 22:26:31 finish=length tokens=119），100 预算会被思考吃满
    // 导致正文为空，被误判为「未返回有效结果」。512 给正文留足空间，也让思考档
    // 差异（低/中档）不会饿死正文。上游对 glm 的关闭信号不敏感（实测无效），
    // 因此不加关思考参数伪装。
    match proto {
        "messages" => serde_json::json!({
            "model": model,
            "max_tokens": 512,
            "messages": [
                {"role": "user", "content": "Ping: 请仅回答 PONG"}
            ],
            "stream": true,
        }),
        "responses" => serde_json::json!({
            "model": model,
            "input": "Ping: 请仅回答 PONG",
            "max_output_tokens": 512,
            "stream": true,
        }),
        _ => serde_json::json!({
            "model": model,
            "messages": [
                {"role": "user", "content": "Ping: 请仅回答 PONG"}
            ],
            "max_tokens": 512,
            "stream": true,
            "chat_template_kwargs": {"enable_thinking": false}
        }),
    }
}

#[tauri::command]
pub async fn proxy_test_chat(
    port: u16,
    model: Option<String>,
    protocol: Option<String>,
) -> Result<TestChatResult, String> {
    let target_model = model.unwrap_or_else(|| "glm-5.3-flash".into());
    let proto = test_chat_proto(protocol.as_deref());
    let url = test_chat_url(port, proto);
    let start = std::time::Instant::now();

    // 30s 总超时：reqwest 客户端级 timeout 覆盖「发起连接 → 响应体读取完毕」全过程，
    // 流式读取中途挂起同样会在 30s 处触发 Err，无需单独的读超时
    // 同时绕过环境代理，避免本机请求被送去 3067 而受 Karing 节点状态牵连
    let client = super::shared::local_client(30);

    let payload = test_chat_payload(&target_model, proto);

    let resp = match client.post(&url).json(&payload).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(TestChatResult {
                success: false,
                model: target_model,
                response: String::new(),
                latency_ms: start.elapsed().as_millis() as u64,
                ttft_ms: None,
                error: Some(e.to_string()),
                protocol: proto.to_string(),
            });
        }
    };

    // 非 2xx：按原有「错误体提取」思路取响应体前 300 字符作为错误信息，整体判失败
    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let snippet: String = body_text.chars().take(300).collect();
        return Ok(TestChatResult {
            success: false,
            model: target_model,
            response: String::new(),
            latency_ms: start.elapsed().as_millis() as u64,
            ttft_ms: None,
            error: Some(format!("HTTP {status}: {snippet}")),
            protocol: proto.to_string(),
        });
    }

    // 逐块读取 SSE：按行解析 data: 帧。响应摘要截断上限，防止异常上游撑爆内存
    const MAX_SUMMARY_CHARS: usize = 4096;
    let mut stream = std::pin::pin!(resp.bytes_stream());
    let mut buf: Vec<u8> = Vec::new();
    let mut response_acc = String::new();
    let mut ttft_ms: Option<u64> = None;
    let mut stream_err: Option<String> = None;
    let mut done = false;

    while !done {
        let chunk = match stream.as_mut().next().await {
            Some(Ok(c)) => c,
            // 网络错误/30s 超时：中断读取，走失败路径（ttft 未测得则返回 None）
            Some(Err(e)) => {
                stream_err = Some(e.to_string());
                break;
            }
            // 流自然结束（服务器关闭连接，可能未发 [DONE]）同样视为完成
            None => break,
        };
        buf.extend_from_slice(&chunk);

        // 只解析完整行：末尾不完整的行留待下一个 chunk 拼接，避免 UTF-8 多字节字符被截断
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            // 跳过空行（SSE 事件分隔）与注释行（':' 开头）
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            // "data:" 前缀行为数据帧；event:/id:/retry: 等其他字段行忽略
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim(); // 兼容 "data:{...}" 与 "data: {...}" 两种写法
            if data == "[DONE]" {
                done = true;
                break;
            }
            // 单帧 JSON 解析异常只跳过该帧，不判整体失败
            let Ok(val) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            // 按协议解析文本增量：
            //   chat      -> choices[0].delta.content
            //   messages  -> content_block_delta.delta.text（Anthropic）
            //   responses -> response.output_text.delta（Codex Responses 语义事件）
            let delta = match proto {
                "messages" => val
                    .pointer("/delta/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                "responses" => {
                    if val.get("type").and_then(|v| v.as_str()) == Some("response.output_text.delta") {
                        val.get("delta").and_then(|v| v.as_str()).unwrap_or("")
                    } else {
                        ""
                    }
                }
                _ => val
                    .pointer("/choices/0/delta/content")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            };
            if delta.is_empty() {
                continue;
            }
            if ttft_ms.is_none() {
                ttft_ms = Some(start.elapsed().as_millis() as u64);
            }
            response_acc.push_str(delta);
            if response_acc.chars().count() >= MAX_SUMMARY_CHARS {
                done = true;
                break;
            }
        }
    }

    let latency_ms = start.elapsed().as_millis() as u64;

    // 失败路径：与原行为一致，success:false + 错误信息、response 置空、ttft_ms 返回 None
    if let Some(err) = stream_err {
        return Ok(TestChatResult {
            success: false,
            model: target_model,
            response: String::new(),
            latency_ms,
            ttft_ms: None,
            error: Some(err),
            protocol: proto.to_string(),
        });
    }

    Ok(TestChatResult {
        success: !response_acc.is_empty(),
        model: target_model,
        response: response_acc,
        latency_ms,
        ttft_ms,
        error: None,
        protocol: proto.to_string(),
    })
}

// ---------------------------------------------------------------------------
// 用量统计（usage_summary）：聚合 converter 每请求写出的 JSONL 用量文件
// ---------------------------------------------------------------------------

/// 用量统计文件路径：%LOCALAPPDATA%\workbuddy2api\usage\usage.jsonl（proxy_start 传给 converter）
fn usage_log_path() -> PathBuf {
    local_app_dir().join("usage").join("usage.jsonl")
}

/// 单行用量记录（与 converter.py `_record_usage` 的 JSONL 字段一一对应）
#[derive(Deserialize, Debug, Default, Clone)]
struct UsageRecord {
    ts: i64,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    model: String,
    #[serde(default)]
    input_tokens: Option<i64>,
    #[serde(default)]
    output_tokens: Option<i64>,
    #[serde(default)]
    latency_ms: i64,
    #[serde(default)]
    ttft_ms: Option<i64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    retry_count: i64,
    #[serde(default)]
    retry_reason: Option<String>,
    #[serde(default)]
    requested_model: Option<String>,
    #[serde(default)]
    actual_model: Option<String>,
    #[serde(default)]
    fallback_reason: Option<String>,
}

/// 用量明细查询入参（缺省字段即不过滤；page 从 1 起）
#[derive(Debug, Default, Deserialize)]
struct UsageQuery {
    #[serde(default)]
    model: Option<String>,
    /// "ok" | "failed"（其他值按不过滤处理）
    #[serde(default)]
    status: Option<String>,
    /// 起始 epoch 毫秒（含）
    #[serde(default)]
    since_ms: Option<i64>,
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    page_size: Option<usize>,
}

// ——— 用量明细纯函数（TDD：测试见 usage_tests） ———

/// 按 model / status / since_ms 过滤。
/// model 为大小写不敏感子串匹配（便于搜 "terra" 这类片段）；空白串视为不过滤。
/// status 仅识别 "ok" / "failed"，其他值忽略。
fn filter_usage_records<'a>(records: &'a [UsageRecord], q: &UsageQuery) -> Vec<&'a UsageRecord> {
    let needle = q
        .model
        .as_deref()
        .map(|m| m.trim().to_lowercase())
        .filter(|m| !m.is_empty());
    let status = q
        .status
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s == "ok" || s == "failed");
    records
        .iter()
        .filter(|r| {
            if let Some(n) = &needle {
                if !r.model.to_lowercase().contains(n.as_str()) {
                    return false;
                }
            }
            match status.as_deref() {
                Some("ok") if !r.ok => return false,
                Some("failed") if r.ok => return false,
                _ => {}
            }
            if let Some(since) = q.since_ms {
                if r.ts < since {
                    return false;
                }
            }
            true
        })
        .collect()
}

/// 分页：返回 (当页条目, 总数, 总页数)。
/// page 从 1 起，0 或越界页收敛为空列表；page_size 为 0 时按 1 处理；
/// 空输入时 total_pages 仍为 1，避免前端除零。
fn paginate_usage_refs<'a>(
    items: &[&'a UsageRecord],
    page: usize,
    page_size: usize,
) -> (Vec<&'a UsageRecord>, usize, usize) {
    let total = items.len();
    let page_size = page_size.max(1);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = page.max(1);
    let start = (page - 1).saturating_mul(page_size);
    let slice = if start < total {
        &items[start..(start + page_size).min(total)]
    } else {
        &[]
    };
    (slice.to_vec(), total, total_pages)
}

/// 按模型分组统计：requests 降序（并列保持首次出现顺序）。
/// 空模型名归入 "(未知)"；avg_latency_ms 为该组算术均值。
fn group_usage_by_model(records: &[UsageRecord]) -> Vec<serde_json::Value> {
    type Agg = (i64, i64, i64, i64, i64, i64); // requests, ok, failed, in, out, latency_sum
    let mut agg: std::collections::HashMap<String, Agg> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for r in records {
        let key = if r.model.is_empty() { "(未知)".to_string() } else { r.model.clone() };
        if !agg.contains_key(&key) {
            order.push(key.clone());
        }
        let e = agg.entry(key).or_insert((0, 0, 0, 0, 0, 0));
        e.0 += 1;
        if r.ok { e.1 += 1 } else { e.2 += 1 }
        e.3 += r.input_tokens.unwrap_or(0);
        e.4 += r.output_tokens.unwrap_or(0);
        e.5 += r.latency_ms;
    }
    let groups: Vec<serde_json::Value> = order
        .into_iter()
        .map(|k| {
            let (req, ok, failed, tin, tout, lat) = agg[&k];
            serde_json::json!({
                "model": k,
                "requests": req,
                "ok": ok,
                "failed": failed,
                "input_tokens": tin,
                "output_tokens": tout,
                "avg_latency_ms": if req > 0 { lat / req } else { 0 },
            })
        })
        .collect();
    let mut indexed: Vec<(usize, serde_json::Value)> = groups.into_iter().enumerate().collect();
    indexed.sort_by(|a, b| {
        let ra = b.1["requests"].as_i64().unwrap_or(0);
        let rb = a.1["requests"].as_i64().unwrap_or(0);
        ra.cmp(&rb).then(a.0.cmp(&b.0)) // 并列时按首次出现顺序
    });
    indexed.into_iter().map(|(_, v)| v).collect()
}

/// 组装用量明细查询响应：过滤 → 最新在前 → 分页 → 附加按模型分组分析。
/// 分析基于**过滤后全集**（不受分页影响），使前端筛选与分组口径一致。
fn query_usage_events(records: &[UsageRecord], q: &UsageQuery) -> serde_json::Value {
    let mut filtered: Vec<&UsageRecord> = filter_usage_records(records, q);
    filtered.sort_by(|a, b| b.ts.cmp(&a.ts)); // 最新在前
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(50).max(1); // 默认 50/页（对齐 EasyCLIProxyAPI）
    let (items, total, total_pages) = paginate_usage_refs(&filtered, page, page_size);
    let items_json: Vec<serde_json::Value> = items
        .iter()
        .map(|r| {
            serde_json::json!({
                "ts": r.ts,
                "model": r.model,
                "ok": r.ok,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "latency_ms": r.latency_ms,
                "ttft_ms": r.ttft_ms,
                "error": r.error,
                "retry_count": r.retry_count,
                "retry_reason": r.retry_reason,
                "requested_model": r.requested_model,
                "actual_model": r.actual_model,
                "fallback_reason": r.fallback_reason,
            })
        })
        .collect();
    let filtered_owned: Vec<UsageRecord> = filtered.iter().map(|r| (*r).clone()).collect();
    serde_json::json!({
        "items": items_json,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "analysis": { "models": group_usage_by_model(&filtered_owned) },
    })
}

/// 读取用量文件字节内容；超过 10MB 时只读末尾 10MB 并丢弃首个不完整行（避免解析半行）。
/// 文件不存在 / 读取失败返回空（聚合结果即全零结构，符合前端契约）。
fn read_usage_tail() -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(usage_log_path()) else {
        return Vec::new();
    };
    const MAX: u64 = 10 * 1024 * 1024;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = Vec::with_capacity(len.min(MAX) as usize);
    if len > MAX {
        if f.seek(SeekFrom::End(-(MAX as i64))).is_err() || f.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        // 从下一个换行符起取（起点极可能落在某行中间）
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=pos);
        } else {
            buf.clear();
        }
    } else if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    buf
}

/// 聚合用量记录（纯函数，便于单测）：
/// - today 按「本地今日零点」epoch 毫秒（local_midnight_ms）切分；
/// - hourly 按 UTC 整点分桶（前端按本地时区渲染标签），固定最近 48 个含空桶；
/// - TPS = Σ输出tokens×1000 / Σ(latency−ttft)，仅统计 ok 且 ttft 有效的样本。
fn aggregate_usage(records: &[UsageRecord], now_utc_ms: i64, local_midnight_ms: i64) -> serde_json::Value {
    let (mut t_req, mut t_ok, mut t_fail, mut t_in, mut t_out) = (0i64, 0i64, 0i64, 0i64, 0i64);
    let (mut d_req, mut d_ok, mut d_fail, mut d_in, mut d_out) = (0i64, 0i64, 0i64, 0i64, 0i64);
    let mut lat_sum = 0i64;
    let mut tps_out_sum = 0i64;
    let mut tps_dur_sum = 0i64;
    let mut tps_samples = 0i64;

    const HOUR_MS: i64 = 3_600_000;
    let cur_bucket = now_utc_ms.div_euclid(HOUR_MS);
    let mut buckets = vec![0i64; 48];          // 每桶请求数
    let mut bucket_out = vec![0i64; 48];       // 每桶输出 tokens

    for r in records {
        t_req += 1;
        if r.ok { t_ok += 1 } else { t_fail += 1 }
        let i = r.input_tokens.unwrap_or(0);
        let o = r.output_tokens.unwrap_or(0);
        t_in += i;
        t_out += o;
        lat_sum += r.latency_ms;
        if r.ok
            && r.ttft_ms.is_some()
            && r.latency_ms > r.ttft_ms.unwrap()
            && r.output_tokens.is_some()
        {
            tps_out_sum += o;
            tps_dur_sum += r.latency_ms - r.ttft_ms.unwrap();
            tps_samples += 1;
        }
        if r.ts >= local_midnight_ms {
            d_req += 1;
            if r.ok { d_ok += 1 } else { d_fail += 1 }
            d_in += i;
            d_out += o;
        }
        // 最近 48 个整点桶内的记录才进趋势图
        let bucket = r.ts.div_euclid(HOUR_MS);
        if bucket > cur_bucket - 48 && bucket <= cur_bucket {
            let idx = (bucket - (cur_bucket - 47)) as usize;
            buckets[idx] += 1;
            bucket_out[idx] += o;
        }
    }

    let hourly: Vec<serde_json::Value> = (0..48)
        .map(|i| {
            serde_json::json!({
                "ts": (cur_bucket - 47 + i) * HOUR_MS,
                "requests": buckets[i as usize],
                "output_tokens": bucket_out[i as usize],
            })
        })
        .collect();

    let tps = if tps_dur_sum > 0 { tps_out_sum as f64 * 1000.0 / tps_dur_sum as f64 } else { 0.0 };
    let avg_latency = if t_req > 0 { lat_sum / t_req } else { 0 };

    serde_json::json!({
        "today": {
            "requests": d_req, "ok": d_ok, "failed": d_fail,
            "input_tokens": d_in, "output_tokens": d_out,
        },
        "overall": {
            "requests": t_req, "ok": t_ok, "failed": t_fail,
            "input_tokens": t_in, "output_tokens": t_out,
            "avg_latency_ms": avg_latency, "tps": tps, "tps_samples": tps_samples,
        },
        "hourly": hourly,
    })
}

#[tauri::command]
pub fn usage_summary() -> Result<serde_json::Value, String> {
    let bytes = read_usage_tail();
    let text = String::from_utf8_lossy(&bytes);
    let records: Vec<UsageRecord> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l.trim()).ok())
        .collect();
    let now_utc_ms = chrono::Utc::now().timestamp_millis();
    // 本地今日零点的 epoch 毫秒（用 naive 日期重建本地时间，避免直接减 offset 的歧义）
    let local_midnight_ms = {
        use chrono::{Datelike, Local, TimeZone};
        let d = Local::now().date_naive();
        Local::with_ymd_and_hms(&Local, d.year(), d.month(), d.day(), 0, 0, 0)
            .single()
            .map(|t| t.timestamp_millis())
            .unwrap_or(0)
    };
    Ok(aggregate_usage(&records, now_utc_ms, local_midnight_ms))
}

/// 用量明细查询命令（对标 EasyCLIProxyAPI 的 get_usage_events）：
/// 支持模型子串 / 状态 / 起始时间过滤 + 分页 + 按模型分组分析。
/// 复用 usage.jsonl 全量读取（超 10MB 只取尾部），与 usage_summary 同源。
#[tauri::command]
pub fn usage_events(
    model: Option<String>,
    status: Option<String>,
    since_ms: Option<i64>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<serde_json::Value, String> {
    let bytes = read_usage_tail();
    let text = String::from_utf8_lossy(&bytes);
    let records: Vec<UsageRecord> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l.trim()).ok())
        .collect();
    let q = UsageQuery { model, status, since_ms, page, page_size };
    Ok(query_usage_events(&records, &q))
}

#[cfg(test)]
mod test_chat_probe_tests {
    use super::*;

    #[test]
    fn chat_probe_url_uses_full_chat_completions_path() {
        // 回归：chat 协议曾拼成 /v1/chat —— 内核无此路由，必 404 {"detail":"Not Found"}
        assert_eq!(
            test_chat_url(8787, "chat"),
            "http://127.0.0.1:8787/v1/chat/completions"
        );
        assert_eq!(test_chat_url(8787, "messages"), "http://127.0.0.1:8787/v1/messages");
        assert_eq!(test_chat_url(8787, "responses"), "http://127.0.0.1:8787/v1/responses");
    }

    #[test]
    fn chat_probe_proto_normalization() {
        assert_eq!(test_chat_proto(None), "chat");
        assert_eq!(test_chat_proto(Some("chat")), "chat");
        assert_eq!(test_chat_proto(Some("messages")), "messages");
        assert_eq!(test_chat_proto(Some("responses")), "responses");
        assert_eq!(test_chat_proto(Some("bogus")), "chat");
    }

    #[test]
    fn chat_probe_payload_budget_leaves_room_for_reasoning() {
        // glm-5.3-flash 等模型默认带 reasoning：100 token 预算会被思考吃满导致正文为空
        // （converter.log 实测 22:26:31 finish=length tokens=119）。三协议探测统一给 512。
        for proto in ["chat", "messages", "responses"] {
            let p = test_chat_payload("glm-5.3-flash", proto);
            let budget = match proto {
                "responses" => p.get("max_output_tokens").and_then(|v| v.as_u64()),
                _ => p.get("max_tokens").and_then(|v| v.as_u64()),
            };
            assert_eq!(budget, Some(512), "协议 {proto} 的探测预算应为 512");
        }
    }

    #[test]
    fn chat_probe_model_is_injected() {
        assert_eq!(
            test_chat_payload("my-model", "responses").get("model").and_then(|v| v.as_str()),
            Some("my-model")
        );
        assert_eq!(
            test_chat_payload("my-model", "chat").get("model").and_then(|v| v.as_str()),
            Some("my-model")
        );
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    fn rec(ts: i64, ok: bool, out: Option<i64>, latency: i64, ttft: Option<i64>) -> UsageRecord {
        UsageRecord {
            ts,
            ok,
            input_tokens: Some(10),
            output_tokens: out,
            latency_ms: latency,
            ttft_ms: ttft,
            ..Default::default()
        }
    }

    /// 带模型名的样本（明细查询测试用）
    fn mrec(ts: i64, model: &str, ok: bool) -> UsageRecord {
        UsageRecord {
            ts,
            ok,
            model: model.to_string(),
            input_tokens: Some(100),
            output_tokens: Some(50),
            latency_ms: 200,
            ..Default::default()
        }
    }

    #[test]
    fn filter_by_model_is_case_insensitive_and_substring() {
        let rs = vec![
            mrec(100, "gpt-5.6-terra", true),
            mrec(200, "gpt-5.6-sol", true),
            mrec(300, "claude-sonnet-4.5", false),
        ];
        // 子串 + 大小写不敏感
        let q = UsageQuery { model: Some("TERRA".into()), ..Default::default() };
        let got = filter_usage_records(&rs, &q);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].model, "gpt-5.6-terra");

        // 空前缀/空白视为不过滤
        let q2 = UsageQuery { model: Some("   ".into()), ..Default::default() };
        assert_eq!(filter_usage_records(&rs, &q2).len(), 3);
    }

    #[test]
    fn filter_by_status_and_since() {
        let rs = vec![
            mrec(100, "a", true),
            mrec(200, "b", false),
            mrec(300, "c", true),
        ];
        let q = UsageQuery { status: Some("failed".into()), ..Default::default() };
        let got = filter_usage_records(&rs, &q);
        assert_eq!(got.len(), 1);
        assert!(!got[0].ok);

        let q2 = UsageQuery { status: Some("ok".into()), ..Default::default() };
        assert_eq!(filter_usage_records(&rs, &q2).len(), 2);

        // since_ms 含边界（ts >= since）
        let q3 = UsageQuery { since_ms: Some(200), ..Default::default() };
        let got3 = filter_usage_records(&rs, &q3);
        assert_eq!(got3.len(), 2);
        assert_eq!(got3[0].ts, 200);

        // 组合条件
        let q4 = UsageQuery { status: Some("ok".into()), since_ms: Some(200), ..Default::default() };
        let got4 = filter_usage_records(&rs, &q4);
        assert_eq!(got4.len(), 1);
        assert_eq!(got4[0].ts, 300);

        // 未知 status 值 → 不过滤
        let q5 = UsageQuery { status: Some("weird".into()), ..Default::default() };
        assert_eq!(filter_usage_records(&rs, &q5).len(), 3);
    }

    #[test]
    fn paginate_bounds_and_totals() {
        let rs: Vec<UsageRecord> = (0..25).map(|i| mrec(i as i64, "m", true)).collect();
        let refs: Vec<&UsageRecord> = rs.iter().collect();

        // 第一页
        let (page1, total, pages) = paginate_usage_refs(&refs, 1, 10);
        assert_eq!(total, 25);
        assert_eq!(pages, 3);
        assert_eq!(page1.len(), 10);
        assert_eq!(page1[0].ts, 0);

        // 末页不足一整页
        let (page3, _, _) = paginate_usage_refs(&refs, 3, 10);
        assert_eq!(page3.len(), 5);
        assert_eq!(page3[0].ts, 20);

        // 越界页 → 空列表但 total/pages 如实
        let (over, total2, pages2) = paginate_usage_refs(&refs, 99, 10);
        assert!(over.is_empty());
        assert_eq!(total2, 25);
        assert_eq!(pages2, 3);

        // page=0 视作 1；page_size=0 视作 1（防御脏入参）
        let (p0, _, _) = paginate_usage_refs(&refs, 0, 10);
        assert_eq!(p0.len(), 10);
        let (ps0, _, pages3) = paginate_usage_refs(&refs, 1, 0);
        assert_eq!(ps0.len(), 1);
        assert_eq!(pages3, 25);

        // 空输入
        let (empty, t0, p0c) = paginate_usage_refs(&[], 1, 10);
        assert!(empty.is_empty());
        assert_eq!(t0, 0);
        assert_eq!(p0c, 1); // 至少 1 页，避免前端除零
    }

    #[test]
    fn group_by_model_orders_by_requests_desc() {
        let rs = vec![
            mrec(1, "alpha", true),
            mrec(2, "beta", false),
            mrec(3, "alpha", true),
            mrec(4, "alpha", false),
            mrec(5, "", true), // 空模型名归入 (未知)
        ];
        let groups = group_usage_by_model(&rs);
        assert_eq!(groups.len(), 3);
        // 降序：alpha(3) > beta(1)
        assert_eq!(groups[0]["model"], "alpha");
        assert_eq!(groups[0]["requests"], 3);
        assert_eq!(groups[0]["ok"], 2);
        assert_eq!(groups[0]["failed"], 1);
        assert_eq!(groups[0]["input_tokens"], 300);
        assert_eq!(groups[0]["output_tokens"], 150);
        assert_eq!(groups[0]["avg_latency_ms"], 200);
        assert_eq!(groups[1]["model"], "beta");
        // (未知) 与 beta 同为 1 次，排序稳定即可（只断言存在）
        let unknown = groups.iter().find(|g| g["model"] == "(未知)");
        assert!(unknown.is_some(), "空模型名应归入 (未知)");
        // 无数据 → 空数组（非 null）
        assert!(group_usage_by_model(&[]).is_empty());
    }

    #[test]
    fn query_events_assembles_paged_response_newest_first() {
        let rs = vec![
            mrec(1, "alpha", true),
            mrec(2, "alpha", true),
            mrec(3, "alpha", true),
            mrec(4, "alpha", false),
            mrec(5, "alpha", false),
            mrec(6, "beta", true),
        ];
        // 过滤 alpha + ok：3 条（ts=1,2,3）；按最新在前 → [3,2,1]
        let q = UsageQuery {
            model: Some("alpha".into()),
            status: Some("ok".into()),
            page: Some(2),
            page_size: Some(2),
            ..Default::default()
        };
        let v = query_usage_events(&rs, &q);
        assert_eq!(v["total"], 3);
        assert_eq!(v["page"], 2);
        assert_eq!(v["page_size"], 2);
        assert_eq!(v["total_pages"], 2);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "第 2 页应只剩 1 条");
        assert_eq!(items[0]["ts"], 1, "最新在前后，第 2 页末条应是最早的 ts=1");
        assert_eq!(items[0]["model"], "alpha");
        assert_eq!(items[0]["ok"], true);
        assert_eq!(items[0]["input_tokens"], 100);
        assert_eq!(items[0]["output_tokens"], 50);
        assert_eq!(items[0]["latency_ms"], 200);

        // 缺省入参：page=1、page_size=50（与 EasyCLIProxyAPI 的 50/页 对齐）
        let v2 = query_usage_events(&rs, &UsageQuery::default());
        assert_eq!(v2["page"], 1);
        assert_eq!(v2["page_size"], 50);
        assert_eq!(v2["total"], 6);
        let items2 = v2["items"].as_array().unwrap();
        assert_eq!(items2[0]["ts"], 6, "首条应为最新的 ts=6");

        // 空输入 → 空 items 且 total=0、total_pages=1
        let v3 = query_usage_events(&[], &UsageQuery::default());
        assert_eq!(v3["total"], 0);
        assert_eq!(v3["total_pages"], 1);
        assert!(v3["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn query_events_includes_failure_and_fallback_fields() {
        let mut failed = mrec(10, "gpt-5.6-terra", false);
        failed.error = Some("HTTP 429 rate limited".into());
        failed.retry_count = 2;
        failed.retry_reason = Some("503".into());
        let mut downgraded = mrec(20, "gpt-5.6-sol", true);
        downgraded.requested_model = Some("gpt-5.6-terra".into());
        downgraded.actual_model = Some("gpt-5.6-sol".into());
        downgraded.fallback_reason = Some("model unavailable".into());
        let rs = vec![failed, downgraded];

        let v = query_usage_events(&rs, &UsageQuery::default());
        let items = v["items"].as_array().unwrap();
        // 最新在前 → downgraded 在前
        assert_eq!(items[0]["requested_model"], "gpt-5.6-terra");
        assert_eq!(items[0]["fallback_reason"], "model unavailable");
        assert_eq!(items[1]["error"], "HTTP 429 rate limited");
        assert_eq!(items[1]["retry_count"], 2);
    }

    #[test]
    fn query_events_includes_model_analysis() {
        let rs = vec![
            mrec(1, "alpha", true),
            mrec(2, "alpha", true),
            mrec(3, "beta", false),
        ];
        let v = query_usage_events(&rs, &UsageQuery::default());
        let models = v["analysis"]["models"].as_array().unwrap();
        assert_eq!(models.len(), 2, "两个模型应各成一组");
        assert_eq!(models[0]["model"], "alpha");
        assert_eq!(models[0]["requests"], 2);
        assert_eq!(models[0]["ok"], 2);
        assert_eq!(models[1]["model"], "beta");
        assert_eq!(models[1]["failed"], 1);

        // 分析随过滤器同步（只看 beta → 只剩 beta 组）
        let q = UsageQuery { model: Some("beta".into()), ..Default::default() };
        let v2 = query_usage_events(&rs, &q);
        let models2 = v2["analysis"]["models"].as_array().unwrap();
        assert_eq!(models2.len(), 1);
        assert_eq!(models2[0]["model"], "beta");
    }

    #[test]
    fn tps_buckets_and_today_split() {
        let now: i64 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
        let cur_hour_bucket = now.div_euclid(3_600_000);
        let h0 = cur_hour_bucket * 3_600_000;
        let records = vec![
            rec(h0, true, Some(100), 1_000, Some(200)),               // 有效样本: dur 800ms
            rec(h0, true, Some(50), 500, None),                       // ttft 缺失 → 不计 TPS
            rec(h0, false, Some(999), 100, Some(10)),                 // 失败 → 不计 TPS
            rec(h0 - 3_600_000, true, Some(300), 2_000, Some(500)),   // 上一小时: dur 1500ms
        ];
        // local_midnight = h0 → 全部计入 today
        let v = aggregate_usage(&records, now, h0);
        let overall = &v["overall"];
        assert_eq!(overall["requests"], 4);
        assert_eq!(overall["ok"], 3);
        assert_eq!(overall["failed"], 1);
        assert_eq!(overall["tps_samples"], 2);
        // TPS = (100+300)*1000 / (800+1500) ≈ 173.91
        let tps = overall["tps"].as_f64().unwrap();
        assert!((tps - 400_000.0 / 2_300.0).abs() < 0.01, "tps={tps}");
        let avg = overall["avg_latency_ms"].as_i64().unwrap();
        assert_eq!(avg, (1_000 + 500 + 100 + 2_000) / 4);
        let hourly = v["hourly"].as_array().unwrap();
        assert_eq!(hourly.len(), 48);
        assert_eq!(hourly[47]["ts"].as_i64().unwrap(), h0);
        assert_eq!(hourly[47]["requests"], 3);
        assert_eq!(hourly[47]["output_tokens"], 100 + 50 + 999); // 失败行 tokens 仍计入总量（不进 TPS）
        assert_eq!(hourly[46]["ts"].as_i64().unwrap(), h0 - 3_600_000);
        assert_eq!(hourly[46]["output_tokens"], 300);
        assert_eq!(hourly[0]["requests"], 0); // 空桶零填充
        assert_eq!(v["today"]["requests"], 3); // 上一小时记录（ts < h0=local_midnight）不算今天

        // local_midnight 晚于该记录 → 不计 today，仍计 overall
        let v2 = aggregate_usage(&records[..1], now, h0 + 1);
        assert_eq!(v2["today"]["requests"], 0);
        assert_eq!(v2["overall"]["requests"], 1);
    }

    #[test]
    fn test_kill_process_tree_by_pid_nonexistent() {
        // 传入不存在的 PID：taskkill 返回非零，应明确返回 Err 且不 panic
        let res = kill_process_tree_by_pid(9_999_999);
        #[cfg(target_os = "windows")]
        assert!(res.is_err(), "不存在的 PID 应返回 Err");
        #[cfg(not(target_os = "windows"))]
        assert!(res.is_ok());
    }

    #[test]
    fn test_kill_process_tree_by_pid_real_process() {
        // 启动一个休眠 10 秒的独立子进程
        let mut child = Command::new("python")
            .args(["-c", "import time; time.sleep(10)"])
            .spawn()
            .expect("failed to spawn test python process");
        let pid = child.id();
        assert!(pid > 0);

        // 使用精确 PID 结束进程树，taskkill 成功
        assert!(kill_process_tree_by_pid(pid).is_ok());

        // 有界等待确认退出
        assert!(wait_timeout(&mut child, std::time::Duration::from_millis(600)));
    }

    #[test]
    fn test_wait_timeout_does_not_block_forever() {
        // 验证即使子进程未退出，wait_timeout 也会在限定时间内返回 false，绝不无限挂起
        let mut child = Command::new("python")
            .args(["-c", "import time; time.sleep(5)"])
            .spawn()
            .expect("failed to spawn test python process");

        let start = std::time::Instant::now();
        let exited = wait_timeout(&mut child, std::time::Duration::from_millis(60));
        let elapsed = start.elapsed();

        assert!(!exited, "5s 进程在 60ms 内不应被标记为退出");
        assert!(elapsed < std::time::Duration::from_millis(300), "不得发生无限阻塞");

        // 清理测试子进程
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn test_proxy_stop_lifecycle_state_consistency() {
        // 验证 Child/PID 状态自洽：
        // 1. 已提前退出的进程能被检测到退出并安全 take 释放句柄
        let mut child = Command::new("python")
            .args(["-c", "import sys; sys.exit(0)"])
            .spawn()
            .expect("failed to spawn test python process");
        let _ = child.wait(); // 确保已经退出

        let handle = ProxyHandle(std::sync::Mutex::new(Some(child)));
        {
            let mut guard = handle.0.lock().unwrap();
            let c = guard.as_mut().unwrap();
            assert!(c.try_wait().unwrap().is_some());
            // 确认已退出后 take 释放
            let _ = guard.take();
        }

        // 2. 重复执行：再次检查时 guard 为 None，完全安全幂等
        {
            let guard = handle.0.lock().unwrap();
            assert!(guard.is_none(), "释放后应为 None，重复 stop 不发生 panic");
        }
    }
}
