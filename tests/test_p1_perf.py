"""P1 性能回归：共享连接池 + turing 失败负缓存。

① 热路径 5 处逐请求建 httpx.AsyncClient → 共享池复用；
② turing helper 失败时每个请求都 fork Node → 负缓存退避。
全程 mock，不触碰真实凭据与上游。
"""

import asyncio
import sys
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


@pytest.fixture()
def clean_turing(monkeypatch):
    monkeypatch.setattr(converter, "_TURING_TOKEN_CACHE", None)
    monkeypatch.setattr(converter, "_TURING_TOKEN_AT", 0.0)
    monkeypatch.setattr(converter, "_TURING_FAIL_AT", 0.0)
    yield


def test_turing_failure_served_from_negative_cache(monkeypatch, clean_turing):
    """helper 持续失败 → 只有第一次真正 fork，后续走负缓存。"""
    import subprocess as sp

    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return sp.CompletedProcess(a[0], 1, stdout=b"", stderr=b"boom")

    monkeypatch.setattr(sp, "run", fake_run)
    assert converter._get_turing_device_token() is None
    assert converter._get_turing_device_token() is None
    assert calls["n"] == 1, "第二次失败必须走负缓存，不再 fork 子进程"


def test_shared_client_reused_for_same_timeout():
    c1 = converter._shared_client(300)
    c2 = converter._shared_client(300)
    assert c1 is c2, "同 timeout 必须复用同一连接池实例"


def test_shared_client_isolated_by_timeout():
    assert converter._shared_client(300) is not converter._shared_client(None)


class _CountingClient:
    instances = 0

    def __init__(self, **kw):
        type(self).instances += 1

    def stream(self, *a, **k):
        return _Err429()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _Err429:
    status_code = 429

    async def aread(self):
        return '{"code":6004,"msg":"rate limited"}'.encode()

    async def aiter_bytes(self):
        return
        yield  # pragma: no cover

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeCred:
    def get_active_session(self):
        return {"auth": {"accessToken": "t"}, "account": {"uid": "u1"}}

    def get_headers(self):
        return {"Authorization": "Bearer t"}


def test_chat_path_builds_only_one_client(monkeypatch):
    """连续两次聊天请求只建一个 AsyncClient（连接池复用）。"""
    converter.CONFIG["cred"] = _FakeCred()
    converter._RATE_LIMIT_STATE.clear()
    _CountingClient.instances = 0
    monkeypatch.setattr(httpx, "AsyncClient", _CountingClient)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    body = {"model": "hy4-preview", "messages": [{"role": "user", "content": "hi"}]}
    assert client.post("/v1/chat/completions", json=body).status_code == 429
    assert client.post("/v1/chat/completions", json=body).status_code == 429
    assert _CountingClient.instances == 1, "两次请求必须复用同一连接池"
    converter._RATE_LIMIT_STATE.clear()
