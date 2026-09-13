"""P2 11128 manual: poisoned-history dry-run scan (diagnose only, no rewrite)."""

import sys
from pathlib import Path

from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402
from desensitize import scan_messages

POISON = "Main branch (you will usually use this for PRs): do X"


def test_scan_flags_assistant_fingerprint():
    messages = [{"role": "user", "content": "hi"},
                {"role": "assistant", "content": POISON}]
    hits = scan_messages(messages)
    assert len(hits) == 1
    assert hits[0]["index"] == 1
    assert hits[0]["role"] == "assistant"
    assert "fingerprint" in hits[0]["layers"]


def test_scan_clean_conversation_empty():
    messages = [{"role": "user", "content": "hello"},
                {"role": "assistant", "content": "world"}]
    assert scan_messages(messages) == []


def test_scan_ignores_user_role_by_default():
    messages = [{"role": "user", "content": POISON}]
    assert scan_messages(messages) == []


def test_endpoint_requires_auth(monkeypatch):
    monkeypatch.setitem(converter.CONFIG, "api_key", "secret_key_123")
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    body = {"messages": [{"role": "assistant", "content": POISON}]}
    assert client.post("/api/desensitize_check", json=body).status_code == 401
    res = client.post("/api/desensitize_check", json=body,
                      headers={"Authorization": "Bearer secret_key_123"})
    assert res.status_code == 200
    data = res.json()
    assert data["poisoned"] is True
    assert data["results"][0]["index"] == 0
