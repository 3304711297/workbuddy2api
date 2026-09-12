"""
tests/test_model_availability.py - 模型可用性感知（运行时学习 + 预标记 + 清单模式）

覆盖：
1. _normalize_list_mode()：非法值归一为 all，合法值透传；
2. _mark_model_unavailable()：运行时学习写入 model_availability.json（per-uid），幂等去重；
3. _mark_model_available()：成功调用覆盖不可用记录（套餐升级后可恢复）；
4. _load_availability()：损坏文件降级为空映射，不抛异常；
5. _effective_unavailable()：预标记兜底，运行时证据（200/11102）优先；
6. /v1/models 清单两种模式端到端：all 全量带 availability 字段；available 剔除不可用。
7. test_premarked_covers_all_gpt_fallback_keys：三真源对拍（独立校验器）。
"""

import json
import sys
import time
from pathlib import Path

import pytest

import converter
from converter import (
    _effective_unavailable,
    _load_availability,
    _mark_model_available,
    _mark_model_unavailable,
    _normalize_list_mode,
)

# 三真源对拍校验器（scripts/check_premarked_sync.py，CI 亦直接调用）
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))
from check_premarked_sync import collect_problems as _collect_premarked_problems


def _check_premarked_sync() -> int:
    """CLI 脚本的测试壳：0=同步，1=漂移（漂移明细打印到 pytest 输出）。"""
    problems = _collect_premarked_problems(
        (_REPO_ROOT / "converter.py").read_text(encoding="utf-8"),
        (_REPO_ROOT / "src-tauri" / "src" / "commands" / "billing.rs").read_text(encoding="utf-8"),
    )
    for p in problems:
        print(f"  - {p}")
    return 1 if problems else 0


# ── 纯函数：模式归一 ──────────────────────────────────────────────

def test_normalize_list_mode_accepts_known_values():
    assert _normalize_list_mode("all") == "all"
    assert _normalize_list_mode("available") == "available"


def test_normalize_list_mode_falls_back_to_all():
    assert _normalize_list_mode("") == "all"
    assert _normalize_list_mode(None) == "all"
    assert _normalize_list_mode("garbage") == "all"


# ── 三真源同步：GPT_FALLBACK_MAP ↔ Rust GPT_PREMARKED ────────────

def test_premarked_covers_all_gpt_fallback_keys():
    """真源对拍（独立校验器，非源内引用）：Python 键集 == Rust 常量键集。

    历史 bug：旧版断言 GPT_FALLBACK_MAP 键 ⊆ _premarked_unavailable()，
    而后者就是 set(GPT_FALLBACK_MAP.keys())——自己对自己断言，恒真，
    Rust GPT_PREMARKED 漂移永远不会红。现改用 CI 脚本 scripts/check_premarked_sync.py
    独立提取两侧源码对拍，测试只是脚本的一层薄壳（CI 亦直接调用该脚本）。
    """
    assert _check_premarked_sync() == 0, (
        "三真源不同步：见上方校验器输出。"
        "新增/删除需授权模型时必须三处一起改："
        "converter.py GPT_FALLBACK_MAP / billing.rs GPT_PREMARKED / 本文件。"
    )


# ── 持久化：运行时学习 ───────────────────────────────────────────

@pytest.fixture
def avail_env(tmp_path, monkeypatch):
    """隔离的 model_availability.json 环境。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    return d / "model_availability.json"


def test_mark_model_unavailable_persists_and_dedupes(avail_env, monkeypatch):
    uid = "uid-test-1"
    _mark_model_unavailable("gpt-6-astra", uid=uid)
    first = json.loads(avail_env.read_text(encoding="utf-8"))
    assert first["accounts"][uid]["gpt-6-astra"]["source"] == "runtime-11102"
    ts1 = first["accounts"][uid]["gpt-6-astra"]["firstSeenMs"]

    # 二次标记：lastSeenMs 更新、firstSeenMs 不变
    time.sleep(0.01)
    _mark_model_unavailable("gpt-6-astra", uid=uid)
    second = json.loads(avail_env.read_text(encoding="utf-8"))
    assert second["accounts"][uid]["gpt-6-astra"]["firstSeenMs"] == ts1
    assert second["accounts"][uid]["gpt-6-astra"]["lastSeenMs"] >= ts1


def test_mark_model_available_overrides_unavailable(avail_env, monkeypatch):
    uid = "uid-test-1"
    _mark_model_unavailable("gpt-6-astra", uid=uid)
    _mark_model_available("gpt-6-astra", uid=uid)
    data = json.loads(avail_env.read_text(encoding="utf-8"))
    assert data["accounts"][uid]["gpt-6-astra"]["source"] == "runtime-200"


def test_load_availability_corrupt_file_degrades(avail_env):
    avail_env.write_text("{ not json", encoding="utf-8")
    assert _load_availability(force=True) == {}


# ── 有效不可用集合：预标记兜底，运行时证据优先 ──────────────────

def test_effective_unavailable_premark_defaults(avail_env, monkeypatch):
    """无运行时证据时，GPT_FALLBACK_MAP 键全部视为不可用。"""
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    unavail = _effective_unavailable("uid-any")
    assert "gpt-6-astra" in unavail
    assert "deepseek-v4-pro" not in unavail


def test_effective_unavailable_runtime_200_wins_over_premark(avail_env, monkeypatch):
    """账号成功调用过 → 覆盖预标记，模型回归可用。"""
    _mark_model_available("gpt-6-astra", uid="uid-upgraded")
    unavail = _effective_unavailable("uid-upgraded")
    assert "gpt-6-astra" not in unavail


def test_effective_unavailable_runtime_11102_persists(avail_env, monkeypatch):
    """运行时 11102 学到的模型在 per-uid 下持续不可用。"""
    _mark_model_unavailable("kimi-k3-1", uid="uid-a")
    unavail = _effective_unavailable("uid-a")
    assert "kimi-k3-1" in unavail
    # 其他账号不受影响
    assert "kimi-k3-1" not in _effective_unavailable("uid-b")


# ── /v1/models 端到端 ────────────────────────────────────────────

@pytest.fixture
def models_env(tmp_path, monkeypatch):
    """隔离 settings.json + accounts.json + model_availability.json。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    (d / "settings.json").write_text(json.dumps({"model_list_mode": "all"}), encoding="utf-8")
    (d / "accounts.json").write_text(json.dumps({
        "active_uid": "uid-a",
        "accounts": {
            "uid-a": {
                "auth": {"accessToken": "tok", "expiresAt": int(time.time() * 1000) + 3600000},
                "account": {"uid": "uid-a", "nickname": "A"},
            }
        },
    }), encoding="utf-8")
    (d / "model_availability.json").write_text(json.dumps({
        "accounts": {"uid-a": {"gpt-6-astra": {"source": "runtime-11102", "firstSeenMs": 1, "lastSeenMs": 1}}}
    }), encoding="utf-8")
    monkeypatch.setattr(converter, "_settings_sig", (0.0, 0))
    monkeypatch.setattr(converter, "_settings_cache", {})
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})
    monkeypatch.setattr(converter, "_MODELS_WINDOWS", {})
    return d


def _client():
    from starlette.testclient import TestClient
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_models_endpoint_all_mode_includes_unavailable_with_flag(models_env, monkeypatch):
    """mode=all（默认）：unavailable 模型保留但带 availability=unavailable 标记。"""
    async def fake_fetch(*a, **kw):
        return ["gpt-6-astra", "deepseek-v4-pro"]
    monkeypatch.setattr(converter, "_fetch_remote_models", fake_fetch)
    client = _client()
    res = client.get("/v1/models")
    assert res.status_code == 200
    data = res.json()["data"]
    by_id = {m["id"]: m for m in data}
    assert "gpt-6-astra" in by_id
    assert by_id["gpt-6-astra"]["availability"] == "unavailable"
    assert "deepseek-v4-pro" in by_id
    assert by_id["deepseek-v4-pro"].get("availability") == "available"


def test_models_endpoint_available_mode_excludes_unavailable(models_env, monkeypatch):
    async def fake_fetch(*a, **kw):
        return ["gpt-6-astra", "deepseek-v4-pro"]
    monkeypatch.setattr(converter, "_fetch_remote_models", fake_fetch)
    models_env.joinpath("settings.json").write_text(json.dumps({"model_list_mode": "available"}), encoding="utf-8")
    monkeypatch.setattr(converter, "_settings_sig", (0.0, 0))
    client = _client()
    res = client.get("/v1/models")
    data = res.json()["data"]
    ids = [m["id"] for m in data]
    assert "gpt-6-astra" not in ids
    assert "deepseek-v4-pro" in ids


def test_models_endpoint_unknown_mode_falls_back_to_all(models_env, monkeypatch):
    """非法模式（settings 损坏/旧版本）→ 全量标记，向后兼容。"""
    async def fake_fetch(*a, **kw):
        return ["gpt-6-astra"]
    monkeypatch.setattr(converter, "_fetch_remote_models", fake_fetch)
    models_env.joinpath("settings.json").write_text(json.dumps({"model_list_mode": "bogus"}), encoding="utf-8")
    monkeypatch.setattr(converter, "_settings_sig", (0.0, 0))
    client = _client()
    res = client.get("/v1/models")
    data = res.json()["data"]
    by_id = {m["id"]: m for m in data}
    assert "gpt-6-astra" in by_id
    assert by_id["gpt-6-astra"]["availability"] == "unavailable"
