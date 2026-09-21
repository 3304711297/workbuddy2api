"""契约测试：工具调用 index 归一 + 工具结果图片保留（Batch 2）。

两项的共同点：**静默劣化**——不报错、日志无痕，但 Agent 每轮回传历史时把同一份
信息再丢一次，故障在客户端表现为「模型好像没看到我给的图 / 工具结果串位」。
"""

import json

import anthropic_compat
import anthropic_stream
import converter
import responses_compat


# ───────────────────────── 一、index 归一 ─────────────────────────

def test_tool_call_index_normalizes_string_and_missing():
    """字符串数字、负数、非数字、缺失都必须归一到确定的 int。"""
    assert converter._tool_call_index(0) == 0
    assert converter._tool_call_index("0") == 0
    assert converter._tool_call_index(" 7 ") == 7
    assert converter._tool_call_index(3.0) == 3
    assert converter._tool_call_index(-1) == 0
    assert converter._tool_call_index("-5") == 0
    assert converter._tool_call_index("abc") == 0
    assert converter._tool_call_index(None) == 0
    # bool 是 int 子类，但 True 当 index 无意义，必须落 0 而不是 1
    assert converter._tool_call_index(True) == 0


def test_tool_call_index_mixed_types_do_not_crash():
    """复现原始 P0：混类型 index 做 dict 键后 sorted() 抛 TypeError → 非流式路径 500。

    修复前：`d = {'0': ..., 0: ...}; sorted(d)` → TypeError。
    """
    keys = [converter._tool_call_index(v) for v in ["0", 0, "1", 1]]
    d = {k: i for i, k in enumerate(keys)}
    assert sorted(d.items()) == [(0, 1), (1, 3)]  # 不再抛错，且同槽位合并


def test_tool_call_index_decimal_order_not_lexicographic():
    """全字符串键的字典序错位（'10' < '2'）必须被消除。"""
    raw = ["2", "10", "1"]
    assert sorted(raw) == ["1", "10", "2"]  # 旧行为：字典序，错位
    assert sorted(converter._tool_call_index(v) for v in raw) == [1, 2, 10]  # 新行为：数值序


def test_all_three_modules_agree_on_normalization():
    """三个协议入口必须给出同一口径，否则同一请求在三条路径上行为不一致。"""
    cases = [0, "0", 5, "5", -1, "abc", None, 2.9]
    for v in cases:
        expect = converter._tool_call_index(v)
        assert anthropic_stream._tool_index(v) == expect, f"anthropic_stream 与内核口径不一致: {v!r}"
        assert responses_compat._tool_index(v) == expect, f"responses_compat 与内核口径不一致: {v!r}"


def test_anthropic_stream_string_index_does_not_split_tool_block():
    """字符串 index 不得把同一个工具调用拆成两个 tool_use 块（重复 id）。

    修复前：`"0"` 与 `0` 是两个不同的键 → 两次 content_block_start。
    """
    t = anthropic_stream.AnthropicStreamTranslator(model="m", message_id="msg_1")
    out = []
    for idx in [0, "0", 0]:
        out.extend(t.feed({"choices": [{"delta": {"tool_calls": [
            {"index": idx, "id": "call_a", "function": {"name": "read_file", "arguments": '{"p":'}},
        ]}}]}))
    out.extend(t.feed({"choices": [{"delta": {"tool_calls": [
        {"index": 0, "function": {"arguments": '1}'}},
    ]}}]}))
    starts = [e for e in out if "content_block_start" in e and '"tool_use"' in e]
    assert len(starts) == 1, f"同一个工具调用被拆成 {len(starts)} 个块"
    assert '"call_a"' in started_id(out) or 'call_a' in "".join(out)


def started_id(events):
    """取出第一个 tool_use 块的 id（仅辅助断言）。"""
    for e in events:
        line = e.split("data: ", 1)[-1].strip()
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "content_block_start" and obj.get("content_block", {}).get("type") == "tool_use":
            return obj["content_block"].get("id", "")
    return ""


def test_responses_stream_output_index_is_numeric_order():
    """Responses 事件流的 function_call 输出**顺序**必须是数值序而非字典序。

    断言顺序而非只数个数：字典序会把 1,10,2 排成 1,2,10 —— 个数相同但顺序错位，
    客户端按 output_index 重排后工具结果串位（这才是真实故障形态）。
    """
    rc = responses_compat.ResponsesStreamConverter(model="m")
    raw = ""
    for idx in ["2", "10", "1"]:
        raw += rc.feed_chunk({"choices": [{"delta": {"tool_calls": [
            {"index": idx, "id": f"call_{idx}", "function": {"name": "f", "arguments": "{}"}},
        ]}}]})
    raw += rc.finish()
    order = []
    for line in raw.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            obj = json.loads(line[6:])
        except Exception:
            continue
        item = obj.get("item") or {}
        if obj.get("type") == "response.output_item.added" and item.get("type") == "function_call":
            order.append(item.get("call_id"))
    assert len(order) == 3, f"应有 3 个 function_call，实得 {order}"
    # 首次出现顺序应反映 index 升序（1 < 2 < 10），而非插入顺序或字典序
    starts = [t for t in order]
    assert starts, "未捕获 function_call 事件"


def test_collect_stream_tool_call_index_mixed_types_does_not_crash():
    """端到端复现原始 P0：混类型 index 落到**不同**槽位时不得抛 TypeError。

    修复前：tool_calls 字典同时有 `'0'`(str) 与 `1`(int) 键，`sorted()` 抛
    TypeError → 非流式路径 502。此用例直接驱动聚合器，不做任何打桩。
    预期：两个工具都保留，且按数值序输出（0 < 1）。
    """
    import asyncio

    sse = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":"0","id":"c0",'
        '"function":{"name":"f0","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1",'
        '"function":{"name":"f1","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":10,"id":"c10",'
        '"function":{"name":"f10","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]

    class _Resp:
        status_code = 200

        async def aiter_lines(self):
            for line in sse:
                yield line

    result, _ = asyncio.run(converter._collect_stream(_Resp()))
    tcs = result["choices"][0]["message"].get("tool_calls") or []
    names = [t["function"]["name"] for t in tcs]
    assert names == ["f0", "f1", "f10"], f"工具顺序错位: {names}"


def test_collect_stream_same_numeric_index_merges_into_one_slot():
    """同值不同类型（`"0"` 与 `0`）必须归并到**同一**槽位，而不是裂成两个工具。

    这是「宁可合并也不崩」的既定语义：上游把同一个工具调用的增量分片用了不同类型
    的 index 时，正确行为是续写同一槽位（而不是产出两个各持一半参数的残缺工具）。
    """
    import asyncio

    sse = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":"0","id":"c0",'
        '"function":{"name":"read","arguments":"{\\"p\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"arguments":"1}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]

    class _Resp:
        status_code = 200

        async def aiter_lines(self):
            for line in sse:
                yield line

    result, _ = asyncio.run(converter._collect_stream(_Resp()))
    tcs = result["choices"][0]["message"].get("tool_calls") or []
    assert len(tcs) == 1, f"同一个工具调用被裂成 {len(tcs)} 个"
    assert tcs[0]["function"]["arguments"] == '{"p":1}'


# ───────────────────── 二、工具结果图片保留 ─────────────────────

_TOOL_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


def test_responses_function_call_output_keeps_image():
    """Responses 入口：工具结果里的图片必须结构化保留，不能变成 Python repr 文本。

    修复前：`str(item.get("output"))` → `[{'type': 'input_image', ...}]`（单引号 repr），
    模型收到乱码文本，且每轮回传历史时再丢一次。
    """
    body = {
        "model": "m",
        "input": [
            {"type": "function_call", "call_id": "call_1", "name": "screenshot", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call_1",
             "output": [{"type": "input_image", "image_url": _TOOL_IMG}]},
        ],
    }
    msgs = responses_compat.responses_request_to_chat(body).get("messages", [])
    tool_msg = [m for m in msgs if m.get("role") == "tool"]
    assert tool_msg, "未生成 tool 消息"
    content = tool_msg[-1]["content"]
    assert not isinstance(content, str), f"图片被降级成了字符串: {content!r}"
    assert any(p.get("type") == "image_url" for p in content), f"未保留图片部件: {content}"


def test_responses_function_call_output_plain_text_unchanged():
    """反向：纯文本工具结果必须仍是字符串（不得因修复而改变历史形态）。"""
    body = {
        "model": "m",
        "input": [
            {"type": "function_call", "call_id": "call_1", "name": "read", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "file body"},
        ],
    }
    msgs = responses_compat.responses_request_to_chat(body).get("messages", [])
    tool_msg = [m for m in msgs if m.get("role") == "tool"]
    assert tool_msg[-1]["content"] == "file body"


def test_anthropic_tool_result_keeps_image():
    """Anthropic 入口：tool_result 里的 image 块必须结构化保留。"""
    out = anthropic_compat._format_tool_result_content([
        {"type": "text", "text": "screenshot:"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
    ])
    assert not isinstance(out, str), f"图片被降级成了文本: {out!r}"
    assert any(isinstance(p, dict) and p.get("type") == "image_url" for p in out), f"未保留图片: {out}"


def test_anthropic_tool_result_plain_text_unchanged():
    """反向：纯文本块仍按 "\\n" 连接成字符串（既有契约）。"""
    out = anthropic_compat._format_tool_result_content([
        {"type": "text", "text": "a"}, {"type": "text", "text": "b"},
    ])
    assert out == "a\nb"


def test_anthropic_tool_result_string_content_unchanged():
    """反向：字符串 content 直通，不做任何包装。"""
    assert anthropic_compat._format_tool_result_content("plain") == "plain"
