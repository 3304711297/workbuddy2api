import pytest
"""converter.py 纯逻辑单测：模型映射 / Host 校验 / 用量统计写盘 / 透传契约。

只测无网络副作用的函数；导入 converter 不启动服务（uvicorn.run 仅在 __main__）。
"""

import json

import converter


# ---------------------------------------------------------------------------
# 模型别名映射
# ---------------------------------------------------------------------------

def test_model_map_aliases():
    assert converter.MODEL_MAP["hy4"] == "hy4-preview"
    assert converter.MODEL_MAP["hy3"] == "hy3-x"
    assert converter.MODEL_MAP["kimi-k3"] == "kimi-k3-1"
    assert converter.MODEL_MAP["minimax-m3"] == "minimax-m3"
    # 已是后端真名的键应幂等
    assert converter.MODEL_MAP["hy4-preview"] == "hy4-preview"


def test_model_map_unknown_passthrough():
    # 调用侧语义：MODEL_MAP.get(name, name) —— 未登记的模型名原样透传
    assert converter.MODEL_MAP.get("glm-5.3", "glm-5.3") == "glm-5.3"


def test_default_models_contract():
    assert len(converter.DEFAULT_MODELS) > 0
    assert len(set(converter.DEFAULT_MODELS)) == len(converter.DEFAULT_MODELS)  # 无重复
    assert "auto" in converter.DEFAULT_MODELS
    assert "hy4-preview" in converter.DEFAULT_MODELS


# ---------------------------------------------------------------------------
# 透传字段白名单契约（GUI/客户端依赖这些字段的可用性）
# ---------------------------------------------------------------------------

def test_passthrough_body_keys_contract():
    expected = {
        "model", "messages", "tools", "tool_choice", "stream",
        "reasoning_effort", "max_tokens", "top_p", "response_format",
    }
    missing = expected - converter.PASSTHROUGH_BODY_KEYS
    assert not missing, f"透传白名单缺少契约字段: {missing}"


# ---------------------------------------------------------------------------
# Host 校验（防 DNS rebinding）
# ---------------------------------------------------------------------------

def test_extract_hostname_basic():
    assert converter._extract_hostname("127.0.0.1:8787") == "127.0.0.1"
    assert converter._extract_hostname("localhost") == "localhost"
    assert converter._extract_hostname("LOCALHOST:80") == "localhost"


def test_extract_hostname_ipv6():
    assert converter._extract_hostname("[::1]:9000") == "::1"
    assert converter._extract_hostname("[::1]") == "::1"
    assert converter._extract_hostname("::1") == "::1"


def test_extract_hostname_foreign():
    # 外部主机名原样返回（由中间件比对白名单后拒绝）
    assert converter._extract_hostname("evil.com:443") == "evil.com"


# ---------------------------------------------------------------------------
# token 数规范化
# ---------------------------------------------------------------------------

def test_usage_int_normalization():
    assert converter._usage_int(None) is None
    assert converter._usage_int(7) == 7
    assert converter._usage_int("12") == 12
    assert converter._usage_int("abc") is None
    assert converter._usage_int(1.9) == 1


# ---------------------------------------------------------------------------
# 用量统计写盘（--usage-log JSONL）
# ---------------------------------------------------------------------------

def test_record_usage_disabled_is_noop():
    # 未启用 --usage-log：不写文件、不抛异常
    converter._record_usage("glm-5.3", True, 0.0, input_tokens=1, output_tokens=2)
    assert converter.CONFIG.get("usage_log") is None  # 默认确实未启用


def test_record_usage_writes_jsonl_line(tmp_path, monkeypatch):
    log = tmp_path / "usage.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(log))
    converter._record_usage(
        "glm-5.3", True, 0.0,
        input_tokens=10, output_tokens=25, ttft_ms=180,
    )
    lines = log.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["model"] == "glm-5.3"
    assert rec["ok"] is True
    assert rec["input_tokens"] == 10
    assert rec["output_tokens"] == 25
    assert rec["ttft_ms"] == 180
    assert rec["error"] is None
    # ts 必须是 epoch 毫秒级整数（读取方按毫秒分桶）
    assert isinstance(rec["ts"], int) and rec["ts"] > 10**12


def test_record_usage_failure_row(tmp_path, monkeypatch):
    log = tmp_path / "usage.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(log))
    converter._record_usage("kimi-k3", False, 0.0, error="HTTP 500")
    rec = json.loads(log.read_text(encoding="utf-8").strip())
    assert rec["ok"] is False
    assert rec["error"] == "HTTP 500"
    # 失败行 token 未知也应显式为 null（契约允许）
    assert rec["output_tokens"] is None


def test_record_usage_failsafe_on_bad_path(monkeypatch):
    # 目录不存在：写盘失败必须静默吞掉，绝不影响请求主流程
    monkeypatch.setitem(
        converter.CONFIG, "usage_log",
        r"Z:\__no_such_dir__\usage.jsonl",
    )
    converter._record_usage("glm-5.3", True, 0.0)  # 不应抛异常


# ---------------------------------------------------------------------------
# 安全与网络边界：回环主机检测
# ---------------------------------------------------------------------------

def test_is_loopback_host():
    assert converter._is_loopback_host("127.0.0.1") is True
    assert converter._is_loopback_host("localhost") is True
    assert converter._is_loopback_host("::1") is True
    assert converter._is_loopback_host("127.0.1.1") is True
    assert converter._is_loopback_host("127.0.0.2") is True
    assert converter._is_loopback_host("127.1.2.3") is True
    assert converter._is_loopback_host("0.0.0.0") is False
    assert converter._is_loopback_host("::") is False
    assert converter._is_loopback_host("192.168.1.100") is False
    assert converter._is_loopback_host("example.com") is False
    assert converter._is_loopback_host("") is False


def test_localhost_only_middleware_allows_loopback_ips():
    from starlette.testclient import TestClient
    client = TestClient(converter.app)

    # 合法回环 IP 均应放行通过（不应被 403 拒绝）
    loopback_hosts = [
        "127.0.0.1:8787",
        "127.0.0.2:8787",
        "127.0.1.1:8787",
        "127.1.2.3:8787",
        "localhost:8787",
        "[::1]:8787",
    ]
    for h in loopback_hosts:
        res = client.get("/health", headers={"Host": h})
        assert res.status_code == 200, f"Host {h} 应被放行，实际状态码: {res.status_code}"

    # 非回环 Host 必须被拦截并返回 403
    forbidden_hosts = [
        "evil.com:8787",
        "192.168.1.100:8787",
        "0.0.0.0:8787",
        "example.org",
    ]
    for h in forbidden_hosts:
        res = client.get("/health", headers={"Host": h})
        assert res.status_code == 403, f"Host {h} 应被拦截，实际状态码: {res.status_code}"
        assert res.json()["error"]["type"] == "invalid_host"


# ---------------------------------------------------------------------------
# 日志脱敏与分级过滤
# ---------------------------------------------------------------------------

def test_sanitize_log_text():
    raw = 'Authorization: Bearer sk-1234567890abcdef and token: "eyJhbGciOiJIUzI1NiJ9.test"'
    clean = converter._sanitize_log_text(raw)
    assert "Bearer ***" in clean
    assert "sk-1234567890abcdef" not in clean
    assert 'token: "***"' in clean


def test_log_levels_filter(tmp_path, monkeypatch):
    log_file = tmp_path / "test.log"
    monkeypatch.setitem(converter.CONFIG, "log_path", str(log_file))

    # 1. 默认 info 级别：忽略 debug 和 trace
    monkeypatch.setitem(converter.CONFIG, "log_level", "info")
    converter._log("info msg", level="info")
    converter._log("debug msg", level="debug")
    converter._log("trace msg", level="trace")

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert "[INFO] info msg" in lines[0]

    # 2. trace 级别：全量捕获
    log_file.unlink()
    monkeypatch.setitem(converter.CONFIG, "log_level", "trace")
    converter._log("info msg", level="info")
    converter._log("debug msg", level="debug")
    converter._log("trace msg", level="trace")

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    assert any("[INFO] info msg" in l for l in lines)
    assert any("[DEBUG] debug msg" in l for l in lines)
    assert any("[TRACE] trace msg" in l for l in lines)


def test_last_user_privacy_logging(tmp_path, monkeypatch):
    log_file = tmp_path / "test.log"
    monkeypatch.setitem(converter.CONFIG, "log_path", str(log_file))

    rid = "req1"
    model_name = "auto"
    client_wants_stream = True
    messages = [{"role": "user", "content": "SUPER_SECRET_USER_MESSAGE"}]
    last_user = converter._last_user_text(messages)
    tool_names = []

    # 1. 默认 info 级别：不记录 last_user 敏感对话
    monkeypatch.setitem(converter.CONFIG, "log_level", "info")
    converter._log(f"[{rid}] ▶ REQUEST {model_name} | stream={client_wants_stream} | msgs={len(messages)}" + (f" | tools={tool_names}" if tool_names else ""))
    if last_user:
        converter._log(f"[{rid}] last_user={converter._truncate(last_user, 60)!r}", level="debug")

    content_info = log_file.read_text(encoding="utf-8")
    assert "SUPER_SECRET_USER_MESSAGE" not in content_info
    assert "▶ REQUEST auto" in content_info

    # 2. debug 级别：记录 last_user
    log_file.unlink()
    monkeypatch.setitem(converter.CONFIG, "log_level", "debug")
    converter._log(f"[{rid}] ▶ REQUEST {model_name} | stream={client_wants_stream} | msgs={len(messages)}" + (f" | tools={tool_names}" if tool_names else ""))
    if last_user:
        converter._log(f"[{rid}] last_user={converter._truncate(last_user, 60)!r}", level="debug")

    content_debug = log_file.read_text(encoding="utf-8")
    assert "SUPER_SECRET_USER_MESSAGE" in content_debug
    assert "[DEBUG]" in content_debug


# ---------------------------------------------------------------------------
# 凭据统一：CredentialManager 优先读取 accounts.json 活跃账号
# ---------------------------------------------------------------------------

def test_credential_manager_reads_accounts_json(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "codebuddy2openai"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    acc_file.write_text(json.dumps({
        "active_uid": "user_unified",
        "accounts": {
            "user_unified": {
                "auth": {"accessToken": "token_from_accounts", "expiresAt": 9999999999999},
                "account": {"uid": "user_unified", "nickname": "Unified User"}
            }
        }
    }, ensure_ascii=False), encoding="utf-8")

    dummy_info = tmp_path / "dummy.info"
    dummy_info.write_text(json.dumps({
        "auth": {"accessToken": "stale_token", "expiresAt": 9999999999999},
        "account": {"uid": "stale_user"}
    }), encoding="utf-8")

    cm = converter.CredentialManager(dummy_info)
    session = cm.get_active_session()
    assert session["account"]["uid"] == "user_unified"
    assert session["auth"]["accessToken"] == "token_from_accounts"
    assert cm.summary()["uid"] == "user_unified"


def test_credential_manager_save_tokens_accounts_json_as_source_of_truth(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "codebuddy2openai"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    acc_file.write_text(json.dumps({
        "active_uid": "user1",
        "accounts": {
            "user1": {
                "auth": {"accessToken": "old_token", "expiresAt": 1000},
                "account": {"uid": "user1", "nickname": "User 1"}
            }
        }
    }, ensure_ascii=False), encoding="utf-8")

    info_file = tmp_path / "test.info"
    info_file.write_text(json.dumps({
        "auth": {"accessToken": "old_token", "expiresAt": 1000},
        "account": {"uid": "user1"}
    }), encoding="utf-8")

    cm = converter.CredentialManager(info_file)
    new_auth = {"accessToken": "new_refreshed_token", "expiresAt": 9999999999}
    cm._save_tokens(new_auth)

    # 验证 accounts.json 真源更新
    updated_acc = json.loads(acc_file.read_text(encoding="utf-8"))
    assert updated_acc["accounts"]["user1"]["auth"]["accessToken"] == "new_refreshed_token"

    # 验证 .info 兼容镜像同步更新
    updated_info = json.loads(info_file.read_text(encoding="utf-8"))
    assert updated_info["auth"]["accessToken"] == "new_refreshed_token"


def test_credential_manager_save_tokens_fails_and_aborts_commit_on_accounts_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "codebuddy2openai"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    acc_file.write_text("invalid json content", encoding="utf-8")

    info_file = tmp_path / "test.info"
    info_file.write_text(json.dumps({
        "auth": {"accessToken": "old_token"},
        "account": {"uid": "user1"}
    }), encoding="utf-8")

    log_file = tmp_path / "test.log"
    monkeypatch.setitem(converter.CONFIG, "log_path", str(log_file))

    cm = converter.CredentialManager(info_file)
    with pytest.raises(RuntimeError, match="写入真源 accounts.json 失败"):
        cm._save_tokens({"accessToken": "new_token"})

    # 日志记录失败告警
    log_content = log_file.read_text(encoding="utf-8")
    assert "写入 accounts.json 失败" in log_content

    # 兼容镜像 .info 绝不提前提交新 Token（保持原子性）
    info_content = json.loads(info_file.read_text(encoding="utf-8"))
    assert info_content["auth"]["accessToken"] == "old_token"


# ---------------------------------------------------------------------------
# /v1/models 动态获取与合并
# ---------------------------------------------------------------------------

def test_merge_model_ids():
    static = ["auto", "hy4-preview", "kimi-k3"]
    dynamic = ["hy4-preview", "deepseek-v3", "glm-5"]
    custom = ["my-custom-model", "kimi-k3"]
    merged = converter._merge_model_ids(static, dynamic, custom)
    assert merged == ["auto", "hy4-preview", "kimi-k3", "deepseek-v3", "glm-5", "my-custom-model"]


def test_list_models_dynamic_merge(tmp_path, monkeypatch):
    import asyncio
    import httpx
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    acc_dir = tmp_path / "codebuddy2openai"
    acc_dir.mkdir(parents=True, exist_ok=True)
    acc_file = acc_dir / "accounts.json"
    acc_file.write_text(json.dumps({
        "active_uid": "u1",
        "accounts": {
            "u1": {
                "auth": {"accessToken": "tok_123"},
                "account": {"uid": "u1"}
            }
        }
    }), encoding="utf-8")

    settings_file = acc_dir / "model_settings.json"
    settings_file.write_text(json.dumps({
        "custom-finetuned-model": {"context_window": 32000}
    }), encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v2/enterprises/personal/models"
        assert request.headers["Authorization"] == "Bearer tok_123"
        return httpx.Response(200, json={
            "code": 0,
            "data": {
                "models": [
                    {"id": "hy4-preview"},
                    {"id": "cloud-new-model"},
                    {"id": "hunyuan-image-v3.0"},
                ]
            }
        })

    monkeypatch.setattr(converter, "_MODELS_TRANSPORT_OVERRIDE", httpx.MockTransport(handler))
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})

    res = asyncio.run(converter.list_models())
    ids = [item["id"] for item in res["data"]]
    assert "auto" in ids
    assert "cloud-new-model" in ids
    assert "custom-finetuned-model" in ids
    assert "hunyuan-image-v3.0" not in ids


def test_models_cache_uid_isolation(tmp_path, monkeypatch):
    """验证动态模型缓存按 UID 严格隔离，不同账号不串读模型矩阵。"""
    import asyncio
    import httpx
    monkeypatch.setattr(converter, "_MODELS_CACHE", {})

    def handler(request: httpx.Request):
        uid = request.headers.get("X-User-Id", "")
        if uid == "user_a":
            models = [{"id": "model-for-a"}]
        elif uid == "user_b":
            models = [{"id": "model-for-b"}]
        else:
            models = [{"id": "model-default"}]
        return httpx.Response(200, json={
            "code": 0,
            "data": {"models": models}
        })

    mock_transport = httpx.MockTransport(handler)

    class DummyCred:
        def __init__(self, uid):
            self.uid = uid
        def get_active_session(self):
            return {
                "auth": {"accessToken": f"token_{self.uid}"},
                "account": {"uid": self.uid}
            }

    # 1. 账号 A 获取模型并缓存
    monkeypatch.setitem(converter.CONFIG, "cred", DummyCred("user_a"))
    res_a = asyncio.run(converter._fetch_remote_models(transport=mock_transport))
    assert res_a == ["model-for-a"]
    assert "user_a" in converter._MODELS_CACHE

    # 2. 立即切换到账号 B，获取模型并缓存，不应命中账号 A 的缓存
    monkeypatch.setitem(converter.CONFIG, "cred", DummyCred("user_b"))
    res_b = asyncio.run(converter._fetch_remote_models(transport=mock_transport))
    assert res_b == ["model-for-b"]
    assert "user_b" in converter._MODELS_CACHE

    # 3. 再次读取账号 A，应命中账号 A 的独立缓存（即使 handler 被禁用）
    monkeypatch.setitem(converter.CONFIG, "cred", DummyCred("user_a"))
    res_a_cached = asyncio.run(converter._fetch_remote_models(transport=None))
    assert res_a_cached == ["model-for-a"]
