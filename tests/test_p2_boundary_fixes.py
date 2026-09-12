"""
tests/test_p2_boundary_fixes.py - 边界收敛三修复（外部评审 P2×3）

1. _FALLBACK_EVENTS 读锁：并发写 + 并发读 /api/rate_limit 不出现 dict 竞态异常；
2. 别名成功记录 mapped 模型：gpt-4o(MODEL_MAP→gpt-5.6-luna) 成功后，
   model_availability.json 记录 gpt-5.6-luna=runtime-200（预标记解除对象正确），
   而不是记录别名 gpt-4o；
3. 同状态写盘节流：runtime-200 重复标记不重复落盘（状态翻转仍立即落盘）。
"""

import json
import threading
import time

import httpx
import pytest
from starlette.testclient import TestClient

import converter
from converter import _record_fallback_event


# ── ① 读锁 ──────────────────────────────────────────────────────

def test_fallback_events_read_is_lock_guarded(monkeypatch):
    """并发写 _FALLBACK_EVENTS 与并发读 /api/rate_limit 压测：无异常即过。

    读路径若不加锁，CPython 下 list(dict.items()) 虽因 GIL 原子，但随后取
    ev["actual"] 等字段时条目可能正被替换/淘汰；锁保护的快照语义才是正确契约。
    这里不直接断言内部实现，而是压测端点 + 验证淘汰线程高密度执行下无崩溃。
    """
    stop = threading.Event()

    def writer():
        i = 0
        while not stop.is_set():
            # 超过 CAP=16 触发淘汰路径 + 条目替换路径同时跑
            _record_fallback_event(f"m-{i % 24}", "fast-model", "11102 unauthorized")
            i += 1

    threads = [threading.Thread(target=writer, daemon=True) for _ in range(4)]
    for t in threads:
        t.start()

    try:
        client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
        for _ in range(30):
            res = client.get("/api/rate_limit")
            assert res.status_code == 200
            fb = res.json()["fallbacks"]
            for ev in fb.values():
                assert "actual" in ev and "count" in ev
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=5)


# ── ② 别名成功记录 mapped 模型 ───────────────────────────────────

@pytest.fixture
def alias_env(tmp_path, monkeypatch):
    """隔离 LOCALAPPDATA + 单账号 accounts.json。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    (d / "accounts.json").write_text(json.dumps({
        "active_uid": "uid-alias",
        "accounts": {"uid-alias": {
            "auth": {"accessToken": "tok", "expiresAt": int(time.time() * 1000) + 3600000},
            "account": {"uid": "uid-alias", "nickname": "A"},
        }},
    }), encoding="utf-8")
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})
    monkeypatch.setattr(converter, "_MODELS_WINDOWS", {})
    return d / "model_availability.json"


def _mock_upstream_client(monkeypatch, sse_body: bytes):
    def mock_handler(request: httpx.Request):
        return httpx.Response(200, content=sse_body, headers={"Content-Type": "text/event-stream"})

    transport = httpx.MockTransport(mock_handler)
    orig = httpx.AsyncClient

    def factory(**kw):
        kw["transport"] = transport
        return orig(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


def test_alias_success_records_mapped_model(alias_env, monkeypatch):
    """gpt-4o 别名成功 → 记 gpt-5.6-luna（mapped）runtime-200，而非 gpt-4o。"""
    cred = converter.CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    sse = (
        'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n'
        'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
        'data: [DONE]\n\n'
    ).encode("utf-8")
    _mock_upstream_client(monkeypatch, sse)

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions", json={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]})
    assert res.status_code == 200

    data = json.loads(alias_env.read_text(encoding="utf-8"))
    entry = data["accounts"]["uid-alias"]
    # mapped 正式名被记录 runtime-200（gpt-5.6-luna 是 GPT 预标记，成功后应解除）
    assert entry.get("gpt-5.6-luna", {}).get("source") == "runtime-200", f"mapped 模型未被记录: {entry}"
    # 别名行不应成为可用性记录主体
    assert "gpt-4o" not in entry


# ── ③ 同状态写盘节流 ────────────────────────────────────────────

def test_same_state_remark_skips_disk_write(alias_env, monkeypatch):
    """同状态重复标记：仅首次落盘，后续 5 分钟窗口内只更新内存。"""
    import os
    calls = {"n": 0}
    real_replace = os.replace

    def counting_replace(src, dst):
        calls["n"] += 1
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", counting_replace)

    uid = "uid-throttle"
    converter._mark_model_available("glm-5.3-flash", uid=uid)
    first = calls["n"]
    assert first >= 1

    for _ in range(5):
        converter._mark_model_available("glm-5.3-flash", uid=uid)
    assert calls["n"] == first, f"同状态重复标记触发了 {calls['n'] - first} 次额外落盘"


def test_state_flip_still_writes_immediately(alias_env, monkeypatch):
    """状态翻转（200 → 11102）必须立即落盘，节流不得吞掉翻转。"""
    uid = "uid-flip"
    converter._mark_model_available("kimi-k3-1", uid=uid)
    converter._mark_model_unavailable("kimi-k3-1", uid=uid)
    data = json.loads(alias_env.read_text(encoding="utf-8"))
    assert data["accounts"][uid]["kimi-k3-1"]["source"] == "runtime-11102"


# ── ④ 内存状态连续性（评审补充：force=True 使「只更新内存」名不副实） ──

def test_same_state_remark_no_disk_read_memory_continuity(alias_env, monkeypatch):
    """同状态窗口内的重复标记：不读盘（签名缓存命中）且内存 lastSeenMs 连续推进。

    旧实现 force=True 每次强制重读磁盘：内存里的新 lastSeenMs 下次调用即被
    磁盘旧值覆盖，「只更新内存」名不副实。新实现走签名缓存——唯一写者是
    converter 自身（AGENTS.md 铁律），签名命中即内存真源。
    """
    import pathlib

    uid = "uid-mem"
    converter._mark_model_available("glm-5.3-flash", uid=uid)  # 首次：读盘 + 写盘

    reads = {"n": 0}
    orig_read_text = pathlib.Path.read_text

    def counting_read_text(self, *a, **kw):
        if str(self) == str(alias_env):
            reads["n"] += 1
        return orig_read_text(self, *a, **kw)

    monkeypatch.setattr(pathlib.Path, "read_text", counting_read_text)

    converter._mark_model_available("glm-5.3-flash", uid=uid)  # 同状态窗口内
    assert reads["n"] == 0, f"同状态重复标记仍强制读盘 {reads['n']} 次"

    # 内存连续性：缓存 lastSeenMs ≥ 磁盘值（磁盘反映最近一次落盘，允许滞后）
    cache_entry = converter._availability_cache["accounts"][uid]["glm-5.3-flash"]
    disk_entry = json.loads(orig_read_text(alias_env, encoding="utf-8"))["accounts"][uid]["glm-5.3-flash"]
    assert cache_entry["lastSeenMs"] >= disk_entry["lastSeenMs"]
    # source 恒准确（决策字段不依赖 lastSeenMs）
    assert cache_entry["source"] == disk_entry["source"] == "runtime-200"
