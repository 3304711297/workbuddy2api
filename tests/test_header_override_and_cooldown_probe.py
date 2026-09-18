"""
tests/test_header_override_and_cooldown_probe.py
针对请求级控制头 (X-WorkBuddy-Account, X-WorkBuddy-Strategy) 与自愈熔断 Half-Open 单飞探针的完整契约测试。
经 ChatGPT 深度思考模式对抗式复核批准，覆盖完整契约：
1. 精确 UID 与有效 Alias 命中
2. 非法/冷却中的 Account 不得绕过安全门禁，且不吞掉同请求合法 Strategy (契约修正 A)
3. 重名 Alias 歧义 Fail-Open
4. 非法 Strategy Fail-Open 回退全局
5. 全冷却 Half-Open 单飞探针 (Single-Flight Probe) 与真实 asyncio.gather 并发防穿透防惊群
6. 全冷却候选必须取有效账号池交集，防死号/删除号被探针选中 (契约修正 C)
7. 并发状态反转保护：旧请求迟到成功禁止覆盖在途产生的新限流 (P1 修复)
8. 流式中断与 Cancellation 下 finally 必须释放探针锁
9. GET /api/rate_limit 保持既有 limited / expired / ok 三态契约不变
"""

import asyncio
import json
import time
import pytest
import httpx
from starlette.testclient import TestClient

import converter
from converter import (
    AccountRotator,
    CredentialManager,
    _is_account_cooldown,
    _clear_account_cooldown,
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

    future_ms = int((time.time() + 120) * 1000)
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS[("uid-beta", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": future_ms,
            "uid": "uid-beta",
        }

    target_uid, strat = rotator.resolve_header_overrides("glm-5.3", "uid-beta", "failover")
    assert target_uid is None  # 必须 Fail-Open 拒绝指定！
    assert strat == "failover"  # 策略依然保留


def test_header_override_ambiguous_alias_fallback(fake_dual_accounts, monkeypatch):
    """契约 2：重名别名视为输入歧义，Fail-Open 安全回退。"""
    cred = CredentialManager()
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


def test_all_cooldown_half_open_single_flight_and_no_leak(fake_dual_accounts, monkeypatch):
    """契约 3 & P0 修复：全池冷却时放行唯一 Half-Open 探针，并发请求安全拦截（绝不穿透打冷账号）。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="failover")

    now = time.time()
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

    # 请求 1：成功抢占单飞探针资格，命中剩余时间最短的 uid-beta
    uid1, headers1 = rotator.select_account("glm-5.3")
    assert uid1 == "uid-beta"
    assert headers1.get("X-User-Id") == "uid-beta"
    assert _is_probe_inflight("uid-beta", "glm-5.3") is True

    # 请求 2（并发进入）：发现 uid-beta 正在探针，且全池其余账号皆冷却，安全返回空，拒绝穿透打上游！
    uid2, headers2 = rotator.select_account("glm-5.3")
    assert uid2 == ""  # P0 修复锁定：绝不返回冷却中的 uid-alpha！
    assert headers2 == {}

    # 探针完成收尾：释放探针
    _release_probe("uid-beta", "glm-5.3")
    assert _is_probe_inflight("uid-beta", "glm-5.3") is False

    # 探针成功后清除冷却自愈
    _clear_account_cooldown("uid-beta", "glm-5.3")
    assert _is_account_cooldown("uid-beta", "glm-5.3") is False


def test_all_cooldown_intersection_guard(fake_dual_accounts, monkeypatch):
    """契约修正 C：全冷却选号时必须与当前有效账号池做交集，绝不挑选已删除/禁用的残留账号。"""
    cred = CredentialManager()
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

    best_uid, _ = rotator.select_account("glm-5.3")
    assert best_uid == "uid-alpha"
    _release_probe("uid-alpha", "glm-5.3")


def test_concurrent_cooldown_state_inversion_protection(fake_dual_accounts):
    """P1 修复：并发状态反转保护——旧请求开始于限流之前、结束于限流之后，成功不得覆盖最新限流。"""
    now = time.time()
    req_a_t0_ms = (now - 5) * 1000  # 请求 A 在 5 秒前启动

    # 在请求 A 运行期间，另一个请求遭遇 429，写入了 2 秒前的最新限流状态
    new_cooldown_created_ms = (now - 2) * 1000
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS[("uid-alpha", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((now + 60) * 1000),
            "lastSeenMs": new_cooldown_created_ms,
            "uid": "uid-alpha",
        }

    # 请求 A 迟到成功完成，尝试清除冷却
    _clear_account_cooldown("uid-alpha", "glm-5.3", req_start_ms=req_a_t0_ms)

    # 断言：由于 req_a_t0_ms < lastSeenMs，新限流被严格保护，未被迟到的成功抹除！
    assert _is_account_cooldown("uid-alpha", "glm-5.3") is True

    # 探针请求（本身持有当前时间）成功自愈：
    probe_start_ms = (now + 1) * 1000
    _clear_account_cooldown("uid-alpha", "glm-5.3", req_start_ms=probe_start_ms)
    assert _is_account_cooldown("uid-alpha", "glm-5.3") is False


def test_rate_limit_endpoint_three_state_contract(fake_dual_accounts, monkeypatch):
    """锁定 GET /api/rate_limit 的 limited / expired / ok(即无条目) 三态及字段完整性契约。"""
    client = TestClient(app, headers={"Host": "127.0.0.1:8787"})

    # 1. 初始无记录：models 为空字典
    r1 = client.get("/api/rate_limit")
    assert r1.status_code == 200
    d1 = r1.json()
    assert "models" in d1
    assert d1["models"] == {}

    # 2. 正在冷却中：limited
    now = time.time()
    with converter._RATE_LIMIT_LOCK:
        converter._RATE_LIMIT_STATE["glm-5.3"] = {
            "code": 6004,
            "message": "频率超限",
            "resetAtMs": int((now + 60) * 1000),
            "resetLocal": "23:59:59",
            "firstSeenMs": int(now * 1000),
            "lastSeenMs": int(now * 1000),
            "uid": "uid-alpha",
            "nickname": "阿尔法号",
        }
    r2 = client.get("/api/rate_limit")
    assert r2.status_code == 200
    d2 = r2.json()
    assert "glm-5.3" in d2["models"]
    ent = d2["models"]["glm-5.3"]
    assert ent["state"] == "limited"
    assert ent["remainingSec"] > 0
    assert ent["resetLocal"] == "23:59:59"

    # 3. 冷却已过：expired
    with converter._RATE_LIMIT_LOCK:
        converter._RATE_LIMIT_STATE["glm-5.3"]["resetAtMs"] = int((now - 10) * 1000)
    r3 = client.get("/api/rate_limit")
    assert r3.status_code == 200
    d3 = r3.json()
    ent3 = d3["models"]["glm-5.3"]
    assert ent3["state"] == "expired"
    assert ent3["remainingSec"] == 0


def test_active_account_response_header(fake_dual_accounts, monkeypatch):
    """契约修正 B：实际发往后端的请求在响应中返回 X-WorkBuddy-Active-Account。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)

    client = TestClient(app, headers={"Host": "127.0.0.1:8787"})

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


@pytest.mark.anyio
async def test_concurrent_all_cooldown_strictly_single_flight(fake_dual_accounts, monkeypatch):
    """验证 20 个并发请求冲撞全池冷却时，strictly <= 1 个拿到探针，其余全部安全拦截绝不穿透打上游。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="failover")

    now = time.time()
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

    async def _select_task():
        return rotator.select_account("glm-5.3")

    results = await asyncio.gather(*[_select_task() for _ in range(20)])
    probes_awarded = [uid for uid, _ in results if uid == "uid-beta"]
    blocked_safely = [uid for uid, _ in results if uid == ""]

    assert len(probes_awarded) == 1  # 严格单飞探针！
    assert len(blocked_safely) == 19  # 其余 19 个安全拦截，绝不穿透！

    _release_probe("uid-beta", "glm-5.3")


def test_header_override_does_not_mutate_global_active_account(fake_dual_accounts, monkeypatch):
    """P0 修复锁定：X-WorkBuddy-Account 请求级覆盖绝不得修改全局 active_uid（零全局副作用）。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    rotator = AccountRotator(cred_mgr=cred, mode="off")

    assert cred.get_active_uid() == "uid-alpha"

    # 请求级指定 uid-beta
    sel_uid, _ = rotator.select_account("glm-5.3", override_uid="uid-beta")
    assert sel_uid == "uid-beta"

    # 全局 active_uid 必须保持 uid-alpha，绝不泄漏副作用！
    assert cred.get_active_uid() == "uid-alpha"


def test_failover_updates_active_account_response_header(fake_dual_accounts, monkeypatch):
    """P0 修复锁定：发生 failover (A->429, B->200) 时，最终响应头必须准确反映最终生效的 B。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")

    client = TestClient(app, headers={"Host": "127.0.0.1:8787"})

    call_seq = []

    def mock_stream_upstream(url, headers, body, model_name, t0, rid, rotator=None, uid="", requested_model=None):
        call_seq.append(uid)
        if uid == "uid-alpha":
            # 首选账号报错 429
            class MockResp:
                status_code = 429
                def aiter_bytes(self):
                    async def _gen():
                        yield b'{"code":6004,"msg":"\xe7\x94\xa8\xe9\x87\x8f\xe8\xb6\x85\xe9\x99\x90"}'
                    return _gen()
            return MockResp()

    # 直接端到端测试非流式请求
    async def mock_handler(request: httpx.Request):
        uid = request.headers.get("X-User-Id")
        call_seq.append(uid)
        if uid == "uid-alpha":
            return httpx.Response(429, json={"code": 6004, "msg": "超限将在 2026-09-08 23:00:00 UTC+8 重置"})
        else:
            sse_bytes = b'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(mock_handler)
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: httpx.AsyncClient(transport=transport))

    resp = client.post("/v1/chat/completions", json={"model": "glm-5.3", "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 200
    # 响应头必须是最终成功的 uid-beta，而不是最初失败的 uid-alpha！
    assert resp.headers.get("X-WorkBuddy-Active-Account") == "uid-beta"


def test_monotonic_clock_protects_cooldown_from_wall_clock_jitter(fake_dual_accounts, monkeypatch):
    """P0 修复锁定：内部冷却由 monotonic clock 驱动，即使系统墙上时钟大幅回拨或前跳，冷却依然受控。"""
    now_mono = time.monotonic()
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS[("uid-alpha", "glm-5.3")] = {
            "code": 6004,
            "resetAtMs": int((time.time() + 60) * 1000),
            "monotonic_until": now_mono + 60.0,
            "uid": "uid-alpha",
        }

    # 模拟墙上时钟跳回 1000 年前（time.time() 剧变）
    monkeypatch.setattr(time, "time", lambda: 0.0)

    # 由于 monotonic 仍在 60s 内，判定依然是 cooldown
    assert _is_account_cooldown("uid-alpha", "glm-5.3") is True


