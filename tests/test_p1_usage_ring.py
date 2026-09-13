"""P1 性能回归：用量聚合内存化（ring + 文件增量同步）。

_rolling_usage 每次全量读 usage.jsonl；改为内存 ring 聚合，
文件只做持久化与外部写入同步（stat + 尾部增量读）。
"""

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


@pytest.fixture()
def usage_file(tmp_path, monkeypatch):
    p = tmp_path / "usage.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(p))
    monkeypatch.setattr(converter, "_USAGE_RING_SOURCE", None)
    converter._USAGE_RING.clear()
    monkeypatch.setattr(converter, "_USAGE_RING_POS", 0)
    yield p
    monkeypatch.setattr(converter, "_USAGE_RING_SOURCE", None)
    converter._USAGE_RING.clear()
    monkeypatch.setattr(converter, "_USAGE_RING_POS", 0)


def _line(ts_ms, model="hy4-preview", ok=True, i=100, o=200, error=None):
    import json
    rec = {"ts": ts_ms, "model": model, "ok": ok,
           "input_tokens": i, "output_tokens": o, "error": error}
    return json.dumps(rec, ensure_ascii=False)


def test_rolling_usage_survives_file_delete(usage_file):
    now_ms = int(time.time() * 1000)
    usage_file.write_text(_line(now_ms) + "\n", encoding="utf-8")
    first = converter._rolling_usage("hy4-preview")
    assert first["reqsToday"] == 1
    usage_file.unlink()  # 文件没了（轮转/误删），内存聚合必须还在
    second = converter._rolling_usage("hy4-preview")
    assert second["reqsToday"] == 1
    assert second["tokensToday"] == 300


def test_rolling_usage_no_rescan_when_file_unchanged(usage_file, monkeypatch):
    now_ms = int(time.time() * 1000)
    usage_file.write_text(_line(now_ms) + "\n", encoding="utf-8")
    assert converter._rolling_usage("hy4-preview")["reqsToday"] == 1
    import builtins
    real_open = builtins.open

    def _boom(*a, **k):
        raise AssertionError("文件未变化时不得重新打开 usage.jsonl")

    monkeypatch.setattr(builtins, "open", _boom)
    try:
        assert converter._rolling_usage("hy4-preview")["reqsToday"] == 1
    finally:
        monkeypatch.setattr(builtins, "open", real_open)


def test_record_usage_visible_after_file_gone(usage_file):
    converter._record_usage("hy4-preview", True, 0.0, input_tokens=10, output_tokens=25)
    usage_file.unlink()
    ru = converter._rolling_usage("hy4-preview")
    assert ru["reqsToday"] == 1
    assert ru["tokensToday"] == 35
