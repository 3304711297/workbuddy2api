"""
tests/test_body_limit_and_ua.py - 请求体大小防护 (413 Payload Too Large) 与 出站 User-Agent 仿真测试

借鉴自:
1. linguo2625469/workbuddy2api-panel: server.max_body_mb 请求体超限返回 413 request_body_too_large，保护本地与上游
2. ardeyouxipianyi/workbuddy2api-intl & turbomind66/workbuddy2api-python: 官方客户端 User-Agent 规范仿真与环境变量覆盖
"""

import json
import pytest
from starlette.testclient import TestClient
import converter


def _client():
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_body_limit_allows_normal_payload(monkeypatch):
    """正常大小的请求体应正常放行（不被 413 拦截）。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 1024 * 1024)  # 1MB
    client = _client()
    
    # 一个极小的合法 JSON 请求
    res = client.post(
        "/v1/chat/completions",
        json={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
    )
    # 不应报 413
    assert res.status_code != 413


def test_body_limit_blocks_oversized_content_length(monkeypatch):
    """当 Content-Length 头部超出上限时，网关直接拦截并返回 413。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 100)  # 设为极小的 100 字节
    client = _client()

    large_content = "a" * 200
    res = client.post(
        "/v1/chat/completions",
        json={"model": "auto", "messages": [{"role": "user", "content": large_content}]},
    )
    assert res.status_code == 413
    data = res.json()
    assert data["error"]["code"] == "request_body_too_large"
    assert "exceeds" in data["error"]["message"].lower() or "上限" in data["error"]["message"]


def test_body_limit_blocks_oversized_anthropic_messages(monkeypatch):
    """针对 Anthropic /v1/messages 端点，超限时同样拦截返回 413。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 100)
    client = _client()

    large_content = "a" * 200
    res = client.post(
        "/v1/messages",
        json={"model": "deepseek-v4-pro", "max_tokens": 10, "messages": [{"role": "user", "content": large_content}]},
    )
    assert res.status_code == 413
    data = res.json()
    assert data["type"] == "error"
    assert data["error"]["type"] == "invalid_request_error"
    assert "too_large" in data["error"]["message"].lower() or "exceeds" in data["error"]["message"].lower() or "上限" in data["error"]["message"]


def test_user_agent_resolution(monkeypatch):
    """测试 User-Agent 的智能解析与环境变量覆盖机制。"""
    # 1. 默认仿真官方客户端 User-Agent
    monkeypatch.delenv("WORKBUDDY2API_USER_AGENT", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_USER_AGENT", raising=False)
    default_ua = converter._get_user_agent(domain="www.codebuddy.cn")
    assert "CodeBuddy" in default_ua or "CLI" in default_ua

    # 国际版仿真
    intl_ua = converter._get_user_agent(domain="www.workbuddy.ai")
    assert "WorkBuddy" in intl_ua

    # 2. 环境变量覆盖
    monkeypatch.setenv("WORKBUDDY2API_USER_AGENT", "CustomClient/1.0.0")
    assert converter._get_user_agent() == "CustomClient/1.0.0"


# ==================== chunked 流式熔断（无 Content-Length） ====================

def _run_asgi_middleware(monkeypatch, path, chunks, max_bytes, headers=None):
    """直接驱动 ASGI 中间件，模拟无 Content-Length 的分块上传（chunked）。

    返回 (是否返回 413, 实际被应用层读到的总字节数)。
    关键断言点：超限时**不应把全部 chunks 读完**。
    """
    import asyncio

    monkeypatch.setattr(converter, "MAX_BODY_BYTES", max_bytes)

    consumed = {"bytes": 0, "calls": 0}
    sent = {}

    pending = list(chunks)

    async def receive():
        consumed["calls"] += 1
        if pending:
            chunk = pending.pop(0)
            consumed["bytes"] += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": bool(pending)}
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            sent["status"] = message["status"]
        elif message["type"] == "http.response.body" and not message.get("more_body"):
            sent["body"] = message.get("body", b"")

    async def app(scope, recv, snd):
        # 应用层读取 body（模拟 FastAPI request.body()）
        total = 0
        while True:
            m = await recv()
            total += len(m.get("body", b""))
            if not m.get("more_body"):
                break
        consumed["app_bytes"] = total
        await snd({"type": "http.response.start", "status": 200, "headers": []})
        await snd({"type": "http.response.body", "body": b"ok", "more_body": False})

    mw = converter.RequestBodyLimitMiddleware(app)
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": headers if headers is not None else [(b"host", b"127.0.0.1:8787")],
    }
    asyncio.run(mw(scope, receive, send))
    return sent, consumed


def test_chunked_oversized_body_aborts_early(monkeypatch):
    """无 Content-Length 的 chunked 大包：必须在累计超限时立即熔断，不读完整个 body。"""
    # 10 个 1KB 分块，上限 4KB → 应在第 5 块左右提前中止
    chunks = [b"x" * 1024] * 10
    sent, consumed = _run_asgi_middleware(
        monkeypatch, "/v1/chat/completions", chunks, max_bytes=4096,
    )
    assert sent.get("status") == 413
    # 核心断言：没有把 10KB 全部读完（提前熔断）
    assert consumed["bytes"] < 10 * 1024, "超限后仍读完了全部 body，未提前熔断"
    assert consumed["bytes"] <= 4096 + 1024, "熔断过晚，多余读取超过一个分块"
    # 应用层不应被调用（不转发上游）
    assert "app_bytes" not in consumed


def test_chunked_oversized_anthropic_error_shape(monkeypatch):
    """Anthropic 端点超限时返回 Anthropic 风格错误体。"""
    import json as _json
    chunks = [b"x" * 1024] * 10
    sent, _ = _run_asgi_middleware(
        monkeypatch, "/v1/messages", chunks, max_bytes=2048,
    )
    assert sent.get("status") == 413
    payload = _json.loads(sent["body"].decode("utf-8"))
    assert payload["type"] == "error"
    assert payload["error"]["type"] == "invalid_request_error"


def test_chunked_within_limit_passes_through(monkeypatch):
    """未超限的 chunked 请求正常透传给应用层，body 完整无损。"""
    chunks = [b"a" * 512, b"b" * 512]
    sent, consumed = _run_asgi_middleware(
        monkeypatch, "/v1/chat/completions", chunks, max_bytes=4096,
    )
    assert sent.get("status") == 200
    assert consumed.get("app_bytes") == 1024, "应用层读到的 body 应与上传内容等长"


def test_content_length_quick_reject_skips_reading(monkeypatch):
    """带超大 Content-Length 时零读取直接 413（不消耗任何 receive）。"""
    sent, consumed = _run_asgi_middleware(
        monkeypatch,
        "/v1/responses",
        [b"x" * 100],
        max_bytes=1024,
        headers=[(b"host", b"127.0.0.1:8787"), (b"content-length", b"99999999")],
    )
    assert sent.get("status") == 413
    assert consumed["calls"] == 0, "Content-Length 快速拒绝不应触发任何 body 读取"
