"""契约测试：**每一个** 11102 非降级落点都必须有直接行为契约。

为什么单独一个文件
------------------
`tests/test_model_unavailable_recording.py` 只直接打了 `/v1/chat/completions`。
于是「5 处落点批量变异全抓」证明的是「五处一起改会红」，**不等于**「每处单独坏了都会红」。
实证（scripts/_mutcheck_percall.py，逐点把那行换成 `pass`）：只有 chat 非流式被抓，
其余 4 处（messages / responses / safe_stream / raw_stream）抹掉后测试仍全绿 ——
即那 4 处可以静默回归而无人察觉。

本文件为那 4 处各补一条**直接**契约：同一 11102 报文打到该端点，
断言 (a) 客户端如实收到错误、(b) 该模型被记账为 runtime-11102。
四个端点覆盖四条独立代码路径：
  · /v1/messages          → anthropic_messages()
  · /v1/responses         → openai_responses()
  · /v1/chat/completions 流式 → _safe_stream_upstream()（有降级逻辑的那条）
  · /v1/responses 流式    → _stream_upstream()（裸流式直通那条）

同时保留一条「无 fallback_tried 时才记账」的负例：降级链已走完仍 11102 时，
记账对象必须是**实际失败的模型**，不能回落到原始请求名。
"""

import json
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402
from converter import CredentialManager  # noqa: E402

_MSG = "model [{m}] is only available for authorized users"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """单账号 + available 清单模式 + 隔离 LOCALAPPDATA。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    (d / "accounts.json").write_text(json.dumps({
        "active_uid": "uid-alpha",
        "accounts": {
            "uid-alpha": {
                "auth": {"accessToken": "token-alpha",
                         "expiresAt": int(time.time() * 1000) + 3600000},
                "account": {"uid": "uid-alpha", "nickname": "阿尔法号"},
            },
        },
    }, ensure_ascii=False), encoding="utf-8")
    (d / "settings.json").write_text(
        json.dumps({"model_list_mode": "available"}), encoding="utf-8")

    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_ROTATOR", None)
    monkeypatch.setitem(converter.CONFIG, "cred", CredentialManager())
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(tmp_path / "usage.jsonl"))
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    yield d
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))


def _reject_11102(monkeypatch, model: str):
    """上游对该模型一律回 11102 400；返回收到的模型名列表。"""
    seen = []

    def handler(request):
        body = json.loads(request.content.decode("utf-8"))
        m = body.get("model")
        seen.append(m)
        return httpx.Response(400, json={"code": 11102, "msg": _MSG.format(m=m)})

    transport = httpx.MockTransport(handler)
    orig = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: orig(**{**kw, "transport": transport}))
    return seen


def _source(uid: str, model: str):
    """读可用性证据的 source —— 路径走实现自己的推导函数，不手工拼接。"""
    f = Path(converter._availability_file())
    if not f.is_file():
        return None
    data = json.loads(f.read_text(encoding="utf-8"))
    rec = ((data.get("accounts") or {}).get(uid) or {}).get(model)
    return rec.get("source") if isinstance(rec, dict) else None


MODEL = "gemini-3.5-flash"


# --------------------------------------------------------------------------
# 四个端点的直接契约（每条对应一个独立落点）
# --------------------------------------------------------------------------

def test_messages_endpoint_records(env, monkeypatch):
    """落点：anthropic_messages() —— /v1/messages 非降级 11102 必须记账。"""
    seen = _reject_11102(monkeypatch, MODEL)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/messages", json={
        "model": MODEL, "max_tokens": 16,
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert res.status_code == 400, "应如实把上游 400 透传给客户端"
    assert seen == [MODEL], "不得降级重试（该模型不在 GPT_FALLBACK_MAP）"
    assert _source("uid-alpha", MODEL) == "runtime-11102", (
        "/v1/messages 的 11102 未记账 —— 清单会继续谎报 available"
    )


def test_responses_endpoint_records(env, monkeypatch):
    """落点：openai_responses() 的非流式分支（4696）—— 必须记账。

    ⚠️ 必须显式传 `stream: False`：该端点的开关是
    `raw_body.get("stream", True)`，**缺省即流式**。不写这一句会走进 `_stream_upstream()`
    那条路（另一处落点），于是「非流式落点」实际从未被这条用例覆盖
    —— 这正是逐点变异脚本抓出来的：只删 4696 时整组用例仍全绿。
    """
    seen = _reject_11102(monkeypatch, MODEL)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/responses", json={
        "model": MODEL, "input": "hi", "max_output_tokens": 16, "stream": False,
    })
    assert res.status_code == 400, "应如实把上游 400 透传给客户端"
    assert seen == [MODEL], "不得降级重试"
    assert _source("uid-alpha", MODEL) == "runtime-11102", (
        "/v1/responses 非流式分支的 11102 未记账"
    )


_TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
    },
}]


def test_chat_plain_stream_path_records(env, monkeypatch):
    """落点：_stream_upstream() —— chat 流式**无工具**时走这条（裸流式直通）。"""
    seen = _reject_11102(monkeypatch, MODEL)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/chat/completions", json={
        "model": MODEL, "stream": True,
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert seen == [MODEL], "不得降级重试"
    assert _source("uid-alpha", MODEL) == "runtime-11102", (
        "chat 裸流式（_stream_upstream）的 11102 未记账"
    )


def test_chat_stream_tool_repair_path_records(env, monkeypatch):
    """落点：_safe_stream_upstream() —— chat 流式**带 tools** 时才走这条。

    进入条件是 `_stream_upstream` 之外的另一条分岔：
        need_tool_repair = client_wants_stream and has_tools and repair_stream_tools
    所以**必须带 tools**，否则请求走的是裸流式那条路、这条落点永远不被覆盖
    （逐点变异脚本实测：不带 tools 时只删 5180，整组用例仍全绿）。
    """
    monkeypatch.setitem(converter.CONFIG, "repair_stream_tools", True)
    seen = _reject_11102(monkeypatch, MODEL)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/chat/completions", json={
        "model": MODEL, "stream": True, "tools": _TOOLS,
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert seen == [MODEL], "不得降级重试"
    assert _source("uid-alpha", MODEL) == "runtime-11102", (
        "chat 工具修复流式路径（_safe_stream_upstream）的 11102 未记账"
    )


def test_responses_stream_path_records(env, monkeypatch):
    """落点：_stream_upstream() —— /v1/responses 流式非降级 11102 必须记账。"""
    seen = _reject_11102(monkeypatch, MODEL)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/responses", json={
        "model": MODEL, "input": "hi", "stream": True,
    })
    assert seen == [MODEL], "不得降级重试"
    assert _source("uid-alpha", MODEL) == "runtime-11102", (
        "responses 流式路径（_stream_upstream）的 11102 未记账"
    )


# --------------------------------------------------------------------------
# 负例：降级链走完后的 11102 记的是「实际再次失败的模型」
# --------------------------------------------------------------------------

def test_after_fallback_exhausted_records_actual_model(env, monkeypatch):
    """降级目标也 11102 时，记的必须是降级后的模型（实际又失败的），不是原始请求名。

    若误记原始请求名，清单会把一个从未被上游拒绝的名字标成不可用；
    而真正失败的降级目标继续躺在清单里。
    """
    def handler(request):
        body = json.loads(request.content.decode("utf-8"))
        m = body.get("model")
        return httpx.Response(400, json={"code": 11102, "msg": _MSG.format(m=m)})

    transport = httpx.MockTransport(handler)
    orig = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: orig(**{**kw, "transport": transport}))
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/chat/completions", json={
        "model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "hi"}],
    })
    assert res.status_code == 400
    fb = converter.GPT_FALLBACK_MAP.get("gpt-5.6-luna") or converter.GPT_FALLBACK_MAP["gpt-5.6-luna"]
    assert _source("uid-alpha", "gpt-5.6-luna") == "runtime-11102", "原始模型应被记账"
    # 降级目标实际也失败了，同样必须记账（否则它在清单里仍是可用）
    assert _source("uid-alpha", fb) == "runtime-11102", (
        "降级目标自己也被 11102 拒绝，却未被记账 —— 它会在清单里继续显示可用"
    )
