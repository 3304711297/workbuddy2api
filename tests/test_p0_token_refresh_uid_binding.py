import json
import pytest
from pathlib import Path
import converter

def test_save_tokens_binds_to_target_uid_not_active_uid_when_switched(tmp_path, monkeypatch):
    """P0-1 竞态防御契约：
    当刷新 A 账号凭据在途时，若外部（如 GUI）将 active_uid 切换为 B，
    写回必须精准落入 A 账号，严禁写回当前的 active_uid (B) 导致账号串号。
    """
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "workbuddy2api"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    
    import time
    now_ms = int(time.time() * 1000)
    
    # 初始状态：active_uid 为 uid_A，同时存在 uid_B
    acc_file.write_text(json.dumps({
        "active_uid": "uid_A",
        "accounts": {
            "uid_A": {
                "auth": {"accessToken": "token_A_old", "refreshToken": "ref_A_old", "expiresAt": now_ms + 100000},
                "account": {"uid": "uid_A", "nickname": "Account A"}
            },
            "uid_B": {
                "auth": {"accessToken": "token_B_orig", "refreshToken": "ref_B_orig", "expiresAt": now_ms + 100000},
                "account": {"uid": "uid_B", "nickname": "Account B"}
            }
        }
    }, ensure_ascii=False), encoding="utf-8")
    
    info_file = tmp_path / "test.info"
    info_file.write_text(json.dumps({
        "auth": {"accessToken": "token_A_old", "expiresAt": now_ms + 100000},
        "account": {"uid": "uid_A"}
    }), encoding="utf-8")
    
    cm = converter.CredentialManager(info_file)
    # T0: 读取当前活跃账号 A 的 session
    session_A = cm.get_active_session()
    assert session_A["account"]["uid"] == "uid_A"
    
    # T1: 外部发生账号切换，active_uid 变为 uid_B
    current_cfg = json.loads(acc_file.read_text(encoding="utf-8"))
    current_cfg["active_uid"] = "uid_B"
    acc_file.write_text(json.dumps(current_cfg, ensure_ascii=False), encoding="utf-8")
    
    # T2: A 的刷新请求返回，调用 _save_tokens
    new_auth_A = {"accessToken": "token_A_refreshed_new", "refreshToken": "ref_A_new", "expiresAt": 9999999}
    cm._save_tokens(session_A, new_auth_A)
    
    # T3: 验证写回结果
    updated_acc = json.loads(acc_file.read_text(encoding="utf-8"))
    # 核心断言 1：A 账号的 Token 必须被成功更新
    assert updated_acc["accounts"]["uid_A"]["auth"]["accessToken"] == "token_A_refreshed_new", \
        "A 账号的刷新结果未能写入 A 账号！"
    # 核心断言 2：B 账号的 Token 绝对不能被 A 的刷新结果污染覆写
    assert updated_acc["accounts"]["uid_B"]["auth"]["accessToken"] == "token_B_orig", \
        "P0 竞态发生：A 账号的刷新结果被错误地写入了当前活跃的 B 账号！"
    # 核心断言 3：当前 active_uid 保持为 B
    assert updated_acc["active_uid"] == "uid_B"
