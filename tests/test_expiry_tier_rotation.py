"""
tests/test_expiry_tier_rotation.py - 按积分到期日分层选号测试

借鉴 momo0410/workbuddy-switch-gateway 的核心创新设计：
两级调度策略：
1. 到期分层：优先消耗最快过期的额度（日粒度分组），避免资产过期作废；
2. 档内分摊：同一天到期的账号平均分摊；
3. 未知到期日：作为兜底档排在最后。
"""

import time
import pytest
from converter import AccountRotator, _parse_expiry_timestamp


class FakeCredManager:
    def __init__(self, accounts_dict, active_uid="uid-1"):
        self.accounts = accounts_dict
        self.active_uid = active_uid

    def list_all_accounts(self):
        return list(self.accounts.items())

    def get_active_uid(self):
        return self.active_uid

    def switch_active_account(self, uid):
        self.active_uid = uid
        return True

    def get_headers_for_uid(self, uid):
        return {"X-Account-Uid": uid}

    def get_headers(self):
        return {"X-Account-Uid": self.active_uid}


def test_parse_expiry_timestamp():
    """测试多源到期时间解析（支持 epoch 秒、毫秒、常见时间字符串与纯日期）。"""
    # 1. 秒级 epoch
    assert _parse_expiry_timestamp(1789111518) == 1789111518
    # 2. 毫秒级 epoch (> 1e12) -> 转秒
    assert _parse_expiry_timestamp(1789111518000) == 1789111518
    # 3. 字符串数字
    assert _parse_expiry_timestamp("1789111518") == 1789111518
    # 4. 标准时间格式
    ts = _parse_expiry_timestamp("2026-09-15 12:00:00")
    assert ts > 0
    # 5. 空或无效
    assert _parse_expiry_timestamp(None) == 0
    assert _parse_expiry_timestamp("") == 0
    assert _parse_expiry_timestamp("invalid") == 0


def test_candidate_uids_tiered_ordering():
    """验证按到期日分层排序规则：最近到期 > 较晚到期 > 未知到期。"""
    now = int(time.time())
    tomorrow_noon = now + 86400
    next_week = now + 86400 * 7

    accounts = {
        "uid-later": {"credit": {"expire_at": next_week}},
        "uid-unknown": {},
        "uid-soon": {"credit": {"expire_at": tomorrow_noon}},
    }
    cred_mgr = FakeCredManager(accounts, active_uid="uid-later")
    rotator = AccountRotator(cred_mgr=cred_mgr, mode="roundrobin")

    tiered = rotator.get_candidate_uids_tiered("deepseek-v4-pro")
    # 最早到期的 uid-soon 必须排在首位
    assert tiered[0] == "uid-soon"
    # 稍后到期的 uid-later 排第二
    assert tiered[1] == "uid-later"
    # 未知到期的 uid-unknown 垫底
    assert tiered[2] == "uid-unknown"


def test_failover_selects_soonest_expiry():
    """在限流避让时，应优先切换至最早到期的可用账号。"""
    now = int(time.time())
    accounts = {
        "uid-active": {"credit": {"expire_at": now + 86400 * 10}},
        "uid-expiring-soon": {"credit": {"expire_at": now + 86400}},
        "uid-expiring-later": {"credit": {"expire_at": now + 86400 * 5}},
    }
    cred_mgr = FakeCredManager(accounts, active_uid="uid-active")
    rotator = AccountRotator(cred_mgr=cred_mgr, mode="failover")

    # 触发当前账号限流切换
    failover = rotator.record_failure_and_failover("uid-active", "glm-5.2", 429, "Too Many Requests")
    assert failover is not None
    new_uid, _ = failover
    # 必须首先切到快要过期的账号，优先烧掉它
    assert new_uid == "uid-expiring-soon"
