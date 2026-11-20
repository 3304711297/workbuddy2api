"""发版前主程序产物校验：拦住「构建成功但无前端」的空壳 exe。

安装包是 LZMA 压缩体，尺寸判据不能套用到 NSIS 包；必须在压缩前检查
src-tauri/target/release/workbuddy2api.exe 本体是否带 dist/assets 资源。
"""

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_build_artifact.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("verify_build_artifact", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_artifact(tmp_path: Path, payload: bytes, asset_name: str = "index-ABC123.js"):
    exe = tmp_path / "workbuddy2api.exe"
    exe.write_bytes(payload)
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / asset_name).write_text("// bundled", encoding="utf-8")
    return exe, assets


def test_assert_payload_entries_accepts_kernel_and_runtime():
    module = _load_module()
    module.assert_payload_entries(
        [
            "workbuddy2api.exe",
            "converter.py",
            "runtime\\python.exe",
            "runtime\\Lib\\site-packages\\fastapi\\__init__.py",
        ]
    )


def test_assert_payload_entries_accepts_forward_slashes():
    module = _load_module()
    module.assert_payload_entries(["converter.py", "runtime/python.exe"])


def test_assert_payload_entries_rejects_missing_kernel():
    """v0.3.0 安装包的真实缺陷：exe 在、内核与运行时都不在。"""
    module = _load_module()
    with pytest.raises(module.ArtifactError, match="converter.py"):
        module.assert_payload_entries(["workbuddy2api.exe", "runtime\\python.exe"])


def test_assert_payload_entries_rejects_missing_runtime():
    module = _load_module()
    with pytest.raises(module.ArtifactError, match="runtime/python.exe"):
        module.assert_payload_entries(["workbuddy2api.exe", "converter.py"])


def test_verify_artifact_accepts_sized_binary_with_embedded_asset(tmp_path):
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"x" * 256 + b"index-ABC123.js")
    assert module.verify_artifact(exe, assets, min_size=128) is None


def test_verify_artifact_rejects_binary_below_min_size(tmp_path):
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"tiny" + b"index-ABC123.js")
    with pytest.raises(module.ArtifactError, match="size"):
        module.verify_artifact(exe, assets, min_size=128)


def test_verify_artifact_rejects_missing_embedded_asset(tmp_path):
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"x" * 256)
    with pytest.raises(module.ArtifactError, match="frontend"):
        module.verify_artifact(exe, assets, min_size=128)


def test_verify_artifact_rejects_empty_assets_dir(tmp_path):
    module = _load_module()
    exe = tmp_path / "workbuddy2api.exe"
    exe.write_bytes(b"x" * 256)
    assets = tmp_path / "assets"
    assets.mkdir()
    with pytest.raises(module.ArtifactError, match="assets"):
        module.verify_artifact(exe, assets, min_size=128)


def test_verify_artifact_checks_baked_build_sha(tmp_path):
    module = _load_module()
    sha = "0123456789abcdef0123456789abcdef01234567"
    exe, assets = _make_artifact(tmp_path, b"x" * 256 + b"index-ABC123.js" + sha.encode())
    assert module.verify_artifact(exe, assets, min_size=128, build_sha=sha) is None
    with pytest.raises(module.ArtifactError, match="sha"):
        module.verify_artifact(exe, assets, min_size=128, build_sha="f" * 40)


def _patch_installer(module, monkeypatch, tmp_path, entries):
    """假装 target/release/bundle/nsis 里有一个 setup.exe，7z 列出的负载由 entries 决定。"""
    bundle = tmp_path / "bundle"
    bundle.mkdir(exist_ok=True)
    (bundle / "workbuddy2api_0.0.0_x64-setup.exe").write_bytes(b"MZ")
    monkeypatch.setattr(module, "DEFAULT_NSIS_DIR", bundle)
    monkeypatch.setattr(module, "_entries_from_7z", lambda setup: entries)


def test_main_uses_ascii_logs_and_exits_zero_for_good_artifact(monkeypatch, tmp_path, capsys):
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"x" * 256 + b"index-ABC123.js")
    monkeypatch.setattr(module, "DEFAULT_EXE", exe)
    monkeypatch.setattr(module, "DEFAULT_ASSETS_DIR", assets)
    monkeypatch.setattr(module, "DEFAULT_MIN_SIZE", 128)
    _patch_installer(module, monkeypatch, tmp_path, ["converter.py", "runtime\\python.exe"])
    monkeypatch.setattr(module, "_current_git_sha", lambda: None)
    assert module.main() == 0
    out = capsys.readouterr().out
    assert "[OK]" in out
    assert out.isascii(), "Windows runner 控制台可能是 cp1252，日志必须纯 ASCII"


def test_main_exits_nonzero_for_empty_shell(monkeypatch, tmp_path, capsys):
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"tiny")
    monkeypatch.setattr(module, "DEFAULT_EXE", exe)
    monkeypatch.setattr(module, "DEFAULT_ASSETS_DIR", assets)
    monkeypatch.setattr(module, "DEFAULT_MIN_SIZE", 128)
    _patch_installer(module, monkeypatch, tmp_path, ["converter.py", "runtime\\python.exe"])
    monkeypatch.setattr(module, "_current_git_sha", lambda: None)
    assert module.main() != 0
    err = capsys.readouterr().err
    assert "[FAIL]" in err
    assert err.isascii(), "失败日志也必须纯 ASCII，避免 cp1252 把构建判死"


def test_main_fails_when_kernel_or_runtime_is_missing_from_installer(monkeypatch, tmp_path, capsys):
    """安装包里没有 converter.py / runtime 时，构建必须失败而不是静默发版。"""
    module = _load_module()
    exe, assets = _make_artifact(tmp_path, b"x" * 256 + b"index-ABC123.js")
    monkeypatch.setattr(module, "DEFAULT_EXE", exe)
    monkeypatch.setattr(module, "DEFAULT_ASSETS_DIR", assets)
    monkeypatch.setattr(module, "DEFAULT_MIN_SIZE", 128)
    _patch_installer(module, monkeypatch, tmp_path, ["workbuddy2api.exe", "converter.py"])
    monkeypatch.setattr(module, "_current_git_sha", lambda: None)
    assert module.main() != 0
    err = capsys.readouterr().err
    assert "runtime/python.exe" in err
    assert err.isascii()
