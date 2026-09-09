"""回归测试：/api/rate_limit 上游频率限制（腾讯 code 6004）自曝端点。

覆盖路径：
  ① 非流式请求上游 429+6004 → HTTPException 分支记录；
  ② 流式请求上游 429+6004 → SSE error chunk 分支记录（流式 HTTP 恒 200）；
  ③ 同模型同 reset 幂等（重复报文只保留 1 条）；
  ④ /api/rate_limit 返回 state/resetLocal/remainingSec/nickname。

全程 monkeypatch httpx.AsyncClient 与 CONFIG["cred"]，不触碰真实凭据与上游。
"""

import sys
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402

SAMPLE_6004 = (
    '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2099-01-01 12:00:00 UTC+8 重置，'
    '您也可以切换其他模型继续使用。","requestId":"test"}'
)


class _FakeResp:
    status_code = 429

    async def aread(self):
        return SAMPLE_6004.encode()

    async def aiter_bytes(self):
        return
        yield  # pragma: no cover — make it an async generator

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeAsyncClient:
    def __init__(self, **kw):
        pass

    def stream(self, *a, **k):
        return _FakeResp()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeCred:
    """最小凭据桩：chat_completions 需要 get_headers，/api/rate_limit 需要 get_active_session。"""

    def get_active_session(self):
        return {
            "auth": {"accessToken": "fake-token"},
            "account": {"uid": "u-test", "nickname": "测试账号"},
        }

    def get_headers(self):
        return {"Authorization": "Bearer fake-token", "X-User-Id": "u-test", "User-Agent": "test"}


@pytest.fixture()
def rl_client(monkeypatch):
    converter.CONFIG["cred"] = _FakeCred()
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    # 清空模块级状态，保证用例隔离
    converter._RATE_LIMIT_STATE.clear()
    yield TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    converter._RATE_LIMIT_STATE.clear()


def test_rate_limit_initial_empty(rl_client):
    res = rl_client.get("/api/rate_limit")
    assert res.status_code == 200
    assert res.json()["models"] == {}


def test_rate_limit_non_stream_records_6004(rl_client):
    res = rl_client.post(
        "/v1/chat/completions",
        json={"model": "hy4-preview", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert res.status_code == 429

    data = rl_client.get("/api/rate_limit").json()
    ent = data["models"]["hy4-preview"]
    assert ent["state"] == "limited"
    assert ent["resetLocal"] == "12:00:00"
    assert ent["remainingSec"] > 0
    assert data["nickname"] == "测试账号"


def test_rate_limit_stream_sse_error_records_6004(rl_client):
    """流式路径：HTTP 恒 200，6004 以 SSE error chunk 内嵌返回，同样必须被记录。"""
    res = rl_client.post(
        "/v1/chat/completions",
        json={"model": "glm-5.3", "messages": [{"role": "user", "content": "hi"}], "stream": True},
    )
    assert res.status_code == 200
    assert "6004" in res.text

    data = rl_client.get("/api/rate_limit").json()
    assert data["models"]["glm-5.3"]["state"] == "limited"


def test_rate_limit_idempotent_same_reset(rl_client):
    body = {"model": "hy4-preview", "messages": [{"role": "user", "content": "hi"}]}
    rl_client.post("/v1/chat/completions", json=body)
    rl_client.post("/v1/chat/completions", json=body)

    data = rl_client.get("/api/rate_limit").json()
    assert len(data["models"]) == 1  # 同模型同 reset 只 1 条


def test_rate_limit_reset_expiry_flips_state(rl_client):
    """reset 时刻已过 → state 翻转为 expired（冷却结束的历史痕迹）。

    与「从未被限过」（无条目）区分开；resetLocal 必须保留，
    前端用它展示「冷却已于 X 结束」，清空会导致文案残缺。
    """
    rl_client.post(
        "/v1/chat/completions",
        json={"model": "hy4-preview", "messages": [{"role": "user", "content": "hi"}]},
    )
    # 直接把内存里的 resetAtMs 改到过去，模拟冷却结束
    converter._RATE_LIMIT_STATE["hy4-preview"]["resetAtMs"] = 0
    data = rl_client.get("/api/rate_limit").json()
    ent = data["models"]["hy4-preview"]
    assert ent["state"] == "expired"
    assert ent["remainingSec"] == 0
    assert ent["resetLocal"] == "12:00:00"  # 历史痕迹保留，前端文案依赖
    assert ent["message"]
