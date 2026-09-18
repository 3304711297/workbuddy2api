"""空/空白模型名归一化、非流式确定性 4xx 不重试、非流式错误体形状（2026-09-18）。

背景（现场实测，图吧工具箱 AI 服务探活报 400 的复盘）：
1. 客户端「测试连接」常发 `model: ""`（自定义提供商模型列表为空时）；
   上游对空模型名一律返回 400 `{"code":11102,"msg":"model [] service info not found"}`。
   网关应把空/空白/缺失模型名归一化为 `auto`，让探测得到真实可用性反馈。
2. 非流式路径遇到确定性 4xx 时，`except HTTPException` 会「吞异常续圈」重发同一请求
   （实测一次请求打了上游 3 次，日志中同一 rid 下 3 个不同上游 requestId）。
   只有可重试错误（429/限流 → 切号）才允许继续循环。
3. 非流式错误体经 `raise HTTPException` 被 FastAPI 包成 `{"detail": ...}`，破坏协议形状；
   应为 `{"error": {...}}`（OpenAI）与 `{"type":"error","error":{...}}`（Anthropic）。
"""
import datetime
import json
import time
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

import converter
from converter import (
    CredentialManager,
    _normalize_model_name,
    _openai_error_body,
    _record_rate_limit,
)

_TZ8 = datetime.timezone(datetime.timedelta(hours=8))

_SSE_OK = (
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n'
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
    'data: [DONE]\n\n'
).encode("utf-8")

_UPSTREAM_11102 = {
    "code": 11102,
    "msg": "model [] service info not found",
    "requestId": "4290-6004-abcd-429a-6004b",
    "displayMsg": {"en": "The requested model is not available.", "zh": "当前模型不可用，请切换其他模型后重试。"},
}


@pytest.fixture
def fake_multi_accounts(tmp_path, monkeypatch):
    """两个有效账号 + 干净冷却表（与 test_credential_rotation.py 同构）。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "workbuddy2api"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    acc_file.write_text(json.dumps({
        "active_uid": "uid-alpha",
        "accounts": {
            "uid-alpha": {"auth": {"accessToken": "token-alpha", "expiresAt": int(time.time() * 1000) + 3600000},
                          "account": {"uid": "uid-alpha", "nickname": "阿尔法号"}},
            "uid-beta": {"auth": {"accessToken": "token-beta", "expiresAt": int(time.time() * 1000) + 3600000},
                         "account": {"uid": "uid-beta", "nickname": "贝塔号"}},
        },
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_ROTATOR", None)
    return acc_file


def _patch_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    orig = httpx.AsyncClient

    def mock_async_client(**kw):
        kw["transport"] = transport
        return orig(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)


# ---------------------------------------------------------------------------
# 1. 纯函数：模型名归一化与错误体形状
# ---------------------------------------------------------------------------

def test_normalize_model_name_rules():
    assert _normalize_model_name("") == "auto"
    assert _normalize_model_name("   ") == "auto"
    assert _normalize_model_name(None) == "auto"
    assert _normalize_model_name("auto") == "auto"
    assert _normalize_model_name("glm-5.3") == "glm-5.3"
    # 非空字符串原样保留（不 trim，避免改变既有语义）
    assert _normalize_model_name(" gpt ") == " gpt "


def test_openai_error_body_shape_and_content():
    body = _openai_error_body(json.dumps(_UPSTREAM_11102).encode("utf-8"), 400)
    assert "detail" not in body
    assert body["error"]["code"] == 11102
    # 中文展示文案优先，原始英文 msg 保留可追溯
    assert body["error"]["message"] == _UPSTREAM_11102["displayMsg"]["zh"]
    assert body["error"]["upstream_message"] == _UPSTREAM_11102["msg"]
    assert body["error"]["type"] == "invalid_request_error"

    # 非 JSON 文本兜底不炸
    fallback = _openai_error_body(b"not json at all", 500)
    assert "error" in fallback and fallback["error"]["type"] == "upstream_error"


# ---------------------------------------------------------------------------
# 2. 端到端：空模型名在发往上游前归一化为 auto
# ---------------------------------------------------------------------------

_E2E_CASES = [
    ("/v1/chat/completions", {"model": "", "messages": [{"role": "user", "content": "hi"}]}),
    ("/v1/chat/completions", {"model": "   ", "messages": [{"role": "user", "content": "hi"}]}),
    ("/v1/messages", {"model": "", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}),
    ("/v1/responses", {"model": "", "stream": False,
                       "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]}),
]


@pytest.mark.parametrize("path,payload", _E2E_CASES)
def test_blank_model_name_normalized_before_upstream(fake_multi_accounts, monkeypatch, path, payload):
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "off")
    seen = []

    def mock_handler(request: httpx.Request):
        seen.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, content=_SSE_OK, headers={"Content-Type": "text/event-stream"})

    _patch_client(monkeypatch, mock_handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post(path, json=payload)

    assert res.status_code == 200, res.text[:200]
    assert seen, "上游未被调用"
    assert seen[0]["model"] == "auto", f"{path} 未归一化空模型名：{seen[0].get('model')!r}"


# ---------------------------------------------------------------------------
# 3. 非流式确定性错误：不重试、错误体形状正确、切号语义不受影响
# ---------------------------------------------------------------------------

def test_nonstream_unauthorized_400_not_retried_and_error_shape(fake_multi_accounts, monkeypatch):
    """确定性 400（11102）不得重发：上游只被调用 1 次，错误体为 {"error": {...}}。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")
    calls = []

    def mock_handler(request: httpx.Request):
        calls.append(json.loads(request.content.decode("utf-8")).get("model"))
        return httpx.Response(400, json=_UPSTREAM_11102)

    _patch_client(monkeypatch, mock_handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions", json={"model": "zzz-not-real", "messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 400
    assert len(calls) == 1, f"确定性 400 被重试，上游调用 {len(calls)} 次：{calls}"
    body = res.json()
    assert "detail" not in body, f"错误体仍被 FastAPI 包成 detail：{body}"
    assert body["error"]["code"] == 11102


def test_nonstream_rate_limited_single_account_not_retried(fake_multi_accounts, monkeypatch):
    """限流但无备用账号（failover 返回 None）时同样不得重发。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "failover")
    # 只保留一个账号 → candidates 为空 → failover 返回 None
    monkeypatch.setattr(converter.AccountRotator, "get_candidate_uids_tiered", lambda self, model: ["uid-alpha"])
    calls = []

    def mock_handler(request: httpx.Request):
        calls.append(1)
        return httpx.Response(429, json={"code": 6004, "msg": "请求频率过高，请稍后再试"})

    _patch_client(monkeypatch, mock_handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/chat/completions", json={"model": "glm-5.3", "messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 429
    assert len(calls) == 1, f"无账号可切时仍重发 {len(calls)} 次"


def test_anthropic_nonstream_error_shape(fake_multi_accounts, monkeypatch):
    """Anthropic 端点错误体必须是 {"type":"error","error":{...}}，不得出现 detail 包裹。"""
    cred = CredentialManager()
    monkeypatch.setitem(converter.CONFIG, "cred", cred)
    monkeypatch.setitem(converter.CONFIG, "rotate_mode", "off")

    def mock_handler(request: httpx.Request):
        return httpx.Response(400, json=_UPSTREAM_11102)

    _patch_client(monkeypatch, mock_handler)
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.post("/v1/messages", json={"model": "zzz-not-real", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 400
    body = res.json()
    assert "detail" not in body, f"Anthropic 错误体被 detail 包裹：{body}"
    assert body["type"] == "error" and "error" in body


# ---------------------------------------------------------------------------
# 4. 限流识别的子串误判防护
# ---------------------------------------------------------------------------

def test_rate_limit_code_field_beats_substring_fragments(monkeypatch):
    """结构化报文里 requestId 等 hex 片段含 429/6004 时不得误判为限流。"""
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})

    body = json.dumps(_UPSTREAM_11102)  # requestId 内含 "4290-6004-abcd-429a-6004b"
    _record_rate_limit("m-false", body, uid="u1", status_code=400)
    assert "m-false" not in converter._RATE_LIMIT_STATE
    assert converter._is_account_cooldown("u1", "m-false") is False

    # 真限流（429 状态）仍必须识别
    _record_rate_limit("m-true", '{"code":6004,"msg":"请求频率过高，请稍后再试"}', uid="u1", status_code=429)
    assert converter._is_account_cooldown("u1", "m-true") is True


def test_rate_limit_json_without_code_scans_semantic_fields_only(monkeypatch):
    """JSON 无 code 时只看 msg/message 语义字段，绝不扫描整个序列化 JSON（防 requestId 误伤）。"""
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})

    # 无 code + requestId 含 6004 → 必须判为「非限流」
    _record_rate_limit("m-meta", '{"msg":"model unavailable","requestId":"4290-6004-abcd"}', uid="u2", status_code=400)
    assert "m-meta" not in converter._RATE_LIMIT_STATE
    assert converter._is_account_cooldown("u2", "m-meta") is False

    # 历史格式：无 code，但 msg 明确是限流语义 → 必须识别
    for i, msg in enumerate(('{"msg":"请求频率过高，请稍后再试"}',
                             '{"msg":"6004 使用量超出频率限制"}',
                             '{"message":"429 Too Many Requests"}')):
        _record_rate_limit(f"m-msg{i}", msg, uid="u3", status_code=400)
        assert converter._is_account_cooldown("u3", f"m-msg{i}") is True, f"漏判历史格式：{msg}"


def test_rate_limit_regex_must_not_bypass_signal_gate(monkeypatch):
    """_RATE_LIMIT_RE 命中不得绕过 _is_rate_limit_signal 之外——顶层非限流 code 时
    嵌套 metadata 里的 `code:6004 + 重置时间` 结构绝不许写入假冷却（外部复核发现的 P2 残留）。

    旧实现在 `_RATE_LIMIT_RE.search()` 命中时直接落状态、从不调用 signal 判据，
    于是顶层 code=11102 的确定性错误只要携带这类嵌套结构就会污染 _RATE_LIMIT_STATE 与
    _ACCOUNT_COOLDOWNS，后续调度会莫名避让该账号。
    """
    monkeypatch.setattr(converter, "_RATE_LIMIT_STATE", {})
    monkeypatch.setattr(converter, "_ACCOUNT_COOLDOWNS", {})

    nested = json.dumps({
        "code": 11102,
        "msg": "model unavailable",
        "details": {"code": 6004, "msg": "将在 2099-01-01 12:00:00 UTC+8 重置"},
    }, ensure_ascii=False)
    assert converter._is_rate_limit_signal(400, nested) is False
    _record_rate_limit("m-nested", nested, uid="u-nested", status_code=400)
    assert "m-nested" not in converter._RATE_LIMIT_STATE, "嵌套 code=6004 结构污染了限流状态"
    assert converter._is_account_cooldown("u-nested", "m-nested") is False, "账号被假冷却"

    # 真限流（顶层 code=6004 且带精确重置时间）仍必须落状态且解析出 resetAtMs
    real = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2099-01-01 12:00:00 UTC+8 重置"}'
    _record_rate_limit("m-real", real, uid="u-real", status_code=400)
    entry = converter._RATE_LIMIT_STATE.get("m-real")
    assert entry is not None, "真限流未被记录"
    expect_ms = int(datetime.datetime.strptime("2099-01-01 12:00:00", "%Y-%m-%d %H:%M:%S")
                    .replace(tzinfo=_TZ8).timestamp() * 1000)
    assert entry["resetAtMs"] == expect_ms, "精确重置时间未被解析"


def test_anthropic_error_type_follows_official_status_mapping():
    """Anthropic 错误 type 必须按官方状态映射（含 401/413/429/504/529），不得一律 api_error。"""
    from converter import _anthropic_error_body

    cases = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
             404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error",
             500: "api_error", 504: "timeout_error", 529: "overloaded_error"}
    for status, expected in cases.items():
        body = _anthropic_error_body(b'{"code":6004,"msg":"\xe9\xa2\x91\xe7\x8e\x87\xe9\x99\x90\xe5\x88\xb6"}', status)
        assert body["type"] == "error"
        assert body["error"]["type"] == expected, f"HTTP {status} 应为 {expected}，实为 {body['error']['type']}"
