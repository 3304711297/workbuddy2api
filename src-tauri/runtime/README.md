# 内置 Python 运行时（构建期产物，不入库）

这个目录由 **`scripts/prepare_bundle_runtime.py`** 在打包前填充：

```bash
# 仓库根目录，Windows
python scripts/prepare_bundle_runtime.py
```

脚本会从 astral-sh/python-build-standalone 下载**钉版**的
`cpython-3.12.x+<release>-x86_64-pc-windows-msvc-install_only*.tar.gz`，
校验 sha256，解包到本目录（`runtime/python.exe` + `Lib/site-packages`），
再把 `converter.py` 实际 import 的运行期依赖（fastapi / starlette / uvicorn[standard] / httpx）
装进这套运行时。

## 为什么这里必须有文件

`src-tauri/tauri.conf.json` 的 `bundle.resources` 把本目录整体打进安装包。
tauri-build 的 `copy_resources()` 对**不存在的**资源路径是 fail-closed 的：
目录一旦消失，干净 clone 上的 `cargo test` / `cargo build` 会直接报
`ResourcePathNotFound`。所以保留这个占位说明文件，让目录始终存在。

真正的运行时（解包后约 70MB）由 `.gitignore` 排除，**绝不入库**。
准备脚本在重装时会保留本文件，不会把工作树弄脏。

## 装了它之后

安装包（NSIS）会自带 `converter.py` + 本运行时，因此在**没有源码、没有装 Python**
的机器上装完即可点「启动服务」。Rust 侧解释器解析顺序见
`src-tauri/src/commands/proxy.rs::resolve_python_interpreter` 的文档注释。
