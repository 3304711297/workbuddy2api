"""契约测试：提示词缓存读数必须落进用量台账。

背景（实测）
------------
上游 CodeBuddy 后端在 usage 里**确实下发**提示词缓存读数，且同一语义有多种命名：
`prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` / `cached_tokens`、
`prompt_cache_write_tokens` / `cache_creation_input_tokens`
（真实样本见 `%LOCALAPPDATA%/workbuddy2api/e2e_response.json`）。

但本仓库此前的用量台账（`usage.jsonl`）**一个 cache 字段都没有**：
`converter.py` 全文不含 `cached_tokens`，`_record_usage` 的行格式里只有
input/output_tokens。结果是同一次请求出现两条不一致的账：

  · **客户端**（Anthropic 出参）看得到 `cache_read_input_tokens`（`anthropic_compat.py` 读了它）；
  · **本机台账**看不到 —— 桌面端的用量看板与缓存命中率分析拿不到任何数据。

本组用例锁三件事：
  1. 上游给了就落盘（三种命名都要认）；
  2. 上游没给**不得合成 0**（缺失 ≠ 未命中，否则缓存命中率出现假分母）；
  3. 四个成功落盘点（chat / messages / responses / 流式）接线齐全，不因路径不同而丢字段。
"""

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import converter  # noqa: E402


@pytest.fixture()
def usage_file(tmp_path, monkeypatch):
    """把用量台账指向临时文件，并复位内存 ring（避免跨用例串味）。"""
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


# --------------------------------------------------------------------------
# 一、取值口径：三种命名都要认（上游同义多命名，实测）
# --------------------------------------------------------------------------

def test_reads_prompt_cache_hit_tokens():
    """首选命名：prompt_cache_hit_tokens。"""
    read, write = converter._usage_cache_counts(
        {"prompt_tokens": 100, "prompt_cache_hit_tokens": 640, "prompt_cache_write_tokens": 32}
    )
    assert read == 640
    assert write == 32


def test_reads_prompt_tokens_details_cached_tokens():
    """嵌套命名：prompt_tokens_details.cached_tokens（OpenAI 风格）。"""
    read, write = converter._usage_cache_counts(
        {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 512}}
    )
    assert read == 512
    assert write is None


def test_reads_flat_cached_tokens_and_cache_creation():
    """兜底命名：顶层 cached_tokens 与 cache_creation_input_tokens。"""
    read, write = converter._usage_cache_counts(
        {"cached_tokens": 256, "cache_creation_input_tokens": 64}
    )
    assert read == 256
    assert write == 64


def test_prefers_explicit_name_over_nested():
    """两个命名同现时以专用字段为准（不因遍历顺序而抖动）。"""
    read, _ = converter._usage_cache_counts(
        {"prompt_cache_hit_tokens": 700, "prompt_tokens_details": {"cached_tokens": 5}}
    )
    assert read == 700


def test_zero_is_a_real_observation_not_missing():
    """上游明确给 0（确实一次未命中）必须原样保留，不得被当成「没给」。"""
    read, write = converter._usage_cache_counts(
        {"prompt_cache_hit_tokens": 0, "prompt_cache_write_tokens": 0}
    )
    assert read == 0
    assert write == 0


def test_missing_yields_none_not_zero():
    """上游未下发 → None。合成 0 会让缓存命中率统计出现假分母。"""
    assert converter._usage_cache_counts({}) == (None, None)
    assert converter._usage_cache_counts({"prompt_tokens": 10}) == (None, None)
    assert converter._usage_cache_counts(None) == (None, None)
    assert converter._usage_cache_counts("not-a-dict") == (None, None)


def test_non_numeric_and_placeholder_values_are_tolerated():
    """非法值按缺失处理，绝不抛异常（统计腿绝不拖累主流程）。"""
    read, write = converter._usage_cache_counts(
        {"prompt_cache_hit_tokens": "n/a", "prompt_cache_write_tokens": {"x": 1}}
    )
    assert read is None
    assert write is None


# --------------------------------------------------------------------------
# 二、落盘口径：有值才写键
# --------------------------------------------------------------------------

def test_record_usage_writes_cache_fields_when_present(usage_file):
    converter._record_usage("hy4-preview", True, 0.0,
                            input_tokens=100, output_tokens=20,
                            cache_read_tokens=640, cache_write_tokens=32)
    rec = _last(usage_file)
    assert rec["cache_read_tokens"] == 640
    assert rec["cache_write_tokens"] == 32


def test_record_usage_omits_keys_when_absent(usage_file):
    """没拿到就**不写这两个键**——字段存在与否本身就是信息。"""
    converter._record_usage("hy4-preview", True, 0.0, input_tokens=100, output_tokens=20)
    rec = _last(usage_file)
    assert "cache_read_tokens" not in rec
    assert "cache_write_tokens" not in rec


def test_record_usage_keeps_explicit_zero(usage_file):
    """显式 0 必须落盘（与「没给」区分开）。"""
    converter._record_usage("hy4-preview", True, 0.0,
                            input_tokens=100, output_tokens=20,
                            cache_read_tokens=0, cache_write_tokens=0)
    rec = _last(usage_file)
    assert rec["cache_read_tokens"] == 0
    assert rec["cache_write_tokens"] == 0


def test_record_usage_cache_is_independent_of_ok_flag(usage_file):
    """失败路径同样可带 cache 读数（上游报了配额/限流时也可能带 usage）。"""
    converter._record_usage("hy4-preview", False, 0.0, error="HTTP 429",
                            cache_read_tokens=128)
    rec = _last(usage_file)
    assert rec["ok"] is False
    assert rec["cache_read_tokens"] == 128
    assert "cache_write_tokens" not in rec


# --------------------------------------------------------------------------
# 三、接线口径：四个成功落盘点都要带上（防只改一处）
# --------------------------------------------------------------------------

def _source() -> str:
    return io.open(Path(__file__).resolve().parents[1] / "converter.py",
                   encoding="utf-8").read()


def test_all_four_success_paths_wire_cache_counts():
    """chat / messages / responses / 流式 四个成功落盘点都必须提取 cache 读数。

    本仓库的四个落盘点各自独立调用 `_record_usage`；只改一处会留下路径相关的
    静默丢字段（同类历史缺陷：某条路径漏传 ttft_ms）。故在此按调用次数锁死。
    """
    src = _source()
    assert src.count("_cr, _cw = _usage_cache_counts(") == 4, (
        "四个成功落盘点的 cache 提取接线数量不对（应为 4）"
    )
    assert src.count("cache_read_tokens=_cr") == 4


def _helper_slice(src: str) -> str:
    """切出 `_usage_cache_counts` 的定义体（含其 docstring），到下一个顶格 def 为止。"""
    start = src.index("def _usage_cache_counts")
    rest = src[start + 1:]
    end = rest.find("\ndef ")
    return src[start:] if end < 0 else src[start:start + 1 + end]


def test_upstream_field_names_confined_to_helper():
    """上游字段名只允许出现在提取器内部——散落各处会在上游改名时漏改。

    断言「全文件出现次数 == 提取器内部出现次数」，即提取器之外一次都没有。
    不能在别处再写裸字段名，新增命名一律加进提取器。
    """
    src = _source()
    helper = _helper_slice(src)
    for name in ("prompt_cache_hit_tokens", "prompt_cache_write_tokens",
                 "cache_creation_input_tokens", '"cached_tokens"'):
        total = src.count(name)
        inside = helper.count(name)
        assert total > 0, f"提取器里找不到 {name}（契约已失效，请核对实现）"
        assert total == inside, (
            f"{name} 在提取器之外出现了 {total - inside} 次；"
            "上游字段名必须集中在 _usage_cache_counts 里"
        )
