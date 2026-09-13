"""P2：/v1/chat/completions 普通流式 → 快照 resp 非空（行为测试）。"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter


def _collected():
    return {
        "id": "chatcmpl-test",
        "model": "m",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": "hello world"}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 2},
    }


def test_pseudo_stream_snapshot_has_resp(tmp_path):
    converter.CONFIG["usage_log"] = None  # 用量关闭也不影响快照腿
    converter.CONFIG["snapshots"] = True
    converter.CONFIG["snapshots_keep"] = 200
    converter.CONFIG["snapshots_log"] = str(tmp_path / "s.jsonl")
    token = converter._SNAP_CTX.set(("/v1/chat/completions", {"model": "m"}))
    try:
        async def drain():
            async for _ in converter._pseudo_stream_response(
                    _collected(), "m", 0.0, rid="test"):
                pass
        asyncio.run(drain())
    finally:
        converter._SNAP_CTX.reset(token)
    rec = json.loads((tmp_path / "s.jsonl").read_text(encoding="utf-8").strip().splitlines()[-1])
    assert rec["endpoint"] == "/v1/chat/completions"
    assert rec["ok"] is True
    assert rec["resp"] == "hello world"
