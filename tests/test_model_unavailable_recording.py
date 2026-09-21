"""契约测试：踩了 11102 雷的模型必须记账，清单不得继续谎报「可用」。

背景（会话 default/20260921_214744_c3dc90 诊断 + 本轮复核）
----------------------------------------------------------
`/v1/models` 走 `model_list_mode = available` 时会把 `_effective_unavailable()` 的模型
从清单里剔除。但那个集合只有两个来源：

  ① 预标记 `_premarked_unavailable()` —— **只含 `GPT_FALLBACK_MAP` 的 7 个键**；
  ② 运行时证据 `model_availability.json` 里 `source == "runtime-11102"` 的条目。

而 `_mark_model_unavailable` 此前**只写在降级分支里**（`if ... and body["model"] in
GPT_FALLBACK_MAP:` 的花括号内）。于是数量最多的那一类——**11102 但不在降级映射表里**
（实测：`gemini-3.5-flash` 无海外授权、`deepseek-v4.1-flash-sg` 上游无此 id）——
直接落到错误返回，**从不记账**。

后果是自相矛盾的清单：`gemini-3.5-flash` 每次调用都 400，却一直以
`availability: "available"` 躺在清单里，用户看到「有」、点了就报错。
症状即「踩雷不记账」。

本组用例锁的是**记账动作本身**（而非 B 方案那种扩展降级映射——那会静默换模型，
语义代价不同，另议）：
  · 非降级的 11102 400 必须写 runtime-11102 证据；
  · 降级路径（GPT 系）记账行为不得回归；
  · 成功一次（runtime-200）必须能把雷标记清掉（否则清单会永久缩水）；
  · 非 11102 的 400 不得误记账（否则网络抖动/参数错误会把模型从清单里误删）。
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
    # 复位可用性内存缓存（mtime+size 签名缓存，跨用例会串味）
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))
    yield d
    monkeypatch.setattr(converter, "_availability_cache", {})
    monkeypatch.setattr(converter, "_availability_sig", (0.0, 0))


_SSE_OK = (
    'data: {"id":"ok-1","choices":[{"index":0,"delta":{"role":"assistant","content":"好"}}]}\n\n'
    'data: {"id":"ok-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n'
    'data: [DONE]\n\n'
).encode("utf-8")


def _install_upstream(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    orig = httpx.AsyncClient

    def factory(**kw):
        kw["transport"] = transport
        return orig(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


def _availability_source(uid: str, model: str):
    """读取可用性证据条目里的 source（不存在返回 None）。

    路径必须走实现自己的 `_availability_file()`：手工拼 `%LOCALAPPDATA%/workbuddy2api/...`
    会与实现的推导方式分叉（本文件初版就因多套一层目录而让「不该记账」的两条用例**空过**——
    永远读到 None，断言看着绿却什么也没验证）。
    """
    f = Path(converter._availability_file())
    if not f.is_file():
        return None
    data = json.loads(f.read_text(encoding="utf-8"))
    rec = ((data.get("accounts") or {}).get(uid) or {}).get(model)
    return rec.get("source") if isinstance(rec, dict) else None


def _models(client) -> dict:
    r = client.get("/v1/models")
    assert r.status_code == 200, r.text
    return {m["id"]: m.get("availability") for m in r.json()["data"]}


# --------------------------------------------------------------------------
# 核心缺口：11102 但不在降级表 → 必须记账
# --------------------------------------------------------------------------

@pytest.mark.parametrize("model,msg", [
    ("gemini-3.5-flash", "is only available for authorized users"),
    ("deepseek-v4.1-flash-sg", "service info not found"),
])
def test_unauthorized_without_fallback_is_recorded(env, monkeypatch, model, msg):
    """非降级的 11102 必须写入 runtime-11102 证据（旧实现只在降级分支记账 → 漏记）。"""
    calls = []

    def handler(request):
        body = json.loads(request.content.decode("utf-8"))
        calls.append(body.get("model"))
        return httpx.Response(400, json={"code": 11102, "msg": f"model [{body.get('model')}] {msg}"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    res = client.post("/v1/chat/completions",
                      json={"model": model, "messages": [{"role": "user", "content": "hi"}]})
    # 行为不变：仍如实把 400 抛给客户端（本次不引入静默降级）
    assert res.status_code == 400
    assert calls == [model], "不得发生降级重试（该模型不在 GPT_FALLBACK_MAP）"

    assert _availability_source("uid-alpha", model) == "runtime-11102", (
        f"{model} 踩了 11102 却未记账 —— 清单会继续谎报 available"
    )


def test_recorded_model_drops_out_of_available_list(env, monkeypatch):
    """记账的最终目的：available 模式下该模型要从清单里消失。"""
    def handler(request):
        body = json.loads(request.content.decode("utf-8"))
        return httpx.Response(400, json={"code": 11102, "msg": "model [gemini-3.5-flash] is only available for authorized users"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})

    before = _models(client)
    assert "gemini-3.5-flash" in before, "前置条件：该模型本应在清单里"

    client.post("/v1/chat/completions",
                json={"model": "gemini-3.5-flash", "messages": [{"role": "user", "content": "hi"}]})

    after = _models(client)
    assert "gemini-3.5-flash" not in after, "踩过 11102 的模型仍以 available 姿态出现"


# --------------------------------------------------------------------------
# 防修过头：不该记账的一律不记
# --------------------------------------------------------------------------

def test_records_canonical_name_under_alias_mapping(env, monkeypatch):
    """别名请求被拒时，记的必须是**规范名**（清单里真实出现的那个）。

    实测：`hy4` → `MODEL_MAP` → `hy4-preview`，且 `/v1/models` **刻意过滤掉别名行**
    （`MODEL_MAP.get(m, m) == m`），所以清单里从来没有 `hy4`，只有 `hy4-preview`。
    记账若落到别名上，等于把一个不在清单里的名字标不可用 —— 用户依旧在清单里看到
    `hy4-preview` 标着 available，缺陷原样存在。
    """
    def handler(request):
        return httpx.Response(400, json={"code": 11102, "msg": "model [hy4-preview] is only available for authorized users"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    # 前置：hy4 确实是别名（否则本用例退化为普通场景，失去意义）
    assert converter.MODEL_MAP.get("hy4") == "hy4-preview"

    res = client.post("/v1/chat/completions",
                      json={"model": "hy4", "messages": [{"role": "user", "content": "hi"}]})
    assert res.status_code == 400

    assert _availability_source("uid-alpha", "hy4-preview") == "runtime-11102", (
        "记账必须落在规范名上（清单里只列规范名）"
    )
    # 收口：被拒的规范名随后应从 available 清单里消失
    assert "hy4-preview" not in _models(client)


def test_unrelated_400_is_not_recorded(env, monkeypatch):
    """非 11102 的 400（参数/内容类）不得把模型打成不可用——否则误删清单条目。"""
    def handler(request):
        return httpx.Response(400, json={"code": 11141, "msg": "the request parameters were rejected by the model provider"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    client.post("/v1/chat/completions",
                json={"model": "gemini-3.5-flash", "messages": [{"role": "user", "content": "hi"}]})
    assert _availability_source("uid-alpha", "gemini-3.5-flash") is None


def test_content_policy_400_is_not_recorded(env, monkeypatch):
    """11140 内容审核拦截是用户输入命中的，与模型可用性无关，严禁记账。"""
    def handler(request):
        return httpx.Response(400, json={"code": 11140, "msg": "内容未通过安全审核，请调整后重试"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    client.post("/v1/chat/completions",
                json={"model": "gemini-3.5-flash", "messages": [{"role": "user", "content": "hi"}]})
    assert _availability_source("uid-alpha", "gemini-3.5-flash") is None


# --------------------------------------------------------------------------
# 降级路径不回归 + 自愈
# --------------------------------------------------------------------------

def test_fallback_path_still_records(env, monkeypatch):
    """GPT 系降级路径原就记账，本次不得弄丢（同时确认降级行为未变）。"""
    calls = []

    def handler(request):
        body = json.loads(request.content.decode("utf-8"))
        m = body.get("model")
        calls.append(m)
        if m == "gpt-5.6-luna":
            return httpx.Response(400, json={"code": 11102, "msg": "model [gpt-5.6-luna] is only available for authorized users"})
        return httpx.Response(200, content=_SSE_OK, headers={"Content-Type": "text/event-stream"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions",
                      json={"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "hi"}]})
    assert res.status_code == 200
    assert calls == ["gpt-5.6-luna", "fast-model"], "降级链应保持原样"
    assert _availability_source("uid-alpha", "gpt-5.6-luna") == "runtime-11102"


def test_success_after_mark_clears_it(env, monkeypatch):
    """成功一次必须能清掉雷标记 —— 否则清单会永久缩水（额度恢复/授权补上后回不来）。"""
    state = {"mode": "fail"}

    def handler(request):
        if state["mode"] == "fail":
            return httpx.Response(400, json={"code": 11102, "msg": "model [gemini-3.5-flash] is only available for authorized users"})
        return httpx.Response(200, content=_SSE_OK, headers={"Content-Type": "text/event-stream"})

    _install_upstream(monkeypatch, handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    payload = {"model": "gemini-3.5-flash", "messages": [{"role": "user", "content": "hi"}]}

    client.post("/v1/chat/completions", json=payload)
    assert _availability_source("uid-alpha", "gemini-3.5-flash") == "runtime-11102"

    state["mode"] = "ok"
    assert client.post("/v1/chat/completions", json=payload).status_code == 200
    assert _availability_source("uid-alpha", "gemini-3.5-flash") == "runtime-200"
    assert "gemini-3.5-flash" in _models(client), "恢复证据后应重新出现在可用清单里"
