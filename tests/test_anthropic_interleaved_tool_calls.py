"""
tests/test_anthropic_interleaved_tool_calls.py - Anthropic 多 tool_calls 交错状态机契约测试
"""

import json
from typing import List, Dict, Any
import pytest

from anthropic_stream import AnthropicStreamTranslator


def parse_sse_events(raw_events: List[str]) -> List[Dict[str, Any]]:
    parsed = []
    for raw in raw_events:
        lines = [line.strip() for line in raw.strip().splitlines() if line.strip()]
        event_type = None
        data = None
        for line in lines:
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_str = line[5:].strip()
                data = json.loads(data_str)
        if event_type or data:
            parsed.append({"event": event_type, "data": data})
    return parsed


def test_sequential_parallel_tools():
    """测试常规顺序的多工具调用 (0 -> 1)，各自恰好一次 start 与 stop。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_0", "function": {"name": "get_weather", "arguments": '{"city":'}}]}}]
    }))
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"Beijing"}'}}]}}]
    }))
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_1", "function": {"name": "get_time", "arguments": "{}"}}]}}]
    }))
    events.extend(t.feed_chunk({
        "choices": [{"delta": {}, "finish_reason": "tool_calls"}]
    }))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    starts = [p for p in parsed if p["event"] == "content_block_start" and p["data"]["content_block"]["type"] == "tool_use"]
    stops = [p for p in parsed if p["event"] == "content_block_stop"]

    assert len(starts) == 2, f"必须恰好有 2 个 tool_use start，实际得到 {len(starts)}"
    assert starts[0]["data"]["index"] == 0
    assert starts[0]["data"]["content_block"]["name"] == "get_weather"
    assert starts[1]["data"]["index"] == 1
    assert starts[1]["data"]["content_block"]["name"] == "get_time"

    assert len(stops) == 2, f"必须恰好有 2 个 content_block_stop，实际得到 {len(stops)}"
    stop_indices = {s["data"]["index"] for s in stops}
    assert stop_indices == {0, 1}


def test_interleaved_tool_calls_0_1_0():
    """核心回归测试：交错流 (0 -> 1 -> 0) 绝不能把 tool 0 拆成两个 content_block_start。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []

    # 1. tool 0 开始
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_search", "function": {"name": "search", "arguments": '{"q":'}}]}}]
    }))
    # 2. tool 1 插入开始
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_calc", "function": {"name": "calc", "arguments": '{"expr":'}}]}}]
    }))
    # 3. tool 0 再次到达增量参数
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"python"}'}}]}}]
    }))
    # 4. tool 1 再次到达增量参数
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": '"1+1"}'}}]}}]
    }))
    # 5. 结束
    events.extend(t.feed_chunk({
        "choices": [{"delta": {}, "finish_reason": "tool_calls"}]
    }))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    starts = [p for p in parsed if p["event"] == "content_block_start" and p["data"]["content_block"]["type"] == "tool_use"]
    deltas = [p for p in parsed if p["event"] == "content_block_delta"]
    stops = [p for p in parsed if p["event"] == "content_block_stop"]

    # 关键断言：绝不能出现第 3 个 start！
    assert len(starts) == 2, f"交错流只能开 2 个工具 block，绝不能重复开第 3 个！实际开: {len(starts)}"
    assert starts[0]["data"]["content_block"]["id"] == "call_search"
    assert starts[1]["data"]["content_block"]["id"] == "call_calc"

    # 检查 deltas 的归属
    deltas_0 = [d for d in deltas if d["data"]["index"] == starts[0]["data"]["index"]]
    deltas_1 = [d for d in deltas if d["data"]["index"] == starts[1]["data"]["index"]]

    args_0 = "".join(d["data"]["delta"]["partial_json"] for d in deltas_0)
    args_1 = "".join(d["data"]["delta"]["partial_json"] for d in deltas_1)

    assert args_0 == '{"q":"python"}'
    assert args_1 == '{"expr":"1+1"}'

    # 两个工具各自恰好一次 stop
    assert len(stops) == 2
    assert {s["data"]["index"] for s in stops} == {starts[0]["data"]["index"], starts[1]["data"]["index"]}


def test_high_frequency_interleaved_tool_calls():
    """高频交错压力测试：0 -> 1 -> 0 -> 1 -> 0 -> 1。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []

    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t0", "function": {"name": "f0", "arguments": "a"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "t1", "function": {"name": "f1", "arguments": "1"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "b"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": "2"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "c"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": "3"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    starts = [p for p in parsed if p["event"] == "content_block_start" and p["data"]["content_block"]["type"] == "tool_use"]
    assert len(starts) == 2, f"高频交错下工具 block 数量恒为 2，实际为 {len(starts)}"

    stops = [p for p in parsed if p["event"] == "content_block_stop"]
    assert len(stops) == 2, f"高频交错下关闭事件必须恰好为 2，实际为 {len(stops)}"


def test_sparse_non_consecutive_upstream_indices():
    """非连续上游 index 映射测试：上游 index 为 3 与 7，Anthropic 连续分配 0 与 1。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []

    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 3, "id": "t3", "function": {"name": "fn3", "arguments": '{"x":1}'}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 7, "id": "t7", "function": {"name": "fn7", "arguments": '{"y":2}'}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 3, "function": {"arguments": ""}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    starts = [p for p in parsed if p["event"] == "content_block_start" and p["data"]["content_block"]["type"] == "tool_use"]
    assert len(starts) == 2
    assert starts[0]["data"]["index"] == 0
    assert starts[0]["data"]["content_block"]["name"] == "fn3"
    assert starts[1]["data"]["index"] == 1
    assert starts[1]["data"]["content_block"]["name"] == "fn7"


def test_tool_metadata_in_first_chunk_only():
    """上游仅在首帧携带 id 和 name，后续帧只有 index 和 arguments 时，元数据不丢失且属于同一 block。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []

    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_meta", "function": {"name": "test_fn", "arguments": "{"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"k":1}'}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    starts = [p for p in parsed if p["event"] == "content_block_start"]
    assert len(starts) == 1
    assert starts[0]["data"]["content_block"]["id"] == "call_meta"
    assert starts[0]["data"]["content_block"]["name"] == "test_fn"


def test_finalize_closes_all_open_tool_blocks():
    """未通过 finish_reason 显示闭合而在 finalize 退出时，所有打开的 tool blocks 必须被完整 stop。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []

    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t0", "function": {"name": "f0", "arguments": "{}"}}]}}]}))
    events.extend(t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "t1", "function": {"name": "f1", "arguments": "{}"}}]}}]}))
    # 模拟客户端直接收到 [DONE]，不带 finish_reason
    events.extend(t.feed_line("data: [DONE]"))

    parsed = parse_sse_events(events)
    stops = [p for p in parsed if p["event"] == "content_block_stop"]
    assert len(stops) == 2
    assert {s["data"]["index"] for s in stops} == {0, 1}

    # 包含 message_delta 和 message_stop
    m_deltas = [p for p in parsed if p["event"] == "message_delta"]
    m_stops = [p for p in parsed if p["event"] == "message_stop"]
    assert len(m_deltas) == 1
    assert len(m_stops) == 1


def test_finalize_idempotency_no_duplicate_stops():
    """测试 finalize 幂等性：重复调用 finalize 绝对不能重复发出 stop 事件。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    t.feed_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t0", "function": {"name": "f0", "arguments": "{}"}}]}}]})
    res1 = t.finalize()
    res2 = t.finalize()

    assert len(res1) > 0
    assert len(res2) == 0, "第二次 finalize 必须返回空列表"


def test_single_tool_regression():
    """测试单工具正常流式向后兼容性与 stop_reason。"""
    t = AnthropicStreamTranslator(model="claude-3-5-sonnet-20241022")
    events = []
    events.extend(t.feed_chunk({
        "choices": [{"delta": {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_single", "function": {"name": "calc", "arguments": '{"a": 1}'}}]}}]
    }))
    events.extend(t.feed_chunk({
        "choices": [{"delta": {}, "finish_reason": "tool_calls"}]
    }))
    events.extend(t.finalize())

    parsed = parse_sse_events(events)
    m_delta = next(p for p in parsed if p["event"] == "message_delta")
    assert m_delta["data"]["delta"]["stop_reason"] == "tool_use"

    starts = [p for p in parsed if p["event"] == "content_block_start" and p["data"]["content_block"]["type"] == "tool_use"]
    assert len(starts) == 1
    assert starts[0]["data"]["content_block"]["name"] == "calc"
