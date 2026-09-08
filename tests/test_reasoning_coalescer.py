"""回归测试：流式 reasoning 合并器 + 空 delta 清洗（借鉴 DistPub/workbuddy2api）。

针对两类真实问题：
  A. 空 content:"" 混在 reasoning delta 里 → AI SDK 客户端出现几百个「Thought for 2ms」
  B. reasoning 分片与 tool_calls 的 arguments 流穿插 → 工具参数 JSON 截断/污染

组件：_sanitize_delta_obj / _ReasoningCoalescer / _SseLineBuffer（模块级纯函数，
不依赖网络/凭据，全程单进程内测）。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


def sse(obj) -> bytes:
    return converter._encode_sse_chunk(obj)


def events_out(chunks: list[bytes]) -> list[dict]:
    """把 _ReasoningCoalescer.feed 的输出流解析回 JSON 对象列表。"""
    out = []
    for evt in chunks:
        for line in evt.split(b"\n"):
            s = line.strip()
            if not s.startswith(b"data:") or s == b"data: [DONE]":
                continue
            try:
                out.append(json.loads(s[5:]))
            except Exception:
                pass
    return out


# ---------- A: strip_empty_delta ----------

def test_sanitize_removes_empty_content_in_reasoning_delta():
    """content 为空且 reasoning 非空 → 删除 content 键，保留 reasoning。"""
    obj = {"choices": [{"index": 0, "delta": {"content": "", "reasoning_content": "思考中"}}]}
    changed, new = converter._sanitize_delta_obj(obj)
    assert changed
    assert "content" not in new["choices"][0]["delta"]
    assert new["choices"][0]["delta"]["reasoning_content"] == "思考中"


def test_sanitize_drops_fully_empty_delta():
    """delta 只有空字段且无 finish_reason → 整个 choice 丢弃。"""
    obj = {"choices": [{"index": 0, "delta": {"content": ""}}]}
    changed, new = converter._sanitize_delta_obj(obj)
    assert changed
    assert new["choices"] == []


def test_sanitize_keeps_finish_reason_choice():
    """delta 空但带 finish_reason → 保留为收尾帧。"""
    obj = {"choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "stop"}]}
    changed, new = converter._sanitize_delta_obj(obj)
    assert changed
    assert new["choices"][0]["finish_reason"] == "stop"
    assert new["choices"][0]["delta"] == {}


def test_sanitize_passthrough_non_delta():
    """非 delta 形状（usage 汇总帧）原样返回。"""
    obj = {"usage": {"total_tokens": 10}}
    changed, new = converter._sanitize_delta_obj(obj)
    assert not changed
    assert new is obj


# ---------- B: reasoning coalescer ----------

def test_coalescer_streams_reasoning_in_realtime_without_delay():
    """纯 reasoning 分片应当即时下发，绝不静默积压等待 content（避免下游 60s/140s 超时）。"""
    c = converter._ReasoningCoalescer()
    chunks1 = c.feed(sse({"choices": [{"index": 0, "delta": {"reasoning_content": "思考1"}}]}))
    assert len(chunks1) > 0, "reasoning 首包必须即时产出，严禁返回空列表导致下游 60s 静默超时"
    objs1 = events_out(chunks1)
    assert objs1[0]["choices"][0]["delta"]["reasoning_content"] == "思考1"

    chunks2 = c.feed(sse({"choices": [{"index": 0, "delta": {"reasoning_content": "思考2"}}]}))
    assert len(chunks2) > 0, "reasoning 连续分片必须持续流式下发"
    objs2 = events_out(chunks2)
    assert objs2[0]["choices"][0]["delta"]["reasoning_content"] == "思考2"


def test_coalescer_streams_scattered_reasoning_in_realtime_before_content():
    """多个纯 reasoning 分片 → 逐帧即时流式释放，且在 content 前保持顺序完整。"""
    c = converter._ReasoningCoalescer()
    chunks = []
    for seg in ("第一", "段思", "考"):
        fed = c.feed(sse({"choices": [{"index": 0, "delta": {"reasoning_content": seg}}]}))
        assert len(fed) > 0, f"分片 '{seg}' 必须即时产生 SSE 帧，不可延迟"
        chunks += fed
    chunks += c.feed(sse({"choices": [{"index": 0, "delta": {"content": "答案"}}]}))
    chunks += c.flush()

    objs = events_out(chunks)
    # 期望事件序列：3 个连续流式 reasoning 帧 → 1 个 content 帧
    reasoning = [o for o in objs if o["choices"][0]["delta"].get("reasoning_content")]
    contents = [o for o in objs if o["choices"][0]["delta"].get("content")]
    assert len(reasoning) == 3, f"reasoning 应保持 3 帧平滑流式输出，实际 {len(reasoning)}"
    joined_reasoning = "".join(r["choices"][0]["delta"]["reasoning_content"] for r in reasoning)
    assert joined_reasoning == "第一段思考"
    assert len(contents) == 1
    assert contents[0]["choices"][0]["delta"]["content"] == "答案"


def test_coalescer_strips_reasoning_from_tool_call_frame():
    """tool_calls 与 reasoning 同帧 → reasoning 被剥离，参数 JSON 不被污染。"""
    c = converter._ReasoningCoalescer()
    frame = {"choices": [{"index": 0, "delta": {
        "reasoning_content": "混入的推理",
        "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                        "function": {"name": "f", "arguments": '{"a":1}'}}],
    }}]}
    chunks = c.feed(sse(frame)) + c.flush()
    objs = events_out(chunks)
    # reasoning 先整段释放，tool_calls 帧内不再含 reasoning_content
    assert objs[0]["choices"][0]["delta"].get("reasoning_content") == "混入的推理"
    tool_frame = objs[1]["choices"][0]["delta"]
    assert tool_frame["tool_calls"][0]["function"]["arguments"] == '{"a":1}'
    assert "reasoning_content" not in tool_frame


def test_coalescer_flush_releases_trailing_reasoning():
    """整段 reasoning 后直接 [DONE] → [DONE] 帧前释放残余 reasoning。"""
    c = converter._ReasoningCoalescer()
    chunks = c.feed(sse({"choices": [{"index": 0, "delta": {"reasoning_content": "尾部思考"}}]}))
    chunks += c.feed(b"data: [DONE]\n\n")
    objs = events_out(chunks)
    reasoning = [o for o in objs if (o.get("choices") or [{}])[0].get("delta", {}).get("reasoning_content")]
    assert reasoning and reasoning[0]["choices"][0]["delta"]["reasoning_content"] == "尾部思考"
    # [DONE] 帧本身不可 JSON 解析，故 objs 长度 == reasoning 帧数（1）
    assert len(reasoning) == 1


def test_coalescer_passthrough_when_disabled(monkeypatch):
    """coalesce_reasoning=False → 原样透传不重组。"""
    monkeypatch.setattr(converter, "CONFIG", dict(converter.CONFIG, coalesce_reasoning=False))
    c = converter._ReasoningCoalescer()
    evt = sse({"choices": [{"index": 0, "delta": {"reasoning_content": "x"}}]})
    assert c.feed(evt) == [evt]


def test_coalescer_deep_thinking_50_chunks_continuous_streaming():
    """模拟深度思考模型（如 hy4-preview 生成复杂 SVG）输出 50 个连续推理分片：
    每帧必须即时产出，严禁在内部积攒导致下游等待 60s 超时。"""
    c = converter._ReasoningCoalescer()
    received_counts = []
    for i in range(50):
        seg = f"步骤{i},"
        fed = c.feed(sse({"choices": [{"index": 0, "delta": {"reasoning_content": seg}}]}))
        received_counts.append(len(fed))
    # 50 次输入均应立即产出
    assert all(cnt == 1 for cnt in received_counts), "所有 50 个思考分片都必须即时下发"


# ---------- _SseLineBuffer ----------

def test_sse_line_buffer_handles_split_chunks():
    """一行 SSE 拆到多个 TCP chunk → 行缓冲能正确切出。"""
    b = converter._SseLineBuffer()
    assert b.feed(b'data: {"a"') == []
    assert b.feed(b':1}\ndata: {"b"') == [b'data: {"a":1}']
    assert b.feed(b':2}\r\n') == [b'data: {"b":2}']
    assert b.flush() == []
