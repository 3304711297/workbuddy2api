"""测试 upstream-watch 巡检逻辑、源配置校验与失败降级守卫。"""
import json
import sys
from pathlib import Path

import importlib.util
from pathlib import Path

tools_path = Path(__file__).resolve().parents[1] / "tools" / "check-upstream.py"
spec = importlib.util.spec_from_file_location("check_upstream", str(tools_path))
check_upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_upstream)


def test_lint_sources_valid():
    sample = {
        "sources": {
            "test-repo": {
                "name": "测试仓库",
                "repo": "owner/test-repo",
                "last_synced_commit": "12345678",
            }
        }
    }
    assert check_upstream.lint_sources(sample) == []


def test_lint_sources_invalid():
    assert "根节点必须为 JSON 对象" in check_upstream.lint_sources([])[0]
    assert "缺少非空的 'sources' 字典" in check_upstream.lint_sources({})[0]
    bad_cfg = {
        "sources": {
            "bad": {"name": "缺少字段"}
        }
    }
    errs = check_upstream.lint_sources(bad_cfg)
    assert any("缺少必填字段 'repo'" in e for e in errs)
    assert any("缺少必填字段 'last_synced_commit'" in e for e in errs)


def test_check_source_handles_query_failure(monkeypatch):
    # 模拟 api_get 全部返回 None（例如网络异常或 API 403 限额）
    monkeypatch.setattr(check_upstream, "api_get", lambda url, token: None)
    cfg = {
        "repo": "owner/repo",
        "last_synced_commit": "abcdef12",
        "name": "测试"
    }
    res = check_upstream.check_source("test", cfg, "fake-token")
    assert res["status"] == "query_failed"
    assert res["has_update"] is False
    assert res["latest_commit"] == "N/A"


def test_check_source_detects_update(monkeypatch):
    sample_commits = [
        {
            "sha": "9999999912345678",
            "commit": {
                "message": "feat: new feature",
                "committer": {"date": "2026-09-17T00:00:00Z"},
            },
        }
    ]
    monkeypatch.setattr(check_upstream, "api_get", lambda url, token: sample_commits)
    cfg = {
        "repo": "owner/repo",
        "last_synced_commit": "11111111",
        "name": "测试"
    }
    res = check_upstream.check_source("test", cfg, "fake-token")
    assert res["status"] == "updated"
    assert res["has_update"] is True
    assert res["latest_commit"] == "99999999"
    assert "compare/11111111...99999999" in res["compare_url"]


def test_check_source_handles_not_found_and_recovers(monkeypatch):
    # 1. 模拟上游返回 404（删库/私有化）
    monkeypatch.setattr(check_upstream, "api_get", lambda url, token: (None, 404))
    cfg = {
        "repo": "Sliverkiss/workbuddy2api",
        "last_synced_commit": "9a26ae7a",
        "name": "Sliverkiss Go 原版"
    }
    res = check_upstream.check_source("wb2api-upstream-sliverkiss", cfg, "fake-token")
    assert res["status"] == "not_found"
    assert res["has_update"] is False
    assert res["last_commit"] == "9a26ae7a"
    assert res["latest_commit"] == "N/A"
    assert "404" in res["commit_msg"]

    # 2. 模拟后续上游仓库恢复上线并推新提交：无缝恢复看门
    restored_commits = [
        {
            "sha": "bbbbbbbb12345678",
            "commit": {
                "message": "feat: repo restored with update",
                "committer": {"date": "2026-09-25T10:00:00Z"},
            },
        }
    ]
    monkeypatch.setattr(check_upstream, "api_get", lambda url, token: (restored_commits, 200))
    res_restored = check_upstream.check_source("wb2api-upstream-sliverkiss", cfg, "fake-token")
    assert res_restored["status"] == "updated"
    assert res_restored["has_update"] is True
    assert res_restored["last_commit"] == "9a26ae7a"
    assert res_restored["latest_commit"] == "bbbbbbbb"
    assert "compare/9a26ae7a...bbbbbbbb" in res_restored["compare_url"]
