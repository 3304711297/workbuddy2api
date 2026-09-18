"""
tests/test_responses_api.py - OpenAI Responses API (/v1/responses) 兼容层测试

适配 Codex CLI 等原生采用 Responses wire format 的 Coding Agent。
"""

import json
import pytest
from starlette.testclient import TestClient

import converter
from responses_compat import (
    responses_request_to_chat,
    ResponsesStreamConverter,
    chat_response_to_responses,
)


def test_responses_request_to_chat_simple_str_input():
    """测试简单字符串 input 转换。"""
    body = {
        "model": "glm-5.2",
        "instructions": "Be helpful.",
        "input": "hello world",
        "temperature": 0.7,
        "max_output_tokens": 100,
    }
    chat = responses_request_to_chat(body)
    assert chat["model"] == "glm-5.2"
    assert chat["messages"][0] == {"role": "system", "content": "Be helpful."}
    assert chat["messages"][1] == {"role": "user", "content": "hello world"}
    assert chat["max_tokens"] == 100
    assert chat["temperature"] == 0.7


def test_responses_request_to_chat_complex_items():
    """测试 input 包含多轮 message、function_call 及 tool output 的复合转换。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "developer", "content": "Dev prompt"},
            {"role": "user", "content": [{"type": "input_text", "text": "Run ls"}]},
            {"type": "function_call", "call_id": "call_1", "name": "shell", "arguments": '{"cmd":"ls"}'},
            {"type": "function_call_output", "call_id": "call_1", "output": "file.txt"},
        ],
        "tools": [
            {"type": "function", "name": "shell", "description": "run shell", "parameters": {"type": "object"}}
        ]
    }
    chat = responses_request_to_chat(body)
    msgs = chat["messages"]
    # developer -> system
    assert msgs[0] == {"role": "system", "content": "Dev prompt"}
    # user text block
    assert msgs[1] == {"role": "user", "content": "Run ls"}
    # assistant tool_call
    assert msgs[2]["role"] == "assistant"
    assert msgs[2]["tool_calls"][0]["id"] == "call_1"
    assert msgs[2]["tool_calls"][0]["function"]["name"] == "shell"
    # tool output
    assert msgs[3] == {"role": "tool", "tool_call_id": "call_1", "content": "file.txt"}
    # tools 格式转换为 Chat 嵌套格式
    assert chat["tools"][0]["type"] == "function"
    assert chat["tools"][0]["function"]["name"] == "shell"


def test_responses_stream_converter():
    """测试将 ChatCompletions SSE 流转换为 Responses 语义事件流。"""
    stream_conv = ResponsesStreamConverter(model="deepseek-v4-pro")

    # 1. 第一个文本 chunk
    chunk1 = {
        "id": "chatcmpl-1",
        "model": "deepseek-v4-pro",
        "choices": [{"delta": {"role": "assistant", "content": "Hello"}}]
    }
    ev1 = stream_conv.feed_chunk(chunk1)
    assert "response.created" in ev1
    assert "response.in_progress" in ev1
    assert "response.output_item.added" in ev1
    assert "response.output_text.delta" in ev1

    # 2. 第二个文本 chunk
    chunk2 = {
        "id": "chatcmpl-1",
        "model": "deepseek-v4-pro",
        "choices": [{"delta": {"content": " world"}}]
    }
    ev2 = stream_conv.feed_chunk(chunk2)
    assert "response.output_text.delta" in ev2
    assert " world" in ev2

    # 3. 收尾 chunk
    chunk_end = {
        "id": "chatcmpl-1",
        "model": "deepseek-v4-pro",
        "choices": [{"delta": {}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    }
    ev_end = stream_conv.feed_chunk(chunk_end)
    finish_ev = stream_conv.finish()

    all_ev = ev1 + ev2 + ev_end + finish_ev
    assert "response.output_text.done" in all_ev
    assert "response.output_item.done" in all_ev
    assert "response.completed" in all_ev

    # 验证官方规范字段：sequence_number 单调递增，response_id 与 item_id 存在
    event_lines = [json.loads(line[6:]) for line in all_ev.split("\n\n") if line.startswith("data: ") and not line.endswith("[DONE]")]
    seqs = [e["sequence_number"] for e in event_lines]
    assert seqs == list(range(len(event_lines)))  # 从 0 开始严格单调连续自增

    text_deltas = [e for e in event_lines if e.get("type") == "response.output_text.delta"]
    assert len(text_deltas) >= 2
    assert "response_id" in text_deltas[0]
    assert "item_id" in text_deltas[0]
    assert text_deltas[0]["item_id"].startswith("msg_")


def test_responses_stream_converter_handles_error_chunk_without_completed():
    """上游错误 chunk 转换为 error/failed 事件，且禁止输出 response.completed。"""
    stream_conv = ResponsesStreamConverter(model="deepseek-v4-pro")
    err_chunk = {
        "error": {"message": "upstream connection error", "type": "upstream_error", "code": 502}
    }
    ev = stream_conv.feed_chunk(err_chunk)
    finish_ev = stream_conv.finish()
    all_ev = ev + finish_ev
    assert "response.failed" in all_ev or "error" in all_ev
    assert "response.completed" not in all_ev


def test_chat_response_to_responses_object():
    """测试非流式 Chat 响应对象转换为 Responses 规范对象。"""
    chat_resp = {
        "id": "chatcmpl-100",
        "model": "deepseek-v4-pro",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Done task",
                "tool_calls": [{
                    "id": "call_abc",
                    "type": "function",
                    "function": {"name": "test_fn", "arguments": "{}"}
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}
    }
    resp_obj = chat_response_to_responses(chat_resp, model="deepseek-v4-pro")
    assert resp_obj["object"] == "response"
    assert resp_obj["status"] == "completed"
    assert len(resp_obj["output"]) == 2
    assert resp_obj["output"][0]["type"] == "message"
    assert resp_obj["output"][0]["content"][0]["text"] == "Done task"
    assert resp_obj["output"][1]["type"] == "function_call"
    assert resp_obj["output"][1]["name"] == "test_fn"


def test_e2e_responses_endpoint_nonstream(monkeypatch):
    """测试通过 TestClient 端到端发起 /v1/responses 非流式请求。"""
    import httpx

    class FakeCred:
        def get_active_uid(self):
            return "uid-resp-1"
        def get_headers(self):
            return {"Authorization": "Bearer fake", "User-Agent": "test"}

    fake_cred = FakeCred()
    monkeypatch.setattr(converter, "_cred", lambda: fake_cred)
    monkeypatch.setattr(converter, "_get_rotator", lambda: converter.AccountRotator(cred_mgr=fake_cred, mode="off"))

    def mock_handler(request: httpx.Request):
        chat_sse = (
            'data: {"id":"chat-1","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"Response hello"}}]}\n\n'
            'data: {"id":"chat-1","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n'
            'data: [DONE]\n\n'
        ).encode("utf-8")
        return httpx.Response(200, content=chat_sse, headers={"Content-Type": "text/event-stream"})

    mock_transport = httpx.MockTransport(mock_handler)
    orig_async_client = httpx.AsyncClient

    def mock_async_client(**kw):
        kw["transport"] = mock_transport
        return orig_async_client(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    payload = {
        "model": "deepseek-v4-pro",
        "input": "hi",
        "stream": False,
    }
    res = client.post("/v1/responses", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["object"] == "response"
    assert data["status"] == "completed"
    assert data["output"][0]["content"][0]["text"] == "Response hello"


def test_responses_input_image_conversion():
    """验证 Responses 原生 input_image（item级 与 content级）被准确转换为 Chat image_url。"""
    req_body = {
        "model": "glm-5v-turbo",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image"},
                    {"type": "input_image", "image_url": "https://example.com/cat.jpg"},
                ],
            },
            {
                "type": "input_image",
                "image_url": {"url": "https://example.com/dog.png"},
            }
        ],
    }
    chat = responses_request_to_chat(req_body)
    msgs = chat["messages"]
    assert len(msgs) == 2

    # 第一条：包含 text 与 image_url 部件
    m1 = msgs[0]
    assert m1["role"] == "user"
    assert isinstance(m1["content"], list)
    assert m1["content"][0] == {"type": "text", "text": "Describe this image"}
    assert m1["content"][1] == {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}}

    # 第二条：单独的 input_image 转换为包含 image_url 的 user 消息
    m2 = msgs[1]
    assert m2["role"] == "user"
    assert m2["content"] == [{"type": "image_url", "image_url": {"url": "https://example.com/dog.png"}}]


# ---------------------------------------------------------------------------
# Responses 多轮历史中的 reasoning item（Codex CLI 等客户端会把上一轮的思维链
# 一并回传）。缺这条分支时它既无 role 也不匹配任何既有分支 → 静默落进「其他类型
# 保底」被整个丢弃，客户端表现为「多轮后思维链消失」，且无任何日志痕迹。
# ---------------------------------------------------------------------------


def test_reasoning_item_attaches_to_following_assistant_message():
    """reasoning 在 assistant 消息之前（Responses 规范输出顺序）→ 挂到该消息上。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "solve math"},
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [{"type": "summary_text", "text": "let me think about 2+2"}],
            },
            {"type": "message", "role": "assistant", "content": "4"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 1, f"不得凭空多出/丢失 assistant 消息：{msgs}"
    assert assistants[0]["reasoning_content"] == "let me think about 2+2"
    assert assistants[0]["content"] == "4"
    # reasoning 不是独立消息，不得泄漏成一条角色不明的记录
    assert all(m.get("role") in ("system", "user", "assistant", "tool") for m in msgs)
    assert len(msgs) == 2


def test_reasoning_item_after_pending_assistant_stays_on_same_turn():
    """assistant 消息仍处未定稿（pending）时到来的 reasoning → 归属同一轮，不漂到下一轮。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "solve math"},
            {"type": "message", "role": "assistant", "content": "4"},
            {"type": "reasoning", "id": "rs_1", "summary": "先算加法"},
            {"role": "user", "content": "再加 1"},
            {"type": "message", "role": "assistant", "content": "5"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 2
    assert assistants[0]["content"] == "4"
    assert assistants[0]["reasoning_content"] == "先算加法", "同轮 reasoning 漂到了下一轮"
    assert "reasoning_content" not in assistants[1]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]


def test_orphan_reasoning_does_not_drift_onto_later_assistant():
    """reasoning 后紧跟 user 消息（无归属轮次）→ 作废，绝不漂到后面无关的 assistant 上。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "q1"},
            {"type": "reasoning", "id": "rs_orphan", "summary": "无归属的思维链"},
            {"role": "user", "content": "q2"},
            {"type": "message", "role": "assistant", "content": "a2"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 1
    assert "reasoning_content" not in assistants[0], "孤儿 reasoning 漂到了下游 assistant 上"
    assert [m["role"] for m in msgs] == ["user", "user", "assistant"]


def test_multiple_reasoning_items_in_one_turn_concatenate_in_order():
    """同一轮出现多条 reasoning → 按出现顺序拼接，不覆盖、不丢失。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "q"},
            {"type": "reasoning", "id": "rs_1", "summary": "第一步"},
            {"type": "reasoning", "id": "rs_2", "summary": "第二步"},
            {"type": "message", "role": "assistant", "content": "a"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["reasoning_content"] == "第一步\n第二步"


def test_reasoning_item_summary_list_and_content_fallback():
    """summary 为数组时逐段拼接；summary 缺失时回退读取 content（字符串/list 两种形态）。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "q1"},
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [
                    {"type": "summary_text", "text": "第一段"},
                    {"type": "summary_text", "text": "第二段"},
                ],
            },
            {"type": "message", "role": "assistant", "content": "a1"},
            {"role": "user", "content": "q2"},
            {
                "type": "reasoning",
                "id": "rs_2",
                "content": [{"type": "reasoning_text", "text": "content 回退路径"}],
            },
            {"type": "message", "role": "assistant", "content": "a2"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 2
    assert assistants[0]["reasoning_content"] == "第一段\n第二段"
    assert assistants[1]["reasoning_content"] == "content 回退路径"


def test_reasoning_item_without_text_does_not_pollute_messages():
    """空 reasoning（无 summary 也无 content）不得注入空 reasoning_content，也不得留痕。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "hi"},
            {"type": "reasoning", "id": "rs_empty", "summary": []},
            {"type": "message", "role": "assistant", "content": "hello"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 1
    assert "reasoning_content" not in assistants[0]
    assert len(msgs) == 2


def test_reasoning_item_attaches_to_assistant_tool_call_turn():
    """reasoning 后跟 function_call 轮次 → 挂到该 assistant 的 tool_calls 消息上。"""
    body = {
        "model": "deepseek-v4-pro",
        "input": [
            {"role": "user", "content": "list files"},
            {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "需要用 shell"}]},
            {"type": "function_call", "call_id": "call_1", "name": "shell", "arguments": '{"cmd":"ls"}'},
            {"type": "function_call_output", "call_id": "call_1", "output": "file.txt"},
        ],
    }
    msgs = responses_request_to_chat(body)["messages"]

    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["reasoning_content"] == "需要用 shell"
    assert assistants[0]["tool_calls"][0]["id"] == "call_1"
    assert msgs[-1]["role"] == "tool"
