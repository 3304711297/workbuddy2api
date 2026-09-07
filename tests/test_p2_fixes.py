"""P2-2 回归测试：动态模型拉取异常可观测性、安全降级与日志脱敏校验。"""

import json
import os
import pytest
import httpx
from unittest.mock import patch, MagicMock

import converter


@pytest.fixture
def mock_log_env(tmp_path):
    log_file = tmp_path / "test_debug.log"
    old_log_path = converter.CONFIG.get("log_path")
    old_log_level = converter.CONFIG.get("log_level")
    converter.CONFIG["log_path"] = str(log_file)
    converter.CONFIG["log_level"] = "debug"
    converter._MODELS_CACHE.clear()

    yield log_file

    converter.CONFIG["log_path"] = old_log_path
    converter.CONFIG["log_level"] = old_log_level
    converter._MODELS_CACHE.clear()


@pytest.mark.anyio
async def test_case_a_network_exception_observability(mock_log_env):
    """Case A: 网络异常时安全降级返回 fallback/空列表，并记录 debug 日志。"""
    def mock_handler(request: httpx.Request):
        raise httpx.ConnectError("Connection refused by peer (127.0.0.1:3067)", request=request)

    transport = httpx.MockTransport(mock_handler)
    with patch.object(converter, "_accounts_file", return_value=mock_log_env.parent / "nonexistent.json"):
        models = await converter._fetch_remote_models(transport=transport)

    assert isinstance(models, list)
    assert models == []

    log_content = mock_log_env.read_text(encoding="utf-8")
    assert "[DEBUG]" in log_content
    assert "网络/HTTP异常" in log_content or "ConnectError" in log_content


@pytest.mark.anyio
async def test_case_b_http_status_errors(mock_log_env):
    """Case B: 模拟 401/403/500 HTTP 错误码，继续降级并记录 debug 日志。"""
    for code in [401, 403, 500]:
        def mock_handler(request: httpx.Request, c=code):
            return httpx.Response(c, text=f"HTTP {c} Error")

        transport = httpx.MockTransport(mock_handler)
        models = await converter._fetch_remote_models(transport=transport)
        assert isinstance(models, list)

        log_content = mock_log_env.read_text(encoding="utf-8")
        assert f"HTTP {code}" in log_content


@pytest.mark.anyio
async def test_case_c_json_decode_error(mock_log_env):
    """Case C: 响应非合法 JSON（如 200 返回 HTML 登录拦截页），安全降级并记录 debug 日志。"""
    def mock_handler(request: httpx.Request):
        return httpx.Response(200, text="<html><body>Not JSON</body></html>")

    transport = httpx.MockTransport(mock_handler)
    models = await converter._fetch_remote_models(transport=transport)
    assert isinstance(models, list)

    log_content = mock_log_env.read_text(encoding="utf-8")
    assert "响应JSON解析失败" in log_content


@pytest.mark.anyio
async def test_case_d_response_structure_abnormal(mock_log_env):
    """Case D: 响应结构异常（如 code != 0 或缺少 models 列表），安全降级并记录原因。"""
    # 1. 业务 code != 0
    def mock_handler_err_code(request: httpx.Request):
        return httpx.Response(200, json={"code": 1001, "msg": "token expired", "data": {}})

    transport1 = httpx.MockTransport(mock_handler_err_code)
    models1 = await converter._fetch_remote_models(transport=transport1)
    assert models1 == []

    log1 = mock_log_env.read_text(encoding="utf-8")
    assert "业务状态码错误 (code=1001)" in log1

    # 2. data 中缺失 models 列表
    def mock_handler_no_models(request: httpx.Request):
        return httpx.Response(200, json={"code": 0, "data": {"other_field": True}})

    transport2 = httpx.MockTransport(mock_handler_no_models)
    models2 = await converter._fetch_remote_models(transport=transport2)
    assert models2 == []

    log2 = mock_log_env.read_text(encoding="utf-8")
    assert "models字段缺失或非列表" in log2


@pytest.mark.anyio
async def test_case_e_log_sanitization_masks_tokens(mock_log_env):
    """Case E: 验证当异常信息或诊断上下文中包含敏感 Token 时，日志被严格掩码，绝无明文泄露。"""
    sensitive_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload_12345"
    sensitive_apikey = "sk-wb-1234567890abcdef12345678"

    def mock_handler(request: httpx.Request):
        # 抛出一个异常，其消息体中包含模拟的 Authorization 和 accessToken
        raise httpx.RequestError(
            f"Failed Authorization: Bearer {sensitive_token} with accessToken: \"{sensitive_apikey}\"",
            request=request,
        )

    transport = httpx.MockTransport(mock_handler)
    models = await converter._fetch_remote_models(transport=transport)
    assert isinstance(models, list)

    log_content = mock_log_env.read_text(encoding="utf-8")
    assert sensitive_token not in log_content, "敏感 Bearer Token 绝不得以明文出现在日志中"
    assert sensitive_apikey not in log_content, "敏感 accessToken 绝不得以明文出现在日志中"
    assert "Bearer ***" in log_content
    assert "accessToken: \"***\"" in log_content or "accessToken" in log_content
