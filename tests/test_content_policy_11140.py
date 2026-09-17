"""测试上游 11140 内容安全审核拦截的识别、防误切号与标准格式化输出。

借鉴自 icebears111/workbuddy2api：
上游 11140 (request illegal / 内容未通过安全审核) 是用户输入 Prompt 命中审核规则，
与账号配额和网络可用性无关。严禁将其误判为限流或故障而进行无谓的切号重试与账号冷却。
"""
import json
import pytest
from starlette.requests import Request
from starlette.datastructures import Headers

import converter
from converter import (
    _is_content_policy_violation,
    _safe_err_raw,
    _err_event,
    AccountRotator,
)


def test_is_content_policy_violation_predicate():
    # 明确命中 11140
    assert _is_content_policy_violation(400, '{"code":11140,"msg":"内容未通过安全审核，请调整后重试"}') is True
    assert _is_content_policy_violation(403, '{"code":11140,"message":"request illegal"}') is True
    assert _is_content_policy_violation(400, '未通过安全审核') is True

    # 包含其他明确业务 code 时，严禁仅凭安全审核文案误判
    assert _is_content_policy_violation(500, '{"code":50001,"msg":"安全审核服务暂时不可用"}') is False
    assert _is_content_policy_violation(400, '{"code":11102,"msg":"安全审核已通过但仅授权用户可用"}') is False

    # 正常限流 / 授权等非安全错误不得误判
    assert _is_content_policy_violation(429, '{"code":6004,"msg":"使用量超出频率限制"}') is False
    assert _is_content_policy_violation(400, '{"code":11102,"msg":"only available for authorized users"}') is False
    assert _is_content_policy_violation(500, 'internal server error') is False
    assert _is_content_policy_violation(200, '') is False


def test_safe_err_raw_formats_11140_to_standard_error():
    raw_json = b'{"code":11140,"msg":"\xe5\x86\x85\xe5\xae\xb9\xe6\x9c\xaa\xe9\x80\x9a\xe8\xbf\x87\xe5\xae\x89\xe5\x85\xa8\xe5\xae\xa1\xe6\xa0\xb8\xef\xbc\x8c\xe8\xaf\xb7\xe8\xb0\x83\xe6\x95\xb4\xe5\x90\x8e\xe9\x87\x8d\xe8\xaf\x95"}'
    res = _safe_err_raw(raw_json, 400)
    assert "error" in res
    err = res["error"]
    assert err["code"] == 11140
    assert err["type"] == "invalid_request_error"
    assert "11140" in err["message"]
    assert "安全审核" in err["message"]

    # 反例保护：其他 code 携带安全审核关键词不得被篡改为 11140
    other_raw = b'{"code":50001,"msg":"\xe5\xae\x89\xe5\x85\xa8\xe5\xae\xa1\xe6\xa0\xb8\xe6\x9c\x8d\xe5\x8a\xa1\xe6\x9a\x82\xe6\x97\xb6\xe4\xb8\x8d\xe5\x8f\xaf\xe7\x94\xa8"}'
    assert _safe_err_raw(other_raw, 500) == {"code": 50001, "msg": "安全审核服务暂时不可用"}


def test_err_event_emits_standard_sse_chunk():
    raw_json = b'{"code":11140,"msg":"request illegal"}'
    chunk = _err_event(raw_json, 400).decode("utf-8")
    assert chunk.startswith("data: ")
    assert chunk.endswith("\n\n")
    parsed = json.loads(chunk[6:].strip())
    assert "error" in parsed
    assert parsed["error"]["code"] == 11140
    assert parsed["error"]["type"] == "invalid_request_error"


def test_rotator_does_not_failover_or_cooldown_on_11140():
    rotator = AccountRotator()
    rotator.mode = "failover"
    
    # 构造 11140 错误
    err_11140 = '{"code":11140,"msg":"内容未通过安全审核"}'
    res = rotator.record_failure_and_failover("test-uid-1", "deepseek-v4.1-flash", 400, err_11140)
    
    # 严格返回 None，拒绝切号
    assert res is None
    
    # 验证账号未被记录到 _RATE_LIMIT_STATE 冷却池中
    with converter._RATE_LIMIT_LOCK:
        entry = converter._RATE_LIMIT_STATE.get("deepseek-v4.1-flash")
        if entry:
            # 如果存在条目，不能是当前 11140 触发的（即 remaining 不能因为这次错误增加）
            assert entry.get("limitedUid") != "test-uid-1"


class _Fake11140StreamResponse:
    def __init__(self, status_code: int = 400, body: bytes = b'{"code":11140,"msg":"\xe5\x86\x85\xe5\xae\xb9\xe6\x9c\xaa\xe9\x80\x9a\xe8\xbf\x87\xe5\xae\x89\xe5\x85\xa8\xe5\xae\xa1\xe6\xa0\xb8\xef\xbc\x8c\xe8\xaf\xb7\xe8\xb0\x83\xe6\x95\xb4\xe5\x90\x8e\xe9\x87\x8d\xe8\xaf\x95"}'):
        self.status_code = status_code
        self._body = body

    async def aiter_bytes(self):
        yield self._body

    async def aiter_lines(self):
        for line in self._body.decode("utf-8").splitlines():
            if line:
                yield line

    async def aread(self) -> bytes:
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _Mock11140AsyncClient:
    def __init__(self, *args, **kwargs):
        pass

    def stream(self, method: str, url: str, *args, **kwargs):
        return _Fake11140StreamResponse()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _MockCred:
    def get_headers(self) -> dict:
        return {"Authorization": "Bearer fake-token", "X-User-Id": "test-user"}

    def get_active_session(self) -> dict:
        return {
            "account": {"nickname": "TestUser", "uid": "test-user"},
            "auth": {"accessToken": "fake-token", "expiresAt": 1799999999999},
        }


@pytest.fixture
def client_11140(monkeypatch):
    import httpx
    from starlette.testclient import TestClient
    monkeypatch.setitem(converter.CONFIG, "cred", _MockCred())
    monkeypatch.setattr(httpx, "AsyncClient", _Mock11140AsyncClient)
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_openai_chat_completions_stream_11140(client_11140):
    req = {
        "model": "deepseek-v4.1-flash",
        "stream": True,
        "messages": [{"role": "user", "content": "hello"}],
    }
    resp = client_11140.post("/v1/chat/completions", json=req)
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")
    assert "invalid_request_error" in resp.text
    assert "11140" in resp.text


def test_anthropic_messages_stream_11140(client_11140):
    req = {
        "model": "deepseek-v4.1-flash",
        "stream": True,
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "hello"}],
    }
    resp = client_11140.post("/v1/messages", json=req)
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")
    assert "event: error" in resp.text
    assert "invalid_request_error" in resp.text
    assert "11140" in resp.text


def test_responses_stream_11140(client_11140):
    req = {
        "model": "deepseek-v4.1-flash",
        "stream": True,
        "input": "hello",
    }
    resp = client_11140.post("/v1/responses", json=req)
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")
    assert "response.failed" in resp.text
    assert "11140" in resp.text


def test_non_streaming_endpoints_11140(client_11140):
    # 1. OpenAI 兼容端点非流式 -> 400
    resp1 = client_11140.post("/v1/chat/completions", json={"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": "hello"}]})
    assert resp1.status_code == 400
    data1 = resp1.json()
    assert data1["error"]["code"] == 11140
    assert data1["error"]["type"] == "invalid_request_error"

    # 2. Anthropic Messages 端点非流式 -> 400
    resp2 = client_11140.post("/v1/messages", json={"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 100})
    assert resp2.status_code == 400
    data2 = resp2.json()
    assert data2["type"] == "error"
    assert data2["error"]["type"] == "invalid_request_error"

    # 3. OpenAI Responses 端点非流式 -> 400
    resp3 = client_11140.post("/v1/responses", json={"model": "deepseek-v4.1-flash", "input": "hello", "stream": False})
    assert resp3.status_code == 400
    data3 = resp3.json()
    assert data3["error"]["code"] == 11140
    assert data3["error"]["type"] == "invalid_request_error"
