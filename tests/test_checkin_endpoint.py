"""回归测试：每日签到按钮（GET /api/checkin/status + POST /api/checkin/claim）。

用户拍板（2026-09-08）：不做自动定时签到，改为 GUI 手动点击触发。
签到链路：POST /v2/billing/meter/checkin-activity-status（状态查询）+
POST /v2/billing/meter/daily-checkin（领取），业务码 1001=今日已领 /
1002=无资格 / 1003=活动已结束。均经 CredentialManager 注入 X-Device-Token。
全程 mock 上游 HTTP，不发起真实签到请求。
"""

import sys
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


class _FakeCred:
    def get_active_session(self):
        return {
            "auth": {"accessToken": "fake-token", "domain": "www.workbuddy.cn"},
            "account": {"uid": "u-test", "nickname": "测试账号"},
        }

    def get_headers(self):
        return {"Authorization": "Bearer fake-token", "X-User-Id": "u-test", "User-Agent": "test"}


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _client_with(monkeypatch, responses: dict):
    """responses: path -> payload；按调用顺序弹出。"""
    converter.CONFIG["cred"] = _FakeCred()
    converter._RATE_LIMIT_STATE.clear()
    paths = list(responses.keys())

    class FakeRespSync:
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, **kw):
            self._i = {}

        def post(self, url, **kw):
            path = "/" + url.split("/", 3)[-1]
            i = self._i.get(path, 0)
            self._i[path] = i + 1
            return FakeRespSync(responses[path][i])

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(httpx, "Client", FakeClient)
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_checkin_status_ok(monkeypatch):
    client = _client_with(monkeypatch, {
        "/v2/billing/meter/checkin-activity-status": [
            {"code": 0, "data": {"active": True, "today_checked_in": False,
                                  "end_time": "2026-12-31", "activity_name": "Buddy 加油站"}},
        ],
    })
    res = client.get("/api/checkin/status")
    assert res.status_code == 200
    d = res.json()
    assert d["ok"] is True
    assert d["data"]["today_checked_in"] is False
    assert d["data"]["active"] is True


def test_checkin_claim_success(monkeypatch):
    client = _client_with(monkeypatch, {
        "/v2/billing/meter/daily-checkin": [
            {"code": 0, "data": {"credit": 100, "streak_days": 3}},
        ],
    })
    res = client.post("/api/checkin/claim")
    assert res.status_code == 200
    d = res.json()
    assert d["ok"] is True
    assert d["credit"] == 100
    assert d["streak_days"] == 3


def test_checkin_claim_already_claimed(monkeypatch):
    client = _client_with(monkeypatch, {
        "/v2/billing/meter/daily-checkin": [
            {"code": 1001, "msg": "今日已领取"},
        ],
    })
    res = client.post("/api/checkin/claim")
    d = res.json()
    assert d["ok"] is False
    assert d["status"] == "already_claimed"


def test_checkin_claim_event_ended(monkeypatch):
    client = _client_with(monkeypatch, {
        "/v2/billing/meter/daily-checkin": [
            {"code": 1003, "msg": "活动已结束"},
        ],
    })
    res = client.post("/api/checkin/claim")
    d = res.json()
    assert d["ok"] is False
    assert d["status"] == "event_ended"


def test_checkin_no_credentials(monkeypatch):
    converter.CONFIG["cred"] = None
    monkeypatch.setattr(converter, "find_auth_file", lambda: None)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/api/checkin/claim")
    assert res.status_code == 503
