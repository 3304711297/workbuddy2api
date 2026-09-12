#!/usr/bin/env python3
"""三真源同步校验：converter.py GPT_FALLBACK_MAP ↔ billing.rs GPT_PREMARKED。

AGENTS.md「模型可用性三真源同步铁律」的自动执行器：
  ① converter.py 的 GPT_FALLBACK_MAP 键（运行时降级判定 + 预标记）
  ② src-tauri/src/commands/billing.rs 的 GPT_PREMARKED（控制台模型表）
两侧键集必须完全一致（集合等价，不比顺序）。

独立提取两侧源码对拍，不做任何源内引用——这是 2026-09-12 修复的教训：
旧测试断言 GPT_FALLBACK_MAP 键 ⊆ _premarked_unavailable()，而后者就是
set(GPT_FALLBACK_MAP.keys())，自己对自己断言恒真，Rust 侧漂移永远不会红。

用法：
    python scripts/check_premarked_sync.py        # CLI：退出码 0=同步 1=漂移
    pytest tests/test_model_availability.py       # 测试薄壳复用 collect_problems()

只依赖标准库，可在 CI 与本地任意环境直接运行。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONVERTER_PY = ROOT / "converter.py"
BILLING_RS = ROOT / "src-tauri" / "src" / "commands" / "billing.rs"

# GPT_FALLBACK_MAP = { ... }  —— 非贪婪取到行首闭合 }（条目均为单行字符串键值对）
_PY_BLOCK = re.compile(r"^GPT_FALLBACK_MAP\s*=\s*\{(.*?)^\}", re.M | re.S)
_PY_KEY = re.compile(r'"([^"]+)"\s*:')

# const GPT_PREMARKED: &[&str] = &[ ... ];
_RS_BLOCK = re.compile(r"const\s+GPT_PREMARKED\s*:\s*&\[&str\]\s*=\s*&\[(.*?)\];", re.S)
_RS_KEY = re.compile(r'"([^"]+)"')


def _extract(block_re: re.Pattern, key_re: re.Pattern, text: str, what: str) -> list[str]:
    m = block_re.search(text)
    if not m:
        raise LookupError(f"未找到 {what} 定义（锚点丢失或被改名？）")
    return key_re.findall(m.group(1))


def extract_py_fallback_keys(text: str) -> list[str]:
    """从 converter.py 源码提取 GPT_FALLBACK_MAP 键。"""
    return _extract(_PY_BLOCK, _PY_KEY, text, "converter.py GPT_FALLBACK_MAP")


def extract_rs_premarked_keys(text: str) -> list[str]:
    """从 billing.rs 源码提取 GPT_PREMARKED 键。"""
    return _extract(_RS_BLOCK, _RS_KEY, text, "billing.rs GPT_PREMARKED")


def collect_problems(py_text: str, rs_text: str) -> list[str]:
    """核心纯函数：返回漂移问题描述列表，空列表 = 两侧同步。"""
    try:
        py_keys = set(extract_py_fallback_keys(py_text))
        rs_keys = set(extract_rs_premarked_keys(rs_text))
    except LookupError as e:
        return [str(e)]
    problems: list[str] = []
    for k in sorted(py_keys - rs_keys):
        problems.append(f"billing.rs GPT_PREMARKED 缺少 {k!r}（converter.py GPT_FALLBACK_MAP 已有）")
    for k in sorted(rs_keys - py_keys):
        problems.append(f"converter.py GPT_FALLBACK_MAP 缺少 {k!r}（billing.rs GPT_PREMARKED 已有）")
    return problems


def main() -> int:
    problems = collect_problems(
        CONVERTER_PY.read_text(encoding="utf-8"),
        BILLING_RS.read_text(encoding="utf-8"),
    )
    if problems:
        print("✗ 三真源不同步（converter.py GPT_FALLBACK_MAP ↔ billing.rs GPT_PREMARKED）：")
        for p in problems:
            print(f"  - {p}")
        print("修复：新增/删除需授权模型时三处一起改（见 AGENTS.md「模型可用性感知」）。")
        return 1
    print("✓ GPT_FALLBACK_MAP 与 GPT_PREMARKED 键集一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
