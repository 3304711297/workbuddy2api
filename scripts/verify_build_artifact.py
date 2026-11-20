#!/usr/bin/env python3
"""Verify the freshly built Tauri executable is not a frontend-less shell.

The NSIS installer is an LZMA archive; checking its compressed size cannot
prove the main binary embeds the Vite bundle. Run this BEFORE checksum/release.

All log output is intentionally ASCII: Windows runners may still use cp1252.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

DEFAULT_EXE = Path("src-tauri/target/release/workbuddy2api.exe")
DEFAULT_ASSETS_DIR = Path("dist/assets")
DEFAULT_MIN_SIZE = 10 * 1024 * 1024
# 安装包产物目录：NSIS bundler 把 resources 直接压进 setup.exe，**不会**在
# target/release/ 下留副本（2026-11-20 v0.3.1 发版实测：按 staging 目录判会误报）。
DEFAULT_NSIS_DIR = Path("src-tauri/target/release/bundle/nsis")
# tauri-bundler 生成的 NSIS 脚本，7z 不可用时的兜底判据。
NSIS_SCRIPT_DIR = Path("src-tauri/target/release/nsis")
REQUIRED_PAYLOAD = ("converter.py", "runtime/python.exe")


class ArtifactError(RuntimeError):
    pass


def _current_git_sha() -> str | None:
    """Return the full HEAD sha baked by build.rs, or None when unavailable."""
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    if len(sha) == 40 and all(c in "0123456789abcdef" for c in sha.lower()):
        return sha
    return None


def verify_artifact(
    exe: Path,
    assets_dir: Path,
    *,
    min_size: int = DEFAULT_MIN_SIZE,
    build_sha: str | None = None,
) -> None:
    """Raise ArtifactError unless the exe has size, frontend assets and sha."""
    exe = Path(exe)
    assets_dir = Path(assets_dir)
    if not exe.is_file():
        raise ArtifactError(f"artifact not found: {exe}")
    size = exe.stat().st_size
    if size < min_size:
        raise ArtifactError(f"artifact size {size} is below min_size {min_size}")
    data = exe.read_bytes()
    asset_files = sorted(assets_dir.glob("*.js"))
    if not asset_files:
        raise ArtifactError("no js assets found under dist/assets")
    matched = [p.name for p in asset_files if p.name.encode() in data]
    if not matched:
        raise ArtifactError("no frontend asset filename embedded in exe")
    if build_sha and build_sha.encode() not in data:
        raise ArtifactError(f"build sha {build_sha} not embedded in exe")


def _seven_zip_candidates() -> list[str]:
    return [
        "7z",
        "7za",
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
    ]


def _entries_from_7z(setup: Path) -> list[str] | None:
    """List payload entries with 7z (ground truth: what users actually install)."""
    for exe in _seven_zip_candidates():
        try:
            out = subprocess.check_output(
                [exe, "l", "-slt", str(setup)],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="replace",
            )
        except (OSError, subprocess.CalledProcessError):
            continue
        entries = [
            line.split(" = ", 1)[1].strip()
            for line in out.splitlines()
            if line.startswith("Path = ")
        ]
        if entries:
            return entries
    return None


def _entries_from_nsi(script_dir: Path) -> list[str] | None:
    """Fallback when 7z is unavailable: read the generated NSIS script.

    Returns the raw File-directive lines (quotes stripped). Matching is
    substring-based, so both per-file ``File /oname=converter.py "..."`` and
    directory recursion show up.
    """
    scripts = sorted(Path(script_dir).rglob("installer.nsi"))
    if not scripts:
        return None
    text = scripts[-1].read_text(encoding="utf-8", errors="replace")
    lines = [
        line.strip().strip('"')
        for line in text.splitlines()
        if "converter.py" in line or "runtime" in line
    ]
    return lines or None


def assert_payload_entries(entries: list[str]) -> None:
    """Raise unless every required kernel/runtime path appears in the payload."""
    normalized = [str(e).replace("/", "\\").lower() for e in entries]
    missing = [
        rel
        for rel in REQUIRED_PAYLOAD
        if not any(rel.replace("/", "\\").lower() in p for p in normalized)
    ]
    if missing:
        raise ArtifactError(
            "installer payload missing "
            f"{', '.join(missing)} "
            "(run: python scripts/prepare_bundle_runtime.py, then rebuild)"
        )


def verify_installer_payload(bundle_dir: Path = DEFAULT_NSIS_DIR) -> None:
    """Raise unless the produced NSIS installer really carries kernel + runtime.

    Issue #47 was exactly this: every build log green, the solver exe fine, yet the
    installer shipped without converter.py or a Python runtime. Only the installer
    payload proves what users get, because the NSIS bundler does not stage copies
    under target/release/.
    """
    bundle_dir = Path(bundle_dir)
    installers = sorted(bundle_dir.glob("*.exe"))
    if not installers:
        raise ArtifactError(f"installer not found under {bundle_dir}")
    setup = installers[0]
    entries = _entries_from_7z(setup)
    if entries is None:
        entries = _entries_from_nsi(NSIS_SCRIPT_DIR)
    if entries is None:
        raise ArtifactError(
            "cannot inspect installer payload: 7z unavailable and "
            f"{NSIS_SCRIPT_DIR}/**/installer.nsi not found"
        )
    assert_payload_entries(entries)


def main() -> int:
    try:
        verify_artifact(
            DEFAULT_EXE,
            DEFAULT_ASSETS_DIR,
            min_size=DEFAULT_MIN_SIZE,
            build_sha=_current_git_sha(),
        )
        verify_installer_payload(DEFAULT_NSIS_DIR)
    except ArtifactError as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1
    print("[OK] artifact verified: size, frontend assets, build sha, installer payload (kernel+runtime)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
