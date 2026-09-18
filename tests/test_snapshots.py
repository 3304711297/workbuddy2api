"""Task 1: 内核快照记录器。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter


def _enable(monkeypatch, tmp_path, keep=5):
    """一律经 monkeypatch 改写全局 CONFIG（用例结束自动还原）。

    直接赋值不还原会把 snapshots/keep/log 泄漏给后续用例与测试文件，
    造成顺序相关的假红/假绿，违反 AGENTS.md 的测试数据隔离铁律。
    """
    p = tmp_path / "snapshots.jsonl"
    monkeypatch.setitem(converter.CONFIG, "snapshots", True)
    monkeypatch.setitem(converter.CONFIG, "snapshots_keep", keep)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(p))
    return p


def test_default_on_writes(tmp_path, monkeypatch):
    # 默认开启：不显式设开关即落盘
    monkeypatch.setitem(converter.CONFIG, "snapshots", True)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(tmp_path / "s.jsonl"))
    assert converter._record_snapshot("/v1/chat/completions", "m", True, 0.0,
                                       request_body={"a": 1}) is not None
    assert (tmp_path / "s.jsonl").exists()


def test_explicit_off_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "snapshots", False)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(tmp_path / "s.jsonl"))
    assert converter._record_snapshot("/v1/chat/completions", "m", True, 0.0,
                                       request_body={"a": 1}) is None
    assert not (tmp_path / "s.jsonl").exists()


def test_record_shape_and_sanitized(tmp_path, monkeypatch):
    p = _enable(monkeypatch, tmp_path)
    sid = converter._record_snapshot(
        "/v1/messages", "deepseek-v4.1-flash", False, 0.0,
        request_body={"model": "m", "key": "Bearer sk-12345678"},
        response_excerpt="boom", error="HTTP 400 bad", replay=False)
    assert sid
    rec = json.loads(p.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert rec["endpoint"] == "/v1/messages"
    assert rec["ok"] is False
    assert rec["id"] == sid
    assert "sk-12345678" not in json.dumps(rec, ensure_ascii=False)
    assert rec["error"].startswith("HTTP 400")


def test_rotation_caps_lines(tmp_path, monkeypatch):
    p = _enable(monkeypatch, tmp_path, keep=5)
    for i in range(14):
        converter._record_snapshot("/v1/chat/completions", "m", True, 0.0,
                                    request_body={"i": i})
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) <= 10
    assert json.loads(lines[-1])["req"]["i"] == 13


def test_config_defaults_snapshot_on_keep_200():
    # 拍板锁定：默认开、留 200（读进程启动时的默认值，不碰运行时开关）
    import importlib
    import converter as conv
    importlib.reload(conv)
    try:
        assert conv.CONFIG["snapshots"] is True
        assert conv.CONFIG["snapshots_keep"] == 200
    finally:
        importlib.reload(conv)
