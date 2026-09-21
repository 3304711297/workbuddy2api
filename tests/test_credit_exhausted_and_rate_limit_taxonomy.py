"""契约测试：额度耗尽（14018/14017）硬冷却、限流码族扩张、非 JSON 回退收紧。

背景（本机 converter.log 实测，105 次命中，2026-09-17 起至 2026-09-21 仍在发生）：
    ✗ HTTP 429 | deepseek-v4.1-flash |
      {"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包…"}}}

旧行为：`_is_rate_limit_signal` 第一行 `if status_code == 429: return True` 无条件命中，
14018 被当成普通软限流 → 只冷 5 分钟 → 冷却一过立刻重选同一个已耗尽的账号 → 成串烧请求。

本文件锁定三类判据，每条都配了**反向用例**（防判据过宽）：
  ① 额度耗尽必须识别（含**嵌套** error.data.code 形态）并做长冷却（到次日边界）；
  ② 无限流码的同文案 429 仍按软限流（不得把两者混为一谈）；
  ③ 非 JSON 自由文本回退不得吃裸 `429`/`6004` 数字（网关 HTML 错误页会把好账号打进假冷却）。
"""

import re
import time
from pathlib import Path

import pytest

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402

# 上游真实报文形态（嵌套信封，本机日志原文）
SAMPLE_14018 = (
    '{"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，'
    '购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage ",'
    '"requestId":"c289bd41-b5a1-441c-9e39-4d9a55fd46a3"}}'
)

# 真实 6004 报文（顶层 code + 中文重置时刻）
SAMPLE_6004 = (
    '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2099-01-01 12:00:00 UTC+8 重置，"'
    '"requestId":"test"}'
)


# ────────────────────────── ① 额度耗尽识别 ──────────────────────────

def test_credit_exhausted_detects_nested_code():
    """嵌套 error.data.code=14018 必须命中（只读顶层 code 会漏判）。"""
    assert converter._is_credit_exhausted_signal(429, SAMPLE_14018) is True


def test_credit_exhausted_detects_allocation_phrase_without_code():
    """无 code 但文案明确说额度已用尽 → 同样命中（保留同义改写兼容）。"""
    raw = '{"msg":"额度已用尽，请购买加量包"}'
    assert converter._is_credit_exhausted_signal(429, raw) is True


@pytest.mark.parametrize("code", ["14017", 14017])
def test_credit_exhausted_trial_code_also_detected(code):
    """14017（试用未开通）同属额度/授权耗尽族，一并长冷却。"""
    raw = '{"error":{"data":{"code":%s,"msg":"The trial version is not yet activated"}}}' % (
        '"%s"' % code if isinstance(code, str) else code,
    )
    assert converter._is_credit_exhausted_signal(429, raw) is True


def test_credit_exhausted_detects_top_level_code():
    """顶层 code=14018（无嵌套信封）同样必须命中。"""
    assert converter._is_credit_exhausted_signal(429, '{"code":14018,"msg":"credits exhausted"}') is True


def test_credit_exhausted_ignores_success_status():
    """正常回答正文里出现「额度」不得触发（status < 400 一律判否）。"""
    assert converter._is_credit_exhausted_signal(200, SAMPLE_14018) is False


def test_credit_exhausted_ignores_unrelated_business_code():
    """有 code 但不在码表内 → 判否（防把确定性问题误判成额度耗尽）。"""
    raw = '{"code":11140,"msg":"内容未通过安全审核"}'
    assert converter._is_credit_exhausted_signal(400, raw) is False


def test_credit_exhausted_ignores_html_gateway_error():
    """HTML 网关错误页不是业务报文，不得判成额度耗尽。"""
    assert converter._is_credit_exhausted_signal(
        502, "<html><body>502 Bad Gateway</body></html>") is False


# ────────────────────────── ② 与软限流的区分 ──────────────────────────

def test_same_text_429_without_credit_code_stays_soft_rate_limit():
    """反向用例（防判据过宽）：无限度码的 429 仍按软限流，不做次日冷却。"""
    raw = '{"requestId":"14018","msg":"Too Many Requests"}'
    assert converter._is_credit_exhausted_signal(429, raw) is False
    assert converter._is_rate_limit_signal(429, raw) is True


def test_credit_exhausted_reset_is_next_day_boundary():
    """额度耗尽的冷却终点必须是次日 00:00（UTC+8），而不是几十分钟。"""
    reset_ms, reset_local = converter._credit_exhausted_reset()
    remaining = (reset_ms - time.time() * 1000) / 1000.0
    assert 0 < remaining <= 24 * 3600 + 60
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2} 00:00:00", reset_local)


def test_record_rate_limit_credit_exhausted_uses_long_cooldown(monkeypatch):
    """端到端：14018 记账后冷却剩余时间必须远超软限流窗口（几十分钟级）。"""
    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()
    try:
        converter._record_rate_limit("deepseek-v4.1-flash", SAMPLE_14018,
                                     uid="u-empty", status_code=429)
        entry = converter._RATE_LIMIT_STATE["deepseek-v4.1-flash"]
        assert entry["code"] == 14018
        assert entry["kind"] == "credit_exhausted"
        remaining = (entry["resetAtMs"] - time.time() * 1000) / 1000.0
        assert remaining > 3600, f"额度耗尽冷却过短: {remaining}s"
        assert ("u-empty", "deepseek-v4.1-flash") in converter._ACCOUNT_COOLDOWNS
    finally:
        converter._RATE_LIMIT_STATE.clear()
        converter._ACCOUNT_COOLDOWNS.clear()


def test_record_rate_limit_soft_429_keeps_short_cooldown():
    """对照：普通 429 无精确时刻仍走 300s±45s 软窗，不受额度分支影响。"""
    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()
    try:
        converter._record_rate_limit("glm-5.3", '{"msg":"Too Many Requests"}',
                                     uid="u-ok", status_code=429)
        entry = converter._RATE_LIMIT_STATE["glm-5.3"]
        assert entry["code"] == 6004
        assert entry["kind"] == "rate_limit"
        remaining = (entry["resetAtMs"] - time.time() * 1000) / 1000.0
        assert 200 < remaining < 400
    finally:
        converter._RATE_LIMIT_STATE.clear()
        converter._ACCOUNT_COOLDOWNS.clear()


def test_failover_entry_accepts_credit_exhausted(monkeypatch):
    """额度耗尽必须能走换号入口（否则空号仍被选中，用户只看到报错）。

    前置门是「限流 or 额度耗尽」；此处把限流判据打桩为 False，只让额度耗尽成立，
    以证明换号确实由额度耗尽这一支触发（而不是被限流分支顺带带过）。
    """
    class _FakeCred:
        def __init__(self):
            self.active = "u-empty"

        def get_active_uid(self):
            return self.active

        def list_all_accounts(self):
            return [("u-empty", {}), ("u-healthy", {})]

        def get_headers_for_uid(self, uid):
            return {"Authorization": "Bearer x", "X-User-Id": uid}

        def switch_active_account(self, uid):
            self.active = uid

    monkeypatch.setattr(converter, "_is_rate_limit_signal", lambda *a, **k: False)
    monkeypatch.setattr(converter, "_is_content_policy_violation", lambda *a, **k: False)
    monkeypatch.setattr(converter, "_record_rate_limit", lambda *a, **k: None)

    rotator = converter.AccountRotator(cred_mgr=_FakeCred(), mode="failover")
    monkeypatch.setattr(rotator, "get_all_accounts", lambda: [("u-empty", {}), ("u-healthy", {})])
    monkeypatch.setattr(rotator, "get_candidate_uids_tiered", lambda model: ["u-healthy"])

    result = rotator.record_failure_and_failover("u-empty", "deepseek-v4.1-flash", 429, SAMPLE_14018)
    assert result is not None, "额度耗尽被前置门挡下，账号永不避让"
    assert result[0] == "u-healthy"


def test_failover_entry_rejects_unrelated_error(monkeypatch):
    """反向：既非限流也非额度耗尽的错误不得换号（防过度避让）。"""
    class _FakeCred:
        def get_active_uid(self):
            return "u-a"

        def list_all_accounts(self):
            return [("u-a", {}), ("u-b", {})]

    monkeypatch.setattr(converter, "_is_content_policy_violation", lambda *a, **k: False)
    rotator = converter.AccountRotator(cred_mgr=_FakeCred(), mode="failover")
    result = rotator.record_failure_and_failover(
        "u-a", "glm-5.3", 400, '{"code":50001,"msg":"internal error"}')
    assert result is None


# ────────────────────────── ③ 非 JSON 回退收紧 ──────────────────────────

def test_html_error_page_with_numeric_429_not_treated_as_rate_limit():
    """反向用例：网关 HTML 页面里的裸 429 不再触发假冷却。"""
    html = ("<html><head><title>502 Bad Gateway</title></head><body>"
            "upstream returned 429 retry later, requestId=4290-6004-abcd"
            "</body></html>")
    assert converter._is_rate_limit_signal(502, html) is False


def test_plain_text_rate_limit_phrase_still_detected():
    """正向：无结构的明文限流措辞仍须命中（不得因收紧而漏判真实限流）。"""
    assert converter._is_rate_limit_signal(400, "请求频率过高，请稍后再试") is True
    assert converter._is_rate_limit_signal(503, "Too Many Requests") is True
    # 裸露的 "usage limit exceeded" 措辞不在整词表内，按设计判否（避免过宽）；
    # 该措辞的真实报文以 6004 码下发，由码族分支覆盖。
    assert converter._is_rate_limit_signal(400, "Your usage limit exceeded") is False


def test_json_rate_limit_code_family_is_recognized():
    """限流码族扩张：6000-6008 全部应按限流处理（旧实现只认 6004）。"""
    for code in range(6000, 6009):
        raw = '{"code":%d,"msg":"frequency limit"}' % code
        assert converter._is_rate_limit_signal(400, raw) is True, f"code {code} 漏判"


def test_json_business_code_outside_family_is_not_rate_limit():
    """反向：结构化报文里出现非限流码即判否（不得裸扫整串）。"""
    raw = '{"code":11102,"msg":"model not authorized","requestId":"6004-4290"}'
    assert converter._is_rate_limit_signal(400, raw) is False


def test_request_id_hex_fragment_does_not_trigger_cooldown():
    """历史踩坑回归：requestId 里的 `4290-6004` 片段不得被当成限流。"""
    raw = '{"code":50001,"msg":"internal","requestId":"4290-6004-abcd"}'
    assert converter._is_rate_limit_signal(500, raw) is False
