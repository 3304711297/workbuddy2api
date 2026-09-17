"""Run repository pytest with disposable user data and no outbound sockets.

Usage: ./.venv/Scripts/python.exe tests/run_isolated_tests.py [pytest arguments]
Windows asyncio's stdlib socketpair is the sole loopback exception (not HTTP).
"""
import inspect
import os
from pathlib import Path
import socket
import sys
import tempfile


def main():
    with tempfile.TemporaryDirectory(prefix="workbuddy-tests-") as directory:
        for key in list(os.environ):
            if key.startswith(("WORKBUDDY2API_", "CODEBUDDY2OPENAI_", "WORKBUDDY_")):
                del os.environ[key]
        for key in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
            os.environ[key] = directory

        def deny_dns(*args, **kwargs):
            raise AssertionError("Live DNS is disabled in isolated tests")

        socket.getaddrinfo = deny_dns

        def audit(event, args):
            if event in ("socket.connect", "socket.sendto", "socket.getaddrinfo"):
                # Windows implements asyncio's private wakeup socketpair using TCP.
                if event == "socket.connect" and any(
                    f.function == "_fallback_socketpair" and f.filename == socket.__file__
                    for f in inspect.stack()
                ):
                    return
                raise AssertionError(f"Live network is disabled: {event}")

        sys.addaudithook(audit)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import pytest
        import converter

        class Isolation:
            @pytest.fixture(autouse=True)
            def isolate_logs(self, monkeypatch, tmp_path):
                for key in ("log_path", "usage_log", "snapshots_log"):
                    monkeypatch.setitem(converter.CONFIG, key, str(tmp_path / (key + ".jsonl")))

        return pytest.main(sys.argv[1:] or ["tests/", "-q"], plugins=[Isolation()])


if __name__ == "__main__":
    raise SystemExit(main())
