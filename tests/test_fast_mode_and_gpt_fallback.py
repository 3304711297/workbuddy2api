"""
tests/test_fast_mode_and_gpt_fallback.py - 测试快速模式(Fast Mode/service_tier)与GPT未授权平滑降级
"""

import asyncio
import json
import httpx
import pytest
from starlette.testclient import TestClient

import converter
from converter import (
    AccountRotator,
    CredentialManager,
    PASSTHROUGH_BODY_KEYS,
    MODEL_MAP,
    GPT_FALLBACK_MAP,
    _record_rate_limit,
    _is_account_cooldown,
    _is_unauthorized_model_error,
    _ACCOUNT_COOLDOWNS,
    _RATE_LIMIT_STATE,
)
import time


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



def test_passthrough_keys_include_fast_mode():
    """验证 PASSTHROUGH_BODY_KEYS 包含 service_tier, speed, fast_mode。"""
    assert "service_tier" in PASSTHROUGH_BODY_KEYS
    assert "speed" in PASSTHROUGH_BODY_KEYS
    assert "fast_mode" in PASSTHROUGH_BODY_KEYS


def test_model_map_includes_openai_gpt_aliases():
    """验证 MODEL_MAP 包含常见 OpenAI 别名。"""
    assert MODEL_MAP.get("gpt-4o") == "gpt-5.6-luna"
    assert MODEL_MAP.get("gpt-4o-mini") == "fast-model"
    assert MODEL_MAP.get("gpt-4") == "deepseek-v4-pro"
    assert MODEL_MAP.get("chatgpt-4o-latest") == "gpt-5.6-sol"
    assert MODEL_MAP.get("o1") == "deepseek-v4-pro"
    assert MODEL_MAP.get("o3-mini") == "deepseek-v4-pro"


def test_rate_limit_fallback_on_429_status_without_timestamp():
    """验证上游返回 HTTP 429 但无正则时间戳时，依然能正确进入冷却状态。"""
    _ACCOUNT_COOLDOWNS.clear()
    _RATE_LIMIT_STATE.clear()

    # 无时间戳的 429 报错
    err_body = '{"code": 6004, "msg": "请求频率过高，请稍后再试"}'
    _record_rate_limit("deepseek-v4.1-flash", err_body, uid="test-uid-1", status_code=429)

    assert _is_account_cooldown("test-uid-1", "deepseek-v4.1-flash") is True
    state = _RATE_LIMIT_STATE.get("deepseek-v4.1-flash")
    assert state is not None
    assert state["code"] == 6004


def test_is_unauthorized_model_error():
    """验证未授权海外 GPT 模型错误特征识别。"""
    assert _is_unauthorized_model_error(
        400,
        '{"code":11102,"msg":"model [gpt-5.6-luna] is only available for authorized users"}'
    ) is True
    assert _is_unauthorized_model_error(
        400,
        '{"code":11102,"msg":"model [gpt-6-astra] service info not found"}'
    ) is True
    assert _is_unauthorized_model_error(200, '{"code":0}') is False
    assert _is_unauthorized_model_error(429, '{"code":6004}') is False


def test_e2e_fast_mode_routes_auto_to_fast_model(fake_multi_accounts, monkeypatch):
    """验证客户端携带 service_tier: priority 且请求 auto 时，自动路由到 fast-model。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    captured_requests = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        captured_requests.append(req_body)
        sse_content = (
            'data: {"id":"fast-1","choices":[{"index":0,"delta":{"role":"assistant","content":"极速回复"}}]}\n\n'
            'data: {"id":"fast-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
            'data: [DONE]\n\n'
        ).encode("utf-8")
        return httpx.Response(200, content=sse_content, headers={"Content-Type": "text/event-stream"})

    mock_transport = httpx.MockTransport(mock_handler)
    orig_async_client = httpx.AsyncClient

    def mock_async_client(**kw):
        kw["transport"] = mock_transport
        return orig_async_client(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    payload = {
        "model": "auto",
        "service_tier": "priority",
        "messages": [{"role": "user", "content": "hi"}],
    }
    res = client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    assert len(captured_requests) == 1
    # 验证模型路由为 fast-model，且 service_tier 成功透传
    assert captured_requests[0]["model"] == "fast-model"
    assert captured_requests[0].get("service_tier") == "priority"


def test_e2e_unauthorized_gpt_model_fallback(fake_multi_accounts, monkeypatch):
    """验证当请求未授权 GPT 模型触发 11102 时，自动平滑降级到对标主力模型重试成功。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    call_models = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        req_model = req_body.get("model")
        call_models.append(req_model)
        if req_model == "gpt-5.6-luna":
            # 模拟上游返回 11102 未授权
            return httpx.Response(
                400,
                json={"code": 11102, "msg": "model [gpt-5.6-luna] is only available for authorized users"}
            )
        elif req_model == "fast-model":
            # 降级后的备选模型成功返回
            sse_content = (
                'data: {"id":"fb-1","choices":[{"index":0,"delta":{"role":"assistant","content":"降级回答成功"}}]}\n\n'
                'data: {"id":"fb-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
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
    payload = {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": "hi"}],
    }
    res = client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert "降级回答成功" in data["choices"][0]["message"]["content"]
    assert call_models == ["gpt-5.6-luna", "fast-model"]


@pytest.mark.anyio
async def test_failover_jitter_behavior(monkeypatch):
    """验证 failover 抖动函数在关闭时不休眠，在开启时生成 0.5~1.2s 随机休眠。"""
    slept_durations = []

    async def mock_sleep(d):
        slept_durations.append(d)

    monkeypatch.setattr(asyncio, "sleep", mock_sleep)

    # 1. 关闭时跳过
    monkeypatch.setitem(converter.CONFIG, "failover_jitter", False)
    await converter._failover_jitter("test-rid")
    assert len(slept_durations) == 0

    # 2. 开启时产生合理抖动
    monkeypatch.setitem(converter.CONFIG, "failover_jitter", True)
    await converter._failover_jitter("test-rid")
    assert len(slept_durations) == 1
    assert 0.5 <= slept_durations[0] <= 1.2

