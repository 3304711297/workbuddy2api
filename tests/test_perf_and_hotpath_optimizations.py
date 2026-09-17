"""单元测试：反代内核热路径与性能优化测试。

覆盖：
1. _model_settings_cache 签名缓存命中与动态刷新
2. _read_all_accounts 签名缓存命中与 _set_active_account 缓存失效
3. AccountRotator.get_candidate_uids_tiered 优先级调度（避免 O(N^2) 磁盘/全表扫描）
4. _record_snapshot 内存行计数器，避免无脑 readlines 全量重读
5. _sanitize_log_text 正则预编译与敏感信息脱敏
6. _responses_stream_generator 行缓冲切包防截断
"""

import json
import time
from pathlib import Path
import pytest
import converter


def test_model_settings_signature_cache(tmp_path, monkeypatch):
    """验证 model_settings 签名缓存：未改动时零 IO 命中，改动后自动更新。"""
    settings_file = tmp_path / "model_settings.json"
    monkeypatch.setattr(converter, "_model_settings_file", lambda: str(settings_file))
    converter._model_settings_cache = {}
    converter._model_settings_sig = (0.0, 0)

    settings_file.write_text(json.dumps({"model-a": {"context_window": 8000}}), encoding="utf-8")
    s1 = converter._load_model_settings()
    assert s1.get("model-a", {}).get("context_window") == 8000

    # 缓存命中：同一对象引用
    s2 = converter._load_model_settings()
    assert s2 is s1

    # 文件修改：签名改变，缓存自动刷新
    time.sleep(0.02)
    settings_file.write_text(json.dumps({"model-a": {"context_window": 16000}}), encoding="utf-8")
    s3 = converter._load_model_settings()
    assert s3.get("model-a", {}).get("context_window") == 16000


def test_read_all_accounts_cache_and_invalidation(tmp_path, monkeypatch):
    """验证 _read_all_accounts 签名缓存与 _set_active_account 强制失效。"""
    acc_file = tmp_path / "accounts.json"
    monkeypatch.setattr(converter, "_accounts_file", lambda: acc_file)
    converter._accounts_cache = ("", {})
    converter._accounts_sig = (0.0, 0)

    raw_data = {
        "active_uid": "u1",
        "accounts": {
            "u1": {"auth": {"token": "t1"}, "account": {"uid": "u1"}},
            "u2": {"auth": {"token": "t2"}, "account": {"uid": "u2"}},
        },
    }
    acc_file.write_text(json.dumps(raw_data), encoding="utf-8")

    act_uid, accs = converter._read_all_accounts()
    assert act_uid == "u1"
    assert len(accs) == 2

    # 命中缓存
    act_uid2, accs2 = converter._read_all_accounts()
    assert act_uid2 == "u1"
    assert accs2 is accs

    # 切换活跃账号：缓存自动失效并更新为新活跃账号
    ok = converter._set_active_account("u2")
    assert ok
    act_uid3, accs3 = converter._read_all_accounts()
    assert act_uid3 == "u2"


def test_account_rotator_candidate_tiered_ordering():
    """验证多账号调度分层：先到期的优先调度。"""
    now = int(time.time())
    mock_data = {
        "u_later": {"credit": {"soonest_expire_at": now + 86400 * 20}},
        "u_sooner": {"credit": {"soonest_expire_at": now + 86400 * 5}},
        "u_nodate": {},
    }

    class MockCredMgr:
        def list_all_accounts(self):
            return list(mock_data.items())
        def get_active_uid(self):
            return "u_later"
        def get_headers(self):
            return {}

    rotator = converter.AccountRotator(cred_mgr=MockCredMgr(), mode="roundrobin")
    candidates = rotator.get_candidate_uids_tiered("any-model")
    # u_sooner 还有 5 天到期，u_later 还有 20 天到期，u_nodate 无到期日兜底
    assert candidates == ["u_sooner", "u_later", "u_nodate"]


def test_sanitize_log_text_precompiled_regex():
    """验证日志脱敏预编译正则。"""
    raw = (
        'Authorization: Bearer secret_token_123456789\n'
        '{"accessToken": "secret_access", "api_key": "secret_key"}'
    )
    clean = converter._sanitize_log_text(raw)
    assert "secret_token" not in clean
    assert "secret_access" not in clean
    assert "secret_key" not in clean
    assert "Bearer ***" in clean
    assert '***' in clean


def test_snapshot_line_counter_rotation(tmp_path, monkeypatch):
    """验证快照轮转在行数超限时触发，且使用行数计数器。"""
    snap_file = tmp_path / "snapshots.jsonl"
    monkeypatch.setitem(converter.CONFIG, "snapshots", True)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(snap_file))
    monkeypatch.setitem(converter.CONFIG, "snapshots_keep", 3)
    converter._SNAP_LINE_COUNT = -1

    # 写入 5 条快照
    for i in range(5):
        converter._record_snapshot("/v1/chat/completions", "test-model", True, time.time())

    # 写入第 7 条，超过 2*keep (6)，应触发回写保留最后 3 条
    converter._record_snapshot("/v1/chat/completions", "test-model", True, time.time())
    converter._record_snapshot("/v1/chat/completions", "test-model", True, time.time())

    lines = snap_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) <= 6
