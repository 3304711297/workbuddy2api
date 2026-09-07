"""针对 WSL 宿主凭据穿透 (PR #7) 与 流式 tool_calls 损坏防御 (Issue #3) 的专用单元测试。"""

import asyncio
import json
from pathlib import Path
import pytest

import converter


# ===========================================================================
# 1. WSL 凭据穿透测试 (PR #7)
# ===========================================================================

def test_is_wsl_detection(monkeypatch):
    monkeypatch.setattr(converter.sys, "platform", "win32")
    assert converter._is_wsl() is False

    monkeypatch.setattr(converter.sys, "platform", "linux")
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu")
    assert converter._is_wsl() is True


def test_wsl_win_local_appdata_finds_user_dir(tmp_path, monkeypatch):
    # 构造假 /mnt/c/Users 目录结构
    c_users = tmp_path / "mnt" / "c" / "Users"
    c_users.mkdir(parents=True)
    user_appdata = c_users / "tester" / "AppData" / "Local"
    user_appdata.mkdir(parents=True)

    # 排除目录
    (c_users / "Public").mkdir()
    (c_users / "Default").mkdir()

    # 将 users_root 指向模拟目录
    monkeypatch.setattr(converter, "_is_wsl", lambda: True)
    monkeypatch.setattr(converter.Path, "home", lambda: tmp_path / "home" / "tester")
    
    # 模拟 _wsl_win_local_appdata
    def mock_wsl_local():
        results = []
        for entry in c_users.iterdir():
            if entry.name.lower() not in {"public", "default", "default user", "all users", "desktop.ini"}:
                local = entry / "AppData" / "Local"
                if local.is_dir():
                    results.append(local)
        return results

    monkeypatch.setattr(converter, "_wsl_win_local_appdata", mock_wsl_local)
    dirs = converter._wsl_win_local_appdata()
    assert user_appdata in dirs


def test_wsl_accounts_file_fallback(tmp_path, monkeypatch):
    # 模拟在 WSL 下且 Linux 本地无 accounts.json 时，能够穿透读取 Windows 宿主 accounts.json
    win_local = tmp_path / "win_local"
    target_acc = win_local / "codebuddy2openai" / "accounts.json"
    target_acc.parent.mkdir(parents=True)
    target_acc.write_text('{"active_uid": "u1", "accounts": {"u1": {}}}', encoding="utf-8")

    monkeypatch.setattr(converter.sys, "platform", "linux")
    monkeypatch.setattr(converter, "_is_wsl", lambda: True)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(converter.Path, "home", lambda: tmp_path / "linux_home")
    monkeypatch.setattr(converter, "_wsl_win_local_appdata", lambda: [win_local])

    found = converter._accounts_file()
    assert found == target_acc


# ===========================================================================
# 2. 流式 tool_calls 损坏校验与伪流式防御测试 (Issue #3)
# ===========================================================================

def test_validate_tool_calls_valid():
    # 正常 tool_calls
    tcs = [
        {"id": "call_1", "type": "function", "function": {"name": "search", "arguments": '{"query":"hermes"}'}},
        {"id": "call_2", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
    ]
    ok, reason = converter._validate_tool_calls(tcs)
    assert ok is True
    assert reason == ""


def test_validate_tool_calls_empty_name():
    # 腾讯后端典型损坏：name 为空字符串
    tcs = [
        {"id": "call_1", "type": "function", "function": {"name": "", "arguments": '{"q":"1"}'}}
    ]
    ok, reason = converter._validate_tool_calls(tcs)
    assert ok is False
    assert "name 为空或缺失" in reason


def test_validate_tool_calls_broken_json():
    # 腾讯后端典型损坏：arguments 分片乱码或未闭合
    tcs = [
        {"id": "call_1", "type": "function", "function": {"name": "fetch", "arguments": '{"query": "unclosed'}}
    ]
    ok, reason = converter._validate_tool_calls(tcs)
    assert ok is False
    assert "不是有效 JSON" in reason


def test_pseudo_stream_response_output():
    # 测试聚合后伪流式输出符合标准 OpenAI SSE
    async def _run():
        collected = {
            "id": "chatcmpl-test-123",
            "model": "deepseek-v4-pro",
            "created": 1700000000,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "query_db", "arguments": '{"limit": 10}'}
                    }]
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

        chunks = []
        async for chunk in converter._pseudo_stream_response(collected, model_name="deepseek-v4-pro"):
            chunks.append(chunk)

        joined = b"".join(chunks).decode("utf-8")
        assert "data: [DONE]" in joined
        assert "query_db" in joined
        assert '\\"limit\\": 10' in joined
        assert '"finish_reason": "tool_calls"' in joined

    asyncio.run(_run())
