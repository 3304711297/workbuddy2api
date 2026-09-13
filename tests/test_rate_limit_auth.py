"""P0 安全回归：/api/rate_limit 鉴权 + _check_auth 恒定时间比较。

背景：api_rate_limit 无鉴权参数但 README 标注需 Authorization，
且返回 nickname/active_uid/rotation；_check_auth 用 == 比较密钥。
全程不触碰真实凭据与上游。
"""

import asyncio
import inspect

import pytest
from fastapi import HTTPException

import converter
from converter import api_rate_limit


@pytest.fixture()
def api_key_set(monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "api_key", "secret_key_123")
    yield
    # conftest 的 autouse fixture 负责恢复 cred；api_key 需手动还原
    converter.CONFIG["api_key"] = ""


def test_rate_limit_rejects_unauthenticated_when_api_key_set(api_key_set):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(api_rate_limit())
    assert exc_info.value.status_code == 401


def test_rate_limit_rejects_wrong_key(api_key_set):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(api_rate_limit(authorization="Bearer wrong_key"))
    assert exc_info.value.status_code == 401


def test_rate_limit_accepts_bearer_and_x_api_key(api_key_set):
    res_bearer = asyncio.run(api_rate_limit(authorization="Bearer secret_key_123"))
    assert "models" in res_bearer
    res_x = asyncio.run(api_rate_limit(x_api_key="secret_key_123"))
    assert "models" in res_x


def test_rate_limit_open_when_no_api_key():
    converter.CONFIG["api_key"] = ""
    res = asyncio.run(api_rate_limit())
    assert "models" in res


def test_check_auth_uses_constant_time_compare():
    src = inspect.getsource(converter._check_auth)
    assert "compare_digest" in src, "_check_auth 必须用 hmac.compare_digest 做密钥比较"
