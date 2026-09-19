"""
tests/test_origin_guard.py - Origin 校验（防浏览器跨站请求）测试

背景：Host 校验（LocalHostOnlyMiddleware）只防 DNS rebinding。恶意外网页面直接向
http://127.0.0.1:8787 发起的「简单请求」（POST + text/plain，不触发 CORS 预检）Host 本来就是
回环，会直达服务端并触发副作用（消耗额度、POST /api/checkin/claim 等）。
OriginGuardMiddleware 按 Origin 头拦截：
  - 无 Origin（curl / Codex CLI / Claude Code CLI / Hermes Agent 等原生客户端）→ 放行
  - 本机回环页面 / Tauri WebView / 浏览器扩展 → 放行
  - 其余（含字面量 "null"）→ 403 invalid_origin

中间件级用例直接以 ASGI 协议驱动，并用「下游探针」断言被拦截的请求**根本没到达下游**；
整机级用例走真实 converter.app。全程不依赖网络 / DNS。
"""

import asyncio
import json

import pytest
from starlette.testclient import TestClient

import converter


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _downstream():
    """下游探针：记录被调用的 path，返回 204。"""
    calls = []

    async def app(scope, receive, send):
        calls.append(scope.get("path"))
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return app, calls


def _call(guard, headers=(), *, method="POST", path="/v1/chat/completions", scope_type="http"):
    """直接以 ASGI 协议驱动中间件，返回下发给客户端的消息列表。"""
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": scope_type,
        "method": method,
        "path": path,
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
    }
    asyncio.run(guard(scope, receive, send))
    return sent


def _status(sent):
    return sent[0]["status"]


def _body(sent):
    return json.loads(sent[-1]["body"])


def _guarded():
    downstream, calls = _downstream()
    return converter.OriginGuardMiddleware(downstream), calls


def _real_client():
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


# 默认应放行的来源（回环页面 / Tauri WebView / 浏览器扩展）
TRUSTED_ORIGINS = [
    "http://localhost",
    "http://localhost:3000",
    "https://localhost:8443",
    "http://127.0.0.1:5173",
    "http://127.0.0.2:3000",           # 127.0.0.0/8 均为回环
    "http://[::1]:8080",
    "HTTP://LOCALHOST:3000",           # scheme / 主机名大小写不敏感
    "http://localhost:3000/",          # 容忍尾部斜杠
    "tauri://localhost",               # Tauri WebView（macOS / Linux）
    "http://tauri.localhost",          # Tauri v2（Windows / Android）
    "https://tauri.localhost",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
]

# 默认应拦截的来源：外网站点 + 各类「看起来像本机」的绕过写法 + 畸形值
UNTRUSTED_ORIGINS = [
    "https://malicious.com",
    "http://malicious.com:8787",
    "null",                            # 沙箱 iframe / file:// / data: 页面，攻击者可轻易构造
    "",                                # 空值
    # —— 前缀 / userinfo / 路径 / 片段 绕过 ——
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://evil.com/localhost",
    "http://localhost@evil.com",
    "http://evil.com@localhost",
    "http://localhost:3000@evil.com",
    "http://localhost#.evil.com",
    "http://localhost?x=1",
    "https://tauri.localhost.evil.com",
    "tauri://evil.com",
    # —— 非回环地址 ——
    "http://0.0.0.0:3000",
    "http://10.0.0.5:3000",
    "http://192.168.1.10:3000",
    # —— 非白名单 scheme ——
    "file://",
    "file:///C:/x.html",
    "data:text/html,x",
    "javascript:alert(1)",
    "ftp://localhost",
    "moz-extension://abcd",            # 默认不放行（需经 WORKBUDDY2API_ALLOWED_ORIGINS 显式加入）
    "vscode-webview://abcd",
    # —— 畸形 ——
    "localhost",
    "127.0.0.1:3000",
    "http://",
    "chrome-extension://",
    "http://localhost:abc",
    "http://localhost:99999",
    "http://[::1",
    "http://local host",
    "http://localhost\t.evil.com",
    "http://localhost.\u00e9vil.com",  # 非 ASCII
]


# ---------------------------------------------------------------------------
# 中间件级：放行规则
# ---------------------------------------------------------------------------

def test_native_cli_clients_without_origin_pass_through():
    """curl / Codex CLI / Claude Code CLI / Hermes Agent 不发 Origin → 放行。"""
    guard, calls = _guarded()
    for ua in ("curl/8.5.0", "claude-cli/2.1.0", "codex_cli_rs/0.5", "hermes-agent/1.0"):
        sent = _call(guard, [("user-agent", ua), ("authorization", "Bearer local"),
                             ("x-api-key", "local")])
        assert _status(sent) == 204
    assert len(calls) == 4


@pytest.mark.parametrize("origin", TRUSTED_ORIGINS)
def test_trusted_origin_passes_through(origin):
    guard, calls = _guarded()
    sent = _call(guard, [("origin", origin)])
    assert _status(sent) == 204
    assert calls == ["/v1/chat/completions"]


# ---------------------------------------------------------------------------
# 中间件级：拦截规则
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("origin", UNTRUSTED_ORIGINS)
def test_untrusted_origin_is_blocked_before_reaching_downstream(origin):
    guard, calls = _guarded()
    sent = _call(guard, [("origin", origin)])
    assert _status(sent) == 403
    assert calls == [], "被拦截的请求不得到达下游（否则副作用已经发生）"
    err = _body(sent)["error"]
    assert err["type"] == "invalid_origin"
    assert "forbidden origin" in err["message"]
    assert "WORKBUDDY2API_ALLOWED_ORIGINS" in err["hint"]


@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_block_applies_to_every_method(method):
    """预检（OPTIONS）与各写方法同样拦截。"""
    guard, calls = _guarded()
    sent = _call(guard, [("origin", "https://malicious.com")], method=method)
    assert _status(sent) == 403
    assert calls == []


def test_any_untrusted_origin_among_duplicate_headers_blocks():
    """多个 Origin 头只要有一个不可信就拒绝（浏览器只会发一个，多值必为非浏览器构造）。"""
    guard, calls = _guarded()
    sent = _call(guard, [("origin", "http://localhost:3000"), ("origin", "https://malicious.com")])
    assert _status(sent) == 403
    assert calls == []


def test_error_body_does_not_reflect_oversized_origin():
    """回显的 Origin 会截断，避免把攻击者构造的超长值原样放大到响应里。"""
    guard, _ = _guarded()
    sent = _call(guard, [("origin", "https://" + "a" * 5000 + ".com")])
    assert _status(sent) == 403
    assert len(sent[-1]["body"]) < 1000
    assert _body(sent)["error"]["message"].endswith("...")


# ---------------------------------------------------------------------------
# 中间件级：生效范围
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_guard_active_when_bound_to_loopback(monkeypatch, host):
    monkeypatch.setitem(converter.CONFIG, "host", host)
    guard, calls = _guarded()
    assert _status(_call(guard, [("origin", "https://malicious.com")])) == 403
    assert calls == []


def test_guard_inactive_when_lan_exposed(monkeypatch):
    """与 Host 校验一致：开放局域网（非回环绑定）时不启用——此时内核已强制要求 API 密钥。"""
    monkeypatch.setitem(converter.CONFIG, "host", "0.0.0.0")
    guard, calls = _guarded()
    sent = _call(guard, [("origin", "https://ui.example.com")])
    assert _status(sent) == 204
    assert calls == ["/v1/chat/completions"]


def test_non_http_scopes_pass_through():
    """lifespan 等非 http scope 原样透传。"""
    calls = []

    async def downstream(scope, receive, send):
        calls.append(scope["type"])

    guard = converter.OriginGuardMiddleware(downstream)
    _call(guard, [("origin", "https://malicious.com")], scope_type="lifespan")
    assert calls == ["lifespan"]


# ---------------------------------------------------------------------------
# WORKBUDDY2API_ALLOWED_ORIGINS
# ---------------------------------------------------------------------------

def test_env_allowlist_extends_default_rules(monkeypatch):
    monkeypatch.delenv("CODEBUDDY2OPENAI_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("WORKBUDDY2API_ALLOWED_ORIGINS",
                       " https://ui.example.com/ , MOZ-EXTENSION://abcd ")
    assert converter._is_allowed_origin("https://ui.example.com")
    assert converter._is_allowed_origin("moz-extension://abcd")
    # 精确匹配：不会顺带放行同域的其它 scheme / 端口 / 子域，也不会放行 null
    assert not converter._is_allowed_origin("http://ui.example.com")
    assert not converter._is_allowed_origin("https://ui.example.com:8443")
    assert not converter._is_allowed_origin("https://evil.ui.example.com")
    assert not converter._is_allowed_origin("null")
    # 默认规则不受影响
    assert converter._is_allowed_origin("http://localhost:3000")
    assert not converter._is_allowed_origin("https://malicious.com")


def test_env_allowlist_null_is_explicit_opt_in(monkeypatch):
    """Electron 的 file:// 页面会发 "null"：默认拒绝，显式列出才放行。"""
    monkeypatch.delenv("WORKBUDDY2API_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_ALLOWED_ORIGINS", raising=False)
    assert not converter._is_allowed_origin("null")
    monkeypatch.setenv("WORKBUDDY2API_ALLOWED_ORIGINS", "null")
    assert converter._is_allowed_origin("null")
    assert not converter._is_allowed_origin("https://malicious.com")


def test_env_allowlist_has_no_wildcards(monkeypatch):
    monkeypatch.delenv("CODEBUDDY2OPENAI_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("WORKBUDDY2API_ALLOWED_ORIGINS", "*, https://*.example.com")
    assert not converter._is_allowed_origin("https://malicious.com")
    assert not converter._is_allowed_origin("https://a.example.com")


def test_env_allowlist_legacy_name_and_precedence(monkeypatch):
    monkeypatch.delenv("WORKBUDDY2API_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("CODEBUDDY2OPENAI_ALLOWED_ORIGINS", "https://old.example.com")
    assert converter._is_allowed_origin("https://old.example.com")
    # 新名优先：两者并存时只认新名
    monkeypatch.setenv("WORKBUDDY2API_ALLOWED_ORIGINS", "https://new.example.com")
    assert converter._is_allowed_origin("https://new.example.com")
    assert not converter._is_allowed_origin("https://old.example.com")


# ---------------------------------------------------------------------------
# 整机级：真实 converter.app
# ---------------------------------------------------------------------------

def test_guard_is_registered_as_outermost_middleware():
    """必须最外层：先于 RequestBodyLimitMiddleware 缓冲 body，先于 Host 校验。"""
    assert converter.app.user_middleware[0].cls is converter.OriginGuardMiddleware


def test_real_app_native_client_without_origin_is_allowed():
    res = _real_client().get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_real_app_loopback_origin_is_allowed():
    res = _real_client().get("/health", headers={"Origin": "http://localhost:3000"})
    assert res.status_code == 200


def test_real_app_blocks_cross_site_origin():
    res = _real_client().get("/health", headers={"Origin": "https://malicious.com"})
    assert res.status_code == 403
    assert res.json()["error"]["type"] == "invalid_origin"


@pytest.mark.parametrize("path", ["/api/checkin/claim", "/v1/chat/completions",
                                  "/v1/messages", "/v1/responses"])
def test_real_app_blocks_simple_post_from_malicious_page(path):
    """text/plain 的「简单请求」不触发 CORS 预检——这正是 Origin 校验要堵的口子。"""
    res = _real_client().post(
        path, content='{"model":"auto","messages":[]}',
        headers={"Origin": "https://malicious.com", "Content-Type": "text/plain"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["type"] == "invalid_origin"


def test_real_app_blocks_sandboxed_iframe_null_origin():
    res = _real_client().post(
        "/api/checkin/claim", content="{}",
        headers={"Origin": "null", "Content-Type": "text/plain"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["type"] == "invalid_origin"


def test_real_app_rejects_cross_site_before_buffering_body(monkeypatch):
    """跨站请求在 body 限长中间件之前就被拒：超限 body 返回 403 而不是 413；
    可信来源的同一请求则穿过 Origin 校验、被 body 限长拦成 413（无需任何网络即可验证放行）。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 100)
    payload = {"model": "auto", "messages": [{"role": "user", "content": "a" * 200}]}
    client = _real_client()

    blocked = client.post("/v1/chat/completions", json=payload,
                          headers={"Origin": "https://malicious.com"})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["type"] == "invalid_origin"

    passed = client.post("/v1/chat/completions", json=payload,
                         headers={"Origin": "http://localhost:3000"})
    assert passed.status_code == 413
