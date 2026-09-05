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

// ---------------------------------------------------------------------------
// 登录与授权 (OAuth)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_begin(platform: String) -> Result<LoginState, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/state?platform={platform}");
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

#[tauri::command]
pub async fn auth_poll(state: String) -> Result<TokenPollResult, String> {
    let url = format!("https://copilot.tencent.com/v2/plugin/auth/token?state={state}");
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

    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let msg = body.get("msg").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let data = body.get("data").cloned().filter(|v| !v.is_null());

    // 如果拿到完整 Token 数据，自动保存入多账号库并设为活跃账号
    if let Some(ref d) = data {
        if let Some(auth_val) = d.get("auth").or(Some(d)) {
            let token = auth_val.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default();
            if !token.is_empty() {
                // 请求 account 接口以获取详细资料 (nickname, uid 等)
                let acct_url = "https://copilot.tencent.com/v2/plugin/account";
                let acct_resp = client
                    .get(acct_url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "codebuddy2openai/2.0")
                    .send()
                    .await;

                if let Ok(acct_r) = acct_resp {
                    if let Ok(acct_json) = acct_r.json::<serde_json::Value>().await {
                        if let Some(acct_data) = acct_json.get("data") {
                            let uid = acct_data.get("uid").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                            if !uid.is_empty() {
                                let full_session = serde_json::json!({
                                    "account": acct_data,
                                    "auth": auth_val
                                });
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
        let exp = val.pointer("/auth/expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let expired = now_ms >= (exp - 60_000);
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

    let client = reqwest::Client::new();
    let resp = client
        .post("https://copilot.tencent.com/v2/plugin/auth/token/refresh")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("X-Refresh-Token", refresh_token)
        .header("X-Auth-Refresh-Source", "plugin")
        .header("X-User-Id", uid_str)
        .header("User-Agent", "codebuddy2openai/2.0")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("刷新网络错误: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("刷新失败: {}", body.get("msg").unwrap_or(&body)));
    }

    if let Some(new_data) = body.get("data") {
        if let Some(auth_mut) = session.get_mut("auth") {
            if let Some(obj) = auth_mut.as_object_mut() {
                for (k, v) in new_data.as_object().unwrap_or(&serde_json::Map::new()) {
                    obj.insert(k.clone(), v.clone());
                }
                obj.insert("lastRefreshTime".into(), serde_json::json!(chrono::Utc::now().timestamp_millis()));
            }
        }
    }

    save_accounts_state(&st)?;
    Ok("Token 刷新成功".into())
}
