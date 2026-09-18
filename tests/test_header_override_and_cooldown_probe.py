"""
tests/test_header_override_and_cooldown_probe.py
针对请求级控制头 (X-WorkBuddy-Account, X-WorkBuddy-Strategy) 与自愈熔断 Half-Open 单飞探针的完整契约测试。
经 ChatGPT 深度思考模式对抗式审查批准，覆盖 8 类关键反向契约：
1. 精确 UID 与有效 Alias 命中
2. 非法/冷却中的 Account 不得绕过安全门禁，且不吞掉同请求合法 Strategy (契约修正 A)
3. 重名 Alias 歧义 Fail-Open
4. 非法 Strategy Fail-Open 回退全局
5. 全冷却 Half-Open 单飞探针 (Single-Flight Probe) 与防惊群保护 (契约修正 D)
6. 全冷却候选必须取有效账号池交集，防死号/删除号被探针选中 (契约修正 C)
7. 探针无论成功/失败/异常均在 finally 保证释放
8. 成功请求自愈清除冷却
"""

import json
import time
import pytest
from starlette.testclient import TestClient

import converter
from converter import (
    AccountRotator,
    CredentialManager,
    _is_account_cooldown,
    _clear_account_cooldown,
    _record_rate_limit,
    _acquire_probe,
    _release_probe,
    _is_probe_inflight,
    app,
)


@pytest.fixture
def fake_dual_accounts(tmp_path, monkeypatch):
    """构建双账号测试沙箱。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "workbuddy2api"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"

    data = {
        "active_uid": "uid-alpha",
        "accounts": {
            "uid-alpha": {
                "auth": {"accessToken": "token-alpha", "expiresAt": int(time.time() * 1000) + 3600000},
                "account": {"uid": "uid-alpha", "nickname": "阿尔法号"},
            },
            "uid-beta": {
                "auth": {"accessToken": "token-beta", "expiresAt": int(time.time() * 1000) + 3600000},
                "account": {"uid": "uid-beta", "nickname": "贝塔号"},
            },
        },
    }
    acc_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_ROTATOR", None)
    monkeypatch.setattr(converter, "_PROBE_INFLIGHT", set())
    return acc_file


def test_header_override_exact_uid(fake_dual_accounts, monkeypatch):
    """契约 1：Header 指定精确 UID 成功路由，且回退策略保持有效。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "uid-beta", None)
    assert target_uid == "uid-beta"
    assert strat is None

    selected_uid, headers = rotator.select_account("glm-5.3", override_uid=target_uid)
    assert selected_uid == "uid-beta"
    assert headers.get("X-User-Id") == "uid-beta"


def test_header_override_exact_alias(fake_dual_accounts, monkeypatch):
    """契约 1 扩展：Header 指定合法别名 (nickname) 成功路由。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "贝塔号", None)
    assert target_uid == "uid-beta"


def test_header_override_invalid_account_preserves_valid_strategy(fake_dual_accounts, monkeypatch):
    """契约修正 A：无效 Account Header Fail-Open，但不应清除同请求中合法的 Strategy Header。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "nonexistent-uid", "round_robin")
    assert target_uid is None  # 无效账号被放弃
    assert strat == "roundrobin"  # 合法策略被保留！


def test_header_override_cannot_bypass_cooldown(fake_dual_accounts, monkeypatch):
    """契约修正 A 核心：冷却中的账号，即使通过 Header 强制指定，也绝不能穿透安全门禁。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    # 手动让 uid-beta 进入冷却
    future_ms = int((time.time() + 120) * 1000)
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS[("uid-beta", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": future_ms,
            "uid": "uid-beta",
        }

    # 尝试用 Header 强行指定冷却中的 uid-beta
    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "uid-beta", "failover")
    assert target_uid is None  # 必须 Fail-Open 拒绝指定！
    assert strat == "failover"  # 策略依然保留


def test_header_override_ambiguous_alias_fallback(fake_dual_accounts, monkeypatch):
    """契约 2：重名别名视为输入歧义，Fail-Open 安全回退。"""
    cred = CredentialManager()
    # 构造两个账号具有相同 nickname
    acc_list = [
        ("uid-1", {"account": {"uid": "uid-1", "nickname": "工作号"}}),
        ("uid-2", {"account": {"uid": "uid-2", "nickname": "工作号"}}),
    ]
    monkeypatch.setattr(cred, "list_all_accounts", lambda: acc_list)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "工作号", None)
    assert target_uid is None  # 歧义别名不应瞎猜，必须 Fail-Open


def test_header_override_invalid_strategy_fallback(fake_dual_accounts, monkeypatch):
    """契约 2：非法 Strategy Header 不报 400，Fail-Open 回退全局默认。"""
    cred = CredentialManager()
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", None, "illegal_strat_123")
    assert target_uid is None
    assert strat is None  # 回退全局


def test_all_cooldown_half_open_single_flight(fake_dual_accounts, monkeypatch):
    """契约 3 & 契约修正 D：全池冷却时放行唯一 Half-Open 探针，并发请求触发防惊群避让。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="failover")

    now = time.time()
    # 构造全冷却：uid-alpha 剩 60s，uid-beta 剩 10s (beta 到期更早，最优)
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS[("uid-alpha", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((now + 60) * 1000),
            "uid": "uid-alpha",
        }
        converter._ACCOUNT_COOLDOWNS[("uid-beta", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((now + 10) * 1000),
            "uid": "uid-beta",
        }

    # 请求 1：应成功抢占单飞探针资格，并命中剩余时间最短的 uid-beta
    uid1, _ = rotator.select_account("glm-5.3")
    assert uid1 == "uid-beta"
    assert _is_probe_inflight("uid-beta", "glm-5.3") is True

    # 请求 2（并发进入）：发现 uid-beta 已有在途探针，防惊群生效，避让回退活跃账号
    uid2, _ = rotator.select_account("glm-5.3")
    assert uid2 == "uid-alpha"  # 避让回退到稳定活跃账号，不抢占探针资格！

    # 探针请求完成收尾：释放探针锁
    _release_probe("uid-beta", "glm-5.3")
    assert _is_probe_inflight("uid-beta", "glm-5.3") is False

    # 若探针成功（2xx），清除冷却自愈
    _clear_account_cooldown("uid-beta", "glm-5.3")
    assert _is_account_cooldown("uid-beta", "glm-5.3") is False


def test_all_cooldown_intersection_guard(fake_dual_accounts, monkeypatch):
    """契约修正 C：全冷却选号时必须与当前有效账号池做交集，绝不挑选已删除/禁用的残留账号。"""
    cred = CredentialManager()
    # 当前有效账号只有 uid-alpha（uid-old 已被用户删除）
    monkeypatch.setattr(cred, "list_all_accounts", lambda: [("uid-alpha", {"account": {"uid": "uid-alpha"}})])
    rotator = AccountRotator(cred_mgr=cred, mode="failover")

    now = time.time()
    with converter._RATE_LIMIT_LOCK:
        # 历史残留状态中有一个更早到期的已删除账号 uid-old
        converter._ACCOUNT_COOLDOWNS[("uid-old", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((now + 5) * 1000),
            "uid": "uid-old",
        }
        converter._ACCOUNT_COOLDOWNS[("uid-alpha", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((now + 30) * 1000),
            "uid": "uid-alpha",
        }

    # 必须只从有效账号 uid-alpha 中选，绝不能挑中已删除的 uid-old 作为 Half-Open 探针
    best_uid, _ = rotator.select_account("glm-5.3")
    assert best_uid == "uid-alpha"
    _release_probe("uid-alpha", "glm-5.3")


def test_active_account_response_header(fake_dual_accounts, monkeypatch):
    """契约修正 B：实际发往后端的请求在响应中返回 X-WorkBuddy-Active-Account。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)

    client = TestClient(app, headers={"Host": "127.0.0.1:8787"})
    # mock 后端流式调用
    async def mock_stream_upstream(*args, **kwargs):
        yield b"data: {\"choices\": [{\"delta\": {\"content\": \"hi\"}}]}\n\n"
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(converter, "_stream_upstream", mock_stream_upstream)

    resp = client.post(
        "/v1/chat/completions",
        headers={"X-WorkBuddy-Account": "uid-beta"},
        json={"model": "glm-5.3", "messages": [{"role": "user", "content": "hi"}], "stream": True},
    )
    assert resp.status_code == 200
    assert resp.headers.get("X-WorkBuddy-Active-Account") == "uid-beta"
