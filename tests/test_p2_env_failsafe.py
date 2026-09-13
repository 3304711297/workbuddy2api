"""P2 启动 robustness：环境变量数值解析失败回退默认，不再崩进程。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


def test_env_float_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("WORKBUDDY2API_MAX_BODY_MB", "abc")
    assert converter._env_float("MAX_BODY_MB", 16.0) == 16.0


def test_env_int_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("WORKBUDDY2API_ROTATE_COUNT", "zzz")
    assert converter._env_int("ROTATE_COUNT", 1) == 1


def test_env_values_still_parse(monkeypatch):
    monkeypatch.setenv("WORKBUDDY2API_MAX_BODY_MB", "32")
    monkeypatch.setenv("WORKBUDDY2API_ROTATE_COUNT", "3")
    assert converter._env_float("MAX_BODY_MB", 16.0) == 32.0
    assert converter._env_int("ROTATE_COUNT", 1) == 3


def test_safe_int_passthrough_and_fallback():
    assert converter._safe_int(3, 1) == 3
    assert converter._safe_int("7", 1) == 7
    assert converter._safe_int("x", 1) == 1
    assert converter._safe_int(None, 1) == 1
    assert converter._safe_float(None, 2.5) == 2.5
