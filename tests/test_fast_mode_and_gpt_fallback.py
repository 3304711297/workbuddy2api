"""
tests/test_fast_mode_and_gpt_fallback.py - 测试快速模式(Fast Mode/service_tier)与GPT未授权平滑降级
"""

import asyncio
import json
import httpx
import pytest
from starlette.testclient import TestClient
from pathlib import Path
import time

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


def test_passthrough_keys_decoupled_from_speed_and_fast_mode():
    """验证 speed / fast_mode 与上游 wire protocol 解耦，不包含在透传键集合中；但保留 service_tier。"""
    assert "service_tier" in PASSTHROUGH_BODY_KEYS
    assert "speed" not in PASSTHROUGH_BODY_KEYS
    assert "fast_mode" not in PASSTHROUGH_BODY_KEYS


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


def test_service_tier_semantics_regression(fake_multi_accounts, monkeypatch):
    """P1 回归测试：
    model=auto + service_tier=auto → 上游实际 model 仍为 auto（保持系统自动选择语义）
    model=auto + service_tier=fast → 上游实际 model=fast-model
    model=auto + service_tier=priority → 上游实际 model=fast-model
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    captured_requests = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        captured_requests.append(req_body)
        sse_content = (
            'data: {"id":"st-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n'
            'data: {"id":"st-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
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

    # 1. service_tier=auto: 不得触发 Fast Mode，上游 model 仍为 auto
    captured_requests.clear()
    res1 = client.post("/v1/chat/completions", json={"model": "auto", "service_tier": "auto", "messages": [{"role": "user", "content": "hi"}]})
    assert res1.status_code == 200
    assert captured_requests[0]["model"] == "auto"
    assert captured_requests[0].get("service_tier") == "auto"

    # 2. service_tier=fast: 触发 Fast Mode，上游 model 路由为 fast-model
    captured_requests.clear()
    res2 = client.post("/v1/chat/completions", json={"model": "auto", "service_tier": "fast", "messages": [{"role": "user", "content": "hi"}]})
    assert res2.status_code == 200
    assert captured_requests[0]["model"] == "fast-model"
    assert captured_requests[0].get("service_tier") == "fast"

    # 3. service_tier=priority: 触发 Fast Mode，上游 model 路由为 fast-model
    captured_requests.clear()
    res3 = client.post("/v1/chat/completions", json={"model": "auto", "service_tier": "priority", "messages": [{"role": "user", "content": "hi"}]})
    assert res3.status_code == 200
    assert captured_requests[0]["model"] == "fast-model"
    assert captured_requests[0].get("service_tier") == "priority"


def test_speed_and_fast_mode_decoupled_from_upstream_body(fake_multi_accounts, monkeypatch):
    """P2 测试：
    客户端带 speed=fast → gateway 正确识别 Fast Mode → 上游请求 body 不包含 speed
    客户端带 fast_mode=true → gateway 正确识别 Fast Mode → 上游请求 body 不包含 fast_mode
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    captured_requests = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        captured_requests.append(req_body)
        sse_content = (
            'data: {"id":"dec-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n'
            'data: {"id":"dec-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
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

    # 1. 客户端带 speed=fast
    captured_requests.clear()
    res1 = client.post("/v1/chat/completions", json={"model": "auto", "speed": "fast", "messages": [{"role": "user", "content": "hi"}]})
    assert res1.status_code == 200
    assert captured_requests[0]["model"] == "fast-model"
    assert "speed" not in captured_requests[0]

    # 2. 客户端带 fast_mode=True
    captured_requests.clear()
    res2 = client.post("/v1/chat/completions", json={"model": "auto", "fast_mode": True, "messages": [{"role": "user", "content": "hi"}]})
    assert res2.status_code == 200
    assert captured_requests[0]["model"] == "fast-model"
    assert "fast_mode" not in captured_requests[0]


def test_e2e_unauthorized_gpt_model_fallback_observability(fake_multi_accounts, monkeypatch, tmp_path):
    """P1/P2 测试：
    验证未授权 GPT 模型触发 11102 时自动平滑降级，且 requested_model / actual_model / fallback_reason 在日志、响应头及 usage.jsonl 中完整记录。
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    usage_file = tmp_path / "usage.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(usage_file))
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

    # 验证响应头具备可观测追踪能力
    assert res.headers.get("X-Actual-Model") == "fast-model"
    assert res.headers.get("X-Requested-Model") == "gpt-5.6-luna"
    assert res.headers.get("X-Fallback-Reason") == "11102 unauthorized"

    # 验证 usage.jsonl 包含完整 requested/actual/fallback 信息
    assert usage_file.exists()
    lines = usage_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 1
    last_record = json.loads(lines[-1])
    assert last_record["model"] == "fast-model"
    assert last_record["requested_model"] == "gpt-5.6-luna"
    assert last_record["actual_model"] == "fast-model"
    assert last_record["fallback_reason"] == "11102 unauthorized"


def test_e2e_anthropic_unauthorized_gpt_model_fallback_observability(fake_multi_accounts, monkeypatch, tmp_path):
    """P1/P2 测试：
    针对 Anthropic /v1/messages 协议，请求模型为 GPT-5.6-luna，降级至 fast-model 时：
    外层返回 model 保持兼容原请求，但响应头与 usage.jsonl 完整记录 actual_model 与 fallback_reason。
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    usage_file = tmp_path / "usage_anthropic.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(usage_file))
    call_models = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        req_model = req_body.get("model")
        call_models.append(req_model)
        if req_model == "gpt-5.6-luna":
            return httpx.Response(
                400,
                json={"code": 11102, "msg": "model [gpt-5.6-luna] is only available for authorized users"}
            )
        elif req_model == "fast-model":
            sse_content = (
                'data: {"id":"fb-anthropic-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Anthropic降级成功"}}]}\n\n'
                'data: {"id":"fb-anthropic-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n'
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
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "hi"}],
    }
    res = client.post("/v1/messages", json=payload)
    assert res.status_code == 200
    data = res.json()
    # 响应体遵循 Anthropic Messages 规范，回显请求的 model 供客户端通过校验
    assert data.get("model") == "gpt-5.6-luna"
    # 响应头可观测性追踪
    assert res.headers.get("X-Actual-Model") == "fast-model"
    assert res.headers.get("X-Requested-Model") == "gpt-5.6-luna"
    assert res.headers.get("X-Fallback-Reason") == "11102 unauthorized"

    # 验证 usage.jsonl 包含真实执行模型与降级标记
    assert usage_file.exists()
    lines = usage_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 1
    rec = json.loads(lines[-1])
    assert rec["model"] == "fast-model"
    assert rec["requested_model"] == "gpt-5.6-luna"
    assert rec["actual_model"] == "fast-model"
    assert rec["fallback_reason"] == "11102 unauthorized"


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


def test_e2e_stream_unauthorized_gpt_model_fallback_observability(fake_multi_accounts, monkeypatch, tmp_path):
    """🟡 P2 回归测试：
    验证 OpenAI 流式请求发生 11102 降级时，流中首包前下发标准 SSE 注释行通知客户端，且 usage.jsonl 完整记录。
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    usage_file = tmp_path / "usage_stream.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(usage_file))
    call_models = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        req_model = req_body.get("model")
        call_models.append(req_model)
        if req_model == "gpt-5.6-luna":
            return httpx.Response(
                400,
                json={"code": 11102, "msg": "model [gpt-5.6-luna] is only available for authorized users"}
            )
        elif req_model == "fast-model":
            sse_content = (
                'data: {"id":"stream-fb-1","model":"fast-model","choices":[{"index":0,"delta":{"role":"assistant","content":"流式降级回答"}}]}\n\n'
                'data: {"id":"stream-fb-1","model":"fast-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
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
        "stream": True,
        "messages": [{"role": "user", "content": "hi"}],
    }
    res = client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    text = res.text
    # 验证客户端在流式流首行明确观测到结构化降级注释行
    assert ": fallback: requested_model=gpt-5.6-luna actual_model=fast-model reason=11102 unauthorized" in text
    assert "流式降级回答" in text
    assert call_models == ["gpt-5.6-luna", "fast-model"]

    # 验证 usage.jsonl
    assert usage_file.exists()
    lines = usage_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 1
    rec = json.loads(lines[-1])
    assert rec["model"] == "fast-model"
    assert rec["requested_model"] == "gpt-5.6-luna"
    assert rec["actual_model"] == "fast-model"
    assert rec["fallback_reason"] == "11102 unauthorized"


def test_e2e_anthropic_stream_unauthorized_gpt_model_fallback_observability(fake_multi_accounts, monkeypatch, tmp_path):
    """🟡 P2 回归测试：
    针对 Anthropic /v1/messages 流式请求发生 11102 降级时，流中透传降级注释行，且后续事件正常下发。
    """
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    usage_file = tmp_path / "usage_anthropic_stream.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(usage_file))
    call_models = []

    def mock_handler(request: httpx.Request):
        req_body = json.loads(request.content.decode("utf-8"))
        req_model = req_body.get("model")
        call_models.append(req_model)
        if req_model == "gpt-5.6-luna":
            return httpx.Response(
                400,
                json={"code": 11102, "msg": "model [gpt-5.6-luna] is only available for authorized users"}
            )
        elif req_model == "fast-model":
            sse_content = (
                'data: {"id":"ant-fb-1","model":"fast-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Anthropic流式降级成功"}}]}\n\n'
                'data: {"id":"ant-fb-1","model":"fast-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6}}\n\n'
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
        "stream": True,
        "max_tokens": 50,
        "messages": [{"role": "user", "content": "hi"}],
    }
    res = client.post("/v1/messages", json=payload)
    assert res.status_code == 200
    text = res.text
    assert ": fallback: requested_model=gpt-5.6-luna actual_model=fast-model reason=11102 unauthorized" in text
    assert "Anthropic流式降级成功" in text
    assert call_models == ["gpt-5.6-luna", "fast-model"]

    # 验证 usage.jsonl
    assert usage_file.exists()
    lines = usage_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 1
    rec = json.loads(lines[-1])
    assert rec["model"] == "fast-model"
    assert rec["requested_model"] == "gpt-5.6-luna"
    assert rec["actual_model"] == "fast-model"
    assert rec["fallback_reason"] == "11102 unauthorized"

