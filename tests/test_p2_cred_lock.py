"""P2 cred lock: no self-deadlock, refresh double-check, header build outside lock."""

import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402
from converter import CredentialManager


@pytest.fixture()
def acc_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    d = tmp_path / "workbuddy2api"
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(converter, "_get_turing_device_token", lambda: None)
    return d


def _write(d, sessions, active="u1"):
    (d / "accounts.json").write_text(
        json.dumps({"active_uid": active,
                    "accounts": sessions}, ensure_ascii=False), encoding="utf-8")


def _sess(uid, ttl_ms):
    return {"auth": {"accessToken": "tok-" + uid,
                     "expiresAt": int(time.time() * 1000) + ttl_ms},
            "account": {"uid": uid}}


def test_no_self_deadlock_on_empty_accounts(acc_dir, monkeypatch):
    monkeypatch.setattr(converter, "_read_all_accounts", lambda: ("", {}))
    cm = CredentialManager()
    done = {}
    t = threading.Thread(
        target=lambda: done.setdefault("ret", cm.get_headers_for_uid("u1")),
        daemon=True)
    t.start()
    t.join(timeout=5)
    assert not t.is_alive(), "get_headers_for_uid self-deadlock"


def test_concurrent_expired_refreshes_once(acc_dir):
    _write(acc_dir, {"u1": _sess("u1", -1000)})
    cm = CredentialManager()
    calls = {"n": 0}

    def fake_refresh():
        calls["n"] += 1
        time.sleep(0.3)
        s = cm._session()
        new_auth = dict(s["auth"])
        new_auth["expiresAt"] = int(time.time() * 1000) + 3600000
        cm._save_tokens(s, new_auth)

    cm._refresh = fake_refresh
    errs = []

    def work():
        try:
            cm.get_headers()
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=work) for _ in range(8)]
    [t.start() for t in ts]
    [t.join(timeout=20) for t in ts]
    assert not errs
    assert calls["n"] == 1


def test_header_build_not_serialized(acc_dir, monkeypatch):
    _write(acc_dir, {"u1": _sess("u1", 3600000)})
    cm = CredentialManager()
    calls = {"n": 0}

    def slow_token():
        calls["n"] += 1
        time.sleep(0.5)
        return None

    monkeypatch.setattr(converter, "_get_turing_device_token", slow_token)
    t0 = time.time()
    ts = [threading.Thread(target=cm.get_headers) for _ in range(6)]
    [t.start() for t in ts]
    [t.join(timeout=20) for t in ts]
    dt = time.time() - t0
    assert calls["n"] == 6
    assert dt < 2.0, "header build still serialized under lock: %.1fs" % dt
