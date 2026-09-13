"""P3 backlog A: pacer hot-reload + per-model interval default on."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402
from request_pacer import RequestPacer


def test_pacer_sync_updates_limits():
    pacer = RequestPacer(max_concurrency=5, min_interval_ms=50.0)
    assert pacer.by_model is False
    pacer.sync_limits(min_interval_ms=200.0, by_model=True)
    assert pacer.min_interval_ms == 200.0
    assert pacer.by_model is True
    pacer.sync_limits()
    assert pacer.min_interval_ms == 200.0


def _fresh_pacer(monkeypatch):
    p = RequestPacer(max_concurrency=5, min_interval_ms=50.0)
    monkeypatch.setattr(converter, "_REQUEST_PACER", p)
    return p


def test_get_pacer_by_model_default_on(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    _fresh_pacer(monkeypatch)
    pacer = converter._get_pacer()
    assert pacer.by_model is True


def test_get_pacer_hot_reads_settings(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    (d / "settings.json").write_text(json.dumps(
        {"pacer_by_model": False, "pacer_min_interval_ms": 10}))
    _fresh_pacer(monkeypatch)
    pacer = converter._get_pacer()
    assert pacer.by_model is False
    assert pacer.min_interval_ms == 10.0
