"""上游出口按账号区域（国内版 / 国际版）路由的回归测试。

背景：国际版（realm=global / domain 含 workbuddy.ai 或 codebuddy.ai）的 token
打 copilot.tencent.com 会被边缘直接 401，必须打 www.workbuddy.ai；池内可同时
存在两个区域的账号，因此主机必须在**每次请求**按当前账号解析，包括 failover 后。

覆盖：区域判定、出站头、计费、模型清单（含 accounts.json 回退）、首条 system
兜底，以及流式 failover 后主机重算。
"""

import asyncio
import json

import httpx
import pytest

import converter

INTL_AUTH = {
    "accessToken": "tok-intl",
    "refreshToken": "rt-intl",
    "realm": "global",
    "domain": "www.workbuddy.ai",
    "expiresAt": 9999999999999,
}
CODEBUDDY_INTL_AUTH = {
    "accessToken": "tok-cb-intl",
    "refreshToken": "rt-cb-intl",
    "domain": "www.codebuddy.ai",
    "expiresAt": 9999999999999,
}
CN_AUTH = {
    "accessToken": "tok-cn",
    "refreshToken": "rt-cn",
    "domain": "www.codebuddy.cn",
    "expiresAt": 9999999999999,
}
ACCOUNT = {"uid": "u1", "nickname": "n", "enterpriseId": ""}


# ---------------------------------------------------------------------------
# 区域 -> 出口（纯函数）
# ---------------------------------------------------------------------------

def test_backend_selection_by_domain_and_realm():
    assert converter._backend_for_domain("www.workbuddy.ai") == converter.BACKEND_INTL
    assert converter._backend_for_domain("www.codebuddy.ai") == converter.BACKEND_INTL
    assert converter._backend_for_domain("www.codebuddy.cn") == converter.BACKEND
    assert converter._backend_for_domain(None) == converter.BACKEND
    # realm 优先：显式 global 即便 domain 缺失/异常也判国际版
    assert converter._backend_for_auth({"realm": "global"}) == converter.BACKEND_INTL
    assert converter._backend_for_auth({"realm": "cn", "domain": "www.workbuddy.ai"}) == converter.BACKEND
    # 缺 realm 回退 domain；空凭据/None 回退国内版（老凭据零回归）
    assert converter._backend_for_auth({"domain": "www.workbuddy.ai"}) == converter.BACKEND_INTL
    assert converter._backend_for_auth({"domain": "www.codebuddy.ai"}) == converter.BACKEND_INTL
    assert converter._backend_for_auth({"domain": "www.codebuddy.cn"}) == converter.BACKEND
    assert converter._backend_for_auth({}) == converter.BACKEND
    assert converter._backend_for_auth(None) == converter.BACKEND


def test_upstream_url_uses_account_region():
    assert converter._upstream_url(converter.UPSTREAM_CHAT_PATH, {"X-Domain": "www.workbuddy.ai"}) == \
        "https://www.workbuddy.ai/v2/chat/completions"
    assert converter._upstream_url(converter.UPSTREAM_CHAT_PATH, {"X-Domain": "www.codebuddy.ai"}) == \
        "https://www.workbuddy.ai/v2/chat/completions"
    assert converter._upstream_url(converter.UPSTREAM_CHAT_PATH, {"X-Domain": "www.codebuddy.cn"}) == \
        "https://copilot.tencent.com/v2/chat/completions"
    # 头里没有 X-Domain（老会话）→ 国内站，保持既有行为
    assert converter._upstream_url("/x", {}) == "https://copilot.tencent.com/x"


# ---------------------------------------------------------------------------
# 出站头：国际版形态（企业头 / Origin / Referer）
# ---------------------------------------------------------------------------

def test_outbound_headers_intl_vs_cn(monkeypatch):
    monkeypatch.setattr(converter, "_get_turing_device_token", lambda: "")
    cm = converter.CredentialManager(None)

    intl = cm._build_headers_from(INTL_AUTH, ACCOUNT)
    assert intl["X-Domain"] == "www.workbuddy.ai"
    assert intl["X-No-Enterprise-Id"] == "1"
    assert intl["Origin"] == converter.BACKEND_INTL
    assert intl["Referer"] == converter.BACKEND_INTL + "/"
    assert "X-Enterprise-Id" not in intl and "X-Tenant-Id" not in intl
    assert intl["User-Agent"] == converter._get_user_agent("www.workbuddy.ai")

    # codebuddy.ai 也属于国际版家族，但出口仍是 workbuddy.ai
    cb_intl = cm._build_headers_from(CODEBUDDY_INTL_AUTH, ACCOUNT)
    assert cb_intl["X-Domain"] == "www.codebuddy.ai"
    assert cb_intl["X-No-Enterprise-Id"] == "1"
    assert cb_intl["Origin"] == converter.BACKEND_INTL
    assert cb_intl["User-Agent"] == converter._get_user_agent("www.codebuddy.ai")
    assert cb_intl["User-Agent"] == converter.DEFAULT_UA_INTL

    cn = cm._build_headers_from(CN_AUTH, ACCOUNT)
    assert cn["X-Domain"] == "www.codebuddy.cn"
    assert cn["X-Enterprise-Id"] == "" and cn["X-Tenant-Id"] == ""
    assert "X-No-Enterprise-Id" not in cn
    assert "Origin" not in cn and "Referer" not in cn


# ---------------------------------------------------------------------------
# 计费 / 模型清单：按活跃账号区域选主机
# ---------------------------------------------------------------------------

def test_billing_query_hits_account_region_host():
    hosts = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(200, json={"code": 0, "data": {"IsPaidUser": False, "Packages": []}})

    transport = httpx.MockTransport(handler)
    asyncio.run(converter._fetch_billing_usage("tok", "u1", auth=INTL_AUTH, transport=transport))
    asyncio.run(converter._fetch_billing_usage("tok", "u1", auth=CODEBUDDY_INTL_AUTH, transport=transport))
    asyncio.run(converter._fetch_billing_usage("tok", "u1", auth=CN_AUTH, transport=transport))
    asyncio.run(converter._fetch_billing_usage("tok", "u1", transport=transport))
    assert hosts == ["www.workbuddy.ai", "www.workbuddy.ai", "copilot.tencent.com", "copilot.tencent.com"]


def test_remote_models_hits_account_region_host(monkeypatch):
    class _Cred:
        def get_active_session(self):
            return {"auth": INTL_AUTH, "account": ACCOUNT}

    monkeypatch.setitem(converter.CONFIG, "cred", _Cred())
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})
    hosts = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(200, json={"code": 0, "data": {"models": [{"id": "hy3"}]}})

    monkeypatch.setattr(converter, "_MODELS_TRANSPORT_OVERRIDE", httpx.MockTransport(handler))
    models = asyncio.run(converter._fetch_remote_models())

    assert "www.workbuddy.ai" in hosts
    assert "copilot.tencent.com" not in hosts, "国际版账号的模型清单不能打到国内站"
    assert "hy3" in models


def test_remote_models_accounts_json_fallback_uses_intl_domain(monkeypatch, tmp_path):
    accounts = {
        "active_uid": "u1",
        "accounts": {"u1": {"auth": CODEBUDDY_INTL_AUTH, "account": ACCOUNT}},
    }
    path = tmp_path / "accounts.json"
    path.write_text(json.dumps(accounts), encoding="utf-8")

    monkeypatch.setitem(converter.CONFIG, "cred", None)
    monkeypatch.setattr(converter, "_accounts_file", lambda: path)
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})
    hosts = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(200, json={"code": 0, "data": {"models": [{"id": "hy3"}]}})

    monkeypatch.setattr(converter, "_MODELS_TRANSPORT_OVERRIDE", httpx.MockTransport(handler))
    models = asyncio.run(converter._fetch_remote_models())

    assert "www.workbuddy.ai" in hosts
    assert "copilot.tencent.com" not in hosts, "accounts.json 回退路径也必须按 domain 选国际站"
    assert "hy3" in models


# ---------------------------------------------------------------------------
# 国际版首条 system 兜底
# ---------------------------------------------------------------------------

def test_intl_system_guard_only_rewrites_intl_without_system():
    intl_hdr = {"X-Domain": "www.workbuddy.ai"}
    cb_intl_hdr = {"X-Domain": "www.codebuddy.ai"}
    cn_hdr = {"X-Domain": "www.codebuddy.cn"}

    body = {"messages": [{"role": "user", "content": "hi"}]}
    converter._ensure_intl_system(body, cn_hdr)
    assert body["messages"] == [{"role": "user", "content": "hi"}], "国内版不得改写请求体"

    converter._ensure_intl_system(body, intl_hdr)
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert body["messages"][0]["content"] == converter.INTL_FALLBACK_SYSTEM

    # 幂等：换号后重复判定不叠加兜底 system
    converter._ensure_intl_system(body, intl_hdr)
    assert [m["role"] for m in body["messages"]] == ["system", "user"]

    # 客户端自带 system：绝不覆盖
    keep = {"messages": [{"role": "system", "content": "MY PROMPT"},
                         {"role": "user", "content": "x"}]}
    converter._ensure_intl_system(keep, intl_hdr)
    assert keep["messages"][0]["content"] == "MY PROMPT"

    # codebuddy.ai 同属国际版，也要补 system
    cb_body = {"messages": [{"role": "user", "content": "hi"}]}
    converter._ensure_intl_system(cb_body, cb_intl_hdr)
    assert cb_body["messages"][0]["role"] == "system"

    # 无 messages 的请求体不炸
    other = {"input": "x"}
    converter._ensure_intl_system(other, intl_hdr)
    assert "messages" not in other


# ---------------------------------------------------------------------------
# chat：主机随当前账号走（含换号后重算）
# ---------------------------------------------------------------------------

class _Rotator:
    """最小 rotator：第一轮失败后换到预置账号。"""

    def __init__(self, failover_pairs):
        self._pairs = list(failover_pairs)

    def get_retry_budget(self, model_name):
        return len(self._pairs)

    def record_failure_and_failover(self, uid, model_name, status_code, err_payload, attempt=None):
        return self._pairs.pop(0) if self._pairs else None


def test_chat_host_follows_current_account_across_failover(monkeypatch):
    """首轮国际版账号 → 429 换到国内版账号，第二轮必须改打国内站。"""
    hosts = []
    bodies = []
    attempt = {"n": 0}

    class _Stream:
        def __init__(self, idx):
            self.idx = idx

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        @property
        def status_code(self):
            return 429 if self.idx == 0 else 200

        async def aread(self):
            return b'{"error":{"message":"rate limited"}}'

        async def aiter_bytes(self):
            chunk = {"id": "c", "object": "chat.completion.chunk",
                     "choices": [{"index": 0, "delta": {"content": "hi"}, "finish_reason": "stop"}]}
            yield f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, **kwargs):
            hosts.append(url)
            bodies.append(kwargs.get("json"))
            idx = attempt["n"]
            attempt["n"] += 1
            return _Stream(idx)

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: _Client())
    monkeypatch.setitem(converter.CONFIG, "usage_log", None)
    monkeypatch.setitem(converter.CONFIG, "log_payloads", False)

    rotator = _Rotator([("uid-cn", {"X-Domain": "www.codebuddy.cn", "Authorization": "Bearer tok-cn"})])

    async def _run():
        out = []
        async for chunk in converter._stream_upstream(
            url=converter._upstream_url(converter.UPSTREAM_CHAT_PATH, {"X-Domain": "www.workbuddy.ai"}),
            headers={"X-Domain": "www.workbuddy.ai", "Authorization": "Bearer tok-intl"},
            body={"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": "hi"}]},
            model_name="deepseek-v4.1-flash",
            uid="uid-intl",
            rotator=rotator,
        ):
            out.append(chunk)
        return out

    events = asyncio.run(_run())
    assert hosts == [
        "https://www.workbuddy.ai/v2/chat/completions",
        "https://copilot.tencent.com/v2/chat/completions",
    ], f"换号后主机未重算：{hosts}"
    assert bodies[0]["messages"][0]["role"] == "system", "国际版首条必须是 system"
    assert any(b"hi" in e for e in events)
