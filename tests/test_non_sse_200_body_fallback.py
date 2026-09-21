"""契约测试：「HTTP 200 + 非 SSE 正文」不得被伪装成成功（Batch 2 · 第三项）。

真实故障形态：上游偶发用 200 直接回一段普通 JSON（或网关 HTML 错误页），整段没有
`data:` 前缀行。旧实现把每个聚合字段留在默认值上，于是产出一个 content 为 null 的
**假成功** —— 客户端看到「模型没回答」，日志里却是一行正常 200 成功，无从排查。
"""

import asyncio
import json

import converter
import pytest


class _FakeResp:
    """模拟 httpx.Response 的 aiter_lines()（只用到这一处接口）。"""

    def __init__(self, lines):
        self.status_code = 200
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


def _collect(lines):
    return asyncio.run(converter._collect_stream(_FakeResp(lines)))


# ───────────────────── 成功形态：真是普通 JSON 的 chat.completion ─────────────────────

def test_non_sse_full_chat_completion_is_accepted():
    """上游只是没走流式却回了完整 chat.completion → 必须原样采纳（不能误判为失败）。"""
    body = json.dumps({
        "id": "chatcmpl-x", "object": "chat.completion", "created": 1, "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    })
    result, _ = _collect([body])
    assert result["choices"][0]["message"]["content"] == "hi"


def test_non_sse_multiline_pretty_printed_json_is_reassembled():
    """正文被 minify 前是多行 JSON —— 拼接后必须仍能解析（不得按行丢弃）。"""
    body = json.dumps({
        "id": "chatcmpl-y", "object": "chat.completion", "created": 1, "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                     "finish_reason": "stop"}],
    }, indent=2, ensure_ascii=False)
    result, _ = _collect(body.splitlines())
    assert result["choices"][0]["message"]["content"] == "ok"


# ───────────────────── 失败形态：必须抛错，不得伪装成功 ─────────────────────

def test_non_sse_error_envelope_raises():
    """错误信封（code 非 0）必须抛 UpstreamInBandError，且原始正文可追溯。"""
    body = '{"error":{"data":{"code":14018,"msg":"额度已用尽"}}}'
    with pytest.raises(converter.UpstreamInBandError) as ei:
        _collect([body])
    assert "14018" in ei.value.raw, "原始正文必须带出去，否则客户端看不到上游原因"


def test_non_sse_html_gateway_page_raises():
    """网关 HTML 错误页（非 JSON）同样必须抛错，不得产出空 content。"""
    with pytest.raises(converter.UpstreamInBandError):
        _collect(["<html><body>502 Bad Gateway</body></html>"])


def test_non_sse_empty_body_raises():
    """空正文是异常，不是「模型回答为空」。"""
    with pytest.raises(converter.UpstreamInBandError):
        _collect([""])


def test_non_sse_unknown_json_object_raises():
    """既不标准也无 choices 的 JSON：不能当成功，否则正文被静默吞掉。"""
    with pytest.raises(converter.UpstreamInBandError):
        _collect(['{"foo":"bar"}'])


def test_non_sse_json_array_raises():
    """顶层是数组（非对象）属于未知形态，须抛错。"""
    with pytest.raises(converter.UpstreamInBandError):
        _collect(["[1,2,3]"])


def test_upstream_in_band_error_is_httpx_error():
    """必须继承 httpx.HTTPError —— 三个协议入口都靠这个分支做换号/记失败/协议化错误。

    若改成普通 Exception，带内错误会穿透入口的 except 链变成 500，换号也失效。
    """
    import httpx

    assert issubclass(converter.UpstreamInBandError, httpx.HTTPError)


# ───────────────────── 正常 SSE 路径不受影响 ─────────────────────

def test_normal_sse_path_unaffected_by_probe():
    """正常 SSE 流必须照旧聚合（探测缓冲不得干扰）。"""
    lines = [
        'data: {"model":"m","choices":[{"delta":{"content":"he"}}]}',
        'data: {"model":"m","choices":[{"delta":{"content":"llo"}}]}',
        'data: {"model":"m","choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)
    assert result["choices"][0]["message"]["content"] == "hello"
    assert result["finish_reason" if "finish_reason" in result else "choices"] is not None


def test_sse_with_leading_noise_lines_still_parses():
    """SSE 前若夹杂空行/注释行（`: keep-alive`），仍按 SSE 处理，不触发非 SSE 兜底。"""
    lines = [
        "",
        ": keep-alive",
        'data: {"model":"m","choices":[{"delta":{"content":"x"}}]}',
        "data: [DONE]",
    ]
    result, _ = _collect(lines)
    assert result["choices"][0]["message"]["content"] == "x"
