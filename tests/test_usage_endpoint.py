"""GET /api/usage_summary 端点单测（Hermes token-stats 配额看板数据源）。

三必备场景：accounts.json 缺失 / token 缺失 / 正常解析（MockTransport 拦截 HTTP，
不发真实请求）。另补后端 code!=0 与网络失败两条错误路径及纯函数单测。
"""

import asyncio
import json

import httpx
import pytest

import converter
from converter import (
    _load_active_session,
    _parse_usage_payload,
    api_usage_summary,
)


def _mock_backend(payload: dict, status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        # 请求契约自检：直查腾讯计费接口，头与体符合约定
        assert request.url.host == "copilot.tencent.com"
        assert request.url.path == "/billing/meter/get-user-resource-summary"
        assert request.headers["Content-Type"] == "application/json"
        assert request.headers["User-Agent"] == "codebuddy2openai/2.0"
        assert request.headers["X-User-Id"] == "u1"
        assert request.headers["Authorization"].startswith("Bearer tok")
        assert json.loads(request.content) == {}
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def _write_accounts(base, cfg: dict):
    d = base / "codebuddy2openai"
    d.mkdir(parents=True, exist_ok=True)
    (d / "accounts.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def fake_localappdata(tmp_path, monkeypatch):
    # _accounts_file() 在调用时读环境变量，直接把 LOCALAPPDATA 指到临时目录
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    return tmp_path


def _valid_accounts_cfg() -> dict:
    return {
        "active_uid": "u1",
        "accounts": {
            "u1": {
                "auth": {"accessToken": "tok", "expiresAt": 9999999999999},
                "account": {"uid": "u1", "nickname": "晚街"},
            }
        },
    }


_OK_PAYLOAD = {
    "code": 0,
    "data": {
        "IsPaidUser": True,
        "Packages": [
            {"PackageCode": "pkgA", "CycleTotalCapacity": "1000.5",
             "CycleRemainCapacity": "500.25", "CycleUsedCapacity": "500.25",
             "CapacityUnit": "credits"},
            {"PackageCode": "pkgB", "CycleTotalCapacity": "100",
             "CycleRemainCapacity": "80", "CycleUsedCapacity": "20",
             "CapacityUnit": "credits"},
        ],
    },
}


# ---------------------------------------------------------------------------
# 场景一：accounts.json 缺失 → {"error": ...}
# ---------------------------------------------------------------------------

def test_endpoint_missing_accounts_file(fake_localappdata):
    res = asyncio.run(api_usage_summary())
    assert set(res) == {"error"}
    assert "accounts.json 不存在" in res["error"]


# ---------------------------------------------------------------------------
# 场景二：活跃账号缺 accessToken → {"error": ...}
# ---------------------------------------------------------------------------

def test_endpoint_missing_token(fake_localappdata):
    _write_accounts(fake_localappdata, {
        "active_uid": "u1",
        "accounts": {"u1": {"auth": {"expiresAt": 1},
                            "account": {"uid": "u1", "nickname": "晚街"}}},
    })
    res = asyncio.run(api_usage_summary())
    assert set(res) == {"error"}
    assert "accessToken" in res["error"]


# ---------------------------------------------------------------------------
# 场景三：正常流程 → 与 Rust UsageSummary 结构对齐
# ---------------------------------------------------------------------------

def test_endpoint_normal_flow(fake_localappdata, monkeypatch):
    _write_accounts(fake_localappdata, _valid_accounts_cfg())
    monkeypatch.setattr(converter, "_BILLING_TRANSPORT_OVERRIDE", _mock_backend(_OK_PAYLOAD))
    res = asyncio.run(api_usage_summary())

    assert set(res) == {"uid", "nickname", "total", "remain", "used",
                        "is_paid_user", "packages"}
    assert res["uid"] == "u1"
    assert res["nickname"] == "晚街"
    assert res["total"] == pytest.approx(1100.5)   # 1000.5 + 100
    assert res["remain"] == pytest.approx(580.25)  # 500.25 + 80
    assert res["used"] == pytest.approx(520.25)    # 500.25 + 20
    assert res["is_paid_user"] is True
    assert res["packages"][0] == {"code": "pkgA", "total": 1000.5,
                                  "remain": 500.25, "used": 500.25,
                                  "unit": "credits"}


# ---------------------------------------------------------------------------
# 额外错误路径：后端 code!=0（含 token 过期语义）与网络失败
# ---------------------------------------------------------------------------

def test_endpoint_backend_error_code(fake_localappdata, monkeypatch):
    _write_accounts(fake_localappdata, _valid_accounts_cfg())
    monkeypatch.setattr(
        converter, "_BILLING_TRANSPORT_OVERRIDE",
        _mock_backend({"code": 401, "msg": "token expired"}),
    )
    res = asyncio.run(api_usage_summary())
    assert set(res) == {"error"}
    assert "token expired" in res["error"]


def test_endpoint_backend_http_500(fake_localappdata, monkeypatch):
    _write_accounts(fake_localappdata, _valid_accounts_cfg())
    monkeypatch.setattr(
        converter, "_BILLING_TRANSPORT_OVERRIDE",
        _mock_backend({"msg": "oops"}, status=500),
    )
    res = asyncio.run(api_usage_summary())
    assert set(res) == {"error"}
    assert "HTTP 500" in res["error"]


def test_endpoint_network_failure(fake_localappdata, monkeypatch):
    _write_accounts(fake_localappdata, _valid_accounts_cfg())

    def broken_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(
        converter, "_BILLING_TRANSPORT_OVERRIDE",
        httpx.MockTransport(broken_handler),
    )
    res = asyncio.run(api_usage_summary())
    assert set(res) == {"error"}
    assert "网络失败" in res["error"]


# ---------------------------------------------------------------------------
# 纯函数：会话选择与载荷解析
# ---------------------------------------------------------------------------

def test_load_active_session_errors():
    with pytest.raises(ValueError):
        _load_active_session({})  # 空 config
    with pytest.raises(ValueError):
        _load_active_session({"active_uid": "u1", "accounts": {"other": {}}})  # 无对应会话


def test_parse_usage_payload_empty_and_defaults():
    res = _parse_usage_payload({})
    assert res == {"total": 0.0, "remain": 0.0, "used": 0.0,
                   "is_paid_user": False, "packages": []}


def test_parse_usage_payload_number_capacity_superset():
    # 数字类型容量也能解析（Rust 仅接受字符串，此处为宽容超集，缺键按 0.0）
    res = _parse_usage_payload({"IsPaidUser": False,
                                "Packages": [{"CycleTotalCapacity": 5,
                                              "CycleRemainCapacity": "2.5"}]})
    assert res["total"] == pytest.approx(5.0)
    assert res["remain"] == pytest.approx(2.5)
    assert res["used"] == 0.0
    assert res["packages"][0]["unit"] == "credits"  # 缺 CapacityUnit 回退默认值
    assert res["packages"][0]["code"] == ""


# ---------------------------------------------------------------------------
# 鉴权对齐：配置 api_key 时 /api/usage_summary 必须严格鉴权
# ---------------------------------------------------------------------------

def test_usage_endpoint_auth_enforced_when_api_key_set(fake_localappdata, monkeypatch):
    _write_accounts(fake_localappdata, _valid_accounts_cfg())
    monkeypatch.setattr(converter, "_BILLING_TRANSPORT_OVERRIDE", _mock_backend(_OK_PAYLOAD))
    monkeypatch.setitem(converter.CONFIG, "api_key", "secret_key_123")

    # 1. 未携带 Key → 401
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(api_usage_summary())
    assert exc_info.value.status_code == 401

    # 2. 携带错误 Key → 401
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(api_usage_summary(authorization="Bearer wrong_key"))
    assert exc_info.value.status_code == 401

    # 3. 携带正确 Bearer Token → 成功
    res_bearer = asyncio.run(api_usage_summary(authorization="Bearer secret_key_123"))
    assert res_bearer["uid"] == "u1"

    # 4. 携带正确 X-Api-Key → 成功
    res_x = asyncio.run(api_usage_summary(x_api_key="secret_key_123"))
    assert res_x["uid"] == "u1"
