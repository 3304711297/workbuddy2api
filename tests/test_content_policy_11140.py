"""测试上游 11140 内容安全审核拦截的识别、防误切号与标准格式化输出。

借鉴自 icebears111/workbuddy2api：
上游 11140 (request illegal / 内容未通过安全审核) 是用户输入 Prompt 命中审核规则，
与账号配额和网络可用性无关。严禁将其误判为限流或故障而进行无谓的切号重试与账号冷却。
"""
import json
import pytest
from starlette.requests import Request
from starlette.datastructures import Headers

import converter
from converter import (
    _is_content_policy_violation,
    _safe_err_raw,
    _err_event,
    AccountRotator,
)


def test_is_content_policy_violation_predicate():
    # 明确命中 11140
    assert _is_content_policy_violation(400, '{"code":11140,"msg":"内容未通过安全审核，请调整后重试"}') is True
    assert _is_content_policy_violation(403, '{"code":11140,"message":"request illegal"}') is True
    assert _is_content_policy_violation(400, '未通过安全审核') is True

    # 正常限流 / 授权等非安全错误不得误判
    assert _is_content_policy_violation(429, '{"code":6004,"msg":"使用量超出频率限制"}') is False
    assert _is_content_policy_violation(400, '{"code":11102,"msg":"only available for authorized users"}') is False
    assert _is_content_policy_violation(500, 'internal server error') is False
    assert _is_content_policy_violation(200, '') is False


def test_safe_err_raw_formats_11140_to_standard_error():
    raw_json = b'{"code":11140,"msg":"\xe5\x86\x85\xe5\xae\xb9\xe6\x9c\xaa\xe9\x80\x9a\xe8\xbf\x87\xe5\xae\x89\xe5\x85\xa8\xe5\xae\xa1\xe6\xa0\xb8\xef\xbc\x8c\xe8\xaf\xb7\xe8\xb0\x83\xe6\x95\xb4\xe5\x90\x8e\xe9\x87\x8d\xe8\xaf\x95"}'
    res = _safe_err_raw(raw_json, 400)
    assert "error" in res
    err = res["error"]
    assert err["code"] == 11140
    assert err["type"] == "invalid_request_error"
    assert "11140" in err["message"]
    assert "安全审核" in err["message"]


def test_err_event_emits_standard_sse_chunk():
    raw_json = b'{"code":11140,"msg":"request illegal"}'
    chunk = _err_event(raw_json, 400).decode("utf-8")
    assert chunk.startswith("data: ")
    assert chunk.endswith("\n\n")
    parsed = json.loads(chunk[6:].strip())
    assert "error" in parsed
    assert parsed["error"]["code"] == 11140
    assert parsed["error"]["type"] == "invalid_request_error"


def test_rotator_does_not_failover_or_cooldown_on_11140():
    rotator = AccountRotator()
    rotator.mode = "failover"
    
    # 构造 11140 错误
    err_11140 = '{"code":11140,"msg":"内容未通过安全审核"}'
    res = rotator.record_failure_and_failover("test-uid-1", "deepseek-v4.1-flash", 400, err_11140)
    
    # 严格返回 None，拒绝切号
    assert res is None
    
    # 验证账号未被记录到 _RATE_LIMIT_STATE 冷却池中
    with converter._RATE_LIMIT_LOCK:
        entry = converter._RATE_LIMIT_STATE.get("deepseek-v4.1-flash")
        if entry:
            # 如果存在条目，不能是当前 11140 触发的（即 remaining 不能因为这次错误增加）
            assert entry.get("limitedUid") != "test-uid-1"
