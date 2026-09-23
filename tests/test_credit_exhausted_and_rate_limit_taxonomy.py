"""契约测试：三层错误分类（额度耗尽 / 账号态故障 / 限流每日额度）与冷却语义。

背景（本机 converter.log 12854 行实测）：
    ✗ HTTP 429 | deepseek-v4.1-flash |
      {"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包…"}}}
    105 条 14018 全部**不带** reset 时间；94 条 6004 配对样本的 reset 距发生时刻
    中位 3.67h、最大 18.63h，**89.4% 超过 2h**。

旧行为：`_is_rate_limit_signal` 第一行 `if status_code == 429: return True` 无条件命中，
14018 被当成普通软限流 → 只冷 5 分钟 → 冷却一过立刻重选同一个已耗尽的账号 → 成串烧请求；
而 6004 的 reset 又被 2h 封顶截断 → 账号解冻后立刻二次撞墙。

本文件锁定四层判据，每条都配**反向用例**（防判据过宽）：
  ① 额度耗尽（14018）必须识别（含**嵌套** error.data.code）并长冷却，**且优先采用上游 reset**；
  ② 账号态故障（14017）必须与额度耗尽**分开**：短冷却可自愈，不得停到次日、不得记成 14018；
  ③ 每日额度（6004/6008）必须对齐上游 reset 墙钟，不受 2h 封顶；瞬时频控码仍走短窗；
  ④ 软限流措辞（`usage limit exceeded` 等）**不得**被判成额度耗尽（上游 ErrSoftRate 契约）。
"""

import datetime
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
def test_trial_not_activated_is_account_fault_not_credit_exhausted(code):
    """14017（试用未开通）是**账号态故障**，不是额度耗尽。

    外部证据（Sliverkiss/workbuddy2api internal/upstream/client.go 分类注释 +
    client_test.go 契约）：
      14017 → ErrAccountFault（试用未激活/账号态故障）→ 短冷却 + 换号，可自愈
      14018 → ErrHardCredit （额度耗尽）             → 长冷却等恢复
    旧实现把两者并进 `_CREDIT_EXHAUSTED_CODES` → 一个新账号被按「额度耗尽」停到次日，
    白丢一个本可用窗口；且 `entry["code"]` 还会把 14017 记成 14018，污染观测。
    """
    raw = '{"error":{"data":{"code":%s,"msg":"The trial version is not yet activated"}}}' % (
        '"%s"' % code if isinstance(code, str) else code,
    )
    assert converter._is_credit_exhausted_signal(429, raw) is False, "14017 不得判为额度耗尽"
    assert converter._is_account_fault_signal(429, raw) is True, "14017 必须判为账号态故障"


def test_account_fault_uses_short_cooldown_not_next_day():
    """14017 的冷却必须是短冷却（可自愈），不得落到次日边界。"""
    converter._RATE_LIMIT_STATE.clear()
    raw = '{"error":{"data":{"code":14017,"msg":"trial not activated"}}}'
    converter._record_rate_limit("m-14017", raw, uid="u1", status_code=429)
    entry = converter._RATE_LIMIT_STATE.get("m-14017")
    assert entry is not None, "14017 必须被记录（换号入口依赖它）"
    assert entry["kind"] == "account_fault"
    assert entry["resetAtMs"] - int(time.time() * 1000) < 3600 * 1000, "14017 不应被停到次日"
    assert str(entry["code"]) == "14017", "必须记录真实码，不得写成 14018"


# frozen_evening 需要真实模块做代理
_REAL_DATETIME = datetime
_REAL_TIME = time

# --------------------------------------------------------------------------
# 时钟固定（日边界断言的正确姿势）
# --------------------------------------------------------------------------
class _FrozenDateTime(datetime.datetime):
    """把 `converter` 看到的「现在」钉死，使日边界断言与运行时刻无关。

    ⚠️ **仅仅继承 datetime 是不够的**：`datetime.datetime.now()` 是 classmethod，子类
    继承它照样读真实时钟。必须**显式覆盖 now()** 才会真正冻结（本文件初版漏了这一步，
    `test_frozen_clock_is_effective` 当场把它抓了出来）。

    为什么必须冻结：日额度/额度耗尽在无 reset 时的兜底终点是**次日 00:00**，而断言用的
    是「剩余量 > 400s」这类下限。跑在 23:54 时距次日 00:00 天然只剩 350s —— 断言必然
    假红而实现完全正确（真实故障模式：午夜前半小时随机变红，然后被误当成真回归去改实现）。
    修法不是放宽阈值，而是钉死时钟：固定 18:00，兜底终点距现在恒 6h。
    """

    @classmethod
    def now(cls, tz=None):
        fixed = cls._fixed
        return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)


@pytest.fixture()
def frozen_evening(monkeypatch):
    """把 converter 的 datetime **和 time** 一起冻结在 UTC+8 当日 18:00。

    ⚠️ 只冻结 datetime 是不够的（本文件第二次踩到）：日边界是个**绝对时刻**
    （次日 00:00），只挪「现在」而 `time.time()` 仍读真实墙钟时，量出来的剩余时间
    依然是「真实现在 → 次日 00:00」≈ 42s，断言照样假红。两者必须同时冻结，
    「距日边界恒 6h」才成立。
    """
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    fixed = _FrozenDateTime(2026, 9, 21, 18, 0, 0, tzinfo=tz8)
    _FrozenDateTime._fixed = fixed
    fixed_epoch = fixed.timestamp()

    class _FrozenTime:
        """time 代理：time()/monotonic() 都钉在冻结时刻（其余委托真实模块）。

        本文件只用 time.time() 与 time.monotonic() 计算剩余量；把两者一起钉住，
        断言才与运行时刻无关。
        """
        time = staticmethod(lambda: fixed_epoch)
        monotonic = staticmethod(lambda: 0.0)
        strftime = staticmethod(_REAL_TIME.strftime)
        localtime = staticmethod(_REAL_TIME.localtime)

        def __getattr__(self, name):
            return getattr(_REAL_TIME, name)

    class _Mod:
        # timedelta / timezone 必须是**真模块级**属性：写成 `datetime.timedelta` 会解析成
        # `_FrozenDateTime.timedelta`（类体内 datetime 已绑定）→ AttributeError。
        datetime = _FrozenDateTime
        timedelta = _REAL_DATETIME.timedelta
        timezone = _REAL_DATETIME.timezone

    monkeypatch.setattr(converter, "datetime", _Mod)
    monkeypatch.setattr(converter, "time", _FrozenTime)
    yield fixed


def _remaining(entry) -> float:
    return entry["monotonic_until"] - converter.time.monotonic()


def _assert_long_cooldown(effective: float, hour: int, what: str):
    """冻结时钟下的长冷却断言：必须对齐日边界，且**不得**退化成瞬时窗。

    ⚠️ 「排除某个秒数区间」是不够的：日边界兜底的真实剩余时间会随运行时刻变化，
    午夜前几分钟天然掉进瞬时窗的数值范围，那种断言在午夜前必然假红（实测 23:54 命中）。
    正解是**钉死时钟**（frozen_evening，恒 18:00 → 剩余恒 6h），此后 `> 400` 才是
    诚实断言：它只可能因实现退化成软限流而失败，不再受墙钟摆布。
    """
    expect_ms, _ = converter._next_day_reset_ms(hour)
    expect = (expect_ms - converter.time.time() * 1000) / 1000.0
    assert abs(effective - expect) < 5, (
        f"{what}: 生效冷却未对齐日边界（{effective}s，期望 ≈{expect}s）"
    )
    assert effective > 400, (
        f"{what}退化成了瞬时软窗（{effective}s）—— 冷却一过立刻重选同一账号，二次撞墙"
    )


def test_frozen_clock_is_effective(frozen_evening):
    """自检：冻结 fixture 必须真的改到 `converter` 看到的时钟。

    没有这条，下面所有「与日边界对齐」的断言都可能因 fixture 失效而**空过**——
    实测变异验证正是这样漏掉过一次（冻结失效时不报错、断言照样绿）。
    """
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    seen = converter.datetime.datetime.now(tz8)
    assert (seen.hour, seen.minute) == (18, 0), (
        f"datetime 冻结未生效，converter 看到的是 {seen}；相关断言等于没验证"
    )
    # time 也必须冻结：日边界是绝对时刻，只挪 datetime 时剩余量仍按真实墙钟算
    assert abs(converter.time.time() - seen.timestamp()) < 1, (
        "time 冻结未生效 —— 只冻结 datetime 会让「距日边界恒 6h」不成立"
    )
    assert converter.time.monotonic() == 0.0

def test_credit_exhausted_uses_long_cooldown(frozen_evening):
    """14018 必须走长冷却（额度耗尽当日不可恢复）。

    ⚠️ 断言不能写死「剩余 > 1h」：兜底是**下一个 00:00（UTC+8）**，若在 23:00 后
    运行，距日边界天然不足 1h（会按当天时刻假红）。正确判据是「对齐日边界且明确
    排除瞬时软窗」，与 `test_daily_quota_without_reset_...` 同源。
    """
    converter._RATE_LIMIT_STATE.clear()
    converter._record_rate_limit("m-14018", SAMPLE_14018, uid="u1", status_code=429)
    entry = converter._RATE_LIMIT_STATE.get("m-14018")
    assert entry is not None
    assert entry["kind"] == "credit_exhausted"
    # 1) 明确排除瞬时软窗（255s~345s）—— 这才是「5 分钟后重试」的成因
    effective = entry["monotonic_until"] - converter.time.monotonic()
    _assert_long_cooldown(effective, converter._CREDIT_EXHAUSTED_FALLBACK_HOUR, "14018 额度耗尽")
    # 2) 必须对齐下一个日边界（本仓本地时区口径的 00:00）
    expect_day_ms, _ = converter._next_day_reset_ms(converter._CREDIT_EXHAUSTED_FALLBACK_HOUR)
    remaining = (entry["resetAtMs"] - converter.time.time() * 1000) / 1000.0
    expect_remaining = (expect_day_ms - converter.time.time() * 1000) / 1000.0
    assert abs(remaining - expect_remaining) < 5, \
        f"14018 兜底应对齐日边界: 实得 {remaining}s 期望 {expect_remaining}s"


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


def test_credit_exhausted_reset_is_next_day_boundary(frozen_evening):
    """额度耗尽的兜底冷却终点必须是次日 00:00（UTC+8），而不是几十分钟。

    注意：本用例只覆盖**兜底**路径（报文无 reset 时）。一旦上游下发 reset，
    `_credit_exhausted_reset` 必须优先采用它（见
    test_credit_exhausted_reset_prefers_upstream_reset）。
    """
    reset_ms, reset_local = converter._credit_exhausted_reset()
    remaining = (reset_ms - converter.time.time() * 1000) / 1000.0
    assert 0 < remaining <= 24 * 3600 + 60
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2} 00:00:00", reset_local)


def test_credit_exhausted_reset_prefers_upstream_reset():
    """上游下发 reset 时必须以它为准（不得被本地兜底墙钟覆盖）。

    本机实测 14018 报文不带 reset（105/105），但一旦上游开始下发，硬编码兜底就会
    变成"过早/过晚恢复"的错误来源 —— 这条用例锁死"reset 优先"的架构决策。
    """
    future = "2031-03-05 17:30:00"
    raw = '{"error":{"data":{"code":14018,"msg":"quota exhausted; 将在 %s UTC+8 重置"}}}' % future
    reset_ms, reset_local = converter._credit_exhausted_reset(raw)
    assert reset_local.endswith("17:30:00"), f"未采用上游 reset: {reset_local}"
    expect_ms = int(datetime.datetime.strptime(future, "%Y-%m-%d %H:%M:%S")
                    .replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
                    .timestamp() * 1000)
    assert reset_ms == expect_ms


def test_soft_rate_phrase_is_not_credit_exhausted():
    """"model usage limit exceeded" 是**模型频控**（上游 ErrSoftRate），不是额度耗尽。

    外部证据（Sliverkiss client_test.go 契约）：{200,code:1,"model usage limit exceeded"}
    → ErrSoftRate；其测试恰以「误判成硬冷却会把有余量账号停到次日」为反例。
    旧实现把 "usage limit exceeded" 放进硬额度词表 → 无顶层码时会误停到次日。
    """
    assert converter._is_credit_exhausted_signal(
        400, '{"msg":"model usage limit exceeded"}') is False
    assert converter._is_credit_exhausted_signal(
        429, '{"msg":"usage limit exceeded"}') is False
    assert converter._is_rate_limit_signal(
        429, '{"msg":"model usage limit exceeded"}') is True


def test_quota_exceeded_still_is_credit_exhausted():
    """反向：`quota exceeded` 上游明确归 ErrHardCredit，必须保留命中（不能连它一起剥掉）。"""
    assert converter._is_credit_exhausted_signal(400, '{"msg":"quota exceeded"}') is True


def test_429_does_not_bypass_authoritative_code():
    """HTTP 429 不得绕过顶层业务码权威（P1-1）。

    实测形态：429 + 顶层 11102（模型不可用）+ 嵌套 details.code=6004。
    旧实现的真值表顶部是 `if status_code == 429: return True`，抢在顶层码仲裁之前命中
    → 这个确定性错误被判成限流 → 触发无谓换号与冷却；而同一报文用 400 下发时判否
    （既有契约 test_rate_limit_regex_must_not_bypass_signal_gate 锁定）——
    同一报文两种状态码两种结论，正是这个 bug 的表现。
    """
    payload = ('{"code":11102,"msg":"model unavailable",'
               '"details":{"code":6004,"msg":"将在 2030-01-01 00:00:00 UTC+8 重置"}}')
    assert converter._is_rate_limit_signal(429, payload) is False, "429 不得绕过顶层码权威"
    assert converter._is_rate_limit_signal(400, payload) is False, "两种状态码必须同结论"
    converter._RATE_LIMIT_STATE.clear()
    converter._record_rate_limit("m-429-bypass", payload, uid="u-good", status_code=429)
    assert "m-429-bypass" not in converter._RATE_LIMIT_STATE, "顶层 11102 不得写假冷却"


def test_429_without_any_code_still_rate_limited():
    """反向（防修过头）：真·429 且报文没有任何可判码/语义 → 仍须判限流。"""
    assert converter._is_rate_limit_signal(429, '{"requestId":"abc-123"}') is True
    assert converter._is_rate_limit_signal(429, "") is True
    assert converter._is_rate_limit_signal(429, "upstream busy") is True


def test_non_numeric_authoritative_code_does_not_veto_semantics():
    """非数字占位码（"unknown"）不得一票否决语义判据（自查补洞）。

    这是 P1-1 修法的**衍生风险**：把 429 降为兜底后，「有顶层码就只看顶层码」这条变得更强，
    于是 ``{"code":"unknown","msg":"rate limit"}`` 会被未知码否决而**漏判限流**（实测复现）。
    口径修正：顶层码必须是**非零数字**才算权威；非数字占位放行给 msg 语义。
    """
    assert converter._is_rate_limit_signal(
        429, '{"code":"unknown","msg":"rate limit"}') is True
    assert converter._is_rate_limit_signal(
        429, '{"code":"unknown"}') is True, "占位码 + 429 仍应兜底判限流"
    assert converter._is_account_fault_signal(
        429, '{"code":"unknown","error":{"data":{"code":14017}}}') is True, "占位码不得挡住嵌套真码"
    # 反向：数字非限流码仍是权威否决（不得因放行非数字码而顺带放行数字码）
    assert converter._is_rate_limit_signal(429, '{"code":11102,"msg":"x"}') is False
    assert converter._is_credit_exhausted_signal(429, '{"code":11102,"msg":"x"}') is False


def test_daily_quota_reset_beyond_two_hours_is_honored():
    """每日额度（6004/6008）的 reset 常远超 2h，必须按上游墙钟而非 2h 封顶（P1-4）。

    本机实测 94 条配对样本：reset 距发生时刻中位 3.67h、最大 18.63h，
    **89.4%（84/94）超过 2h**。旧实现统一封顶 7200s → 账号在额度未恢复时就重新入池
    → 立刻二次撞墙（用户侧表现为"换一圈又全撞限流"）。

    ⚠️ 必须断言**生效冷却**（`monotonic_until`），而不是只断言展示字段 `resetAtMs`：
    `_is_account_cooldown` / `_get_cooldown_reset_ms` 都以 `monotonic_until` 为准，
    只查 `resetAtMs` 会在 2h 封顶仍然存在时误判为通过（本用例初版即踩此坑）。
    """
    converter._RATE_LIMIT_STATE.clear()
    # 构造一个 5.5h 之后才重置的真实形态
    reset_dt = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) \
        + datetime.timedelta(hours=5, minutes=30)
    raw = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 %s UTC+8 重置，您也可以切换其他模型继续使用。"}' % \
        reset_dt.strftime("%Y-%m-%d %H:%M:%S")
    converter._record_rate_limit("m-daily", raw, uid="u1", status_code=400)
    entry = converter._RATE_LIMIT_STATE["m-daily"]
    assert entry["kind"] == "daily_quota", f"6004 应归每日额度: {entry['kind']}"
    # 展示字段：对齐上游墙钟
    remaining = (entry["resetAtMs"] - converter.time.time() * 1000) / 1000.0
    assert 5.4 * 3600 < remaining < 5.6 * 3600, f"resetAtMs 未对齐上游: {remaining}s"
    # 生效字段：真正决定账号何时回到池子的那个
    effective = entry["monotonic_until"] - converter.time.monotonic()
    assert effective > 7200, f"生效冷却被 2h 封顶截断了: {effective}s"
    assert 5.4 * 3600 < effective < 5.6 * 3600, f"生效冷却未对齐上游 reset: {effective}s"


def test_transient_rate_code_keeps_short_cooldown():
    """对照：非每日额度的限流码（6000-6003/6005-6007）无 reset 时仍走短窗。"""
    converter._RATE_LIMIT_STATE.clear()
    converter._record_rate_limit("m-transient", '{"code":6006,"msg":"请求频率过高，请稍后再试"}',
                                 uid="u1", status_code=400)
    entry = converter._RATE_LIMIT_STATE["m-transient"]
    effective = entry["monotonic_until"] - converter.time.monotonic()
    assert 200 < effective < 400, f"瞬时频控不应长冷却: {effective}s"
    assert entry["kind"] == "rate_limit"


@pytest.mark.parametrize("code", [6004, 6008, "6004", "6008"])
def test_daily_quota_without_reset_does_not_reenter_pool_in_5min(code, frozen_evening):
    """**关键契约**：每日额度（6004/6008）**无 reset 时间**时不得退化成 5 分钟软限流。

    这是「分类做了、兜底没跟上」的残留缺口：6004/6008 是 TPD/RPD（按日额度），
    无 reset 时若沿用瞬时频控的 300s±45s，账号 5 分钟后重新入池必然二次撞墙
    （本机 94 条样本的 reset 距发生时刻中位 3.67h、89.4% 超过 2h）。

    契约：6004/6008 + 有 reset → 用 reset；6004/6008 + 无 reset → 日级保守兜底；
          普通 600x + 无 reset → 维持 5min±45s。

    ⚠️ 断言不能写死「> 7200s」：夜里跑时离次日 00:00 天然不足 2h（会假红）。
    正确判据是「冷却终点对齐日边界」，且**不得落在瞬时软窗内**（255s~345s）。
    """
    converter._RATE_LIMIT_STATE.clear()
    raw = '{"code":%s,"msg":"您的使用量已超出频率限制"}' % (
        '"%s"' % code if isinstance(code, str) else code)
    converter._record_rate_limit("m-daily-noreset", raw, uid="u1", status_code=400)
    entry = converter._RATE_LIMIT_STATE["m-daily-noreset"]
    assert entry["kind"] == "daily_quota", f"code {code} 应归每日额度"
    effective = entry["monotonic_until"] - converter.time.monotonic()
    # 1) 明确排除瞬时软窗（含 ±45s 抖动范围）——这才是「二次撞墙」的成因
    _assert_long_cooldown(effective, converter._DAILY_QUOTA_FALLBACK_HOUR, "每日额度无 reset 兜底")
    # 2) 必须对齐到下一个日边界（而非任意长数字）
    expect_day_ms, _ = converter._next_day_reset_ms(converter._DAILY_QUOTA_FALLBACK_HOUR)
    remaining = (entry["resetAtMs"] - converter.time.time() * 1000) / 1000.0
    expect_remaining = (expect_day_ms - converter.time.time() * 1000) / 1000.0
    assert abs(remaining - expect_remaining) < 5, \
        f"应兜底到下一个日边界: 实得 {remaining}s 期望 {expect_remaining}s"
    assert abs(effective - expect_remaining) < 5, "生效冷却与展示字段须同源"


def test_daily_quota_without_reset_and_credit_exhausted_share_day_boundary():
    """每日额度无 reset 的兜底与额度耗尽同口径（同一日边界函数），避免两套魔数。"""
    a = converter._next_day_reset_ms(converter._DAILY_QUOTA_FALLBACK_HOUR)
    b = converter._credit_exhausted_reset("")
    assert a == b, "两处日边界兜底必须一致"


def test_record_rate_limit_credit_exhausted_uses_long_cooldown(monkeypatch, frozen_evening):
    """端到端：14018 记账后冷却必须远超软限流窗口，且封禁落进账号冷却表。

    ⚠️ 同样不得写死「> 3600s」：日边界兜底在 23:00 后天然不足 1h。判据改为
    「排除瞬时软窗 + 与日边界同源」，避免按运行时刻假红。
    """
    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()
    try:
        converter._record_rate_limit("deepseek-v4.1-flash", SAMPLE_14018,
                                     uid="u-empty", status_code=429)
        entry = converter._RATE_LIMIT_STATE["deepseek-v4.1-flash"]
        assert str(entry["code"]) == "14018"
        assert entry["kind"] == "credit_exhausted"
        effective = entry["monotonic_until"] - converter.time.monotonic()
        _assert_long_cooldown(effective, converter._CREDIT_EXHAUSTED_FALLBACK_HOUR, "额度耗尽")
        expect_day_ms, _ = converter._next_day_reset_ms(converter._CREDIT_EXHAUSTED_FALLBACK_HOUR)
        remaining = (entry["resetAtMs"] - converter.time.time() * 1000) / 1000.0
        expect_remaining = (expect_day_ms - converter.time.time() * 1000) / 1000.0
        assert abs(remaining - expect_remaining) < 5, \
            f"额度耗尽应兜底到日边界: 实得 {remaining}s 期望 {expect_remaining}s"
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
        assert entry["kind"] == "rate_limit"
        remaining = (entry["resetAtMs"] - converter.time.time() * 1000) / 1000.0
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
    # 英文 ErrSoftRate 契约措辞同样必须命中（上游 client_test.go 逐条锁定）
    assert converter._is_rate_limit_signal(400, "Your usage limit exceeded") is True
    assert converter._is_rate_limit_signal(400, "rate-limited upstream") is True
    assert converter._is_rate_limit_signal(403, "usage limit reached") is True
    # 反向：不得因此吃裸数字（网关 HTML 页里的 upstream 429）
    assert converter._is_rate_limit_signal(502, "<html>502 Bad Gateway upstream 429</html>") is False


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


def test_14003_is_recognized_as_rate_limit_with_seconds_cooldown():
    """14003（RateLimitError / quota_request_limit）必须识别为限流并走秒级短冷却。

    借鉴 xiaofan6ya/workbuddy2api 事故复盘（commit bc173d82）：
    - 官方 UI：'当前模型请求繁忙，请切换模型或稍后重试'，属模型级瞬时繁忙而非账号额度耗尽；
    - 必须被 _is_rate_limit_signal 正确识别（进入限流码族）；
    - 冷却时间走秒级（15s~25s，默认 20s±5s），避免落入 300s 软限流或 90000s 日级额度导致整池停摆；
    - kind 必须为 request_rate，code 必须为 14003。
    """
    raw = '{"code":14003,"msg":"too many requests","displayMsg":{"zh":"请求过于频繁，请稍后重试。"}}'
    assert converter._is_rate_limit_signal(429, raw) is True
    assert converter._is_rate_limit_signal(400, raw) is True
    assert converter._is_credit_exhausted_signal(429, raw) is False
    assert converter._is_account_fault_signal(429, raw) is False

    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()
    converter._record_rate_limit("deepseek-v4.1-flash", raw, uid="u-test", status_code=429)
    entry = converter._RATE_LIMIT_STATE.get("deepseek-v4.1-flash")
    assert entry is not None
    assert entry["code"] == 14003
    assert entry["kind"] == "request_rate"
    remaining_s = (entry["resetAtMs"] - int(time.time() * 1000)) / 1000.0
    assert 10.0 <= remaining_s <= 35.0, f"14003 冷却应为秒级短窗，实际为 {remaining_s}s"


def test_cooldown_monotonic_deadline_prevents_concurrent_shortening():
    """ChatGPT 对拍 P1-2 契约：冷却截止时间单调递增，并发观测绝不能把冷却写短。
    并发下请求 A 生成 25s 冷却，若后到的请求 B 生成 15s 冷却，
    不得将 A 已经建立的更长冷却覆盖为更短时间。
    """
    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()

    # 1. 第一次记录：设定一个较长的重置时刻（UTC+8 时间字符串）
    t_long_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + 60))
    raw_long = f'{{"code":14003,"msg":"将在 {t_long_str} UTC+8 重置"}}'
    converter._record_rate_limit("deepseek-v4.1-flash", raw_long, uid="u-test", status_code=429)
    first_entry = converter._ACCOUNT_COOLDOWNS.get(("u-test", "deepseek-v4.1-flash"))
    assert first_entry is not None
    first_reset = first_entry["resetAtMs"]
    first_mono = first_entry["monotonic_until"]

    # 2. 第二次记录：并发迟到的观察带了更短的重置时间
    t_short_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + 10))
    raw_short = f'{{"code":14003,"msg":"将在 {t_short_str} UTC+8 重置"}}'
    converter._record_rate_limit("deepseek-v4.1-flash", raw_short, uid="u-test", status_code=429)
    second_entry = converter._ACCOUNT_COOLDOWNS.get(("u-test", "deepseek-v4.1-flash"))
    assert second_entry is not None

    # 断言：必须单调保留更长截止时间，不得被写短
    assert second_entry["resetAtMs"] == first_reset, "resetAtMs 不得被后到更短的观测覆盖"
    assert second_entry["monotonic_until"] >= first_mono, "monotonic_until 不得被缩短"

    converter._RATE_LIMIT_STATE.clear()
    converter._ACCOUNT_COOLDOWNS.clear()





def test_14003_has_independent_lightweight_retry_budget():
    """ChatGPT 对拍 P1-4 契约：14003 模型繁忙具有独立轻量重试预算（上限 1 次），
    即使账号池有 5 个账号，遇到 14003 也绝不进行 5 次重试放大风暴。
    """
    rotator = converter.AccountRotator()
    rotator.mode = "failover"
    # mock 5 个账号
    rotator.get_all_accounts = lambda: [(f"u{i}", {}) for i in range(5)]
    rotator.get_candidate_uids_tiered = lambda m: [f"u{i}" for i in range(5)]
    rotator.cred_mgr = type("CM", (), {
        "switch_active_account": lambda s, u: None,
        "get_headers_for_uid": lambda s, u: {},
        "get_headers": lambda s: {}
    })()

    # 普通账号故障或无错误码：允许最多 5 次换号重试
    assert rotator.get_retry_budget("deepseek-v4.1-flash") == 5

    # 14003 / _REQUEST_RATE_CODES：严格限制为 1 次重试预算
    assert rotator.get_retry_budget("deepseek-v4.1-flash", error_code=14003) == 1
    assert rotator.get_retry_budget("deepseek-v4.1-flash", error_code="14003") == 1

    # request-local 动态阻断验证：
    # 第一次 14003 失败（attempt=0），允许切号 1 次
    res1 = rotator.record_failure_and_failover("u0", "deepseek-v4.1-flash", 429, '{"code":14003}', attempt=0)
    assert res1 is not None, "第 1 次 14003 允许尝试切号"

    # 第二次 14003 失败（attempt=1），严格拒绝切号（达到上限 1 次），切断重试放大
    res2 = rotator.record_failure_and_failover("u1", "deepseek-v4.1-flash", 429, '{"code":14003}', attempt=1)
    assert res2 is None, "第 2 次 14003 必须拒绝切号，严格限制最多重试 1 次"



def test_14003_display_msg_zh_and_http_200_recognized():
    """ChatGPT 对拍 P1-5 契约：displayMsg.zh 语义识别与 HTTP 200/信封识别。
    即使 msg 为空或 code 不在顶层，displayMsg.zh 包含'模型请求繁忙'必须被精准识别为限流。
    """
    raw_display = '{"code":14003,"msg":"","displayMsg":{"zh":"当前模型请求繁忙，请切换模型或稍后重试。"}}'
    assert converter._is_rate_limit_signal(200, raw_display) is True, "HTTP 200 信封下的 14003 必须识别"
    assert converter._is_rate_limit_signal(None, raw_display) is True

    # msg 缺省仅有 displayMsg 文本
    raw_only_display = '{"msg":"","displayMsg":{"zh":"当前模型请求繁忙，请切换模型或稍后重试。"}}'
    assert converter._is_rate_limit_signal(200, raw_only_display) is True


def test_upstream_in_band_error_raw_payload_preserved():
    """ChatGPT 对拍 P1-5 闭环验证：UpstreamInBandError 抛出时保留原始 raw body，
    在 HTTPError 异常捕获中优先提取 e.raw，确保 code: 14003 强类型结构化判定不失真。
    """
    raw_200 = '{"code":14003,"msg":"too many requests"}'
    err = converter.UpstreamInBandError(raw_200, 200)

    # 验证 e.raw 完好保存
    assert getattr(err, "raw", None) == raw_200

    # 验证提取层消费
    extracted = getattr(err, "raw", None) or str(err)
    assert extracted == raw_200
    assert converter._is_rate_limit_signal(200, extracted) is True
    import json
    assert converter._authoritative_code(json.loads(extracted)) == "14003"





