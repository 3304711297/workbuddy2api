"""R1: --snapshots/--no-snapshots/--snapshots-keep 必须真正落到 CONFIG。"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter


def _args(snapshots=None, keep=None):
    return types.SimpleNamespace(snapshots=snapshots, snapshots_keep=keep)


def test_no_snapshots_disables():
    snap, keep = converter._snapshot_settings_from_args(_args(snapshots=False, keep=500))
    assert snap is False
    assert keep == 500


def test_snapshots_enables_with_keep():
    snap, keep = converter._snapshot_settings_from_args(_args(snapshots=True, keep=50))
    assert snap is True
    assert keep == 50


def test_unset_falls_back_to_env_defaults(monkeypatch):
    monkeypatch.delenv("WORKBUDDY2API_SNAPSHOTS", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_SNAPSHOTS", raising=False)
    monkeypatch.delenv("WORKBUDDY2API_SNAPSHOTS_KEEP", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_SNAPSHOTS_KEEP", raising=False)
    snap, keep = converter._snapshot_settings_from_args(_args())
    assert snap is True
    assert keep == 200
