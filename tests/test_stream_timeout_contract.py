import os
import httpx
import pytest
import converter


def test_shared_timeout_safe_for_extended_thinking():
    """验证共享分段超时参数能够容纳长思考模型（DeepSeek R1/o1等），read 不能是脆弱的 60s。"""
    timeout = converter._SHARED_TIMEOUT_DEFAULT
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.connect == 5.0
    # 架构评审结论：read 必须 >= 300s（5分钟），避免长思考静默期被 httpx 误杀
    assert timeout.read is not None and timeout.read >= 300.0, f"read timeout {timeout.read}s 过短，长思考模型会遭遇 ReadTimeout 假死"
    assert timeout.write is not None and timeout.write >= 30.0, f"write timeout {timeout.write}s 过短，大上下文写入会遭遇 WriteTimeout"
    assert timeout.pool is not None and timeout.pool >= 10.0, f"pool timeout {timeout.pool}s 过短，并发慢请求挤占会造成 PoolTimeout"


def test_shared_timeout_env_override(monkeypatch):
    """验证可通过环境变量动态调整流式读超时。"""
    monkeypatch.setenv("WORKBUDDY2API_STREAM_READ_TIMEOUT", "450")
    t = converter._get_default_shared_timeout()
    assert t.read == 450.0
    assert t.connect == 5.0
    assert t.write == 30.0
    assert t.pool == 10.0


def test_rate_limit_cooldown_has_decorrelated_jitter():
    """验证默认限流冷却时间包含随机去相关抖动，避免多请求在精确同一毫秒二次惊群。"""
    resets = []
    for i in range(10):
        converter._record_rate_limit("test-jitter-model", "rate limited: 429", uid=f"uj-{i}", status_code=429)
        with converter._RATE_LIMIT_LOCK:
            entry = converter._ACCOUNT_COOLDOWNS.get((f"uj-{i}", "test-jitter-model"))
            if entry:
                resets.append(entry["resetAtMs"])
    assert len(set(resets)) > 1, "冷却时间未注入随机抖动，可能产生惊群重试碰撞"


class _MockMultiCredMgr:
    def __init__(self, accounts):
        self.accounts = accounts
        self.active_uid = accounts[0][0]

    def list_all_accounts(self):
        return self.accounts

    def get_active_uid(self):
        return self.active_uid

    def switch_active_account(self, uid):
        self.active_uid = uid

    def get_headers(self):
        return {"Authorization": f"Bearer {self.active_uid}"}

    def get_headers_for_uid(self, uid):
        return {"Authorization": f"Bearer {uid}"}


def test_failover_distributes_among_top_tier_candidates():
    """验证在同到期日有多账号可用时，failover 切号能平摊调度，而不是所有人永远冲向单一账号。"""
    accs = [
        ("acc-1", {"credit": {"expire_at": 1893456000}}),
        ("acc-2", {"credit": {"expire_at": 1893456000}}),
        ("acc-3", {"credit": {"expire_at": 1893456000}}),
    ]
    mgr = _MockMultiCredMgr(accs)
    rotator = converter.AccountRotator(cred_mgr=mgr, mode="failover")
    
    picked_uids = []
    for _ in range(4):
        res = rotator.record_failure_and_failover("acc-1", "test-m", 429, "rate limited")
        if res:
            picked_uids.append(res[0])
            
    assert "acc-2" in picked_uids
    assert "acc-3" in picked_uids
