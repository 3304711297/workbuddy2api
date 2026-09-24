import time
import pytest
from unittest.mock import MagicMock
import converter

def test_credential_readiness_classification():
    """验证凭据就绪状态三级分类：
    0: READY_INSTANT (access token 充足且未过期)
    1: READY_REFRESHABLE (access token 过期但 refresh token 健在)
    2: UNREADY (两者均过期或凭据缺失)
    """
    now_ms = int(time.time() * 1000)

    # 1. READY_INSTANT: token 未过期（未来 1 小时）
    sess_instant = {
        "auth": {
            "token": "valid_token",
            "expiresAt": now_ms + 3600_000,
            "refreshToken": "ref_1"
        }
    }
    assert converter._get_credential_readiness(sess_instant) == 0

    # 2. READY_REFRESHABLE: access token 已过期，但 refresh token 未过期
    sess_refreshable = {
        "auth": {
            "token": "expired_token",
            "expiresAt": now_ms - 10_000,
            "refreshToken": "ref_valid",
            "refreshExpiresAt": now_ms + 86400_000
        }
    }
    assert converter._get_credential_readiness(sess_refreshable) == 1

    # 3. UNREADY: access token 过期且 refresh token 过期或缺失
    sess_unready = {
        "auth": {
            "token": "expired_token",
            "expiresAt": now_ms - 10_000,
            "refreshToken": ""
        }
    }
    assert converter._get_credential_readiness(sess_unready) == 2


def test_rotator_prioritizes_instant_ready_over_expired_soonest():
    """Direction A 契约：
    凭据可用性门禁（credential_readiness）优先于资产到期日。
    账号 A 资产虽然 10 分钟后就过期，但 access token 已过期需网络续期；
    账号 B 资产 2 小时后过期，但 access token 即时可用。
    调度器必须优先选择即时可用的账号 B，消灭主路径上的同步网络延迟。
    """
    now = int(time.time())
    now_ms = now * 1000

    accounts = {
        "uid-expired-token-soonest-asset": {
            "credit": {"expire_at": now + 600},
            "auth": {
                "token": "expired",
                "expiresAt": now_ms - 1000,
                "refreshToken": "valid_ref"
            }
        },
        "uid-instant-ready-later-asset": {
            "credit": {"expire_at": now + 7200},
            "auth": {
                "token": "instant_valid",
                "expiresAt": now_ms + 3600_000,
                "refreshToken": "valid_ref"
            }
        }
    }

    class MockCredMgr:
        def list_all_accounts(self):
            return list(accounts.items())

    rotator = converter.AccountRotator(cred_mgr=MockCredMgr(), mode="roundrobin")
    candidates = rotator.get_candidate_uids_tiered("deepseek-v4-pro")

    assert len(candidates) == 2
    # uid-instant-ready-later-asset 必须排第一，因为它是即时就绪的
    assert candidates[0] == "uid-instant-ready-later-asset"
    assert candidates[1] == "uid-expired-token-soonest-asset"


def test_credential_manager_singleflight_refresh(monkeypatch, tmp_path):
    """Direction A 契约：
    单 UID 刷新防重（Single-flight Deduplication）。
    当多个并发请求或协程同时触发同一 uid 的刷新时，
    只有首个获得锁的任务发起真实网络调用，其余等待后直接复用新凭据返回，严禁并发重复刷爆上游。
    """
    import threading
    import json
    from pathlib import Path

    acc_file = tmp_path / "accounts.json"
    initial_accounts = {
        "active_uid": "u1",
        "accounts": {
            "u1": {
                "account": {"uid": "u1"},
                "auth": {
                    "token": "old_token",
                    "refreshToken": "ref_token",
                    "expiresAt": int(time.time() * 1000) - 5000
                }
            }
        }
    }
    acc_file.write_text(json.dumps(initial_accounts), encoding="utf-8")
    monkeypatch.setattr(converter, "_accounts_file", lambda: acc_file)

    network_calls = []

    class MockHttpxClient:
        def __init__(self, *args, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def post(self, url, headers=None, json=None):
            time.sleep(0.05)  # 模拟网络延迟
            network_calls.append(url)
            return MagicMock(json=lambda: {
                "code": 0,
                "data": {
                    "token": "new_refreshed_token",
                    "expiresIn": 3600,
                    "refreshToken": "new_ref_token"
                }
            })

    monkeypatch.setattr(converter.httpx, "Client", MockHttpxClient)

    cred_mgr = converter.CredentialManager()
    threads = []
    session_snapshot = initial_accounts["accounts"]["u1"]

    for _ in range(5):
        t = threading.Thread(target=cred_mgr._refresh_session_tokens, args=("u1", session_snapshot))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    # 5 个并发线程只能产生 1 次真实网络刷新调用
    assert len(network_calls) == 1
    # 且落盘文件中的 token 已被刷新为 new_refreshed_token
    cfg = json.loads(acc_file.read_text(encoding="utf-8"))
    assert cfg["accounts"]["u1"]["auth"]["token"] == "new_refreshed_token"

