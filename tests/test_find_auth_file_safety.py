"""find_auth_file 契约测试：收紧对 .info 文件的探测与匹配，防止误读/覆写官方或无关 .info 文件。

背景与安全红线：
1. 原实现 `for f in sorted(d.glob("*.info")): return f` 会贪婪匹配目录下的任何 .info 文件。
   如果官方安装目录或其他工具在该目录下生成非凭据 .info 或带特殊前缀的文件，
   原逻辑会把它当作自己的凭据读取，并在 _write_back 时执行原子替换，导致官方登录态被损坏。
2. 收紧策略：
   - 优先匹配本应用维护的 `workbuddy-desktop.info`；
   - 次优先匹配已知合法凭据命名模式（如标准 uuid/hex 或 `auth.info`、`codebuddy.info`、`user.info`）；
   - 过滤掉明显非凭据特征的文件（如以 `.` 开头的隐藏文件、临时文件、备份文件、非 json 格式等）；
   - 最关键：如果仅找到外部或未知 .info，或者 accounts.json 已经存在并生效，不得将未知 .info 视作可回写目标。
"""
from pathlib import Path
import json
import pytest
import converter


def test_find_auth_file_prefers_workbuddy_desktop_info(tmp_path, monkeypatch):
    """优先选择 workbuddy-desktop.info。"""
    d = tmp_path / "auth"
    d.mkdir(parents=True)
    other = d / "random_account.info"
    other.write_text(json.dumps({"auth": {"accessToken": "other"}}), encoding="utf-8")
    wb = d / "workbuddy-desktop.info"
    wb.write_text(json.dumps({"auth": {"accessToken": "wb"}}), encoding="utf-8")

    monkeypatch.setattr(converter, "auth_dirs", lambda: [d])
    res = converter.find_auth_file()
    assert res == wb


def test_find_auth_file_ignores_hidden_and_temp_files(tmp_path, monkeypatch):
    """忽略以 . 开头的隐藏 .info 或临时/备份 .info 文件。"""
    d = tmp_path / "auth"
    d.mkdir(parents=True)
    hidden = d / ".hidden.info"
    hidden.write_text(json.dumps({"auth": {}}), encoding="utf-8")
    underscore = d / "_internal.info"
    underscore.write_text(json.dumps({"auth": {}}), encoding="utf-8")
    bak_globbed = d / "backup.info.bak"
    bak_globbed.write_text(json.dumps({"auth": {}}), encoding="utf-8")

    monkeypatch.setattr(converter, "auth_dirs", lambda: [d])
    res = converter.find_auth_file()
    assert res is None, f"不应匹配隐藏或临时文件: {res}"


def test_find_auth_file_corrupted_desktop_info_falls_back_or_none(tmp_path, monkeypatch):
    """当 workbuddy-desktop.info 内容损坏（非有效 JSON 或无 token 键）时，不得被直接采用。"""
    d = tmp_path / "auth"
    d.mkdir(parents=True)
    corrupted_wb = d / "workbuddy-desktop.info"
    corrupted_wb.write_text("CORRUPTED_NON_JSON_CONTENT", encoding="utf-8")

    monkeypatch.setattr(converter, "auth_dirs", lambda: [d])
    res = converter.find_auth_file()
    assert res is None, f"损坏的 desktop.info 不得被返回: {res}"


def test_find_auth_file_ignores_non_json_or_invalid_info(tmp_path, monkeypatch):
    """忽略非合法 JSON 格式的 .info 文件（避免将崩溃日志、二进制 dump 或文本标记当成凭据）。"""
    d = tmp_path / "auth"
    d.mkdir(parents=True)
    corrupted = d / "system_crash_dump.info"
    corrupted.write_text("BINARY_DUMP_NOT_JSON: \x00\x01\x02", encoding="utf-8")

    monkeypatch.setattr(converter, "auth_dirs", lambda: [d])
    res = converter.find_auth_file()
    assert res is None, f"非 JSON 文件应被过滤: {res}"


def test_find_auth_file_falls_back_to_valid_json_info(tmp_path, monkeypatch):
    """当不存在 workbuddy-desktop.info 时，安全回退到合法的 .info JSON 凭据文件。"""
    d = tmp_path / "auth"
    d.mkdir(parents=True)
    valid = d / "legacy_auth.info"
    valid.write_text(json.dumps({"auth": {"accessToken": "valid"}}), encoding="utf-8")

    monkeypatch.setattr(converter, "auth_dirs", lambda: [d])
    res = converter.find_auth_file()
    assert res == valid
