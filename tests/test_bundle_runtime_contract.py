"""安装包必须自带内核与 Python 运行时的契约（issue #47）。

背景（已复现）：v0.3.0 的 NSIS 安装包用 7z 解包后只有 workbuddy2api.exe +
uninstall.exe + NSIS 插件——既没有 converter.py，也没有任何 Python 运行时，
`src-tauri/tauri.conf.json` 的 bundle 段甚至没有 resources 字段。
于是「无源码、无 Python」的干净机器装完点「启动服务」必然失败。

本文件锁五件事，每一条都对应一个会静默出错的改法：

① bundle.resources 必须是 **map 形态**并显式登记每个内核模块 + runtime 目录。
   list 形态下 `../converter.py` 会被 tauri 落到 `_up_/converter.py`
   （tauri-utils `resource_relpath()` 把 `..` 映射成 `_up_`），而 Rust 侧
   解析的是 `resource_dir()/converter.py` —— 文件在包里、路径却对不上，
   症状与「没打包」完全一样。
② 内核**实际 import** 的本地模块必须全部在清单里。只按文档抄几个名字，
   一旦新增 `xxx.py` 并 import，装完就是 ImportError。
③ 构建期准备脚本必须钉版（tag + 资产名 + sha256）并校验，且拒绝把 tar
   里的绝对路径 / `..` 成员写到运行时目录外。
④ `src-tauri/runtime/` 必须有一个入库的占位文件：tauri-build 的
   `copy_resources` 对**不存在的**资源路径是 fail-closed 的，干净 clone 上
   `cargo test` 会直接失败；而真正的运行时（约 40MB）绝不入库。
⑤ 幂等：已就绪时不得重复下载（CI/本地重复构建不该反复拉 22MB）。
"""

from __future__ import annotations

import ast
import importlib.util
import json
import subprocess
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TAURI_CONF = ROOT / "src-tauri" / "tauri.conf.json"
PREPARE_SCRIPT = ROOT / "scripts" / "prepare_bundle_runtime.py"
RUNTIME_DIR = ROOT / "src-tauri" / "runtime"

# 需求显式点名的内核文件（存在才要求登记）。converter.py 是最小必要项，
# 其余是它的同目录依赖；缺失任意一个，装完就是 ImportError 而不是启动失败提示。
REQUIRED_KERNEL_FILES = (
    "converter.py",
    "anthropic_compat.py",
    "anthropic_stream.py",
    "token_refresher.py",
    "request_pacer.py",
    "desensitize.py",
    "turing_helper.cjs",
)


# ---------------------------------------------------------------------------
# 工具：内核模块的真实依赖图（以源码为准，不抄文档）
# ---------------------------------------------------------------------------
def _local_module_names() -> set[str]:
    """仓库根目录下的内核模块名（converter.py 的同级 .py）。"""
    return {p.stem for p in ROOT.glob("*.py")}


def _imports_of(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def _kernel_dependency_closure() -> tuple[set[str], set[str]]:
    """从 converter.py 出发做传递闭包，返回（本地模块集合, 第三方模块集合）。

    函数内的 import 也算（converter.py 的 desensitize / anthropic_compat 等都是
    延迟导入），所以必须遍历 AST 全树而不是只看文件头。
    """
    local = _local_module_names()
    seen: set[str] = set()
    queue = ["converter"]
    third_party: set[str] = set()
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        for imported in _imports_of(ROOT / f"{name}.py"):
            if imported in local:
                queue.append(imported)
            else:
                third_party.add(imported)
    return seen, third_party


def _tauri_conf() -> dict:
    return json.loads(TAURI_CONF.read_text(encoding="utf-8"))


def _bundle_resources() -> dict[str, str]:
    resources = _tauri_conf()["bundle"].get("resources")
    assert isinstance(resources, dict), (
        "bundle.resources 必须是 map 形态（{源路径: 目标路径}）：list 形态会把 "
        "../converter.py 落到 _up_/converter.py，Rust 侧 resource_dir()/converter.py 找不到"
    )
    return resources


def _load_prepare_module():
    assert PREPARE_SCRIPT.is_file(), f"缺少构建期准备脚本 {PREPARE_SCRIPT}"
    spec = importlib.util.spec_from_file_location("prepare_bundle_runtime", PREPARE_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# ① ② bundle.resources 内容
# ---------------------------------------------------------------------------
def test_bundle_resources_lists_named_kernel_files_at_resource_root():
    resources = _bundle_resources()
    targets = set(resources.values())
    for name in REQUIRED_KERNEL_FILES:
        if not (ROOT / name).is_file():
            continue
        assert name in targets, f"bundle.resources 未把 {name} 打包到资源根目录"
        sources = [src for src, dst in resources.items() if dst == name]
        assert sources == [f"../{name}"], (
            f"{name} 的源路径应为 ../{name}（相对 src-tauri/），实际 {sources}"
        )


def test_bundle_resources_covers_every_local_module_the_kernel_imports():
    local_modules, _ = _kernel_dependency_closure()
    targets = set(_bundle_resources().values())
    missing = sorted(f"{name}.py" for name in local_modules if f"{name}.py" not in targets)
    assert not missing, (
        "converter.py 传递依赖的本地模块没有全部打包，安装包运行时会 ImportError："
        f"{missing}"
    )


def test_bundle_resources_includes_bundled_runtime_dir():
    resources = _bundle_resources()
    assert resources.get("runtime") == "runtime", (
        "bundle.resources 必须包含内置运行时目录（源 runtime → 目标 runtime），"
        f"实际 {resources.get('runtime')!r}"
    )


def test_bundle_resources_never_leak_absolute_machine_paths():
    for src, dst in _bundle_resources().items():
        for value in (src, dst):
            assert ":" not in value and "\\" not in value and not value.startswith("/"), (
                f"资源路径必须是相对 POSIX 路径，实际 {value!r}（机器专属绝对路径不得入库）"
            )


# ---------------------------------------------------------------------------
# ④ 占位文件 + .gitignore
# ---------------------------------------------------------------------------
def test_runtime_dir_has_committed_placeholder_so_cargo_build_succeeds_on_clean_clone():
    readme = RUNTIME_DIR / "README.md"
    assert readme.is_file(), (
        "src-tauri/runtime/ 必须有入库的占位文件：tauri-build 对不存在的资源路径 "
        "fail-closed，干净 clone 上 cargo test 会直接失败"
    )
    text = readme.read_text(encoding="utf-8")
    assert "prepare_bundle_runtime.py" in text, "占位说明必须指向准备脚本，否则没人知道这个目录怎么来"


def test_gitignore_excludes_runtime_payload_but_keeps_placeholder():
    probe = "src-tauri/runtime/python.exe"
    ignored = subprocess.run(
        ["git", "-C", str(ROOT), "check-ignore", "-q", "--", probe],
        capture_output=True,
        text=True,
    )
    assert ignored.returncode == 0, f"{probe} 未被忽略：约 40MB 的运行时会被误提交"

    placeholder = subprocess.run(
        ["git", "-C", str(ROOT), "check-ignore", "-q", "--", "src-tauri/runtime/README.md"],
        capture_output=True,
        text=True,
    )
    assert placeholder.returncode != 0, "占位文件被忽略：干净 clone 上 build.rs 会因缺少 runtime 目录而失败"


# ---------------------------------------------------------------------------
# ③ 准备脚本：钉版 + 校验 + 解包安全 + 幂等
# ---------------------------------------------------------------------------
def test_prepare_script_pins_a_windows_x64_python_312_install_only_asset():
    module = _load_prepare_module()
    asset = module.ASSET_NAME
    assert asset.startswith("cpython-3.12."), f"运行时必须钉 3.12 主线，实际 {asset}"
    assert "x86_64-pc-windows-msvc" in asset, f"必须是 Windows x64 资产，实际 {asset}"
    assert "install_only" in asset, f"必须是 install_only 资产（带 tests/静态库的包会白涨几十 MB），实际 {asset}"
    assert module.PINNED_RELEASE and module.PINNED_RELEASE in asset, (
        "资产名必须带钉住的 release tag，否则同一份代码在不同时间构建出不同运行时"
    )
    assert module.DOWNLOAD_URL == (
        "https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{module.PINNED_RELEASE}/{asset}"
    ), "下载地址必须由钉住的 tag + 资产名拼出（禁止 latest）"
    assert len(module.ASSET_SHA256) == 64 and all(
        c in "0123456789abcdef" for c in module.ASSET_SHA256
    ), "ASSET_SHA256 必须是 64 位小写十六进制"


def test_prepare_script_verifies_archive_sha256_before_extracting(tmp_path):
    module = _load_prepare_module()
    archive = tmp_path / "fake.tar.gz"
    archive.write_bytes(b"not-the-real-asset")
    with pytest.raises(Exception) as excinfo:
        module.verify_archive_sha256(archive, expected="0" * 64)
    message = str(excinfo.value)
    assert "sha256" in message.lower(), f"报错必须点明 sha256 校验失败：{message}"
    assert str(archive) in message or archive.name in message, "报错必须包含出问题的文件路径"

    # 同一个文件，期望值等于真实摘要时必须放行（防止写成恒失败）
    assert module.verify_archive_sha256(archive, expected=module.sha256_file(archive)) == module.sha256_file(archive)


def test_prepare_script_rejects_unsafe_tar_members(tmp_path):
    module = _load_prepare_module()
    archive = tmp_path / "evil.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        payload = b"pwned"
        info = tarfile.TarInfo("python/../../evil.dll")
        info.size = len(payload)
        import io

        tar.addfile(info, io.BytesIO(payload))

    dest = tmp_path / "runtime"
    dest.mkdir()
    with pytest.raises(Exception) as excinfo:
        module.extract_python_runtime(archive, dest)
    assert "不安全" in str(excinfo.value) or "unsafe" in str(excinfo.value).lower()
    assert not (tmp_path / "evil.dll").exists(), "路径穿越成员必须被拒绝且不落盘"


def test_prepare_script_extracts_python_prefix_stripped(tmp_path):
    """tar 顶层是 python/，落地后必须是 runtime/python.exe（Rust 侧就这么找）。"""
    module = _load_prepare_module()
    archive = tmp_path / "fake.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        payload = b"MZ fake interpreter"
        info = tarfile.TarInfo("python/python.exe")
        info.size = len(payload)
        import io

        tar.addfile(info, io.BytesIO(payload))
        info2 = tarfile.TarInfo("python/Lib/os.py")
        info2.size = 1
        tar.addfile(info2, io.BytesIO(b"#"))

    dest = tmp_path / "runtime"
    module.extract_python_runtime(archive, dest)
    assert (dest / "python.exe").is_file(), "解包必须剥掉 tar 的 python/ 前缀"
    assert (dest / "Lib" / "os.py").is_file()


def test_prepare_script_runtime_is_ready_is_idempotent_and_strict(tmp_path):
    module = _load_prepare_module()
    runtime = tmp_path / "runtime"
    assert module.runtime_is_ready(runtime) is False

    # 只放 python.exe：没有依赖也没有清单，必须判未就绪（否则会跳过 pip 安装）
    runtime.mkdir()
    (runtime / "python.exe").write_bytes(b"MZ")
    assert module.runtime_is_ready(runtime) is False

    site = runtime / "Lib" / "site-packages"
    for pkg in ("fastapi", "httpx", "starlette", "uvicorn"):
        (site / pkg).mkdir(parents=True)
    (site / "fastapi" / "__init__.py").write_text("", encoding="utf-8")
    assert module.runtime_is_ready(runtime) is False, "没有清单仍应判未就绪"

    (runtime / module.MANIFEST_NAME).write_text(
        json.dumps(
            {
                "python": module.PINNED_PYTHON_VERSION,
                "release": module.PINNED_RELEASE,
                "asset": module.ASSET_NAME,
                "asset_sha256": module.ASSET_SHA256,
                "packages": list(module.REQUIRED_PACKAGES),
            }
        ),
        encoding="utf-8",
    )
    assert module.runtime_is_ready(runtime) is True

    # 依赖版本/清单漂移（改了 REQUIRED_PACKAGES 但没重跑 pip）必须判未就绪
    (runtime / module.MANIFEST_NAME).write_text(
        json.dumps(
            {
                "python": module.PINNED_PYTHON_VERSION,
                "release": module.PINNED_RELEASE,
                "asset": module.ASSET_NAME,
                "asset_sha256": module.ASSET_SHA256,
                "packages": ["httpx==0.0.1"],
            }
        ),
        encoding="utf-8",
    )
    assert module.runtime_is_ready(runtime) is False


def test_prepare_script_check_mode_fails_closed_with_actionable_message(tmp_path, capsys):
    module = _load_prepare_module()
    code = module.main(["--check", "--runtime-dir", str(tmp_path / "missing")])
    assert code != 0
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "prepare_bundle_runtime" in combined, (
        f"--check 失败时必须告诉用户跑什么命令：{combined!r}"
    )


def test_prepare_script_covers_every_third_party_import_of_the_kernel():
    module = _load_prepare_module()
    _, third_party = _kernel_dependency_closure()
    # 第三方模块 → pip 分发名（同名者直接映射；uvicorn 需要 [standard] 才有 httptools/websockets）
    distribution_for = {
        "fastapi": "fastapi",
        "starlette": "starlette",
        "httpx": "httpx",
        "uvicorn": "uvicorn[standard]",
    }
    kernel_third_party = {m for m in third_party if m in distribution_for}
    assert kernel_third_party, "依赖图解析失败：没有识别到任何第三方 import"

    declared = " ".join(module.REQUIRED_PACKAGES)
    for module_name in sorted(kernel_third_party):
        assert distribution_for[module_name] in declared, (
            f"converter.py 依赖 {module_name}，但准备脚本的 REQUIRED_PACKAGES 里没有 "
            f"{distribution_for[module_name]}：装完会 ImportError"
        )
    for required in ("httpx", "fastapi", "uvicorn[standard]"):
        assert required in declared, f"REQUIRED_PACKAGES 至少必须包含 {required}"


def test_prepare_script_has_no_machine_specific_paths_and_no_latest():
    source = PREPARE_SCRIPT.read_text(encoding="utf-8")
    for bad in ("C:\\Users", "D:\\", "C:/Users", "D:/"):
        assert bad not in source, f"提交物里不得出现机器专属绝对路径：{bad}"
    assert "/latest" not in source, "禁止使用 latest：运行时必须钉版，否则构建不可复现"
