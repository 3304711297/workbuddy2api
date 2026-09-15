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


def test_rate_limit_night_free_and_today_usage(rl_client, tmp_path, monkeypatch):
    import time
    log_file = tmp_path / "usage.jsonl"
    now_ms = int(time.time() * 1000)
    lines = [
        '{"ts": ' + str(now_ms - 1000) + ', "model": "hy4-preview", "ok": true, "input_tokens": 100, "output_tokens": 200}',
        '{"ts": ' + str(now_ms - 500) + ', "model": "hy4-preview", "error": "HTTP 429"}',
    ]
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(log_file))

    # 触发记录以便在 snapshot 中出现该模型
    rl_client.post("/v1/chat/completions", json={"model": "hy4-preview", "messages": [{"role": "user", "content": "hi"}]})

    data = rl_client.get("/api/rate_limit").json()
    assert "nightFree" in data
    assert isinstance(data["nightFree"], bool)
    assert data["nightWindow"]["start"] == "23:00"
    assert data["nightWindow"]["end"] == "08:00"

    ru = data["rollingUsage"].get("hy4-preview")
    assert ru is not None
    assert ru["reqsToday"] == 1
    assert ru["tokensToday"] == 300
    assert ru["err429_today"] >= 1
    assert "nightFree" in ru


def test_rate_limit_multi_account_attribution_and_cooldown(rl_client, monkeypatch):
    """验证多账号场景下的限流归因：
    当账号 A (晚街) 触发 6004 限流避让，切换为账号 B (活跃号) 时：
    /api/rate_limit 必须精确指出 limitedUid 为账号 A，
    且当前活跃账号 B 的 isActiveAccountLimited 为 False。
    """
    class _FakeMultiCred:
        def __init__(self):
            self.active_uid = "u-active"
            self.accounts = {
                "u-wanjie": {"account": {"uid": "u-wanjie", "nickname": "晚街"}},
                "u-active": {"account": {"uid": "u-active", "nickname": "17325834246"}},
            }

        def get_active_uid(self):
            return self.active_uid

        def get_active_session(self):
            return self.accounts[self.active_uid]

        def list_all_accounts(self):
            return list(self.accounts.items())

        def get_headers(self):
            return {"Authorization": "Bearer fake", "X-User-Id": self.active_uid}

    fake_cred = _FakeMultiCred()
    monkeypatch.setitem(converter.CONFIG, "cred", fake_cred)
    converter._ACCOUNT_COOLDOWNS.clear()
    converter._RATE_LIMIT_STATE.clear()

    # 模拟账号 u-wanjie 在 deepseek-v4.1-flash 上触发 6004
    converter._record_rate_limit(
        "deepseek-v4.1-flash",
        SAMPLE_6004,
        uid="u-wanjie",
        status_code=429,
    )

    res = rl_client.get("/api/rate_limit")
    assert res.status_code == 200
    data = res.json()
    model_entry = data["models"]["deepseek-v4.1-flash"]

    # 必须保留向后兼容字段
    assert model_entry["state"] == "limited"
    assert model_entry["remainingSec"] > 0

    # 必须具备账号级归因
    assert model_entry["limitedUid"] == "u-wanjie"
    assert model_entry["limitedNickname"] == "晚街"
    # 当前活跃账号是 u-active，并没有被限流
    assert model_entry["isActiveAccountLimited"] is False
    assert data["rotation"]["active_uid"] == "u-active"

    # 当活跃账号切回 u-wanjie 时，isActiveAccountLimited 必须变为 True
    fake_cred.active_uid = "u-wanjie"
    res2 = rl_client.get("/api/rate_limit")
    data2 = res2.json()
    assert data2["models"]["deepseek-v4.1-flash"]["isActiveAccountLimited"] is True


def test_rate_limit_models_view_aligns_with_active_account_cooldown(rl_client, monkeypatch):
    """验证同模型双账号受限时，models[model] 优先与当前活跃账号的真实 cooldown 时间戳对齐：
    A 账号限流重置于 20:00:00
    B 账号限流重置于 20:30:00
    - 当前活跃为 A 时，models[model] 的 resetLocal 必须为 20:00:00，limitedUid 为 A；
    - 当前活跃为 B 时，models[model] 的 resetLocal 必须为 20:30:00，limitedUid 为 B；
    - 当前活跃为健康号 C 时，isActiveAccountLimited 为 False，且展示最近一次被限备用号。
    """
    class _FakeThreeCred:
        def __init__(self):
            self.active_uid = "u-wanjie"
            self.accounts = {
                "u-wanjie": {"account": {"uid": "u-wanjie", "nickname": "晚街"}},
                "u-active": {"account": {"uid": "u-active", "nickname": "17325834246"}},
                "u-third": {"account": {"uid": "u-third", "nickname": "备用三号"}},
            }

        def get_active_uid(self):
            return self.active_uid

        def get_active_session(self):
            return self.accounts[self.active_uid]

        def list_all_accounts(self):
            return list(self.accounts.items())

        def get_headers(self):
            return {"Authorization": "Bearer fake", "X-User-Id": self.active_uid}

    fake_cred = _FakeThreeCred()
    monkeypatch.setitem(converter.CONFIG, "cred", fake_cred)
    converter._ACCOUNT_COOLDOWNS.clear()
    converter._RATE_LIMIT_STATE.clear()

    raw_a = '{"code":6004,"msg":"将在 2099-01-01 20:00:00 UTC+8 重置"}'
    raw_b = '{"code":6004,"msg":"将在 2099-01-01 20:30:00 UTC+8 重置"}'

    # A 账号先触发
    converter._record_rate_limit("deepseek-v4.1-flash", raw_a, uid="u-wanjie", status_code=429)
    # B 账号后触发，覆盖 _RATE_LIMIT_STATE
    converter._record_rate_limit("deepseek-v4.1-flash", raw_b, uid="u-active", status_code=429)

    # 1. 活跃号为 A 时，必须优先对齐 A 账号的时间（20:00:00），而不是被 B 覆盖的 20:30:00
    fake_cred.active_uid = "u-wanjie"
    res_a = rl_client.get("/api/rate_limit")
    data_a = res_a.json()
    model_a = data_a["models"]["deepseek-v4.1-flash"]
    assert model_a["limitedUid"] == "u-wanjie"
    assert model_a["limitedNickname"] == "晚街"
    assert model_a["resetLocal"] == "20:00:00"
    assert model_a["isActiveAccountLimited"] is True

    # 2. 活跃号为 B 时，必须对齐 B 账号的时间（20:30:00）
    fake_cred.active_uid = "u-active"
    res_b = rl_client.get("/api/rate_limit")
    data_b = res_b.json()
    model_b = data_b["models"]["deepseek-v4.1-flash"]
    assert model_b["limitedUid"] == "u-active"
    assert model_b["limitedNickname"] == "17325834246"
    assert model_b["resetLocal"] == "20:30:00"
    assert model_b["isActiveAccountLimited"] is True

    # 3. 活跃号为健康号 C 时，不误报当前号限流，展示最新避让号
    fake_cred.active_uid = "u-third"
    res_c = rl_client.get("/api/rate_limit")
    data_c = res_c.json()
    model_c = data_c["models"]["deepseek-v4.1-flash"]
    assert model_c["isActiveAccountLimited"] is False
