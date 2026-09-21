"""契约测试：截断流不得被报成完整成功（采纳自 ShouZhuo0413/codebuddy2api 的
`validate_stream_end` 思路，按本仓形态独立实现）。

背景
----
上游流被**中途切断**（连接断了、网关掐了、上游超时中断）时，客户端会收到「正文来了
一部分，但没有任何收尾标记」。旧行为在这条路径上**无条件合成正常收尾**：

  · `/v1/chat/completions`：`_stream_upstream` 结束即打印 `◀ RESPONSE ... stream
    finish=None`，并 `_record_usage(ok=True)`；
  · `/v1/responses`：`ResponsesStreamConverter.finish()` 无条件补
    `response.completed` + 完成态 item。

于是客户端把半句话当完整答案消费（Codex/Claude Code 据此结束本轮、不再重试），
而日志里是一行正常 200 成功 —— **静默失败**：既看不到异常，也拿不到可重试的信号。

修法：两个终止信号（上游 `[DONE]`、choice 的 `finish_reason`）**都缺**时判为截断。
判据刻意取「两个都缺」而不是「缺 [DONE]」：本机 1711 条 RESPONSE 日志里 600 条流式
响应**全部**给了 finish_reason，其中 587 条**没有**再补 [DONE]（13 条补了）——
单看 [DONE] 会把 587 条正常流全部误报成截断。

反向纪律（同样重要）
--------------------
正常收尾（给了 finish_reason）绝不能因为缺 [DONE] 被误报；空流仍走空流哨兵；
客户端主动断开（CancelledError）仍记 client disconnected，不算截断。
"""

import asyncio
import json

import pytest

import converter
from responses_compat import ResponsesStreamConverter


# ═══════════════════ ① Responses 转换器：finish() 的截断哨兵 ═══════════════════

def _collect_responses(chunks):
    conv = ResponsesStreamConverter(model="m")
    out = ""
    for c in chunks:
        out += conv.feed_chunk(c)
    out += conv.finish()
    return out


def test_truncated_responses_stream_reports_failed_not_completed():
    """**核心用例**：有正文但无 finish_reason 就断流 → 必须 response.failed。"""
    out = _collect_responses([
        {"choices": [{"delta": {"content": "half an answer"}}]},
        # 流到此为止：没有 finish_reason
    ])
    assert "response.failed" in out
    assert "response.completed" not in out
    assert "upstream_stream_interrupted" in out


def test_truncated_stream_keeps_partial_content():
    """诚实内容面：已产出的部分正文必须保留（不是把内容也丢掉）。"""
    out = _collect_responses([
        {"choices": [{"delta": {"content": "partial "}}]},
        {"choices": [{"delta": {"content": "output"}}]},
    ])
    assert "partial " in out and "output" in out
    assert "response.failed" in out


def test_truncated_tool_call_stream_reports_failed():
    """工具调用流被截断（参数没给完）同样必须报 failed，不能当 completed。"""
    out = _collect_responses([
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c1", "function": {"name": "f", "arguments": '{"a":'}}]}}]},
    ])
    assert "response.failed" in out
    assert "response.completed" not in out


def test_normal_stream_with_finish_reason_stays_completed():
    """**关键反向用例 A**：给了 finish_reason 的正常流必须照旧 completed。"""
    out = _collect_responses([
        {"choices": [{"delta": {"content": "ok"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    ])
    assert "response.completed" in out
    assert "response.failed" not in out


def test_normal_stream_without_done_marker_stays_completed():
    """**关键反向用例 B**：只有 finish_reason、没有 [DONE]（本机 587/600 的真实形态）
    绝不能因为「缺 [DONE]」被误报成截断。"""
    out = _collect_responses([
        {"choices": [{"delta": {"content": "ok"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        # 之后没有 [DONE]，feed_chunk 也不会收到 —— 属正常
    ])
    assert "response.completed" in out
    assert "response.failed" not in out


def test_tool_call_finish_reason_counts_as_terminal():
    """finish_reason=tool_calls 同样是合法收尾（Agent 场景的主力形态）。"""
    out = _collect_responses([
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c1", "function": {"name": "f", "arguments": "{}"}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ])
    assert "response.completed" in out
    assert "response.failed" not in out


def test_upstream_error_chunk_still_uses_failed_path():
    """上游错误 chunk 的既有 failed 路径不受影响（不是被哨兵取代）。"""
    out = _collect_responses([
        {"choices": [{"delta": {"content": "x"}}]},
        {"error": {"message": "boom", "code": 500}},
    ])
    assert "response.failed" in out
    assert "response.completed" not in out


def test_empty_stream_does_not_emit_failed():
    """整条流零帧 → 保持原样（不凭空造 failed 事件；空流由 chat 侧哨兵负责）。"""
    out = _collect_responses([])
    assert "response.failed" not in out


# ═══════════════════ ② chat 流式路径：截断不得记成功 ═══════════════════

class _FakeStreamResponse:
    def __init__(self, lines: list[bytes]):
        self._lines = lines
        self.status_code = 200
        self.headers = {}

    async def aiter_bytes(self):
        for ln in self._lines:
            yield ln

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    def stream(self, *args, **kwargs):
        return self._resp


class _FakeCtx:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return _FakeClient(self._resp)

    async def __aexit__(self, *args):
        pass


def _drive(lines, monkeypatch):
    monkeypatch.setattr(converter, "_shared_client_ctx",
                        lambda timeout=None: _FakeCtx(_FakeStreamResponse(lines)))
    calls = []
    monkeypatch.setattr(converter, "_record_usage", lambda *a, **k: calls.append((a, k)))

    async def _run():
        gen = converter._stream_upstream(url="https://api.test/stream", headers={},
                                         body={"model": "m"}, model_name="m")
        return [c async for c in gen]

    return asyncio.run(_run()), calls


def _chunk(content=None, finish=None):
    d = {}
    if content is not None:
        d["content"] = content
    return ("data: " + json.dumps({"choices": [{"delta": d,
                                                "finish_reason": finish}]}) + "\n\n").encode()


def test_chat_truncated_stream_emits_error_and_records_failure(monkeypatch):
    """**核心用例**：chat 流式被截断 → 必须下发错误帧，且如实记失败。

    旧行为在这里打印正常 RESPONSE、记 ok=True，客户端拿到半句话当完整答案。
    """
    out, calls = _drive([_chunk(content="half"), _chunk(content=" an answer")], monkeypatch)
    blob = b"".join(out).decode("utf-8", "replace")
    assert "upstream stream interrupted" in blob, "截断流必须下发明确的错误面"
    assert calls, "必须记录一次用量"
    assert calls[-1][1].get("ok") is False, "截断不得记成成功"
    assert "interrupted" in str(calls[-1][1].get("error") or "")


def test_chat_normal_finish_reason_without_done_records_success(monkeypatch):
    """**关键反向用例**：给了 finish_reason 但没有 [DONE]（本机主力形态）→ 照旧成功。"""
    out, calls = _drive([_chunk(content="ok"), _chunk(finish="stop")], monkeypatch)
    blob = b"".join(out).decode("utf-8", "replace")
    assert "interrupted" not in blob
    assert calls[-1][1].get("ok") is True, "有 finish_reason 的正常流必须记成功"


def test_chat_done_marker_alone_is_not_enough_but_not_fatal(monkeypatch):
    """有 [DONE] 而无 finish_reason：这是合法收尾形态的一种，不得误报截断。"""
    out, calls = _drive([_chunk(content="ok"), b"data: [DONE]\n\n"], monkeypatch)
    blob = b"".join(out).decode("utf-8", "replace")
    assert "interrupted" not in blob
    assert calls[-1][1].get("ok") is True
