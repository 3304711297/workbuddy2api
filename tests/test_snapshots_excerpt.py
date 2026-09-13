"""R3: 非流式成功点写入响应摘要（resp 不再恒为 None）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter


def test_excerpt_prefers_content():
    collected = {"choices": [{"message": {"content": "hello", "reasoning_content": "think"}}]}
    assert converter._snapshot_excerpt(collected) == "hello"


def test_excerpt_falls_back_to_reasoning_then_dump():
    collected = {"choices": [{"message": {"reasoning_content": "r"}}]}
    assert converter._snapshot_excerpt(collected) == "r"
    collected = {"foo": "bar"}
    assert "bar" in (converter._snapshot_excerpt(collected) or "")


def test_excerpt_garbage_safe():
    assert isinstance(converter._snapshot_excerpt(None), str)
    assert converter._snapshot_excerpt("x") is not None


def test_nonstream_success_sites_pass_excerpt():
    src = Path(converter.__file__).read_text(encoding="utf-8")
    assert src.count("snapshot_resp=_snapshot_excerpt(collected)") >= 3
