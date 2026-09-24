"""针对审查发现的三项流式与换号稳定性问题的失败测试（RED）。

1. test_stream_upstream_reset_line_buf_nonlocal:
   验证 _reset_attempt_state 重置时，外层 line_buf 确实被清空，上一轮残留的半截 SSE 分片不会污染下一轮重试。
2. test_stream_upstream_no_failover_after_client_visible_progress:
   验证一旦向客户端交付过内容（client-visible output），后续发生 HTTPError / 网络中断时，
   绝对禁止继续换号重试从头生成（防内容拼接污染），必须终止流并输出错误。
3. test_safe_stream_upstream_httperror_failover_account_switch_callback:
   验证 _safe_stream_upstream 在 HTTPError 换号重试时，必须调用 on_account_switched(new_uid)。
"""
import asyncio
import json
import pytest
import httpx
import converter

class MockRotator:
    def __init__(self, failover_pairs):
        self.failover_pairs = list(failover_pairs)
        self.call_count = 0

    def get_retry_budget(self, model_name):
        return len(self.failover_pairs)

    def record_failure_and_failover(self, uid, model_name, status_code, err_msg):
        self.call_count += 1
        if self.failover_pairs:
            return self.failover_pairs.pop(0)
        return None

def test_stream_upstream_reset_line_buf_nonlocal(monkeypatch):
    """当第一轮请求在收到半截 SSE 行（无换行符）后断开重试，第二轮首包不应与第一轮半截残留拼合。"""
    async def _test():
        # 模拟上游：第 0 轮返回半截残缺行并抛出 HTTPError；第 1 轮返回正常完整的 SSE 数据。
        call_idx = 0

        class MockAsyncStream:
            def __init__(self, idx):
                self.idx = idx
                self.status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def aiter_bytes(self):
                if self.idx == 0:
                    yield b"data: {\"corrupted_fragment\": true"
                    raise httpx.ReadTimeout("connection dropped mid-stream")
                else:
                    valid_obj = {
                        "id": "chatcmpl-test",
                        "object": "chat.completion.chunk",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": "Hello world from attempt 1"},
                            "finish_reason": "stop"
                        }]
                    }
                    yield f"data: {json.dumps(valid_obj)}\n\ndata: [DONE]\n\n".encode("utf-8")

        class MockClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            def stream(self, method, url, **kwargs):
                nonlocal call_idx
                stream_obj = MockAsyncStream(call_idx)
                call_idx += 1
                return stream_obj

        monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: MockClient())

        rotator = MockRotator([("uid-retry", {"authorization": "Bearer token2"})])

        chunks = []
        async for chunk in converter._stream_upstream(
            url="https://api.test/stream",
            headers={"authorization": "Bearer token1"},
            body={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
            model_name="gpt-4o",
            t0=0.0,
            rid="test-rid-1",
            rotator=rotator,
            uid="uid-initial"
        ):
            chunks.append(chunk)

        full_output = b"".join(chunks).decode("utf-8", "replace")
        # 断言：第 1 轮绝不能把 corrupted_fragment 拼在 valid_obj 前面
        assert "corrupted_fragment" not in full_output, "第一轮的残留残片污染了第二轮的 line_buf！"
        assert "Hello world from attempt 1" in full_output

    asyncio.run(_test())


def test_stream_upstream_no_failover_after_client_visible_progress(monkeypatch):
    """一旦客户端已经收到过实质性 token，遇到 HTTPError 绝对禁止跨账号重放重试，必须直接终止并输出错误。"""
    async def _test():
        call_idx = 0

        class MockAsyncStream:
            def __init__(self, idx):
                self.idx = idx
                self.status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def aiter_bytes(self):
                if self.idx == 0:
                    # 产生足以越过首包窗口的真实回答（超过 200 字符 或 带 finish_reason）
                    chunk1 = {
                        "id": "chatcmpl-test",
                        "object": "chat.completion.chunk",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": "A" * 250},
                            "finish_reason": None
                        }]
                    }
                    yield f"data: {json.dumps(chunk1)}\n\n".encode("utf-8")
                    # 此时客户端已经收到了 "A" * 250。随后发生网络中断
                    raise httpx.ReadTimeout("network disconnect after 250 chars")
                else:
                    chunk2 = {
                        "id": "chatcmpl-test",
                        "object": "chat.completion.chunk",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": "B" * 50},
                            "finish_reason": "stop"
                        }]
                    }
                    yield f"data: {json.dumps(chunk2)}\n\ndata: [DONE]\n\n".encode("utf-8")

        class MockClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            def stream(self, method, url, **kwargs):
                nonlocal call_idx
                stream_obj = MockAsyncStream(call_idx)
                call_idx += 1
                return stream_obj

        monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: MockClient())

        rotator = MockRotator([("uid-account-2", {"authorization": "Bearer token2"})])

        chunks = []
        async for chunk in converter._stream_upstream(
            url="https://api.test/stream",
            headers={"authorization": "Bearer token1"},
            body={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
            model_name="gpt-4o",
            t0=0.0,
            rid="test-rid-2",
            rotator=rotator,
            uid="uid-account-1"
        ):
            chunks.append(chunk)

        full_output = b"".join(chunks).decode("utf-8", "replace")
        # 验证：客户端应该收到了第一轮的 A*250，但绝不能接着收到第二轮从头开始生成的 B*50！
        assert "A" * 250 in full_output
        assert "B" * 50 not in full_output, "已下发内容给客户端后，竟然在同流中换号重发了新账号的内容！"
        assert rotator.call_count == 0, "客户端已见输出后，不应该调用 rotator.record_failure_and_failover 尝试重放"

    asyncio.run(_test())


def test_safe_stream_upstream_httperror_failover_account_switch_callback(monkeypatch):
    """验证 _safe_stream_upstream 在 HTTPError 换号重试时，必须触发 on_account_switched(new_uid)。"""
    async def _test():
        switched_uids = []
        call_idx = 0

        class MockAsyncStream:
            def __init__(self, idx):
                self.idx = idx
                self.status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def aiter_raw(self):
                if self.idx == 0:
                    raise httpx.ConnectError("connection refused")
                else:
                    valid_chunk = {
                        "id": "chatcmpl-test",
                        "object": "chat.completion.chunk",
                        "choices": [{
                            "index": 0,
                            "delta": {"tool_calls": [{"id": "call_1", "function": {"name": "test_fn"}}]},
                            "finish_reason": "tool_calls"
                        }]
                    }
                    yield f"data: {json.dumps(valid_chunk)}\n\n".encode("utf-8")

            async def aiter_lines(self):
                if self.idx == 0:
                    raise httpx.ConnectError("connection refused")
                else:
                    valid_chunk = {
                        "id": "chatcmpl-test",
                        "object": "chat.completion.chunk",
                        "choices": [{
                            "index": 0,
                            "delta": {"tool_calls": [{"id": "call_1", "function": {"name": "test_fn"}}]},
                            "finish_reason": "tool_calls"
                        }]
                    }
                    yield f"data: {json.dumps(valid_chunk)}"

        class MockClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            def stream(self, method, url, **kwargs):
                nonlocal call_idx
                stream_obj = MockAsyncStream(call_idx)
                call_idx += 1
                return stream_obj

        monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: MockClient())

        rotator = MockRotator([("uid-target-switched", {"authorization": "Bearer token2"})])

        def on_switch(new_uid):
            switched_uids.append(new_uid)

        chunks = []
        async for chunk in converter._safe_stream_upstream(
            url="https://api.test/stream",
            headers={"authorization": "Bearer token1"},
            body={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}], "tools": [{"type": "function"}]},
            model_name="gpt-4o",
            t0=0.0,
            rid="test-rid-3",
            rotator=rotator,
            uid="uid-origin",
            on_account_switched=on_switch
        ):
            chunks.append(chunk)

        assert "uid-target-switched" in switched_uids, "_safe_stream_upstream 在 HTTPError 换号时未触发 on_account_switched！"
        # 且在换号重试期间必须触发 on_switch(new_uid)
        assert len(switched_uids) >= 1
        assert switched_uids[-1] == "uid-target-switched"

    asyncio.run(_test())
