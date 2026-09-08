"""回归测试：X-Device-Token 设备风控头注入（借鉴 xiaofan6ya/workbuddy2api）。

覆盖：
  ① _get_turing_device_token()：子进程成功→返回 token；helper 失败→返回 None（优雅降级）；
     进程内缓存命中（第二次调用不重复起子进程）；
  ② _build_headers_from：token 可用时注入 X-Device-Token；不可用时不注入该键；
  ③ turing_helper.js 文件存在。
全程 mock subprocess，不真实调用 SDK。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


@pytest.fixture()
def _clean_token_cache(monkeypatch):
    monkeypatch.setattr(converter, "_TURING_TOKEN_CACHE", None)
    monkeypatch.setattr(converter, "_TURING_TOKEN_AT", 0.0)
    yield


def test_helper_script_exists():
    helper = Path(__file__).resolve().parents[1] / "turing_helper.cjs"
    assert helper.is_file(), "turing_helper.cjs 必须存在于仓库根（.cjs 后缀规避 package.json type:module）"


def test_token_none_when_helper_fails(monkeypatch, _clean_token_cache):
    """helper 不可用（非0退出/无输出）→ 返回 None，绝不抛异常。"""
    import subprocess as sp

    def fake_run(*a, **k):
        return sp.CompletedProcess(a[0], 1, stdout=b"", stderr=b"boom")

    monkeypatch.setattr(sp, "run", fake_run)
    assert converter._get_turing_device_token() is None


def test_token_cached_second_call(monkeypatch, _clean_token_cache):
    """两次连续调用只应真实起一次子进程（10min 缓存）。"""
    import subprocess as sp

    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        return sp.CompletedProcess(a[0], 0, stdout=b'{"token":"v3:TEST"}', stderr=b"")

    monkeypatch.setattr(sp, "run", fake_run)
    t1 = converter._get_turing_device_token()
    t2 = converter._get_turing_device_token()
    assert t1 == "v3:TEST"
    assert t2 == "v3:TEST"
    assert calls["n"] == 1, "第二次调用必须命中进程内缓存"


def test_headers_inject_device_token(monkeypatch, _clean_token_cache):
    """token 可用 → headers 带 X-Device-Token。"""
    import subprocess as sp

    monkeypatch.setattr(
        sp, "run",
        lambda *a, **k: sp.CompletedProcess(a[0], 0, stdout=b'{"token":"v3:OK"}', stderr=b""),
    )
    cm = converter.CredentialManager.__new__(converter.CredentialManager)
    h = cm._build_headers_from({"accessToken": "t"}, {"uid": "u"})
    assert h.get("X-Device-Token") == "v3:OK"


def test_headers_no_token_key_when_unavailable(monkeypatch, _clean_token_cache):
    """token 不可用 → headers 不应包含 X-Device-Token 键（而非空值）。"""
    import subprocess as sp

    def fake_run(*a, **k):
        return sp.CompletedProcess(a[0], 1, stdout=b"", stderr=b"x")

    monkeypatch.setattr(sp, "run", fake_run)
    cm = converter.CredentialManager.__new__(converter.CredentialManager)
    h = cm._build_headers_from({"accessToken": "t"}, {"uid": "u"})
    assert "X-Device-Token" not in h
