"""端到端回归测试：/v1/messages Anthropic Messages 协议兼容端点。"""

import json
import sys
from pathlib import Path
from typing import AsyncGenerator

import httpx
import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


class _FakeStreamResponse:
    def __init__(self, status_code: int = 200, chunks: list[bytes] = None):
        self.status_code = status_code
        self._chunks = chunks or []

    async def aiter_bytes(self) -> AsyncGenerator[bytes, None]:
        for c in self._chunks:
            yield c

    async def aiter_lines(self) -> AsyncGenerator[str, None]:
        for c in self._chunks:
            for line in c.decode("utf-8").splitlines():
                if line:
                    yield line

    async def aread(self) -> bytes:
        return b"".join(self._chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _MockAsyncClient:
    def __init__(self, *args, **kwargs):
        pass

    def stream(self, method: str, url: str, *args, **kwargs):
        sample_openai_sse = [
            b'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from "},"finish_reason":null}]}\n\n',
            b'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"Anthropic endpoint!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
            b'data: [DONE]\n\n',
        ]
        return _FakeStreamResponse(200, sample_openai_sse)

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
def client(monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "cred", _MockCred())
    monkeypatch.setattr(httpx, "AsyncClient", _MockAsyncClient)
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_anthropic_messages_non_stream(client):
    req = {
        "model": "deepseek-v4.1-flash",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    }
    resp = client.post("/v1/messages", json=req)
    assert resp.status_code == 200
    data = resp.json()
    assert data["type"] == "message"
    assert data["role"] == "assistant"
    assert data["model"] == "deepseek-v4.1-flash"
    assert len(data["content"]) == 1
    assert data["content"][0]["type"] == "text"
    assert "Hello from Anthropic endpoint!" in data["content"][0]["text"]
    assert data["stop_reason"] == "end_turn"
    assert data["usage"]["input_tokens"] == 10
    assert data["usage"]["output_tokens"] == 5


def test_anthropic_messages_stream(client):
    req = {
        "model": "deepseek-v4.1-flash",
        "max_tokens": 100,
        "stream": True,
        "messages": [
            {"role": "user", "content": "Hello stream"}
        ]
    }
    resp = client.post("/v1/messages", json=req)
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    text = resp.text
    assert "event: message_start" in text
    assert "event: content_block_start" in text
    assert "event: content_block_delta" in text
    assert "event: content_block_stop" in text
    assert "event: message_delta" in text
    assert "event: message_stop" in text


def test_anthropic_messages_bad_json(client):
    resp = client.post("/v1/messages", content=b"invalid json")
    assert resp.status_code == 400
    assert resp.json()["type"] == "error"


def test_anthropic_messages_missing_messages(client):
    resp = client.post("/v1/messages", json={"model": "deepseek-v4.1-flash"})
    assert resp.status_code == 400
    assert resp.json()["type"] == "error"


def test_anthropic_messages_auth_headers(client, monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "api_key", "secret123")
    req = {
        "model": "deepseek-v4.1-flash",
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "hi"}]
    }
    # 无 key -> 401
    res_fail = client.post("/v1/messages", json=req)
    assert res_fail.status_code == 401

    # x-api-key -> 200
    res_key = client.post("/v1/messages", json=req, headers={"x-api-key": "secret123"})
    assert res_key.status_code == 200

    # Authorization Bearer -> 200
    res_bearer = client.post("/v1/messages", json=req, headers={"Authorization": "Bearer secret123"})
    assert res_bearer.status_code == 200
