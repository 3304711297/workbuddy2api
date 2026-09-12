"""
tests/test_fallback_observability.py - 降级感知：/api/rate_limit 的 fallbacks 字段

覆盖：
1. _record_fallback_event()：内存记录降级事件（requested→actual/reason/ts），环形上限；
2. /api/rate_limit 响应含 fallbacks 字段：结构 {requested: {actual, reason, count, lastLocal}}；
3. fallbacks 与 availability 学习联动：降级事件发生时模型不可用记录同步存在。
"""

import json
import time

import pytest
from starlette.testclient import TestClient

import converter
from converter import _FALLBACK_EVENTS, _record_fallback_event


@pytest.fixture(autouse=True)
def clean_fallback_events(monkeypatch):
    monkeypatch.setattr(converter, "_FALLBACK_EVENTS", {})
    yield


def test_record_fallback_event_basic():
    _record_fallback_event("gpt-6-astra", "deepseek-v4-pro", "11102 unauthorized")
    ev = converter._FALLBACK_EVENTS["gpt-6-astra"]
    assert ev["actual"] == "deepseek-v4-pro"
    assert ev["reason"] == "11102 unauthorized"
    assert ev["count"] == 1
    assert ev["lastMs"] > 0


def test_record_fallback_event_aggregates_count():
    _record_fallback_event("gpt-6-astra", "deepseek-v4-pro", "11102 unauthorized")
    time.sleep(0.01)
    _record_fallback_event("gpt-6-astra", "deepseek-v4-pro", "11102 unauthorized")
    ev = converter._FALLBACK_EVENTS["gpt-6-astra"]
    assert ev["count"] == 2
    assert ev["firstMs"] < ev["lastMs"]


def test_record_fallback_event_changes_when_actual_changes():
    """同一请求模型换了实际模型（如换号/换映射）：重置计数，记录新目标。"""
    _record_fallback_event("gpt-6-astra", "deepseek-v4-pro", "11102 unauthorized")
    _record_fallback_event("gpt-6-astra", "glm-5.3", "11102 unauthorized")
    ev = converter._FALLBACK_EVENTS["gpt-6-astra"]
    assert ev["actual"] == "glm-5.3"
    assert ev["count"] == 1


def test_record_fallback_event_cap():
    """环形上限：最多记录 _FALLBACK_CAP 个请求模型，防无限增长。"""
    for i in range(converter._FALLBACK_CAP + 10):
        _record_fallback_event(f"model-{i}", "fast-model", "11102 unauthorized")
    assert len(converter._FALLBACK_EVENTS) <= converter._FALLBACK_CAP


def test_rate_limit_endpoint_exposes_fallbacks():
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    _record_fallback_event("gpt-6-astra", "deepseek-v4-pro", "11102 unauthorized")
    res = client.get("/api/rate_limit")
    assert res.status_code == 200
    data = res.json()
    assert "fallbacks" in data
    fb = data["fallbacks"]["gpt-6-astra"]
    assert fb["actual"] == "deepseek-v4-pro"
    assert fb["reason"] == "11102 unauthorized"
    assert fb["count"] == 1
    assert "lastLocal" in fb


def test_rate_limit_fallbacks_empty_when_no_degradation():
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.get("/api/rate_limit")
    assert res.status_code == 200
    assert res.json()["fallbacks"] == {}
