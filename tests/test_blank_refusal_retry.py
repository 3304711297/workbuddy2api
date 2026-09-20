"""空拒答（content_filter + 零 token + 无实质产出）同账号自动重试契约测试。

背景（2026-09-20 实测样本，见 ``%LOCALAPPDATA%/workbuddy2api`` 的
``converter.log`` 与 ``usage/snapshots.jsonl``）：

上游安全策略**抽样误伤**时返回 HTTP 200 + ``finish_reason=content_filter``，
正文只有一句拒答文案（实测 ``Sorry, I can't respond to this question.``），
usage 计 **0 token**。Hermes 把 ``content_filter`` 归类为不可重试的终止态，
用户只看到「编辑消息」而没有「重试」，观感是会话卡住（链路其实是好的）。

⚠️ 本文件同时锁定两条**对既有交接文档的实测修正**：

1. **拒答文案确实出现在 ``content`` 里**（快照 ``resp`` 字段原文可证），
   所以「无 content」不能作为判据 —— 改用「正文长度上限」。
   若照抄「``not content``」，判据永远不会命中，修复会静默失效。
2. 上游 ``finish_reason`` 实测是**下划线** ``content_filter``，而旧代码只比对
   连字符 ``content-filter``（``_log_finish`` / 流式 tag），导致**真实命中从未
   被打上标签**；同时旧的字节扫描把模型正文里出现的「敏感/审核」字样当成命中，
   实测 7 次全是**假阳性**（均为成功的 tool_calls 响应）。
   归一化 + 结构化判定后两者才成立。
"""
import asyncio
import json

import pytest
from starlette.testclient import TestClient

import converter

REFUSAL_TEXT = "Sorry, I can't respond to this question."


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


def _chunk(delta: dict, finish=None, usage=None) -> bytes:
    payload = {
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "model": "deepseek-v4.1-flash",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        payload["usage"] = usage
    return _sse(payload)


def frames_refusal() -> list[bytes]:
    """空拒答：正文只有拒答文案、finish=content_filter、usage 计 0 token。"""
    return [
        _chunk({"role": "assistant", "content": REFUSAL_TEXT}),
        _chunk({}, finish="content_filter"),
        _chunk({}, usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
        b"data: [DONE]\n\n",
    ]


def frames_success(text: str = "正常回答") -> list[bytes]:
    return [
        _chunk({"role": "assistant", "content": text}),
        _chunk({}, finish="stop"),
        _chunk({}, usage={"prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46}),
        b"data: [DONE]\n\n",
    ]


def frames_long_content_filter() -> list[bytes]:
    """有实质内容的 content_filter：长正文 + 计费 token，属正常语义，不得重试。"""
    return [
        _chunk({"role": "assistant", "content": "x" * 500}),
        _chunk({}, finish="content_filter"),
        _chunk({}, usage={"prompt_tokens": 10, "completion_tokens": 200, "total_tokens": 210}),
        b"data: [DONE]\n\n",
    ]


def frames_tool_calls_content_filter() -> list[bytes]:
    """带工具调用的 content_filter：不是空拒答，不得重试。"""
    return [
        _chunk({"role": "assistant", "tool_calls": [
            {"index": 0, "id": "call_1", "type": "function",
             "function": {"name": "terminal", "arguments": "{}"}}]}),
        _chunk({}, finish="content_filter"),
        _chunk({}, usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}),
        b"data: [DONE]\n\n",
    ]


class _FakeStream:
    status_code = 200
    headers = {}

    def __init__(self, frames: list[bytes]):
        self._frames = frames

    async def aiter_bytes(self):
        for f in self._frames:
            yield f

    async def aiter_lines(self):
        for f in self._frames:
            for line in f.decode("utf-8").splitlines():
                if line:
                    yield line

    async def aread(self) -> bytes:
        return b"".join(self._frames)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _ScriptedClient:
    """按调用序号依次给出不同 SSE 脚本的 httpx.AsyncClient 替身。"""

    def __init__(self, scripts: list[list[bytes]]):
        self._scripts = scripts
        self.calls = 0

    def stream(self, *args, **kwargs):
        frames = self._scripts[min(self.calls, len(self._scripts) - 1)]
        self.calls += 1
        return _FakeStream(frames)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _Ctx:
    def __init__(self, client):
        self._client = client

    async def __aenter__(self):
        return self._client

    async def __aexit__(self, *args):
        return False


@pytest.fixture
def no_sleep(monkeypatch):
    """把同账号重试前的防风控抖动换成零等待，避免用例被 0.5~1.2s 拖慢。"""
    async def _noop(rid=""):
        return None

    monkeypatch.setattr(converter, "_failover_jitter", _noop)


@pytest.fixture
def quiet_side_effects(monkeypatch):
    """隔离副作用落盘：用例只关心上游调用次数与客户端可见输出。"""
    monkeypatch.setattr(converter, "_mark_model_available", lambda *a, **k: None)
    monkeypatch.setattr(converter, "_mark_model_unavailable", lambda *a, **k: None)
    monkeypatch.setattr(converter, "_clear_account_cooldown", lambda *a, **k: None)
    monkeypatch.setattr(converter, "_record_usage", lambda *a, **k: None)
    monkeypatch.setattr(converter, "_record_rate_limit", lambda *a, **k: None)


class _StubCred:
    """最小凭据替身：只为让端点通过 _cred() 的前置检查。"""

    def get_headers(self) -> dict:
        return {"Authorization": "Bearer fake-token"}

    def get_active_uid(self) -> str:
        return "uid-test"

    def get_headers_for_uid(self, uid: str) -> dict:
        return {"Authorization": "Bearer fake-token"}

    def get_active_session(self) -> dict:
        return {"account": {"nickname": "TestUser", "uid": "uid-test"},
                "auth": {"accessToken": "fake-token", "expiresAt": 1799999999999}}


class _StubRotator:
    mode = "off"

    def get_retry_budget(self, model: str) -> int:
        return 1  # → max_attempts = 2，即「上限 2 次尝试」

    def select_account(self, model, override_uid=None, override_mode=None):
        return "uid-test", {"Authorization": "Bearer fake"}

    def resolve_header_overrides(self, model, req_account, req_strategy):
        return None, None

    def record_failure_and_failover(self, uid, model, status, err):
        return None


@pytest.fixture
def client(monkeypatch, quiet_side_effects):
    monkeypatch.setitem(converter.CONFIG, "cred", _StubCred())
    monkeypatch.setattr(converter, "_get_rotator", lambda: _StubRotator())
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


# ── 判据单元 ────────────────────────────────────────────────────────────

def test_normalize_finish_reason_covers_upstream_spellings():
    """上游实测下发下划线 content_filter；旧代码只认连字符，必须两者等价。"""
    assert converter._normalize_finish_reason("content_filter") == "content_filter"
    assert converter._normalize_finish_reason("content-filter") == "content_filter"
    assert converter._normalize_finish_reason(" Content-Filter ") == "content_filter"
    assert converter._normalize_finish_reason("stop") == "stop"
    assert converter._normalize_finish_reason(None) == ""
    assert converter._normalize_finish_reason("") == ""


def _collected(content, finish, total_tokens, tool_calls=None):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {
        "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": total_tokens},
    }


def test_is_blank_refusal_predicate_matrix():
    """空拒答判据：finish=content_filter + 无工具调用 + 零 token + 正文短。"""
    # 实测样本原文：拒答文案在 content 里，tokens=0
    assert converter._is_blank_refusal(_collected(REFUSAL_TEXT, "content_filter", 0)) is True
    # 连字符拼写同样算（归一化）
    assert converter._is_blank_refusal(_collected(REFUSAL_TEXT, "content-filter", 0)) is True
    # 完全空正文也算
    assert converter._is_blank_refusal(_collected(None, "content_filter", 0)) is True

    # 反例：有实质产出（长正文 / 计费 token / 工具调用 / 正常 finish）都不算空拒答
    assert converter._is_blank_refusal(_collected("x" * 500, "content_filter", 210)) is False
    assert converter._is_blank_refusal(_collected(REFUSAL_TEXT, "content_filter", 12)) is False
    assert converter._is_blank_refusal(_collected(None, "content_filter", 0, tool_calls=[
        {"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}
    ])) is False
    assert converter._is_blank_refusal(_collected("ok", "stop", 5)) is False
    # 结构缺失不得抛异常
    assert converter._is_blank_refusal(None) is False
    assert converter._is_blank_refusal({}) is False
    assert converter._is_blank_refusal({"choices": []}) is False


# ── 流式路径 ────────────────────────────────────────────────────────────

def _run_stream(monkeypatch, scripts, **kwargs):
    client = _ScriptedClient(scripts)
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(client))

    async def _go():
        out = []
        gen = converter._stream_upstream(
            url="https://api.test/v2/chat/completions",
            headers={"Authorization": "Bearer fake"},
            body={"model": "deepseek-v4.1-flash"},
            model_name="deepseek-v4.1-flash",
            uid="uid-test",
            **kwargs,
        )
        async for chunk in gen:
            out.append(chunk)
        return b"".join(out)

    return asyncio.run(_go()), client


def test_stream_blank_refusal_retried_and_text_not_leaked(monkeypatch, no_sleep, quiet_side_effects):
    """流式空拒答：同账号重试，且**首次尝试的拒答文案不得泄漏给客户端**。"""
    payload, client = _run_stream(monkeypatch, [frames_refusal(), frames_success("正常回答")])

    assert client.calls == 2, "空拒答必须触发一次同账号重试"
    text = payload.decode("utf-8")
    assert "正常回答" in text
    assert REFUSAL_TEXT not in text, "被重试掉的拒答文案绝不能出现在客户端流里"


def test_stream_blank_refusal_exhausted_passes_through(monkeypatch, no_sleep, quiet_side_effects):
    """上限 2 次尝试仍失败：原样透传，保留诚实的错误面（不无限重试）。"""
    payload, client = _run_stream(monkeypatch, [frames_refusal(), frames_refusal()])

    assert client.calls == 2, "重试上限为 1 次（共 2 次尝试）"
    assert REFUSAL_TEXT in payload.decode("utf-8"), "仍失败时必须原样透传，不得静默吞掉"


def test_stream_long_content_filter_not_retried(monkeypatch, no_sleep, quiet_side_effects):
    """有实质内容的 content_filter 是正常语义，不得重试（防误伤）。"""
    payload, client = _run_stream(monkeypatch, [frames_long_content_filter()])

    assert client.calls == 1
    assert "x" * 500 in payload.decode("utf-8")


def test_stream_tool_calls_content_filter_not_retried(monkeypatch, no_sleep, quiet_side_effects):
    """带工具调用的 content_filter 不是空拒答，不得重试。"""
    payload, client = _run_stream(monkeypatch, [frames_tool_calls_content_filter()])

    assert client.calls == 1
    assert "terminal" in payload.decode("utf-8")


def test_stream_normal_answer_is_not_held(monkeypatch, no_sleep, quiet_side_effects):
    """正常回答不得被滞留：首帧即放行（避免用重试窗口拖慢常规流式）。"""
    payload, client = _run_stream(monkeypatch, [frames_success("你好")])

    assert client.calls == 1
    assert "你好" in payload.decode("utf-8")


# ── 非流式路径（三端点共用判据） ────────────────────────────────────────

def _post_chat(client, **extra):
    body = {"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": "hi"}]}
    body.update(extra)
    return client.post("/v1/chat/completions", json=body)


def test_non_stream_blank_refusal_retried_same_account(monkeypatch, client, no_sleep):
    scripted = _ScriptedClient([frames_refusal(), frames_success("正常回答")])
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(scripted))

    resp = _post_chat(client)

    assert scripted.calls == 2, "非流式空拒答必须同账号重试一次"
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "正常回答"
    assert resp.headers.get("X-WorkBuddy-Active-Account") == "uid-test", "必须同账号，不得切号"


def test_non_stream_blank_refusal_exhausted_passes_through(monkeypatch, client, no_sleep):
    scripted = _ScriptedClient([frames_refusal(), frames_refusal()])
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(scripted))

    resp = _post_chat(client)

    assert scripted.calls == 2, "重试上限 1 次，不得超过"
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["finish_reason"] == "content_filter"


def test_non_stream_long_content_filter_not_retried(monkeypatch, client, no_sleep):
    scripted = _ScriptedClient([frames_long_content_filter()])
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(scripted))

    resp = _post_chat(client)

    assert scripted.calls == 1, "有实质内容的 content_filter 不得重试"


def test_non_stream_anthropic_blank_refusal_retried(monkeypatch, client, no_sleep):
    scripted = _ScriptedClient([frames_refusal(), frames_success("正常回答")])
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(scripted))

    resp = client.post("/v1/messages", json={
        "model": "deepseek-v4.1-flash", "max_tokens": 64,
        "messages": [{"role": "user", "content": "hi"}],
    })

    assert scripted.calls == 2, "Anthropic 端点非流式同样必须重试"
    assert resp.status_code == 200


def test_11140_deterministic_block_is_never_retried(monkeypatch, client, no_sleep):
    """11140 是 HTTP 400 请求级预拦截，属确定性拒绝：行为必须与现在完全一致（不重试）。"""
    class _Blocked(_FakeStream):
        status_code = 400

        def __init__(self):
            super().__init__([b'{"code":11140,"msg":"request illegal"}'])

    class _Client:
        def __init__(self):
            self.calls = 0

        def stream(self, *a, **k):
            self.calls += 1
            return _Blocked()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    blocked = _Client()
    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Ctx(blocked))

    resp = _post_chat(client)

    assert blocked.calls == 1, "确定性 11140 绝不重试（换号/同号重试都是白烧额度）"
    assert resp.status_code == 400
