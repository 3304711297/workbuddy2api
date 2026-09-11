"""
tests/test_credential_rotation.py - 多账号凭据轮换与故障自动转移测试

测试覆盖：
1. 默认 off 模式下，多账号不轮换，保持原有单账号行为；
2. failover 模式下，遇到 6004/429 自动切号并重试成功；
3. roundrobin 模式下，按请求次数在健康账号间循环轮流调度；
4. 遇到限流账号自动标记冷却并在冷却期内避开调度；
5. 全池账号均冷却时的优雅熔断降级。
"""

import asyncio
import json
import time
from pathlib import Path
import httpx
import pytest
from starlette.testclient import TestClient

import converter
from converter import (
    AccountRotator,
    CredentialManager,
    _is_account_cooldown,
    _record_rate_limit,
    _read_all_accounts,
    _set_active_account,
)


@pytest.fixture
def fake_multi_accounts(tmp_path, monkeypatch):
    """构建包含两个有效账号的 accounts.json 测试环境。"""
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
    return acc_file


def test_rotation_mode_off_by_default(fake_multi_accounts, monkeypatch):
    """默认 off 模式下，即使有多个账号，也始终使用当前 active_uid，不发生轮换。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "off")

    rotator = AccountRotator(cred_mgr=cred, mode="off")
    uid, headers = rotator.select_account("glm-5.3")
    assert uid == "uid-alpha"
    assert headers["X-User-Id"] == "uid-alpha"

    # 模拟遇到 429，off 模式绝不进行 failover
    failover = rotator.record_failure_and_failover("uid-alpha", "glm-5.3", 429, "6004 频率限制")
    assert failover is None


def test_failover_switches_account_on_rate_limit(fake_multi_accounts, monkeypatch):
    """failover 模式下，遇到 6004 限流时自动切换到另一个可用账号，并把原账号设为冷却。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")

    rotator = AccountRotator(cred_mgr=cred, mode="failover")
    uid, headers = rotator.select_account("deepseek-v4.1-flash")
    assert uid == "uid-alpha"

    # 模拟 uid-alpha 遭遇 6004 冷却
    raw_6004 = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-12 10:00:00 UTC+8 重置"}'
    failover = rotator.record_failure_and_failover("uid-alpha", "deepseek-v4.1-flash", 200, raw_6004)
    assert failover is not None
    new_uid, new_headers = failover
    assert new_uid == "uid-beta"
    assert new_headers["X-User-Id"] == "uid-beta"

    # 验证原账号已记录冷却状态，新请求主动避让
    assert _is_account_cooldown("uid-alpha", "deepseek-v4.1-flash") is True
    assert _is_account_cooldown("uid-beta", "deepseek-v4.1-flash") is False

    # 下一次请求自动选中非冷却的 uid-beta
    next_uid, next_headers = rotator.select_account("deepseek-v4.1-flash")
    assert next_uid == "uid-beta"


def test_roundrobin_request_cycling(fake_multi_accounts, monkeypatch):
    """roundrobin 模式下，按请求计数在可用账号间交替轮询。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "roundrobin")
    monkeypatch.setitem(converter.CONFIG, "rotate_count", 1)

    rotator = AccountRotator(cred_mgr=cred, mode="roundrobin", rotate_count=1)

    uids = []
    for _ in range(4):
        uid, _ = rotator.select_account("glm-5.3")
        uids.append(uid)

    assert uids == ["uid-beta", "uid-alpha", "uid-beta", "uid-alpha"]


def test_all_accounts_cooling_down_returns_none(fake_multi_accounts, monkeypatch):
    """当账号池中所有账号均处于冷却状态时，failover 优雅返回 None，不再死循环。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")

    rotator = AccountRotator(cred_mgr=cred, mode="failover")
    raw_6004 = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-12 12:00:00 UTC+8 重置"}'

    # 先让 alpha 冷却
    res1 = rotator.record_failure_and_failover("uid-alpha", "glm-5.3", 429, raw_6004)
    assert res1 is not None
    assert res1[0] == "uid-beta"

    # 再让 beta 也冷却
    res2 = rotator.record_failure_and_failover("uid-beta", "glm-5.3", 429, raw_6004)
    assert res2 is None  # 全池已冷却，无其他可用账号


def test_e2e_chat_completions_failover_transparent_retry(fake_multi_accounts, monkeypatch):
    """端到端验证：非流式请求遇到账号 1 返回 429 时，透明切到账号 2 重试并直接返回 200 成功响应。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")

    call_history = []

    def mock_handler(request: httpx.Request):
        user_id = request.headers.get("X-User-Id")
        call_history.append(user_id)
        if user_id == "uid-alpha":
            # 首发账号报 6004 频率限制
            return httpx.Response(
                429,
                json={"code": 6004, "msg": "您的使用量已超出频率限制，将在 2026-09-12 15:00:00 UTC+8 重置"}
            )
        elif user_id == "uid-beta":
            # 备用账号返回正常 SSE 流
            sse_content = (
                'data: {"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"来自贝塔号的回答"}}]}\n\n'
                'data: {"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
                'data: [DONE]\n\n'
            ).encode("utf-8")
            return httpx.Response(200, content=sse_content, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(404)

    mock_transport = httpx.MockTransport(mock_handler)
    orig_async_client = httpx.AsyncClient
    def mock_async_client(**kw):
        kw["transport"] = mock_transport
        return orig_async_client(**kw)
    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions", json={"model": "glm-5.3", "messages": [{"role": "user", "content": "hello"}]})

    assert res.status_code == 200
    data = res.json()
    assert "来自贝塔号的回答" in data["choices"][0]["message"]["content"]
    assert call_history == ["uid-alpha", "uid-beta"]


def test_e2e_stream_chat_completions_failover_retry(fake_multi_accounts, monkeypatch):
    """端到端验证：流式请求遇到账号 1 返回 429 时，透明重试账号 2 并正常下发 SSE 分片。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")

    call_history = []

    def mock_handler(request: httpx.Request):
        user_id = request.headers.get("X-User-Id")
        call_history.append(user_id)
        if user_id == "uid-alpha":
            return httpx.Response(
                429,
                json={"code": 6004, "msg": "您的使用量已超出频率限制，将在 2026-09-12 16:00:00 UTC+8 重置"}
            )
        elif user_id == "uid-beta":
            sse_content = (
                'data: {"id":"chat-stream-1","choices":[{"index":0,"delta":{"role":"assistant","content":"贝塔流式响应"}}]}\n\n'
                'data: {"id":"chat-stream-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
                'data: [DONE]\n\n'
            ).encode("utf-8")
            return httpx.Response(200, content=sse_content, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(404)

    mock_transport = httpx.MockTransport(mock_handler)
    orig_async_client = httpx.AsyncClient
    def mock_async_client(**kw):
        kw["transport"] = mock_transport
        return orig_async_client(**kw)
    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions", json={"model": "glm-5.3", "stream": True, "messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 200
    assert "贝塔流式响应" in res.text
    assert call_history == ["uid-alpha", "uid-beta"]

