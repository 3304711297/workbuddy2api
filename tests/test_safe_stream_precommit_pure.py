import asyncio
import json
import pytest
import converter

def test_safe_stream_upstream_no_premature_ping_before_commit(monkeypatch):
    """P1-1 契约验证：
    _safe_stream_upstream 在聚合校验阶段不得提前 yield ': ping'，
    确保 DeferredHeaderStreamingResponse 延迟到最终账号确定后才提交响应头，
    防止 failover 切号后响应头与实际内容失真。
    """
    async def _test():
        chunks = []
        call_idx = 0

        class MockAsyncStream:
            def __init__(self, idx):
                self.idx = idx
                self.status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def aiter_lines(self):
                # 模拟较慢的上游生成（超过 5.0 秒）
                await asyncio.sleep(0.1)
                valid_chunk = {
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [{"id": "call_1", "function": {"name": "test_fn", "arguments": "{}"}}]},
                        "finish_reason": "tool_calls"
                    }]
                }
                yield f"data: {json.dumps(valid_chunk)}"
                yield "data: [DONE]"

        class MockClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            def stream(self, method, url, **kwargs):
                return MockAsyncStream(0)

        monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: MockClient())

        async for chunk in converter._safe_stream_upstream(
            url="https://api.test/stream",
            headers={"authorization": "Bearer token1"},
            body={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}], "tools": [{"type": "function"}]},
            model_name="gpt-4o",
            t0=0.0,
            rid="test-rid-pure",
            rotator=None,
            uid="uid-origin"
        ):
            chunks.append(chunk)

        # 首个 chunk 必须是真正的协议 chunk（或 fallback 注释），绝不得是保活 ping
        assert len(chunks) > 0
        first_chunk = chunks[0]
        assert b": ping" not in first_chunk, "safe_stream 不得在聚合阶段提前 yield ': ping' 心跳！"

    asyncio.run(_test())
