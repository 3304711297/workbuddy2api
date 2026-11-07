"""官方 classifyErrorDetail 错误码表：额度耗尽 / 账号状态必须与 HTTP 状态码解耦。

背景（2026-11-07 吸收 zx-yk/workbuddy2api-panel 304aa5e3）：
上游把「额度耗尽」「授权过期」「未激活」全套在 429 上返回。本仓此前只认 14018 与
14017，其余码会落到 `status == 429 → 软限流`：
  - 额度耗尽被软冷却 5 分钟，回来额度还是空；
  - 授权过期冷却→恢复→再失败，无限循环，日志里看不出真因。

这里钉住三件事：
  ① 码表内的额度码在任何 4xx 状态下都判「额度耗尽」，不判账号态故障；
  ② 码表内的账号态码判「账号态故障」，不判额度耗尽（处置是短冷却而非停到次日）；
  ③ 码表外的码（10105 / 6004 / 14003）语义不变，不被抢走。
"""
import json

import pytest

import converter


CREDIT_CODES = ("14001", "14002", "14012", "14013", "14014", "14018", "14019")
ACCOUNT_CODES = ("14015", "14016", "14017")


def _body(code, nested: bool = False) -> str:
    if nested:
        return json.dumps({"error": {"data": {"code": code, "msg": "x"}}})
    return json.dumps({"code": code, "msg": "x"})


@pytest.mark.parametrize("code", CREDIT_CODES)
@pytest.mark.parametrize("status", (429, 400, 403))
def test_credit_codes_are_hard_credit_regardless_of_status(code, status):
    text = _body(int(code))
    assert converter._is_credit_exhausted_signal(status, text) is True, (
        f"{code} 是官方 quota_balance_exhausted，不得因 status={status} 被当成软限流"
    )
    assert converter._is_account_fault_signal(status, text) is False


@pytest.mark.parametrize("code", ACCOUNT_CODES)
@pytest.mark.parametrize("status", (429, 400, 403))
def test_account_state_codes_are_account_fault_not_credit(code, status):
    text = _body(int(code))
    assert converter._is_account_fault_signal(status, text) is True, (
        f"{code} 是账号状态问题（授权过期/未激活），应短冷却换号而不是停到次日"
    )
    assert converter._is_credit_exhausted_signal(status, text) is False


@pytest.mark.parametrize("code", CREDIT_CODES)
def test_credit_codes_are_found_in_nested_envelope(code):
    """上游实测把码藏在 error.data.code；只读顶层会漏判。"""
    text = _body(int(code), nested=True)
    assert converter._is_credit_exhausted_signal(429, text) is True


@pytest.mark.parametrize("code", ACCOUNT_CODES)
def test_account_codes_accept_string_form(code):
    text = json.dumps({"code": code})
    assert converter._is_account_fault_signal(429, text) is True


def test_unlisted_codes_keep_existing_semantics():
    """10105 可自愈、6004 模型级限流、14003 模型繁忙：都不得被新码表抢走。"""
    for code in (10105, 6004, 14003):
        text = _body(code)
        assert converter._is_credit_exhausted_signal(429, text) is False, code
        assert converter._is_account_fault_signal(429, text) is False, code
