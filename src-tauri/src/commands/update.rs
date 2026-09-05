//! 更新检查（check_app_update）：轻量查询 GitHub Release，不做自动更新

use serde::Serialize;
use std::time::Duration;

/// 更新检查结果（前端契约：失败不打断流程，返回 update_available=false + error 描述）
#[derive(Serialize)]
pub struct AppUpdateInfo {
    current: String,
    latest: Option<String>,
    update_available: bool,
    release_url: Option<String>,
    error: Option<String>,
}

/// 版本比较：去 v 前缀后按 '.' 分段数值比较，段数不齐以 0 补齐
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|s| s.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

const RELEASE_API: &str = "https://api.github.com/repos/3304711297/codebuddy2openai/releases/latest";

/// 拉取最新 release 元数据；proxy 传 Some 时走显式代理
async fn fetch_latest_release(proxy: Option<&str>) -> Result<serde_json::Value, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("codebuddy2openai-gui")
        .timeout(Duration::from_secs(10));
    if let Some(p) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
    }
    let resp = builder
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_app_update() -> Result<AppUpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    // 先直连（reqwest 默认吃环境变量代理），失败再走本机回退代理 127.0.0.1:3067（用户环境惯例）
    let payload = match fetch_latest_release(None).await {
        Ok(v) => Ok(v),
        Err(_) => fetch_latest_release(Some("http://127.0.0.1:3067")).await,
    };
    Ok(match payload {
        Ok(v) => {
            let tag = v
                .get("tag_name")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let release_url = v
                .get("html_url")
                .and_then(|u| u.as_str())
                .map(|s| s.to_string());
            if tag.is_empty() {
                AppUpdateInfo {
                    current,
                    latest: None,
                    update_available: false,
                    release_url,
                    error: Some("release 数据缺少 tag_name".into()),
                }
            } else {
                let latest = tag.trim_start_matches('v').to_string();
                let update_available = version_cmp(&latest, &current) == std::cmp::Ordering::Greater;
                AppUpdateInfo {
                    current,
                    latest: Some(latest),
                    update_available,
                    release_url,
                    error: None,
                }
            }
        }
        Err(e) => AppUpdateInfo {
            current,
            latest: None,
            update_available: false,
            release_url: None,
            error: Some(e),
        },
    })
}

#[cfg(test)]
mod version_tests {
    use super::*;

    #[test]
    fn version_compare() {
        use std::cmp::Ordering;
        assert_eq!(version_cmp("0.2.1", "0.2.0"), Ordering::Greater);
        assert_eq!(version_cmp("v0.2.10", "0.2.9"), Ordering::Greater);
        assert_eq!(version_cmp("0.2.0", "0.2.0"), Ordering::Equal);
        assert_eq!(version_cmp("0.1.9", "0.2.0"), Ordering::Less);
        assert_eq!(version_cmp("0.2", "0.2.0"), Ordering::Equal); // 段数不齐补 0
    }
}
