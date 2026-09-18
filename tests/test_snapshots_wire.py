"""Task 3: 三端点接线（ContextVar 随请求透传，_record_usage 统一落快照）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter


def _fn_body(src, fn):
    return src.split(fn, 1)[1].split("\n@app.", 1)[0]


def test_endpoints_set_snapshot_context():
    src = Path(converter.__file__).read_text(encoding="utf-8")
    for fn in ["async def chat_completions", "async def anthropic_messages",
               "async def openai_responses"]:
        assert "_snap_context(" in _fn_body(src, fn), fn


def test_record_usage_forwards_to_snapshot():
    import inspect
    src = inspect.getsource(converter._record_usage)
    assert "_SNAP_CTX.get(" in src


def test_snapshot_independent_of_usage_log(tmp_path, monkeypatch):
    # 用量未启用时快照仍落盘。
    # 一律经 monkeypatch 改写全局 CONFIG：直接赋值不还原会泄漏给后续用例/测试文件
    # （顺序一变就出现莫名其妙的红/绿），也违反 AGENTS.md 的测试数据隔离铁律。
    monkeypatch.setitem(converter.CONFIG, "usage_log", None)
    monkeypatch.setitem(converter.CONFIG, "snapshots", True)
    monkeypatch.setitem(converter.CONFIG, "snapshots_keep", 200)
    monkeypatch.setitem(converter.CONFIG, "snapshots_log", str(tmp_path / "s.jsonl"))
    token = converter._SNAP_CTX.set(("/v1/chat/completions", {"a": 1}))
    try:
        converter._record_usage("m", True, 0.0)
    finally:
        converter._SNAP_CTX.reset(token)
    lines = (tmp_path / "s.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
