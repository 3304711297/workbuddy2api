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
