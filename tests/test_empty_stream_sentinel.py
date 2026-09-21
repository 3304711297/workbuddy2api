"""契约测试：空流不得被伪装成「模型回答为空」（Batch 3）。

真实形态：上游 HTTP 200 且 SSE 格式合法，但整段流里**没有任何实质内容**
（只收到 `[DONE]`，或只有空 delta / 空行）。旧行为把它聚合/透传成「200 + 空回答」，
即把上游故障伪装成「模型回答为空」——调用方据此判断重试策略会得出错误结论，
日志里也只是一行正常 200 成功，观测面完全看不到异常。

反向要求（同样重要）：**合法的空回答不得被误报成故障** —— 若上游明确下发
`finish_reason`（哪怕正文为空），那是模型确实没说话，属诚实结果，必须照常放行。
"""

import asyncio
import json

import converter
import pytest

from tests.test_non_sse_200_body_fallback import _FakeResp  # 复用同一 fake（aiter_lines）


def _collect(lines):
    return asyncio.run(converter._collect_stream(_FakeResp(lines)))


# ───────────────────── 空流必须抛错（非流式语义）─────────────────────

def test_sse_with_only_done_is_rejected():
    """只收到 [DONE] 的空流 → 必须抛 UpstreamEmptyStreamError，不得产出空回答。"""
    with pytest.raises(converter.UpstreamEmptyStreamError):
        _collect(["data: [DONE]"])


def test_sse_with_empty_deltas_only_is_rejected():
    """只有空 delta（content:""、reasoning_content:""）的空流同样必须抛错。"""
    lines = [
        'data: {"model":"m","choices":[{"delta":{"content":""}}]}',
        'data: {"model":"m","choices":[{"delta":{"reasoning_content":""}}]}',
        'data: {"model":"m","choices":[{"delta":{}}]}',
        "data: [DONE]",
    ]
    with pytest.raises(converter.UpstreamEmptyStreamError):
        _collect(lines)


def test_sse_with_no_frames_at_all_is_rejected():
    """连一行 SSE 都没有（空正文）→ 也必须是错误，不能是空成功。"""
    with pytest.raises(converter.UpstreamInBandError):
        _collect([])


def test_empty_stream_error_is_httpx_error():
    """必须继承 httpx.HTTPError：三个协议入口靠这个分支做换号/记失败/协议化错误。"""
    import httpx

    assert issubclass(converter.UpstreamEmptyStreamError, httpx.HTTPError)


# ───────────────────── 反向：合法内容不得被误报 ─────────────────────

def test_normal_content_still_passes():
    """正向：有正文的正常流不受哨兵影响。"""
    lines = [
        'data: {"model":"m","choices":[{"delta":{"content":"hi"}}]}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)
    assert result["choices"][0]["message"]["content"] == "hi"


def test_reasoning_only_stream_still_passes():
    """正向：只有 reasoning 没有正文的流（真思考流）必须放行。"""
    lines = [
        'data: {"model":"m","choices":[{"delta":{"reasoning_content":"思考中"}}]}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)
    assert result["choices"][0]["message"]["reasoning_content"] == "思考中"


def test_tool_call_only_stream_still_passes():
    """正向：只有 tool_calls 的流必须放行。"""
    lines = [
        'data: {"model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1",'
        '"function":{"name":"f","arguments":"{}"}}]}}]}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)
    assert result["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "f"


def test_empty_content_with_finish_reason_is_honest_result():
    """**关键反向用例**：上游明确给了 finish_reason 而正文为空 → 属诚实结果，不得误报故障。

    这是哨兵最容易修过头的地方：把「模型确实没说话」也判成上游故障，会让调用方
    对着一个合法的空回答反复重试。
    """
    lines = [
        'data: {"model":"m","choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5}}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)  # 不得抛异常
    assert result["choices"][0]["finish_reason"] == "stop"


def test_zero_token_usage_alone_does_not_count_as_payload():
    """usage 全 0 不构成「有内容」（否则空流会被 usage 帧救活）。"""
    assert converter._has_stream_payload([], [], {}, {"prompt_tokens": 0,
                                                      "completion_tokens": 0,
                                                      "total_tokens": 0}, None) is False
    assert converter._has_stream_payload([], [], {}, {"total_tokens": 7}, None) is True


def test_has_stream_payload_ignores_non_numeric_usage():
    """usage 里的非数字值（字符串/None）不得让判据崩或误判。"""
    assert converter._has_stream_payload([], [], {}, {"total_tokens": "abc"}, None) is False
    assert converter._has_stream_payload([], [], {}, {"total_tokens": None}, None) is False
