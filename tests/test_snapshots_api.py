"""Task 2: /api/snapshots 查询端点（直调函数，绕过 LocalHostOnlyMiddleware）。"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter
from converter import api_snapshots


@pytest.fixture()
def snap_enabled(tmp_path, monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "snapshots", True)
    monkeypatch.setitem(converter.CONFIG, "snapshots_keep", 200)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(tmp_path / "s.jsonl"))
    monkeypatch.setitem(converter.CONFIG, "api_key", "")


def test_snapshots_endpoint_newest_first(snap_enabled):
    for i in range(3):
        converter._record_snapshot("/v1/chat/completions", "m", True, 0.0,
                                    request_body={"i": i})
    body = asyncio.run(api_snapshots(limit=2))
    assert len(body["snapshots"]) == 2
    assert body["snapshots"][0]["req"]["i"] == 2
    assert body["total"] == 2


def test_snapshots_requires_auth_when_key_set(snap_enabled, monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "api_key", "secret")
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(api_snapshots())
    assert exc_info.value.status_code == 401
    body = asyncio.run(api_snapshots(authorization="Bearer secret"))
    assert "snapshots" in body


def test_snapshots_empty_when_no_file(snap_enabled):
    body = asyncio.run(api_snapshots())
    assert body == {"snapshots": [], "total": 0}
