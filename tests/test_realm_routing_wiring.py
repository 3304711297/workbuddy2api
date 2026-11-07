"""锁定区域路由的接线：任何上游调用点都不许退回硬编码国内站。

这些是源码级契约，补的是「纯函数正确但某个调用点忘接线」的静默回归：
单测能跑通 helper，却未必覆盖刷新、三协议入口、流式 failover 与 Rust 命令。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_all_python_upstream_calls_are_region_aware():
    py = _read("converter.py")

    # 三协议入口的初始 URL + 三协议非流式重试循环，共 6 处
    assert py.count("_upstream_url(UPSTREAM_CHAT_PATH, headers)") == 6
    # 两条流式聚合路径（_stream_upstream / _safe_stream_upstream）每轮重算
    assert py.count("_resolve_upstream_url(url, curr_headers)") == 2
    # 刷新 ×2、出站头判定、模型清单、计费，共 5 处
    assert py.count("_backend_for_auth(auth)") == 5
    assert "_fetch_billing_usage(token, uid, auth=auth)" in py
    assert py.count("_upstream_url(_CHECKIN_STATUS_PATH, headers)") == 2
    assert py.count("_upstream_url(_CHECKIN_CLAIM_PATH, headers)") == 1
    assert "f\"{BACKEND}/v2/chat/completions\"" not in py
    assert "_BILLING_URL = " not in py
    assert "\n_MODELS_URL = " not in py


def test_all_rust_upstream_calls_are_region_aware():
    auth = _read("src-tauri/src/commands/auth.rs")
    billing = _read("src-tauri/src/commands/billing.rs")

    # token 刷新 1 处；模型清单 + 积分查询 2 处
    assert auth.count("super::shared::upstream_base_for(auth)") == 1
    assert billing.count("super::shared::upstream_base_for(auth)") == 2
    assert 'post("https://copilot.tencent.com/' not in auth
    assert '.get("https://copilot.tencent.com/' not in billing
    assert '.post("https://copilot.tencent.com/' not in billing
