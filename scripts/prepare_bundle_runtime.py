#!/usr/bin/env python3
"""为 NSIS 安装包准备内置 Python 运行时 + 内核依赖（issue #47）。

为什么需要它
------------
v0.3.0 的安装包解包后只有 workbuddy2api.exe + uninstall.exe：没有 converter.py，
也没有任何 Python 运行时。用户在**没有源码、没有装 Python** 的干净机器上装完，
点「启动服务」必然失败。修法是随包内置：

    src-tauri/runtime/python.exe        ← python-build-standalone（钉版 + sha256）
    src-tauri/runtime/Lib/site-packages ← fastapi / starlette / uvicorn[standard] / httpx
    <资源根>/converter.py 等内核脚本     ← tauri.conf.json 的 bundle.resources

本脚本只做「准备」这一件事，构建由仓库主自己跑 `npm run tauri build`。

幂等性
------
运行时 + 依赖 + 清单（`.wb2a-runtime.json`）三者齐全时直接跳过，不联网。
改了 REQUIRED_PACKAGES 后清单对不上会自动重装，不会用旧依赖糊过去。

失败时的可行动报错
------------------
- 下载失败：提示代理 / 手动下载 + `--archive` 离线路径；
- sha256 不匹配：点明期望值与实际值（多半是断流或代理劫持）；
- pip 失败：提示镜像源环境变量；
- 非 Windows 主机：明确说明内置资产是 x86_64-pc-windows-msvc，需要在 Windows 上准备。

日志一律纯 ASCII/中文短句，最后一行 `[OK]` / `[FAIL]`，便于 CI 与人工判读。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

# ---------------------------------------------------------------------------
# 钉版（改动必须同步 tests/test_bundle_runtime_contract.py 的断言）
# ---------------------------------------------------------------------------
PINNED_RELEASE = "20261110"
PINNED_PYTHON_VERSION = "3.12.16"
TARGET_TRIPLE = "x86_64-pc-windows-msvc"
# install_only_stripped：只去掉测试套件与调试符号，pip / ssl / sqlite 都在。
# 相比 install_only（47MB 压缩）体积减半，解包后仍可直接 pip install。
ASSET_VARIANT = "install_only_stripped"
ASSET_NAME = (
    f"cpython-{PINNED_PYTHON_VERSION}+{PINNED_RELEASE}-{TARGET_TRIPLE}-{ASSET_VARIANT}.tar.gz"
)
ASSET_SHA256 = "355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc"
DOWNLOAD_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    f"{PINNED_RELEASE}/{ASSET_NAME}"
)

# converter.py 的实际第三方 import：fastapi / starlette / httpx / uvicorn。
# 版本钉死 = 与 `.venv` 下跑过全套测试的版本一致，避免「发版运行时和测试运行时不是一套」。
REQUIRED_PACKAGES = (
    "fastapi==0.142.4",
    "starlette==1.7.0",
    "uvicorn[standard]==0.54.0",
    "httpx==0.28.1",
)
# 依赖装完后必须能 import 这些顶层模块（少一个就是装残了）
IMPORT_SMOKE_MODULES = ("fastapi", "httpx", "starlette", "uvicorn")

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT / "src-tauri" / "runtime"
CACHE_DIR = ROOT / "src-tauri" / "target" / "runtime-cache"
MANIFEST_NAME = ".wb2a-runtime.json"
# tar 顶层前缀（python-build-standalone 的 install_only 资产固定为 python/）
ARCHIVE_PREFIX = "python/"
# 重装时保留的占位文件（入库，见 src-tauri/runtime/README.md）
PRESERVE_ON_RESET = {"README.md"}


class PrepareError(RuntimeError):
    """可预期的失败：消息本身就是给用户看的行动指引。"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive_sha256(archive: Path, expected: str = ASSET_SHA256) -> str:
    """校验归档 sha256；不匹配时抛出可行动报错（含期望值与实际值）。"""
    archive = Path(archive)
    if not archive.is_file():
        raise PrepareError(f"归档不存在：{archive}")
    actual = sha256_file(archive)
    if actual != expected:
        raise PrepareError(
            f"sha256 校验失败：{archive}\n"
            f"  期望 {expected}\n"
            f"  实际 {actual}\n"
            "  多半是下载被截断或被代理改写了内容。删除该文件后重跑本脚本；"
            "若反复失败，改用手动下载：\n"
            f"  {DOWNLOAD_URL}\n"
            "  然后 python scripts/prepare_bundle_runtime.py --archive <下载到的 tar.gz>"
        )
    return actual


def python_exe_path(runtime_dir: Path) -> Path:
    """内置解释器路径。资产固定是 Windows x64，故与宿主平台无关，一律 python.exe。"""
    return Path(runtime_dir) / "python.exe"


def _site_packages(runtime_dir: Path) -> Path:
    return Path(runtime_dir) / "Lib" / "site-packages"


def runtime_is_ready(runtime_dir: Path) -> bool:
    """运行时是否已就绪（幂等判据）。

    三重校验，缺一不可：
      ① python.exe 存在（否则脚本会「已经装好」地跳过，安装包照样起不来）；
      ② 每个依赖的顶层包都已落到 Lib/site-packages（防止 pip 半途失败留下空壳）；
      ③ 清单里的 python/release/asset/sha256/packages 与当前脚本一致
         （改了钉版版本或依赖列表后必须重装，不能拿旧运行时冒充）。
    """
    runtime_dir = Path(runtime_dir)
    if not python_exe_path(runtime_dir).is_file():
        return False
    site_packages = _site_packages(runtime_dir)
    for module in IMPORT_SMOKE_MODULES:
        if not (site_packages / module).exists():
            return False
    manifest_path = runtime_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    expected = {
        "python": PINNED_PYTHON_VERSION,
        "release": PINNED_RELEASE,
        "asset": ASSET_NAME,
        "asset_sha256": ASSET_SHA256,
        "packages": list(REQUIRED_PACKAGES),
    }
    return all(manifest.get(key) == value for key, value in expected.items())


# ---------------------------------------------------------------------------
# 下载 / 解包
# ---------------------------------------------------------------------------
def download_asset(url: str = DOWNLOAD_URL, destination: Path | None = None) -> Path:
    """下载钉版资产到缓存目录；先写 .part 再原子改名，避免半截文件被当成可用归档。"""
    destination = Path(destination or (CACHE_DIR / ASSET_NAME))
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "workbuddy2api-build"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as out:
            shutil.copyfileobj(response, out, 1 << 20)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        partial.unlink(missing_ok=True)
        raise PrepareError(
            f"下载运行时失败：{url}\n  原因：{exc}\n"
            "  排查：① 浏览器能否打开该地址（GitHub Releases 在部分网络下需要代理）；"
            "② 若本机走代理，设置 HTTPS_PROXY 后重跑；"
            "③ 离线环境请手动下载后执行 "
            "python scripts/prepare_bundle_runtime.py --archive <文件路径>"
        ) from exc
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(destination)
    return destination


def _member_relative_path(name: str) -> str | None:
    """把归档成员名归一成 python/ 之后的相对路径；不属于 python/ 的返回 None。"""
    normalized = name.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if not normalized.startswith(ARCHIVE_PREFIX):
        return None
    return normalized[len(ARCHIVE_PREFIX) :]


def _is_unsafe_relative(rel: str) -> bool:
    if ":" in rel:  # Windows 盘符（C:）或 NTFS 数据流
        return True
    parts = PurePosixPath(rel).parts
    return not parts or any(part in ("..", "/") for part in parts)


def extract_python_runtime(archive: Path, destination: Path) -> None:
    """把归档里的 python/* 解包到 destination（剥掉 python/ 前缀）。

    安全性：绝对路径、盘符、`..` 成员一律拒绝——这个归档来自外网，且脚本会在
    CI 的构建机上以仓库权限落盘，路径穿越等于任意写文件。
    """
    archive = Path(archive)
    destination = Path(destination)
    if destination.exists() and not destination.is_dir():
        raise PrepareError(f"目标路径不是目录：{destination}")
    destination.mkdir(parents=True, exist_ok=True)

    with tarfile.open(archive, "r:*") as tar:
        for member in tar.getmembers():
            rel = _member_relative_path(member.name)
            if rel is None:
                continue
            if _is_unsafe_relative(rel):
                raise PrepareError(
                    f"归档包含不安全路径成员，拒绝解包：{member.name!r}（来自 {archive}）"
                )
            if member.issym() or member.islnk():
                raise PrepareError(
                    f"归档包含符号链接成员，拒绝解包：{member.name!r}（无法保证链接目标不出目录）"
                )
            target = destination / rel
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                raise PrepareError(f"无法读取归档成员：{member.name}")
            with source, open(target, "wb") as out:
                shutil.copyfileobj(source, out, 1 << 20)
            if os.name != "nt":
                # Windows 宿主无执行位概念；非 Windows 上保留权限便于普查
                os.chmod(target, member.mode & 0o777 or 0o644)


def reset_runtime_dir(runtime_dir: Path) -> None:
    """清空运行时目录，但保留入库的占位说明（否则会弄脏工作树）。"""
    runtime_dir = Path(runtime_dir)
    if not runtime_dir.exists():
        runtime_dir.mkdir(parents=True, exist_ok=True)
        return
    for entry in runtime_dir.iterdir():
        if entry.name in PRESERVE_ON_RESET:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()


# ---------------------------------------------------------------------------
# 依赖安装
# ---------------------------------------------------------------------------
def _run(cmd: list[str], *, what: str) -> None:
    try:
        completed = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as exc:
        raise PrepareError(f"{what} 无法执行：{exc}") from exc
    if completed.returncode != 0:
        tail = (completed.stdout or "")[-1500:] + (completed.stderr or "")[-2500:]
        raise PrepareError(f"{what} 失败（退出码 {completed.returncode}）：\n{tail.strip()}")


def install_dependencies(python_exe: Path) -> None:
    """把运行期依赖装进内置运行时。

    优先 `python.exe -m pip`（install_only 自带 pip）；没有 pip 时回退 `uv pip install`。
    两条路都失败则抛错，绝不留下「python 在、依赖不在」的半成品。
    """
    base = [
        str(python_exe),
        "-I",
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        "--no-warn-script-location",
    ]
    try:
        _run(base + list(REQUIRED_PACKAGES), what="pip install 运行期依赖")
        return
    except PrepareError as pip_error:
        uv = shutil.which("uv")
        if not uv:
            raise PrepareError(
                f"{pip_error}\n"
                "  内置运行时没有可用的 pip，且 PATH 上找不到 uv。\n"
                "  排查：① 网络能否访问 PyPI（可用 PIP_INDEX_URL 指向镜像）；"
                "② 重跑 python scripts/prepare_bundle_runtime.py --force 重新解包运行时。"
            ) from pip_error
        print("[INFO] pip 不可用，回退 uv pip install", flush=True)
        _run(
            [uv, "pip", "install", "--python", str(python_exe), *REQUIRED_PACKAGES],
            what="uv pip install 运行期依赖",
        )


def verify_runtime_imports(python_exe: Path) -> None:
    """装完必须能 import：把「装残了」挡在打包之前。"""
    code = "import " + ", ".join(IMPORT_SMOKE_MODULES)
    try:
        _run([str(python_exe), "-I", "-c", code], what=f"运行时自检（{code}）")
    except PrepareError as exc:
        raise PrepareError(
            f"{exc}\n  依赖没有真正进到内置运行时：请删除 {python_exe.parent} 后重跑本脚本"
        ) from exc


def write_manifest(runtime_dir: Path) -> None:
    payload = {
        "python": PINNED_PYTHON_VERSION,
        "release": PINNED_RELEASE,
        "asset": ASSET_NAME,
        "asset_sha256": ASSET_SHA256,
        "packages": list(REQUIRED_PACKAGES),
        "source": DOWNLOAD_URL,
    }
    (Path(runtime_dir) / MANIFEST_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _dir_size(path: Path) -> int:
    total = 0
    for entry in Path(path).rglob("*"):
        if entry.is_file():
            total += entry.stat().st_size
    return total


def prepare(runtime_dir: Path, cache_dir: Path, *, archive: Path | None = None) -> Path:
    """把钉版运行时落到 runtime_dir（含依赖与清单），返回 runtime_dir。"""
    runtime_dir = Path(runtime_dir)
    cache_dir = Path(cache_dir)

    if archive is not None:
        source = Path(archive)
        print(f"[INFO] 使用本地归档：{source}", flush=True)
    else:
        cached = cache_dir / ASSET_NAME
        if cached.is_file() and sha256_file(cached) == ASSET_SHA256:
            print(f"[INFO] 命中下载缓存：{cached}", flush=True)
            source = cached
        else:
            print(f"[INFO] 下载 {ASSET_NAME}（{PINNED_PYTHON_VERSION}, {TARGET_TRIPLE}）", flush=True)
            source = download_asset(DOWNLOAD_URL, cached)

    verify_archive_sha256(source)
    print("[INFO] sha256 校验通过", flush=True)

    print(f"[INFO] 解包到 {runtime_dir}", flush=True)
    reset_runtime_dir(runtime_dir)
    extract_python_runtime(source, runtime_dir)

    python_exe = python_exe_path(runtime_dir)
    if not python_exe.is_file():
        raise PrepareError(f"解包后找不到 {python_exe}：归档布局可能变了，请检查 ASSET_NAME/前缀")

    python_exe.chmod(0o755)
    print("[INFO] 安装运行期依赖：" + " ".join(REQUIRED_PACKAGES), flush=True)
    install_dependencies(python_exe)
    verify_runtime_imports(python_exe)
    write_manifest(runtime_dir)
    return runtime_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="准备 NSIS 安装包内置的 Python 运行时（钉版 + sha256 + 运行期依赖）",
    )
    parser.add_argument("--runtime-dir", default=str(RUNTIME_DIR), help="落地目录（默认 src-tauri/runtime）")
    parser.add_argument("--cache-dir", default=str(CACHE_DIR), help="下载缓存目录（默认 src-tauri/target/runtime-cache）")
    parser.add_argument(
        "--archive",
        default=os.environ.get("WORKBUDDY2API_RUNTIME_ARCHIVE") or None,
        help="离线：直接使用已下载的 tar.gz（也接受环境变量 WORKBUDDY2API_RUNTIME_ARCHIVE）",
    )
    parser.add_argument("--check", action="store_true", help="只检查是否就绪，不就绪则以非零退出")
    parser.add_argument("--force", action="store_true", help="忽略已就绪状态，重新解包并重装依赖")
    args = parser.parse_args(argv)

    runtime_dir = Path(args.runtime_dir)

    if not args.force and runtime_is_ready(runtime_dir):
        print(
            f"[OK] 内置运行时已就绪：{runtime_dir}（{_dir_size(runtime_dir) // (1 << 20)} MB）",
            flush=True,
        )
        return 0

    if args.check:
        print(f"[FAIL] 内置运行时未就绪：{runtime_dir}", file=sys.stderr, flush=True)
        print(
            "[HINT] 先运行：python scripts/prepare_bundle_runtime.py",
            file=sys.stderr,
            flush=True,
        )
        return 1

    if os.name != "nt":
        print(
            "[FAIL] 本脚本只能在 Windows 上准备运行期依赖：钉住的资产是 "
            f"{TARGET_TRIPLE}（python.exe），非 Windows 主机无法执行它来 pip install。",
            file=sys.stderr,
            flush=True,
        )
        print("[HINT] 请在 Windows 上运行：python scripts/prepare_bundle_runtime.py", file=sys.stderr, flush=True)
        return 1

    try:
        prepare(runtime_dir, Path(args.cache_dir), archive=args.archive)
    except PrepareError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr, flush=True)
        print("[HINT] 修复后重跑：python scripts/prepare_bundle_runtime.py", file=sys.stderr, flush=True)
        return 1

    print(
        f"[OK] 内置运行时准备完成：{runtime_dir}（{_dir_size(runtime_dir) // (1 << 20)} MB）",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
