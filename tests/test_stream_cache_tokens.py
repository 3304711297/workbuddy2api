"""契约测试：**裸流式**（`_stream_upstream`）的成功落盘也必须带上缓存读数。

为什么单独一个文件
------------------
`tests/test_usage_cache_tokens.py` 用「接线次数 == 4」锁覆盖面，但那个计数**数错了对象**：
它把 `_safe_stream_upstream`（带 tools 的伪流式）算作「流式落盘点」，
而真正承载绝大多数流量的 **`_stream_upstream`**（chat 无工具流式 / messages 流式 /
responses 流式三条端点共用）从未接线。

实测证据（生产 `usage/usage.jsonl`，同一模型 `glm-5.3-flash`、同为 ok=true）：
  · 非流式行 → 带 `cache_read_tokens` / `cache_write_tokens`
  · 流式行   → **无这两个键**
即「同一个模型，走流式就丢字段」——上一轮修复声称覆盖「四个成功落盘点」，实际漏了
承载最多流量的那一个。计数式断言给了假安全感：它数的是**别处**的接线。

本文件用**直接行为**锁住，而不是数调用次数：给 `_stream_upstream` 喂一段带 cache 读数的
SSE，断言落盘行里真的出现这两个键。
"""

import asyncio
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


@pytest.fixture()
def usage_file(tmp_path, monkeypatch):
    p = tmp_path / "usage.jsonl"
    monkeypatch.setitem(converter.CONFIG, "usage_log", str(p))
    monkeypatch.setattr(converter, "_USAGE_RING_SOURCE", None)
    converter._USAGE_RING.clear()
    monkeypatch.setattr(converter, "_USAGE_RING_POS", 0)
    yield p
    monkeypatch.setattr(converter, "_USAGE_RING_SOURCE", None)
    converter._USAGE_RING.clear()
    monkeypatch.setattr(converter, "_USAGE_RING_POS", 0)


def _last(p) -> dict:
    lines = [l for l in io.open(p, encoding="utf-8").read().splitlines() if l.strip()]
    assert lines, "usage.jsonl 未写入任何行"
    return json.loads(lines[-1])


def _sse(usage_payload: dict) -> bytes:
    """一段合法 SSE：正文 + finish_reason + usage + [DONE]。"""
    chunks = [
        {"id": "c1", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "好"}}]},
        {"id": "c1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
         "usage": usage_payload},
    ]
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks)
    return (body + "data: [DONE]\n\n").encode("utf-8")


def _install_stream(monkeypatch, payload: bytes):
    """把上游流替换成给定的 SSE 字节流。"""
    class Resp:
        status_code = 200
        headers = {}

        async def aiter_bytes(self):
            yield payload

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    class Client:
        def stream(self, *a, **kw):
            return Resp()

    class Ctx:
        async def __aenter__(self):
            return Client()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(converter, "_shared_client_ctx", lambda timeout=None: Ctx())


def _drive(payload):
    async def _run():
        gen = converter._stream_upstream(
            url="https://api.test/stream", headers={},
            body={"model": "glm-5.3-flash"}, model_name="glm-5.3-flash",
        )
        async for _ in gen:
            pass
    asyncio.run(_run())


# --------------------------------------------------------------------------
# 主契约：裸流式成功落盘必须带 cache 读数
# --------------------------------------------------------------------------

def test_stream_success_records_prompt_cache_hit_tokens(usage_file, monkeypatch):
    """上游流式下发了 prompt_cache_hit_tokens → 落盘行必须带 cache_read_tokens。"""
    _install_stream(monkeypatch, _sse({
        "prompt_tokens": 120, "completion_tokens": 8, "total_tokens": 128,
        "prompt_cache_hit_tokens": 640, "prompt_cache_write_tokens": 32,
    }))
    _drive(None)

    rec = _last(usage_file)
    assert rec["ok"] is True
    assert rec.get("cache_read_tokens") == 640, (
        "裸流式（_stream_upstream）成功落盘丢了 cache 读数 —— "
        "同一模型走流式与非流式会出现不一致的账"
    )
    assert rec.get("cache_write_tokens") == 32


def test_stream_success_records_nested_cached_tokens(usage_file, monkeypatch):
    """嵌套命名（prompt_tokens_details.cached_tokens）在流式路径同样要认。"""
    _install_stream(monkeypatch, _sse({
        "prompt_tokens": 120, "completion_tokens": 8,
        "prompt_tokens_details": {"cached_tokens": 512},
    }))
    _drive(None)
    assert _last(usage_file).get("cache_read_tokens") == 512


def test_stream_missing_cache_does_not_synthesize_zero(usage_file, monkeypatch):
    """上游流式没给 cache 读数 → **不得写键**（缺失 ≠ 未命中，否则命中率出现假分母）。"""
    _install_stream(monkeypatch, _sse({"prompt_tokens": 120, "completion_tokens": 8}))
    _drive(None)
    rec = _last(usage_file)
    assert "cache_read_tokens" not in rec
    assert "cache_write_tokens" not in rec


def test_stream_explicit_zero_is_preserved(usage_file, monkeypatch):
    """上游明确给 0（确实未命中）必须原样落盘。"""
    _install_stream(monkeypatch, _sse({
        "prompt_tokens": 120, "completion_tokens": 8,
        "prompt_cache_hit_tokens": 0, "prompt_cache_write_tokens": 0,
    }))
    _drive(None)
    rec = _last(usage_file)
    assert rec.get("cache_read_tokens") == 0
    assert rec.get("cache_write_tokens") == 0


# --------------------------------------------------------------------------
# 防「只补一条路径」：三条共用 _stream_upstream 的端点都要经它落盘
# --------------------------------------------------------------------------

def test_stream_cache_is_injected_by_single_funnel():
    """cache 读数由 `_stream_upstream` 内的**单一漏斗**统一注入，调用点不得各自接线。

    历史教训：`_stream_upstream` 有 9 个 `_record_usage_once` 出口，上一轮修复
    用「接线次数 == N」的计数断言覆盖，结果整条路径漏接（同一模型走流式无 cache 键、
    走非流式有）。计数式断言的毛病是**它数的可能不是承载流量的那条路径**。
    现在改结构：`_record_usage_once` 内部统一从 `usage` 提取并注入，
    于是「漏接某条出口」在语法上不再可能。
    """
    src = io.open(Path(__file__).resolve().parents[1] / "converter.py",
                  encoding="utf-8").read()
    start = src.index("async def _stream_upstream")
    end = src.index("\nasync def ", start + 1)
    body = src[start:end]

    assert body.count("_record_usage_once(") >= 4, "落盘点数量异常，请核对实现"
    # 漏斗内必须有提取动作
    assert body.count("_cr, _cw = _usage_cache_counts(usage)") == 1, (
        "cache 提取必须且只能在单一漏斗里出现一次"
    )
    assert body.count("cache_read_tokens") >= 1
    # 调用点不得再各自传 cache 参数（否则又回到逐点接线的老路）
    assert "cache_read_tokens=_cr" not in body, (
        "落盘点又出现了逐点接线 —— 请统一走 _record_usage_once 的漏斗"
    )
