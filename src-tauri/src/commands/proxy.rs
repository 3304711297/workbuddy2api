//! 反代控制与测试、日志管理与用量统计聚合

use crate::ProxyHandle;
use futures_util::StreamExt; // 流式读取 SSE 字节块（配合 reqwest "stream" feature）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{Manager, State};

use super::shared::{env_nonempty, local_app_dir, user_home};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TestChatResult {
    pub success: bool,
    pub model: String,
    pub response: String,
    pub latency_ms: u64,
    /// 首字时延（毫秒）：请求发出到第一个非空 delta.content 的耗时；None 序列化为 null 表示未测得
    pub ttft_ms: Option<u64>,
    pub error: Option<String>,
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
    // 用量统计：每次聊天请求完成后由 converter 向该文件追加一行 JSONL，供 usage_summary 聚合
    let usage_dir = local_app_dir().join("usage");
    let _ = std::fs::create_dir_all(&usage_dir);
    cmd.arg("--usage-log").arg(usage_dir.join("usage.jsonl"));

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

/// 打开应用数据目录（%LOCALAPPDATA%\codebuddy2openai，即日志文件所在目录）。
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

    // 成功停止后同样轮转一次日志：子进程已退出、兜底清理也已等待完毕，
    // 此时文件不再被写入；失败（占用未释放）静默跳过，下次启动时会再次尝试
    if stopped {
        rotate_proxy_log_if_oversized();
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

    // 30s 总超时：reqwest 客户端级 timeout 覆盖「发起连接 → 响应体读取完毕」全过程，
    // 流式读取中途挂起同样会在 30s 处触发 Err，无需单独的读超时
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // 对标上游 provider_health.rs 的流式判首包思路：发 stream:true 请求逐块解析 SSE，
    // 第一个非空 delta.content 到达的时刻即为 TTFT（首字时延）
    let payload = serde_json::json!({
        "model": target_model,
        "messages": [
            {"role": "user", "content": "Ping: 请仅回答 PONG"}
        ],
        "max_tokens": 100,
        "stream": true,
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
                ttft_ms: None,
                error: Some(e.to_string()),
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
            // 只取 choices[0].delta.content；空内容（如 role 帧）与 reasoning_content 均不计 TTFT
            let delta = val
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
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
        });
    }

    Ok(TestChatResult {
        success: !response_acc.is_empty(),
        model: target_model,
        response: response_acc,
        latency_ms,
        ttft_ms,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// 用量统计（usage_summary）：聚合 converter 每请求写出的 JSONL 用量文件
// ---------------------------------------------------------------------------

/// 用量统计文件路径：%LOCALAPPDATA%\codebuddy2openai\usage\usage.jsonl（proxy_start 传给 converter）
fn usage_log_path() -> PathBuf {
    local_app_dir().join("usage").join("usage.jsonl")
}

/// 单行用量记录（与 converter.py `_record_usage` 的 JSONL 字段一一对应）
#[derive(Deserialize, Debug)]
struct UsageRecord {
    ts: i64,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    input_tokens: Option<i64>,
    #[serde(default)]
    output_tokens: Option<i64>,
    #[serde(default)]
    latency_ms: i64,
    #[serde(default)]
    ttft_ms: Option<i64>,
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
        }
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
}
