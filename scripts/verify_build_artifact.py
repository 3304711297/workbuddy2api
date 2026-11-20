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
# tauri-build 把 bundle.resources 拷到 target/<profile>/ 下（Windows 下该目录就是
# 运行时的 resource_dir）。安装包缺内核/运行时的缺陷在这里拦住。
DEFAULT_STAGING = Path("src-tauri/target/release")
REQUIRED_STAGED_PAYLOAD = ("converter.py", "runtime/python.exe")


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


def verify_bundle_payload(staging: Path) -> None:
    """Raise ArtifactError unless the bundled kernel and runtime were staged.

    tauri-build copies `bundle.resources` into `target/<profile>/`; the NSIS bundler
    then installs that directory next to the exe. A missing `converter.py` or
    `runtime/python.exe` means the installer ships an app whose "start service"
    button can only fail (issue #47), while every build log stays green.
    """
    staging = Path(staging)
    missing = [rel for rel in REQUIRED_STAGED_PAYLOAD if not (staging / rel).is_file()]
    if missing:
        raise ArtifactError(
            "bundled payload missing under "
            f"{staging}: {', '.join(missing)} "
            "(run: python scripts/prepare_bundle_runtime.py, then rebuild)"
        )


def main() -> int:
    try:
        verify_artifact(
            DEFAULT_EXE,
            DEFAULT_ASSETS_DIR,
            min_size=DEFAULT_MIN_SIZE,
            build_sha=_current_git_sha(),
        )
        verify_bundle_payload(DEFAULT_STAGING)
    except ArtifactError as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1
    print("[OK] artifact verified: size, frontend assets, build sha, bundled kernel+runtime")
    return 0


if __name__ == "__main__":
    sys.exit(main())
