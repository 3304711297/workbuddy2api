"""P1 bounds: rate-limit state capped, streaming buffers bounded."""

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


def test_rate_limit_state_capped(monkeypatch):
    converter._RATE_LIMIT_STATE.clear()
    monkeypatch.setattr(converter, "CONFIG", {**converter.CONFIG, "cred": None})
    for i in range(100):
        converter._record_rate_limit("evil-model-%d" % i, "429 Too Many Requests", status_code=429)
    assert len(converter._RATE_LIMIT_STATE) <= converter._RATE_LIMIT_CAP
    assert "evil-model-99" in converter._RATE_LIMIT_STATE
    assert "evil-model-0" not in converter._RATE_LIMIT_STATE
    converter._RATE_LIMIT_STATE.clear()


class _OKResp:
    status_code = 200

    async def aiter_bytes(self):
        yield b'data: {"content":"hello"}' + b"\n\n"
        yield b'data: [DONE]' + b"\n\n"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _OKClient:
    def __init__(self, **kw):
        pass

    def stream(self, *a, **k):
        return _OKResp()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_stream_no_buffer_without_payload_log(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _OKClient)
    monkeypatch.setitem(converter.CONFIG, "log_payloads", False)
    monkeypatch.setitem(converter.CONFIG, "usage_log", None)
    captured = {}
    monkeypatch.setattr(converter, "_log_payload", lambda msg: captured.setdefault("msg", msg))

    async def _run():
        return [e async for e in converter._stream_upstream(
            "http://x", {}, {"model": "hy4-preview"}, model_name="hy4-preview")]

    events = asyncio.run(_run())
    assert any(b"hello" in e for e in events)
    assert "hello" not in captured.get("msg", "")
