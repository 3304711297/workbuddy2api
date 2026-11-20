"""11140 风控形态细分与全池连坐暂停（2026-11-07 吸收 misakano7545 b494426a）。

核心事实：同一个 code 11140 承载三种语义，混为一谈会两头出错——
  - 内容审核：用户输入问题，不换号、不冷却（既有行为）；
  - 账号风控：上游判在设备/出口上，换号会把整池逐个送进去；
  - 模型限流：可自愈的软限流，不能当成确定性拒绝。

这里钉住四件事：
  ① 三种形态按「code + 文案」双条件分流，不误伤；
  ② 同一 uid 重复命中不凑数，窗口内 ≥2 个不同 uid 才触发全池暂停；
  ③ 账号风控写账号级冷却（uid+model），不影响其他账号；
  ④ 暂停期间三条对话入口快速 503 + Retry-After，其他端点不受影响。
"""
import json
import time

import pytest
from starlette.testclient import TestClient

import converter


RESTRICT_BODY = json.dumps(
    {"code": 11140, "msg": "账号存在异常行为，已被限制使用", "requestId": "aaaabbbb"},
    ensure_ascii=False,
)
UNUSUAL_BODY = json.dumps(
    {"code": 11140, "msg": "Your account shows unusual activity and has been restricted."}
)
MODEL_RATE_BODY = json.dumps(
    {"code": 11140, "msg": "The model provider is rate-limiting requests."}
)
CONTENT_BODY = json.dumps(
    {"code": 11140, "msg": "内容未通过安全审核，请调整后重试"}, ensure_ascii=False
)


@pytest.fixture(autouse=True)
def _clean_state():
    converter._reset_restriction_state()
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS.clear()
        converter._RATE_LIMIT_STATE.clear()
    yield
    converter._reset_restriction_state()
    with converter._RATE_LIMIT_LOCK:
        converter._ACCOUNT_COOLDOWNS.clear()
        converter._RATE_LIMIT_STATE.clear()


# ---------------------------------------------------------------------------
# ① 三种形态分流
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body", [RESTRICT_BODY, UNUSUAL_BODY])
def test_account_restriction_requires_code_and_wording(body):
    assert converter._classify_11140(403, body) == "account_restricted"
    assert converter._is_account_restriction(403, body) is True
    assert converter._is_content_policy_violation(403, body) is False


def test_content_review_stays_content():
    assert converter._classify_11140(400, CONTENT_BODY) == "content"
    assert converter._is_content_policy_violation(400, CONTENT_BODY) is True
    assert converter._is_account_restriction(400, CONTENT_BODY) is False


def test_request_illegal_keeps_legacy_content_semantics():
    """本仓历史实测 request illegal 属内容审核；不被下游另一条抓包口径改写。"""
    body = json.dumps({"code": 11140, "msg": "request illegal"})
    assert converter._classify_11140(400, body) == "content"


def test_model_rate_limiting_is_not_content_review():
    """同一 code 承载的模型限流：旧实现只按 code 判，会误当确定性拒绝。"""
    assert converter._classify_11140(429, MODEL_RATE_BODY) == "model_rate"
    assert converter._is_content_policy_violation(429, MODEL_RATE_BODY) is False
    assert converter._is_account_restriction(429, MODEL_RATE_BODY) is False


def test_other_business_code_is_never_reclassified_as_11140():
    other = json.dumps({"code": 6004, "msg": "账号存在异常行为"})
    assert converter._classify_11140(429, other) == ""
    assert converter._is_content_policy_violation(429, other) is False


def test_wording_without_code_is_not_account_restriction():
    """只有文案没有 11140 码：可能是别的业务码 / 普通正文，不得判账号受限。"""
    assert converter._classify_11140(403, "账号存在异常行为，已被限制使用") == ""
    assert converter._is_account_restriction(403, "账号存在异常行为，已被限制使用") is False


# ---------------------------------------------------------------------------
# ② 连坐状态机
# ---------------------------------------------------------------------------

def test_single_account_does_not_trigger_hold():
    assert converter._note_account_restriction("u1") == 0.0
    assert converter._note_account_restriction("u1") == 0.0, "同一 uid 重复命中不得凑数"
    assert converter._restriction_hold_remaining() == 0.0


def test_two_distinct_accounts_trigger_hold():
    assert converter._note_account_restriction("u1") == 0.0
    hold = converter._note_account_restriction("u2")
    assert hold > 0
    remain = converter._restriction_hold_remaining()
    # 默认调用路径等价「单域即全池」：首次暂停必须是短暂停，不是 30 分钟账号级冷却
    assert 0 < remain <= converter._RESTRICTION_PAUSE_BASE_SEC


def test_reset_clears_hold():
    converter._note_account_restriction("u1")
    converter._note_account_restriction("u2")
    assert converter._restriction_hold_remaining() > 0
    converter._reset_restriction_state()
    assert converter._restriction_hold_remaining() == 0.0


# ---------------------------------------------------------------------------
# ③ 账号级冷却
# ---------------------------------------------------------------------------

def test_restriction_writes_account_cooldown_only_for_that_account():
    converter._record_account_restriction("u1", "glm-5.2", RESTRICT_BODY)
    assert converter._is_account_cooldown("u1", "glm-5.2") is True
    assert converter._is_account_cooldown("u2", "glm-5.2") is False
    # 不写模型级观测面，避免面板把「一个号被限制」显示成「整个模型冷却」
    assert "glm-5.2" not in converter._RATE_LIMIT_STATE
    entry = converter._ACCOUNT_COOLDOWNS[("u1", "glm-5.2")]
    assert entry["kind"] == "account_restricted"
    assert entry["code"] == 11140


# ---------------------------------------------------------------------------
# ④ 暂停期间快速失败
# ---------------------------------------------------------------------------

def _activate_hold():
    converter._note_account_restriction("u1")
    converter._note_account_restriction("u2")
    assert converter._restriction_hold_remaining() > 0


def test_chat_is_503_during_hold_with_openai_shape():
    _activate_hold()
    client = TestClient(converter.app)
    res = client.post("/v1/chat/completions", json={"model": "glm-5.2", "messages": []})
    assert res.status_code == 503
    assert res.headers.get("retry-after")
    assert res.headers.get("x-workbuddy-restriction-hold") == "1"
    payload = res.json()
    assert payload["error"]["code"] == "account_restricted_hold"
    assert "11140" in payload["error"]["message"]


def test_messages_is_503_with_anthropic_shape():
    _activate_hold()
    client = TestClient(converter.app)
    res = client.post("/v1/messages", json={"model": "glm-5.2", "messages": []})
    assert res.status_code == 503
    payload = res.json()
    assert payload["type"] == "error"
    assert payload["error"]["type"] == "api_error"


def test_health_is_not_blocked_by_hold():
    _activate_hold()
    client = TestClient(converter.app)
    # Host 必须是回环，否则会先被 LocalHostOnlyMiddleware 以 403 拦掉（与 hold 无关）
    res = client.get("/health", headers={"Host": "127.0.0.1"})
    assert res.status_code == 200


# ---------------------------------------------------------------------------
# ⑤ 小步退避 + 阈值按池规模缩放 + 按域分桶（issue #46 吸收上游 de24d38f/d3edea90）
#
# 事故背景：固定「2 个号 → 全池停 30 分钟」在 340 号池上造成连续停派、4,036 条请求
# 503；且单一全局闸让 CN 扫荡把 global 账号一起停掉。新语义：
#   - 阈值 = max(2, 本域健康号 // 10)；
#   - 首次暂停 30s，连续触发 2 倍退避至 600s，平静 30 分钟清零 streak；
#   - 状态按 realm（cn/global）分桶，只有所有域都被暂停时才落下全池闸；
#   - `_RESTRICTION_HOLD_SEC` 仍是账号级 30 分钟冷却（语义不得混用）。
# ---------------------------------------------------------------------------

def _restrict(uid, realm="cn", pool=4, known=("cn",)):
    return converter._note_account_restriction(
        uid, realm, realm_pool_size=pool, known_realms=known
    )


def test_first_pause_is_short_not_thirty_minutes():
    assert _restrict("u1", pool=4) == 0.0
    first = _restrict("u2", pool=4)
    assert first == converter._RESTRICTION_PAUSE_BASE_SEC
    remain = converter._restriction_pause_remaining("cn")
    assert 0 < remain <= converter._RESTRICTION_PAUSE_BASE_SEC


def test_consecutive_pauses_double_until_cap():
    pauses = []
    for i in range(8):
        _restrict(f"a{i}", pool=4)
        pauses.append(_restrict(f"b{i}", pool=4))
    assert pauses[0] == converter._RESTRICTION_PAUSE_BASE_SEC
    assert pauses[1] == converter._RESTRICTION_PAUSE_BASE_SEC * 2
    assert max(pauses) == converter._RESTRICTION_PAUSE_MAX_SEC
    assert pauses == sorted(pauses), "退避必须单调不减"


def test_threshold_scales_with_realm_pool_size():
    """340 号池：阈值是 34，不是 2 —— 两个号撞限制不得把整池停掉。"""
    _restrict("u1", pool=340)
    assert _restrict("u2", pool=340) == 0.0
    assert converter._restriction_pause_remaining("cn") == 0.0
    for i in range(3, 35):  # u1..u34 = 34 个不同账号
        _restrict(f"u{i}", pool=340)
    assert converter._restriction_pause_remaining("cn") > 0


def test_threshold_never_below_two_on_tiny_pool():
    assert _restrict("u1", pool=1) == 0.0
    assert _restrict("u2", pool=1) > 0


def test_calm_period_resets_backoff_streak():
    _restrict("u1", pool=4)
    assert _restrict("u2", pool=4) == converter._RESTRICTION_PAUSE_BASE_SEC
    bucket = converter._RESTRICTION_BUCKETS["cn"]
    bucket["last_trigger"] -= converter._RESTRICTION_CALM_RESET_SEC + 1
    bucket["hold_until"] = 0.0
    _restrict("u3", pool=4)
    assert _restrict("u4", pool=4) == converter._RESTRICTION_PAUSE_BASE_SEC


def test_cn_sweep_does_not_pause_global_realm():
    known = ("cn", "global")
    _restrict("c1", pool=10, known=known)
    _restrict("c2", pool=10, known=known)
    assert converter._restriction_pause_remaining("cn") > 0
    assert converter._restriction_pause_remaining("global") == 0.0
    # 全池闸未落下：中间件不得把 global 请求也 503 掉
    assert converter._restriction_hold_remaining() == 0.0
    client = TestClient(converter.app)
    res = client.post("/v1/messages", json={"model": "glm-5.2", "messages": []})
    assert res.status_code != 503


def test_whole_pool_gate_drops_only_when_every_realm_is_paused():
    known = ("cn", "global")
    _restrict("c1", pool=10, known=known)
    _restrict("c2", pool=10, known=known)
    assert converter._restriction_hold_remaining() == 0.0
    _restrict("g1", "global", pool=10, known=known)
    _restrict("g2", "global", pool=10, known=known)
    assert converter._restriction_pause_remaining("global") > 0
    assert 0 < converter._restriction_hold_remaining() <= converter._RESTRICTION_PAUSE_MAX_SEC


def test_restriction_scope_buckets_accounts_by_realm():
    accounts = [
        ("g1", {"auth": {"realm": "global"}}),
        ("g2", {"auth": {"domain": "www.workbuddy.ai"}}),
        ("c1", {"auth": {"domain": "copilot.tencent.com"}}),
    ]
    realm, healthy, known = converter._restriction_scope_for_accounts(accounts, "g1")
    assert realm == "global"
    assert known == ("cn", "global")
    assert healthy == 2
    realm, healthy, known = converter._restriction_scope_for_accounts(accounts, "c1")
    assert (realm, healthy) == ("cn", 1)
    # uid 不在池里时保守归 CN（与 _backend_for_auth 的国内站兜底一致）
    assert converter._restriction_scope_for_accounts(accounts, "missing")[0] == "cn"


def test_restriction_scope_excludes_cooled_accounts_from_healthy_count():
    converter._record_account_restriction("c1", "glm-5.2", RESTRICT_BODY)
    accounts = [
        ("c1", {"auth": {"domain": "copilot.tencent.com"}}),
        ("c2", {"auth": {"domain": "copilot.tencent.com"}}),
    ]
    realm, healthy, _ = converter._restriction_scope_for_accounts(
        accounts, "c2", model="glm-5.2"
    )
    assert (realm, healthy) == ("cn", 1)


def test_failover_routes_restriction_into_account_realm_bucket():
    class _FakeCredMgr:
        def __init__(self, accounts):
            self._accounts = accounts

        def list_all_accounts(self):
            return self._accounts

    accounts = [
        ("c1", {"auth": {"domain": "copilot.tencent.com"}}),
        ("c2", {"auth": {"domain": "copilot.tencent.com"}}),
        ("g1", {"auth": {"realm": "global"}}),
        ("g2", {"auth": {"realm": "global"}}),
    ]
    rotator = converter.AccountRotator(_FakeCredMgr(accounts), mode="failover")
    assert rotator.record_failure_and_failover("c1", "glm-5.2", 403, RESTRICT_BODY) is None
    assert rotator.record_failure_and_failover("c2", "glm-5.2", 403, RESTRICT_BODY) is None
    assert converter._restriction_pause_remaining("cn") > 0
    assert converter._restriction_pause_remaining("global") == 0.0
    assert converter._restriction_hold_remaining() == 0.0


def test_account_cooldown_keeps_thirty_minutes_hard_constraint():
    """`_RESTRICTION_HOLD_SEC` 是账号级冷却（1800s），不得被全池暂停改革挪用。"""
    assert converter._RESTRICTION_HOLD_SEC == 1800.0
    converter._record_account_restriction("u1", "glm-5.2", RESTRICT_BODY)
    entry = converter._ACCOUNT_COOLDOWNS[("u1", "glm-5.2")]
    remain = entry["monotonic_until"] - time.monotonic()
    assert 1700 < remain <= 1800


def test_reset_clears_realm_buckets():
    _restrict("u1", pool=4)
    _restrict("u2", pool=4)
    converter._reset_restriction_state()
    assert converter._restriction_pause_remaining("cn") == 0.0
    assert converter._restriction_hold_remaining() == 0.0
    assert converter._RESTRICTION_BUCKETS == {}
