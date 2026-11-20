"""Chat 形状 Responses 回放的保真：reasoning_content / tool_calls / tool_call_id。

Codex CLI 等客户端会把上一轮历史以 **Chat 形状**塞回 Responses `input`
（`{"role":"assistant","content":…,"tool_calls":[…],"reasoning_content":…}` 与
`{"role":"tool","tool_call_id":…,"name":…}`）。转换层若只取 `content`：

- assistant 的 `tool_calls` 丢失 → 后面的 tool 结果成为孤儿；
- 出站清理会把「没有对应调用的 tool 消息」与「没有结果的调用」成对删掉，
  模型于是「忘记自己刚调用过工具」，反复重试同一个工具；
- `reasoning_content` 丢失 → DeepSeek 系模型多轮思维链回填失效。

这里钉住 Chat 形状回放的字段保真，同时保留「不存在的字段不得凭空造」。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from responses_compat import responses_request_to_chat


def _messages(*items):
    return responses_request_to_chat({"model": "m", "input": list(items)})["messages"]


TOOL_CALL = {
    "id": "call_1",
    "type": "function",
    "function": {"name": "shell", "arguments": '{"cmd":"ls"}'},
}


def test_chat_shaped_assistant_keeps_tool_calls_and_reasoning():
    msgs = _messages(
        {"role": "user", "content": "run it"},
        {
            "type": "message",
            "role": "assistant",
            "content": "running",
            "reasoning_content": "need to list files",
            "tool_calls": [TOOL_CALL],
        },
        {
            "type": "message",
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "shell",
            "content": "file.txt",
        },
    )
    assistant, tool = msgs[1], msgs[2]
    assert assistant["reasoning_content"] == "need to list files"
    assert assistant["tool_calls"] == [TOOL_CALL]
    # 调用与结果必须仍能按 id 配对（否则出站清理会成对删除）
    assert tool["tool_call_id"] == assistant["tool_calls"][0]["id"]
    assert tool["name"] == "shell"
    assert tool["content"] == "file.txt"


def test_chat_shaped_assistant_without_content_keeps_tool_calls():
    """content 为 None/空时仍要落地该轮，否则 tool_calls 无处可挂。"""
    msgs = _messages(
        {"role": "user", "content": "go"},
        {"type": "message", "role": "assistant", "content": None, "tool_calls": [TOOL_CALL]},
    )
    assert msgs[1]["content"] == ""
    assert msgs[1]["tool_calls"] == [TOOL_CALL]


def test_multiple_tool_calls_preserved_in_order():
    second = {
        "id": "call_2",
        "type": "function",
        "function": {"name": "read", "arguments": '{"path":"a"}'},
    }
    msgs = _messages(
        {"role": "user", "content": "go"},
        {
            "type": "message",
            "role": "assistant",
            "content": "",
            "tool_calls": [TOOL_CALL, second],
        },
    )
    assert [tc["id"] for tc in msgs[1]["tool_calls"]] == ["call_1", "call_2"]


def test_plain_assistant_message_does_not_gain_empty_metadata():
    msgs = _messages(
        {"role": "user", "content": "hi"},
        {"type": "message", "role": "assistant", "content": "hello"},
    )
    assert msgs[1] == {"role": "assistant", "content": "hello"}


def test_tool_result_without_call_id_does_not_invent_one():
    msgs = _messages({"type": "message", "role": "tool", "content": "orphan"})
    assert msgs[0] == {"role": "tool", "content": "orphan"}


def test_reasoning_item_and_assistant_reasoning_are_deduplicated():
    """reasoning item 与内联 reasoning_content 同时回放时只保留一份。"""
    msgs = _messages(
        {"role": "user", "content": "hi"},
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "think"}]},
        {
            "type": "message",
            "role": "assistant",
            "content": "answer",
            "reasoning_content": "think",
        },
    )
    assert msgs[1]["reasoning_content"] == "think"

    msgs = _messages(
        {"role": "user", "content": "hi"},
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "first"}]},
        {
            "type": "message",
            "role": "assistant",
            "content": "answer",
            "reasoning_content": "second",
        },
    )
    assert msgs[1]["reasoning_content"] == "first\nsecond"
