"""
tests/test_settings_hot_reload.py - settings.json 热读（免重启生效）测试

覆盖：
1. load_app_settings() 按 mtime+size 签名缓存，文件未变不重复读盘；
2. 文件变更后热读立即返回新值（免重启核心保证）；
3. settings.json 缺失/损坏时优雅降级，不抛异常、沿用上次配置；
4. _get_rotator() 以 settings.json 为运行时真源，优先于 CLI 参数/环境变量；
5. 非法 rotate_mode 值被归一为 off，避免异常值导致调度错乱。
"""

import json
import os
import time
from pathlib import Path

import pytest

import converter
from converter import AccountRotator, CredentialManager, _get_rotator, load_app_settings


@pytest.fixture
def settings_env(tmp_path, monkeypatch):
    """隔离的 settings.json 环境。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "settings.json"
    # 清空模块级缓存，保证用例隔离
    monkeypatch.setattr(converter, "_settings_sig", (0.0, 0))
    monkeypatch.setattr(converter, "_settings_cache", {})
    monkeypatch.setattr(converter, "_ACCOUNT_ROTATOR", None)
    return f


def _write(path: Path, cfg: dict):
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def test_hot_reload_returns_new_value_without_restart(settings_env):
    """核心保证：文件变更后热读立即拿到新值（无需重启内核）。"""
    f = settings_env
    _write(f, {"rotate_mode": "off", "rotate_count": 1})
    assert load_app_settings()["rotate_mode"] == "off"

    # 模拟 GUI 保存新策略（mtime 必然变化）
    time.sleep(0.02)
    _write(f, {"rotate_mode": "failover", "rotate_count": 3})
    cfg = load_app_settings(force=True)
    assert cfg["rotate_mode"] == "failover"
    assert cfg["rotate_count"] == 3


def test_hot_reload_caches_when_unchanged(settings_env, monkeypatch):
    """文件未变时走缓存，不重复读盘。"""
    f = settings_env
    _write(f, {"rotate_mode": "failover"})
    load_app_settings(force=True)

    calls = {"n": 0}
    orig_read = Path.read_text

    def counting_read_text(self, *a, **kw):
        calls["n"] += 1
        return orig_read(self, *a, **kw)

    monkeypatch.setattr(Path, "read_text", counting_read_text)
    for _ in range(5):
        assert load_app_settings()["rotate_mode"] == "failover"
    assert calls["n"] == 0, "文件签名未变时必须命中缓存，不得重复读盘"


def test_missing_settings_json_degrades_gracefully(settings_env):
    """settings.json 不存在时返回空 dict，不抛异常。"""
    assert settings_env.exists() is False
    assert load_app_settings() == {}


def test_corrupted_settings_json_degrades_gracefully(settings_env):
    """settings.json 损坏（非法 JSON）时不抛异常，沿用上次配置。"""
    f = settings_env
    _write(f, {"rotate_mode": "failover"})
    assert load_app_settings(force=True)["rotate_mode"] == "failover"

    time.sleep(0.02)
    f.write_text("{ 这不是合法 JSON", encoding="utf-8")
    cfg = load_app_settings(force=True)
    assert cfg.get("rotate_mode") == "failover", "损坏时应沿用上次成功读取的配置"


def test_rotator_prefers_hot_settings_over_cli(settings_env, monkeypatch):
    """_get_rotator 以 settings.json 为运行时真源，优先于 CLI/环境变量默认值。"""
    f = settings_env
    monkeypatch.setitem(converter.CONFIG, "cred", None)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "off")   # CLI 默认
    monkeypatch.setitem(converter.CONFIG, "rotate_count", 1)

    _write(f, {"rotate_mode": "roundrobin", "rotate_count": 7})
    r = _get_rotator()
    assert r.mode == "roundrobin", "settings.json 应压过 CLI 默认值"
    assert r.rotate_count == 7


def test_rotator_falls_back_to_cli_when_settings_absent(settings_env, monkeypatch):
    """settings.json 缺失时回退到 CLI 参数，保证行为可预期。"""
    monkeypatch.setitem(converter.CONFIG, "cred", None)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")
    monkeypatch.setitem(converter.CONFIG, "rotate_count", 2)

    r = _get_rotator()
    assert r.mode == "failover"
    assert r.rotate_count == 2


def test_rotator_normalizes_invalid_mode(settings_env, monkeypatch):
    """非法 rotate_mode 值被归一为 off，避免调度错乱。"""
    f = settings_env
    monkeypatch.setitem(converter.CONFIG, "cred", None)
    _write(f, {"rotate_mode": "bogus-mode", "rotate_count": 1})
    r = _get_rotator()
    assert r.mode == "off"


def test_rotator_survives_invalid_rotate_count(settings_env, monkeypatch):
    """rotate_count 非法（非数字/0/负数）时被规整为 >=1 的安全值。"""
    f = settings_env
    monkeypatch.setitem(converter.CONFIG, "cred", None)
    monkeypatch.setitem(converter.CONFIG, "rotate_count", 1)

    _write(f, {"rotate_mode": "roundrobin", "rotate_count": "abc"})
    assert _get_rotator().rotate_count >= 1

    time.sleep(0.02)
    _write(f, {"rotate_mode": "roundrobin", "rotate_count": 0})
    assert _get_rotator().rotate_count >= 1


def test_mode_switch_applies_on_next_request(settings_env, monkeypatch):
    """端到端语义：模式切换后，下一次 _get_rotator() 即返回新模式。"""
    f = settings_env
    monkeypatch.setitem(converter.CONFIG, "cred", None)

    _write(f, {"rotate_mode": "off"})
    assert _get_rotator().mode == "off"

    time.sleep(0.02)
    _write(f, {"rotate_mode": "failover"})
    assert _get_rotator().mode == "failover"

    time.sleep(0.02)
    _write(f, {"rotate_mode": "roundrobin", "rotate_count": 5})
    r = _get_rotator()
    assert r.mode == "roundrobin"
    assert r.rotate_count == 5
