"""契约测试：Responses 流式 history 缓存完整性与截断防护（对抗 ChatGPT 复核 P1-1, P1-2）。

1. P1-1: ResponsesStreamConverter 在流式完成时，不仅缓存文本 content，
   还必须完整提取 tool_calls 和 reasoning_content，保证下一轮 previous_response_id 继续时
   agent 能够拿到完整的工具调用元数据和思维链。
2. P1-2: 截断哨兵与失败流保护：若流途中发生中断（未收到 finish_reason）触发 response.failed，
   或者收到上游 error chunk，该失败响应绝不得写入 previous_response_id 缓存，避免历史污染。
3. P2: instructions 无论是否存在 previous_response_id 历史，都必须置于 messages 列表首位（第 0 项）。
"""
import json
import pytest
from responses_compat import (
    ResponsesStreamConverter,
    cache_response_messages,
    get_cached_response_messages,
    responses_request_to_chat,
)


def test_stream_converter_build_assistant_message_with_tools_and_reasoning():
    """验证 ResponsesStreamConverter.build_assistant_message 完整保留 content, tool_calls, reasoning_content。"""
    converter = ResponsesStreamConverter(model="deepseek-v4-flash")
    
    # 模拟流式 chunk：下发 reasoning、content 以及 tool_calls
    c1 = {
        "choices": [{
            "delta": {
                "role": "assistant",
                "reasoning_content": "let me think about tool call",
                "content": "calling tool now",
                "tool_calls": [{
                    "index": 0,
                    "id": "call_123",
                    "type": "function",
                    "function": {"name": "bash", "arguments": "echo hi"},
                }]
            }
        }]
    }
    converter.feed_chunk(c1)
    
    msg = converter.build_assistant_message()
    assert msg["role"] == "assistant"
    assert msg["content"] == "calling tool now"
    assert msg["reasoning_content"] == "let me think about tool call"
    assert len(msg["tool_calls"]) == 1
    assert msg["tool_calls"][0]["id"] == "call_123"
    assert msg["tool_calls"][0]["function"]["name"] == "bash"
    assert msg["tool_calls"][0]["function"]["arguments"] == "echo hi"


def test_failed_or_truncated_stream_never_cached():
    """验证遇到截断（零 finish_reason）时，converter 标记 _failed 为 True，且不应被缓存。"""
    converter = ResponsesStreamConverter(model="deepseek-v4-flash")
    # 下发部分内容但没有任何 finish_reason
    c = {"choices": [{"delta": {"content": "half message"}}]}
    converter.feed_chunk(c)
    
    # finish() 触发截断哨兵
    events = converter.finish()
    assert "response.failed" in events
    assert converter._failed is True, "截断后必须将 _failed 置为 True"


def test_instructions_always_placed_at_index_0_with_previous_response_id():
    """验证即使存在 previous_response_id 历史，当前请求的 instructions 依然稳固排在首位（index 0）。"""
    prev_id = "resp_test_history_order"
    cache_response_messages(prev_id, [
        {"role": "user", "content": "round 1 user"},
        {"role": "assistant", "content": "round 1 reply"},
    ])
    
    req = {
        "model": "deepseek-chat",
        "previous_response_id": prev_id,
        "instructions": "You are a specialized code assistant.",
        "input": "round 2 question",
    }
    chat = responses_request_to_chat(req)
    msgs = chat["messages"]
    
    # 结构断言：
    # index 0: system (instructions)
    # index 1: round 1 user
    # index 2: round 1 assistant
    # index 3: round 2 user
    assert len(msgs) == 4
    assert msgs[0] == {"role": "system", "content": "You are a specialized code assistant."}
    assert msgs[1] == {"role": "user", "content": "round 1 user"}
    assert msgs[2] == {"role": "assistant", "content": "round 1 reply"}
    assert msgs[3] == {"role": "user", "content": "round 2 question"}
