import asyncio
import json
from pathlib import Path
import pytest
import httpx

import converter


# Helper to parse SSE stream into chunk objects
async def _consume_sse_stream(async_gen):
    chunks = []
    async for raw_bytes in async_gen:
        text = raw_bytes.decode("utf-8")
        for line in text.strip().split("\n"):
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                chunks.append("[DONE]")
            else:
                chunks.append(json.loads(data))
    return chunks


# ===========================================================================
# 1. _pseudo_stream_response 流式协议测试 (P0-1)
# ===========================================================================

def test_pseudo_stream_content_only():
    collected = {
        "id": "chatcmpl-test-1",
        "model": "glm-5.3-flash",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello world from pure content",
            },
            "finish_reason": "stop",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="glm-5.3-flash"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]
        contents = [d["content"] for d in deltas if "content" in d and d["content"]]
        assert "".join(contents) == "Hello world from pure content"
        # 确保无 tool_calls 与 reasoning_content
        assert not any("tool_calls" in d for d in deltas)
        assert not any("reasoning_content" in d for d in deltas)
        assert chunks[-2]["choices"][0]["finish_reason"] == "stop"

    asyncio.run(_run())


def test_pseudo_stream_tool_calls_only():
    collected = {
        "id": "chatcmpl-test-2",
        "model": "glm-5.3-flash",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}
                }]
            },
            "finish_reason": "tool_calls",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="glm-5.3-flash"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]
        # 必须存在 tool_calls 且无 content 乱发
        tcs_deltas = [d["tool_calls"] for d in deltas if "tool_calls" in d]
        assert len(tcs_deltas) > 0
        assert not any("content" in d and d["content"] for d in deltas)
        assert chunks[-2]["choices"][0]["finish_reason"] == "tool_calls"

    asyncio.run(_run())


def test_pseudo_stream_content_and_tool_calls():
    # 修复目标：文本 + tool_calls 不再互斥，两者均必须出现在下发的 chunk 序列中
    collected = {
        "id": "chatcmpl-test-3",
        "model": "glm-5.3-flash",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "我先为您读取配置文件。",
                "tool_calls": [{
                    "id": "call_conf",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path":"config.yaml"}'}
                }]
            },
            "finish_reason": "tool_calls",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="glm-5.3-flash"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]
        
        # 验证 content 存在且完整
        contents = [d["content"] for d in deltas if "content" in d and d["content"]]
        assert "".join(contents) == "我先为您读取配置文件。"

        # 验证 tool_calls 存在且完整
        tcs = [d["tool_calls"] for d in deltas if "tool_calls" in d]
        assert len(tcs) > 0
        args_parts = []
        for tc_list in tcs:
            for tc in tc_list:
                fn = tc.get("function") or {}
                if "arguments" in fn and fn["arguments"]:
                    args_parts.append(fn["arguments"])
        assert "".join(args_parts) == '{"path":"config.yaml"}'

    asyncio.run(_run())


def test_pseudo_stream_reasoning_and_content():
    # 修复目标：reasoning_content 独立于 content，不混入 content，且两者均下发
    collected = {
        "id": "chatcmpl-test-4",
        "model": "deepseek-v4-pro",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "reasoning_content": "思考：用户需要排序算法。",
                "content": "这是快速排序代码。",
            },
            "finish_reason": "stop",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="deepseek-v4-pro"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]

        reasonings = [d["reasoning_content"] for d in deltas if "reasoning_content" in d and d["reasoning_content"]]
        contents = [d["content"] for d in deltas if "content" in d and d["content"]]

        # 严禁将 reasoning_content 拼入 content
        assert "".join(reasonings) == "思考：用户需要排序算法。"
        assert "".join(contents) == "这是快速排序代码。"
        assert "思考" not in "".join(contents)

    asyncio.run(_run())


def test_pseudo_stream_reasoning_content_and_tool_calls():
    # 修复目标：三者并存时，三者全部正确下发且字段完全隔离
    collected = {
        "id": "chatcmpl-test-5",
        "model": "deepseek-v4-pro",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "reasoning_content": "先看目录下有什么文件。",
                "content": "正在为您检索目录...",
                "tool_calls": [{
                    "id": "call_ls",
                    "type": "function",
                    "function": {"name": "list_files", "arguments": "{}"}
                }]
            },
            "finish_reason": "tool_calls",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="deepseek-v4-pro"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]

        reasonings = [d["reasoning_content"] for d in deltas if "reasoning_content" in d and d["reasoning_content"]]
        contents = [d["content"] for d in deltas if "content" in d and d["content"]]
        tcs = [d["tool_calls"] for d in deltas if "tool_calls" in d]

        assert "".join(reasonings) == "先看目录下有什么文件。"
        assert "".join(contents) == "正在为您检索目录..."
        assert len(tcs) > 0

    asyncio.run(_run())


def test_pseudo_stream_multi_tool_calls():
    # 修复目标：多 tool_calls 下发无遗漏，index 正确
    collected = {
        "id": "chatcmpl-test-6",
        "model": "glm-5.3-flash",
        "created": 1700000000,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "tool_a", "arguments": '{"x":1}'}
                    },
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "tool_b", "arguments": '{"y":2}'}
                    }
                ]
            },
            "finish_reason": "tool_calls",
        }],
    }
    async def _run():
        chunks = await _consume_sse_stream(converter._pseudo_stream_response(collected, model_name="glm-5.3-flash"))
        assert chunks[-1] == "[DONE]"
        deltas = [c["choices"][0]["delta"] for c in chunks[:-1] if "choices" in c]
        indices = set()
        names = []
        for d in deltas:
            for tc in d.get("tool_calls", []):
                indices.add(tc["index"])
                fn = tc.get("function", {})
                if fn.get("name"):
                    names.append(fn["name"])
        assert indices == {0, 1}
        assert names == ["tool_a", "tool_b"]

    asyncio.run(_run())


# ===========================================================================
# 2. _collect_stream 收集独立性测试 (P0-1)
# ===========================================================================

def test_collect_stream_collects_reasoning_independently():
    # 模拟上游 SSE 流：包含 reasoning_content、content、tool_calls
    sse_lines = [
        'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"思考1"}}]}\n',
        'data: {"choices":[{"delta":{"reasoning_content":"思考2"}}]}\n',
        'data: {"choices":[{"delta":{"content":"正文1"}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f1","arguments":"{\\\"a\\\""}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
        'data: [DONE]\n',
    ]

    async def _aiter():
        for line in sse_lines:
            yield line

    # 构造假 Response
    class DummyResponse:
        def aiter_lines(self):
            return _aiter()

    async def _run():
        result, _ = await converter._collect_stream(DummyResponse(), t0=1.0)
        msg = result["choices"][0]["message"]
        # 验证 reasoning_content 与 content 独立聚合
        assert msg.get("reasoning_content") == "思考1思考2"
        assert msg.get("content") == "正文1"
        assert len(msg.get("tool_calls", [])) == 1
        assert msg["tool_calls"][0]["function"]["name"] == "f1"
        assert msg["tool_calls"][0]["function"]["arguments"] == '{"a":1}'

    asyncio.run(_run())


def test_collect_stream_no_reasoning_backward_compatibility():
    # 无 reasoning 的普通流，聚合结果中不应包含 reasoning_content 键，保持旧行为
    sse_lines = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"hello"}}]}\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
    ]

    class DummyResponse:
        def aiter_lines(self):
            async def _aiter():
                for line in sse_lines:
                    yield line
            return _aiter()

    async def _run():
        result, _ = await converter._collect_stream(DummyResponse(), t0=1.0)
        msg = result["choices"][0]["message"]
        assert msg.get("content") == "hello"
        assert "reasoning_content" not in msg

    asyncio.run(_run())


# ===========================================================================
# 3. accounts.json 启动加载闭环测试 (P0-2)
# ===========================================================================

def test_startup_with_only_accounts_json_no_info_file(tmp_path, monkeypatch):
    # 模拟环境：仅存在 accounts.json，任何 auth_dirs() 下无 *.info 文件
    acc_dir = tmp_path / "appdata" / "codebuddy2openai"
    acc_dir.mkdir(parents=True)
    acc_file = acc_dir / "accounts.json"
    
    account_data = {
        "active_uid": "test_uid_999",
        "accounts": {
            "test_uid_999": {
                "auth": {
                    "accessToken": "test_access_token_abc",
                    "refreshToken": "test_refresh_token_xyz",
                    "expiresAt": 1900000000000,
                },
                "account": {
                    "uid": "test_uid_999",
                    "nickname": "测试活跃用户",
                    "enterpriseName": "测试企业",
                }
            }
        }
    }
    acc_file.write_text(json.dumps(account_data, ensure_ascii=False), encoding="utf-8")

    empty_auth_dir = tmp_path / "empty_auth"
    empty_auth_dir.mkdir(parents=True)

    monkeypatch.setattr(converter, "auth_dirs", lambda: [empty_auth_dir])
    monkeypatch.setattr(converter, "_accounts_file", lambda: acc_file)

    # 验证 find_auth_file 为 None
    assert converter.find_auth_file() is None

    # 初始化 CredentialManager，即使传入 None，也应成功读取 accounts.json
    cm = converter.CredentialManager(None)
    summary = cm.summary()
    assert summary["uid"] == "test_uid_999"
    assert summary["nickname"] == "测试活跃用户"
    assert summary["enterpriseName"] == "测试企业"
    assert summary["token_expired"] is False

    headers = cm.get_headers()
    assert headers["Authorization"] == "Bearer test_access_token_abc"
    assert headers["X-User-Id"] == "test_uid_999"


def test_preflight_with_only_accounts_json(tmp_path, monkeypatch):
    # 修复目标：只有 accounts.json 时，preflight() 正常通过且 CONFIG['cred'] 不为 None
    acc_dir = tmp_path / "appdata" / "codebuddy2openai"
    acc_dir.mkdir(parents=True)
    acc_file = acc_dir / "accounts.json"
    
    account_data = {
        "active_uid": "test_uid_888",
        "accounts": {
            "test_uid_888": {
                "auth": {
                    "accessToken": "token_888",
                    "expiresAt": 1900000000000,
                },
                "account": {
                    "uid": "test_uid_888",
                    "nickname": "仅accounts用户",
                    "enterpriseName": "独立企业",
                }
            }
        }
    }
    acc_file.write_text(json.dumps(account_data, ensure_ascii=False), encoding="utf-8")

    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    monkeypatch.setattr(converter, "auth_dirs", lambda: [empty_dir])
    monkeypatch.setattr(converter, "_accounts_file", lambda: acc_file)

    # 重设 CONFIG['cred']，模拟 init_cred()
    converter.init_cred()
    assert converter.CONFIG.get("cred") is not None
    assert converter.preflight() is True
    assert converter.CONFIG["cred"].summary()["uid"] == "test_uid_888"

