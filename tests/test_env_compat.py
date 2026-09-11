"""环境变量兼容层测试：确认项目从 codebuddy2openai 改名到 workbuddy2api 后，
既有的旧环境变量仍有效（旧名兜底），同时新名优先，避免升级后行为静默变化。
"""

import converter
from converter import _env_compat


def test_new_env_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("WORKBUDDY2API_KEY", "new_value")
    monkeypatch.setenv("CODEBUDDY2OPENAI_KEY", "legacy_value")
    assert _env_compat("KEY", "") == "new_value"


def test_legacy_env_still_works_when_new_absent(monkeypatch):
    monkeypatch.delenv("WORKBUDDY2API_KEY", raising=False)
    monkeypatch.setenv("CODEBUDDY2OPENAI_KEY", "legacy_value")
    assert _env_compat("KEY", "") == "legacy_value"


def test_legacy_env_works_when_new_is_empty_string(monkeypatch):
    """空串应视为"未设置"，继续回退旧名（常见于包装脚本 export X=""）。"""
    monkeypatch.setenv("WORKBUDDY2API_KEY", "")
    monkeypatch.setenv("CODEBUDDY2OPENAI_KEY", "legacy_value")
    assert _env_compat("KEY", "") == "legacy_value"


def test_default_returned_when_nothing_set(monkeypatch):
    monkeypatch.delenv("WORKBUDDY2API_KEY", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_KEY", raising=False)
    assert _env_compat("KEY", "fallback") == "fallback"
    assert _env_compat("KEY") == ""


def test_all_suffixes_use_compat_layer(monkeypatch):
    """核心配置项均应经 _env_compat 读取，而不是裸 os.environ.get 旧名。"""
    cases = [
        ("KEY", "api_key"),
        ("LOG_LEVEL", "log_level"),
        ("ROTATE_MODE", "rotate_mode"),
        ("ROTATE_COUNT", "rotate_count"),
        ("MAX_CONCURRENCY", "max_concurrency"),
        ("MIN_INTERVAL_MS", "min_interval_ms"),
        ("REPAIR_STREAM_TOOLS", "repair_stream_tools"),
        ("USAGE_LOG", "usage_log"),
        ("SCAN_ALL_USERS", "scan_all_users"),
        ("LOG_PAYLOADS", "log_payloads"),
        ("REFRESH_INTERVAL", "refresh_interval"),
        ("REFRESH_THRESHOLD", "refresh_threshold"),
    ]
    for suffix, _ in cases:
        monkeypatch.setenv(f"CODEBUDDY2OPENAI_{suffix}", "legacy")
        assert _env_compat(suffix) == "legacy", f"{suffix} 未回退旧名"
        monkeypatch.setenv(f"WORKBUDDY2API_{suffix}", "new")
        assert _env_compat(suffix) == "new", f"{suffix} 未优先新名"
        monkeypatch.delenv(f"WORKBUDDY2API_{suffix}")
        monkeypatch.delenv(f"CODEBUDDY2OPENAI_{suffix}")


def test_no_bare_legacy_reads_remain_in_source():
    """源码中不应再有裸读旧环境变量的写法（除 _env_compat 自身）。"""
    import pathlib

    src = pathlib.Path(converter.__file__).read_text(encoding="utf-8")
    lines = src.splitlines()
    offenders = []
    in_helper = False
    for i, line in enumerate(lines, start=1):
        # 跟踪 _env_compat 函数体（其内部实现本身就要读旧名）
        if line.startswith("def _env_compat("):
            in_helper = True
        elif in_helper and line and not line[0].isspace():
            in_helper = False
        if in_helper:
            continue
        if "CODEBUDDY2OPENAI_" not in line:
            continue
        # 允许：注释、docstring 提及（help 文本/兼容说明）
        if line.lstrip().startswith("#") or "兼容旧名" in line:
            continue
        # 字符串字面量里提及旧名（help 文本）不构成实际读取
        if "os.environ.get" not in line and "os.environ[" not in line:
            continue
        offenders.append(f"{i}: {line.strip()}")
    assert not offenders, "存在裸读旧环境变量的代码：\n" + "\n".join(offenders)
