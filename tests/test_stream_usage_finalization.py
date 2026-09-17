"""
tests/test_stream_usage_finalization.py - 流式 usage 幂等收尾与退出原因分类契约测试
"""

import asyncio
import pytest
import httpx
import converter


def test_stream_usage_cancelled_records_client_disconnected(monkeypatch):
    """测试客户端取消退出时，usage 记录且原因标记为 client disconnected。"""
    recorded_calls = []

    def mock_record_usage(*args, **kwargs):
        recorded_calls.append((args, kwargs))

    monkeypatch.setattr(converter, "_record_usage", mock_record_usage)

    class CancelStreamResponse:
        status_code = 200
        headers = {}

        async def aiter_bytes(self):
            raise asyncio.CancelledError()
            yield b""

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class DummyClient:
        def stream(self, *args, **kwargs):
            return CancelStreamResponse()

    class DummyCtx:
        async def __aenter__(self):
            return DummyClient()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: DummyCtx())

    async def _run():
        gen = converter._stream_upstream(
            url="https://api.test/stream",
            headers={},
            body={"model": "deepseek-chat"},
            model_name="deepseek-chat",
        )
        with pytest.raises(asyncio.CancelledError):
            async for _ in gen:
                pass

    asyncio.run(_run())

    assert len(recorded_calls) == 1, "取消路径必须恰好记录一次 usage"
    _, kwargs = recorded_calls[0]
    assert kwargs.get("ok") is False
    assert kwargs.get("error") == "client disconnected"


def test_stream_usage_internal_error_does_not_mask_as_client_disconnected(monkeypatch):
    """测试内部未预期异常（非取消）退出时，不能误标为 client disconnected，必须如实上报 stream error。"""
    recorded_calls = []

    def mock_record_usage(*args, **kwargs):
        recorded_calls.append((args, kwargs))

    monkeypatch.setattr(converter, "_record_usage", mock_record_usage)

    # 模拟内部流式处理抛出 ValueError
    class DummyStreamResponse:
        status_code = 200
        headers = {}

        async def aiter_bytes(self):
            yield b"data: test\n\n"
            raise ValueError("parser json corrupted")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class DummyClient:
        def stream(self, *args, **kwargs):
            return DummyStreamResponse()

    class DummyCtx:
        async def __aenter__(self):
            return DummyClient()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: DummyCtx())

    async def _run():
        gen = converter._stream_upstream(
            url="https://api.test/stream",
            headers={},
            body={"model": "deepseek-chat"},
            model_name="deepseek-chat",
        )
        with pytest.raises(ValueError, match="parser json corrupted"):
            async for _ in gen:
                pass

    asyncio.run(_run())

    assert len(recorded_calls) == 1, "内部异常退出必须恰好记录一次 usage"
    _, kwargs = recorded_calls[0]
    assert kwargs.get("ok") is False
    assert kwargs.get("error") != "client disconnected", "内部异常绝不可被伪装成客户端断开"
    assert "stream error: parser json corrupted" in kwargs.get("error")


def test_stream_usage_normal_completion_records_success(monkeypatch):
    """测试正常 SSE 完成时，记录一条 ok=True 且 error=None 的记录，且 finally 不重复记账。"""
    recorded_calls = []

    def mock_record_usage(*args, **kwargs):
        recorded_calls.append((args, kwargs))

    monkeypatch.setattr(converter, "_record_usage", mock_record_usage)

    class NormalStreamResponse:
        status_code = 200
        headers = {}

        async def aiter_bytes(self):
            yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class DummyClient:
        def stream(self, *args, **kwargs):
            return NormalStreamResponse()

    class DummyCtx:
        async def __aenter__(self):
            return DummyClient()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: DummyCtx())

    async def _run():
        gen = converter._stream_upstream(
            url="https://api.test/stream",
            headers={},
            body={"model": "deepseek-chat"},
            model_name="deepseek-chat",
        )
        async for _ in gen:
            pass

    asyncio.run(_run())

    assert len(recorded_calls) == 1, "正常路径必须恰好记录一次 usage"
    _, kwargs = recorded_calls[0]
    assert kwargs.get("ok") is True
    assert kwargs.get("error") is None


def test_stream_usage_upstream_500_records_once(monkeypatch):
    """测试上游 500 报错时，记录一条 ok=False, error='HTTP 500' 的记录，且 finally 不重复记账。"""
    recorded_calls = []

    def mock_record_usage(*args, **kwargs):
        recorded_calls.append((args, kwargs))

    monkeypatch.setattr(converter, "_record_usage", mock_record_usage)

    class ErrStreamResponse:
        status_code = 500
        headers = {}

        async def aread(self):
            return b'{"error":"internal upstream failure"}'

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class DummyClient:
        def stream(self, *args, **kwargs):
            return ErrStreamResponse()

    class DummyCtx:
        async def __aenter__(self):
            return DummyClient()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: DummyCtx())

    async def _run():
        gen = converter._stream_upstream(
            url="https://api.test/stream",
            headers={},
            body={"model": "deepseek-chat"},
            model_name="deepseek-chat",
        )
        async for _ in gen:
            pass

    asyncio.run(_run())

    assert len(recorded_calls) == 1, "500 路径必须恰好记录一次 usage"
    args, kwargs = recorded_calls[0]
    ok_val = kwargs.get("ok", args[1] if len(args) > 1 else None)
    assert ok_val is False
    assert kwargs.get("error") == "HTTP 500"
