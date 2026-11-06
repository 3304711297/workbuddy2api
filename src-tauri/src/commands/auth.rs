//! 登录与授权 (OAuth) 以及多账号管理命令

use serde::{Deserialize, Serialize};

use super::shared::{load_accounts_state, save_accounts_state};

// ---------------------------------------------------------------------------
// 登录数据模型
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LoginState {
    pub state: String,
    pub auth_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenPollResult {
    pub code: i64,
    pub msg: String,
    pub data: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountItem {
    pub uid: String,
    pub nickname: String,
    pub phone_number: Option<String>,
    pub enterprise_name: Option<String>,
    pub token_expires_at: i64,
    pub token_expired: bool,
    pub is_active: bool,
    pub last_updated: i64,
}

/// 把上游下发的相对有效期（expiresIn / refreshExpiresIn）归一成绝对时间戳。
///
/// auth/token 与刷新响应给的是「从签发时刻起多少秒」，而账号列表、内核
/// `_auth_is_expired()`、`token_refresher.py` 都只认 `expiresAt`。缺字段会被
/// 当成 0 → 刚签发的新凭据立即显示「token 已过期」。刷新路径也不能保留旧
/// 绝对时间：响应里的相对 TTL 属于新 token，旧 expiresAt 已经失效。
fn normalize_auth_expiry(auth: &mut serde_json::Value, now_ms: i64) {
    let Some(obj) = auth.as_object_mut() else {
        return;
    };
    let mut saw_relative_ttl = false;
    if let Some(seconds) = obj.get("expiresIn").and_then(|v| v.as_i64()).filter(|v| *v > 0) {
        obj.insert(
            "expiresAt".into(),
            serde_json::json!(now_ms.saturating_add(seconds.saturating_mul(1_000))),
        );
        saw_relative_ttl = true;
    }
    if let Some(seconds) = obj
        .get("refreshExpiresIn")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
    {
        obj.insert(
            "refreshExpiresAt".into(),
            serde_json::json!(now_ms.saturating_add(seconds.saturating_mul(1_000))),
        );
        saw_relative_ttl = true;
    }
    if saw_relative_ttl {
        obj.insert("lastRefreshTime".into(), serde_json::json!(now_ms));
    }
}

fn auth_session_for_save(
    acct_data: &serde_json::Value,
    auth_val: &serde_json::Value,
    now_ms: i64,
) -> serde_json::Value {
    let mut saved_auth = auth_val.clone();
    normalize_auth_expiry(&mut saved_auth, now_ms);
    serde_json::json!({ "account": acct_data, "auth": saved_auth })
}

fn merge_refreshed_auth(session: &mut serde_json::Value, new_data: &serde_json::Value, now_ms: i64) {
    if let Some(auth_mut) = session.get_mut("auth") {
        if let Some(obj) = auth_mut.as_object_mut() {
            if let Some(new_obj) = new_data.as_object() {
                for (k, v) in new_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        normalize_auth_expiry(auth_mut, now_ms);
    }
}

/// 与账号卡片现有 60 秒宽限保持一致；缺失/非法 expiresAt 维持「已过期」。
fn auth_token_expiry(auth: &serde_json::Value, now_ms: i64) -> (i64, bool) {
    let exp = auth.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    (exp, now_ms >= exp.saturating_sub(60_000))
}

// ---------------------------------------------------------------------------
// 登录与授权 (OAuth)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_begin(platform: String) -> Result<LoginState, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/state?platform={platform}");
    // 腾讯上游国内直连即可，绕过环境代理，避免受 Karing 节点故障影响
    let client = super::shared::upstream_client(30);
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

#[tauri::command]
pub async fn auth_poll(state: String) -> Result<TokenPollResult, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/token?state={state}");
    // 腾讯上游国内直连即可，绕过环境代理，避免受 Karing 节点故障影响
    let client = super::shared::upstream_client(30);
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

    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let msg = body.get("msg").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let data = body.get("data").cloned().filter(|v| !v.is_null());

    // 如果拿到完整 Token 数据，自动保存入多账号库并设为活跃账号
    if let Some(ref d) = data {
        if let Some(auth_val) = d.get("auth").or(Some(d)) {
            let token = auth_val.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default();
            if !token.is_empty() {
                let auth_received_at_ms = chrono::Utc::now().timestamp_millis();
                // 请求 account 接口以获取详细资料 (nickname, uid 等)
                let acct_url = "https://copilot.tencent.com/v2/plugin/account";
                let acct_resp = client
                    .get(acct_url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "workbuddy2api/2.0")
                    .send()
                    .await;

                if let Ok(acct_r) = acct_resp {
                    if let Ok(acct_json) = acct_r.json::<serde_json::Value>().await {
                        if let Some(acct_data) = acct_json.get("data") {
                            let uid = acct_data.get("uid").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                            if !uid.is_empty() {
                                let full_session = auth_session_for_save(
                                    acct_data,
                                    auth_val,
                                    auth_received_at_ms,
                                );
                                let mut st = load_accounts_state();
                                st.active_uid = uid.clone();
                                st.accounts.insert(uid, full_session);
                                let _ = save_accounts_state(&st);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(TokenPollResult { code, msg, data })
}

// ---------------------------------------------------------------------------
// 多账号管理 (Accounts Management)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn accounts_list() -> Result<Vec<AccountItem>, String> {
    let st = load_accounts_state();
    let mut list = Vec::new();
    let now_ms = chrono::Utc::now().timestamp_millis();

    for (uid, val) in &st.accounts {
        let nickname = val.pointer("/account/nickname").and_then(|v| v.as_str()).unwrap_or("—").to_string();
        let phone = val.pointer("/account/phoneNumber").and_then(|v| v.as_str()).map(|s| s.to_string());
        let enterprise = val.pointer("/account/enterpriseName").and_then(|v| v.as_str()).map(|s| s.to_string());
        let (exp, expired) = val
            .get("auth")
            .map(|auth| auth_token_expiry(auth, now_ms))
            .unwrap_or((0, true));
        let is_active = uid == &st.active_uid;

        list.push(AccountItem {
            uid: uid.clone(),
            nickname,
            phone_number: phone,
            enterprise_name: enterprise,
            token_expires_at: exp,
            token_expired: expired,
            is_active,
            last_updated: now_ms,
        });
    }

    // 活跃账号排在最前面
    list.sort_by(|a, b| b.is_active.cmp(&a.is_active));
    Ok(list)
}

#[tauri::command]
pub fn accounts_switch(uid: String) -> Result<String, String> {
    let mut st = load_accounts_state();
    if !st.accounts.contains_key(&uid) {
        return Err(format!("未找到账号: {uid}"));
    }
    st.active_uid = uid.clone();
    save_accounts_state(&st)?;
    Ok(format!("已切换活跃账号至 {uid}"))
}

#[tauri::command]
pub fn accounts_delete(uid: String) -> Result<String, String> {
    let mut st = load_accounts_state();
    st.accounts.remove(&uid);
    if st.active_uid == uid {
        st.active_uid = st.accounts.keys().next().cloned().unwrap_or_default();
    }
    save_accounts_state(&st)?;
    Ok(format!("已删除账号 {uid}"))
}

#[tauri::command]
pub async fn accounts_refresh_token(uid: Option<String>) -> Result<String, String> {
    let mut st = load_accounts_state();
    let target_uid = uid.unwrap_or_else(|| st.active_uid.clone());
    let session = st.accounts.get_mut(&target_uid).ok_or_else(|| format!("未找到指定账号: {target_uid}"))?;

    let auth = session.get("auth").ok_or("缺少 auth 节点")?;
    let refresh_token = auth.get("refreshToken").and_then(|v| v.as_str()).ok_or("缺少 refreshToken")?;
    let access_token = auth.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default();
    let acct = session.get("account").ok_or("缺少 account 节点")?;
    let uid_str = acct.get("uid").and_then(|v| v.as_str()).unwrap_or_default();

    // 腾讯上游国内直连即可，绕过环境代理，避免受 Karing 节点故障影响
    let client = super::shared::upstream_client(30);
    let resp = client
        .post("https://copilot.tencent.com/v2/plugin/auth/token/refresh")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("X-Refresh-Token", refresh_token)
        .header("X-Auth-Refresh-Source", "plugin")
        .header("X-User-Id", uid_str)
        .header("User-Agent", "workbuddy2api/2.0")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("刷新网络错误: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("刷新失败: {}", body.get("msg").unwrap_or(&body)));
    }

    if let Some(new_data) = body.get("data") {
        merge_refreshed_auth(session, new_data, chrono::Utc::now().timestamp_millis());
    }

    save_accounts_state(&st)?;
    Ok("Token 刷新成功".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn login_and_refresh_paths_are_wired_to_expiry_normalization() {
        // 归一函数本身正确，但调用点被绕开时新登录仍会缺 expiresAt。
        // 用生产源码切片锁定两条写入路径的接线（网络命令本身难以在单测里驱动）。
        let src = include_str!("auth.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        let poll_start = production.find("pub async fn auth_poll").expect("缺少 auth_poll");
        let poll_end = production[poll_start..]
            .find("// 多账号管理")
            .map(|i| poll_start + i)
            .expect("缺少 auth_poll 结束边界");
        let poll = &production[poll_start..poll_end];
        assert!(
            poll.contains("auth_session_for_save("),
            "auth_poll 未在落盘前调用有效期归一化"
        );
        assert!(
            poll.contains("auth_received_at_ms"),
            "auth_poll 必须使用接收时刻作为相对 TTL 的锚点"
        );

        let refresh_start = production
            .find("pub async fn accounts_refresh_token")
            .expect("缺少 accounts_refresh_token");
        let refresh = &production[refresh_start..];
        assert!(
            refresh.contains("merge_refreshed_auth("),
            "手动刷新未调用有效期归一化，会保留旧 token 的绝对过期时间"
        );

        let list_start = production.find("pub fn accounts_list").expect("缺少 accounts_list");
        let list_end = production[list_start..]
            .find("pub fn accounts_switch")
            .map(|i| list_start + i)
            .expect("缺少 accounts_list 结束边界");
        let list = &production[list_start..list_end];
        assert!(
            list.contains("auth_token_expiry("),
            "账号列表未复用统一的过期判定"
        );
    }

    #[test]
    fn auth_poll_persists_absolute_expiry_for_relative_token_ttl() {
        let received_at_ms = 1_793_947_135_517_i64;
        let account = json!({ "uid": "uid-login", "nickname": "新登录账号" });
        // auth/token 的真实形状：只有相对秒数，没有 expiresAt / refreshExpiresAt。
        let auth = json!({
            "accessToken": "new-access-token",
            "refreshToken": "new-refresh-token",
            "expiresIn": 2_592_000,
            "refreshExpiresIn": 5_183_999,
        });

        let session = auth_session_for_save(&account, &auth, received_at_ms);

        assert_eq!(
            session.pointer("/auth/expiresAt").and_then(|v| v.as_i64()),
            Some(received_at_ms + 2_592_000_000),
            "登录落盘前必须把 expiresIn 换算成绝对 expiresAt"
        );
        assert_eq!(
            session.pointer("/auth/refreshExpiresAt").and_then(|v| v.as_i64()),
            Some(received_at_ms + 5_183_999_000),
            "refreshExpiresIn 同理，缺字段会让后台续期与账号卡片各自误判"
        );
        let (exp, expired) = auth_token_expiry(session.get("auth").unwrap(), received_at_ms + 1_000);
        assert_eq!(exp, received_at_ms + 2_592_000_000);
        assert!(!expired, "刚签发的新 token 不得被账号列表判为已过期");
    }

    #[test]
    fn refresh_uses_new_relative_ttl_instead_of_stale_absolute_expiry() {
        let refreshed_at_ms = 1_793_950_000_000_i64;
        let mut session = json!({
            "account": { "uid": "uid-refresh" },
            "auth": {
                "accessToken": "old-access-token",
                "refreshToken": "old-refresh-token",
                "expiresIn": 60,
                "expiresAt": 1_000,
                "refreshExpiresAt": 2_000,
            }
        });
        let new_data = json!({
            "accessToken": "rotated-access-token",
            "refreshToken": "rotated-refresh-token",
            "expiresIn": 3_600,
            "refreshExpiresIn": 7_200,
        });

        merge_refreshed_auth(&mut session, &new_data, refreshed_at_ms);

        assert_eq!(
            session.pointer("/auth/expiresAt").and_then(|v| v.as_i64()),
            Some(refreshed_at_ms + 3_600_000),
            "刷新响应给的是新 token 的相对 TTL，不能保留旧 token 的绝对过期时间"
        );
        assert_eq!(
            session.pointer("/auth/refreshExpiresAt").and_then(|v| v.as_i64()),
            Some(refreshed_at_ms + 7_200_000)
        );
        let (_, expired) = auth_token_expiry(session.get("auth").unwrap(), refreshed_at_ms + 1_000);
        assert!(!expired);
    }
}
