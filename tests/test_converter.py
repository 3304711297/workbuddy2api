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
    assert converter._is_loopback_host("0.0.0.0") is False
    assert converter._is_loopback_host("::") is False
    assert converter._is_loopback_host("192.168.1.100") is False
    assert converter._is_loopback_host("example.com") is False
    assert converter._is_loopback_host("") is False


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
