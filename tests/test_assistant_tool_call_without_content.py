"""契约测试：保留不含 content 的 assistant tool_calls 消息（验证 orangeboyChen/codebuddy2api #192 场景）。

背景
----
在 OpenAI 规范中，当 assistant 调用工具时，可以仅返回 `tool_calls` 而省略 `content` 字段
（或值为 null/None）。部分客户端 SDK（例如 Go 的 openai-go）在序列化时使用 omitzero，
会直接省略 content 字段。
若反代网关在过滤或投影历史消息时误以 `item.content is not None` 为守卫，会导致 assistant 消息
被意外丢弃，从而让后续的 tool 结果消息变成孤儿（orphaned tool message），引起上游模型 400 报错。

本测试验证本仓库在脱敏、投影、以及消息流转全链路均正确保留此类 contentless assistant 消息。
"""

import desensitize
import responses_projection


def test_desensitize_preserves_contentless_assistant_tool_call():
    """验证 desensitize_body 不会因为 assistant 消息缺少 content 或 content 为 None 而丢弃或报错。"""
    tool_calls = [
        {
            "id": "call_report_01",
            "type": "function",
            "function": {"name": "report_status", "arguments": '{"status": "ok"}'},
        }
    ]
    # 1. 完全不传 content 字段
    body_no_content = {
        "messages": [
            {"role": "user", "content": "check status"},
            {"role": "assistant", "tool_calls": tool_calls},
            {"role": "tool", "tool_call_id": "call_report_01", "content": "all systems green"},
        ]
    }
    res1 = desensitize.desensitize_body(body_no_content, roles=("system", "assistant"))
    assert len(res1["messages"]) == 3
    assert res1["messages"][1]["role"] == "assistant"
    assert res1["messages"][1]["tool_calls"] == tool_calls
    assert "content" not in res1["messages"][1]

    # 2. content 为 None
    body_none_content = {
        "messages": [
            {"role": "user", "content": "check status"},
            {"role": "assistant", "content": None, "tool_calls": tool_calls},
            {"role": "tool", "tool_call_id": "call_report_01", "content": "all systems green"},
        ]
    }
    res2 = desensitize.desensitize_body(body_none_content, roles=("system", "assistant"))
    assert len(res2["messages"]) == 3
    assert res2["messages"][1]["role"] == "assistant"
    assert res2["messages"][1]["content"] is None
    assert res2["messages"][1]["tool_calls"] == tool_calls


def test_responses_projection_preserves_contentless_assistant_tool_call():
    """验证 responses_projection 保留无 content 的 assistant tool_calls 并不破坏配对关系。"""
    tool_calls = [
        {
            "id": "call_inspect_02",
            "type": "function",
            "function": {"name": "inspect_code", "arguments": '{"path": "main.py"}'},
        }
    ]
    body = {
        "messages": [
            {"role": "user", "content": "Please inspect main.py"},
            {"role": "assistant", "tool_calls": tool_calls},
            {"role": "tool", "tool_call_id": "call_inspect_02", "content": "def main(): pass"},
        ],
        "tools": [{"type": "function", "function": {"name": "inspect_code"}}],
    }

    projected, stats = responses_projection.project_responses_chat_body(body)
    msgs = projected["messages"]

    # 校验 assistant 消息未被丢弃
    assistant_msgs = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistant_msgs) == 1
    asst = assistant_msgs[0]
    assert asst.get("tool_calls") == tool_calls

    # 校验 tool 消息与其配对保持一致
    tool_msgs = [m for m in msgs if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].get("tool_call_id") == "call_inspect_02"


def test_multi_turn_contentless_tool_calls_sequence():
    """验证多轮连续无 content 的 tool_calls 与 tool 返回序列在投影中完整保留。"""
    call1 = {"id": "c1", "type": "function", "function": {"name": "tool_a", "arguments": "{}"}}
    call2 = {"id": "c2", "type": "function", "function": {"name": "tool_b", "arguments": "{}"}}

    body = {
        "messages": [
            {"role": "user", "content": "step 1 and 2"},
            {"role": "assistant", "tool_calls": [call1]},
            {"role": "tool", "tool_call_id": "c1", "content": "step 1 done"},
            {"role": "assistant", "tool_calls": [call2]},
            {"role": "tool", "tool_call_id": "c2", "content": "step 2 done"},
        ],
        "tools": [
            {"type": "function", "function": {"name": "tool_a"}},
            {"type": "function", "function": {"name": "tool_b"}},
        ],
    }

    projected, _ = responses_projection.project_responses_chat_body(body)
    roles = [m.get("role") for m in projected["messages"]]
    assert roles == ["user", "assistant", "tool", "assistant", "tool"]
