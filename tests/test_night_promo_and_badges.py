import re
import datetime
import pytest
from starlette.testclient import TestClient
import converter


def test_rate_limit_night_window_clarifies_specific_models():
    """验证 /api/rate_limit 的 nightWindow 清晰注明特定模型限免，非全场免费，且 serverTime 与 UTC+8 对齐。"""
    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    res = client.get("/api/rate_limit")
    assert res.status_code == 200
    data = res.json()

    # 1. nightWindow 结构与文案断言
    nw = data.get("nightWindow", {})
    assert nw.get("active") in (True, False)
    assert nw.get("start") == "23:00"
    assert nw.get("end") == "08:00"
    assert "指定模型" in nw.get("desc", "") or "部分模型" in nw.get("desc", "")
    assert nw.get("scope") == "specific_models"

    # 2. serverTime 格式与东八区 (UTC+8) 时间一致性断言
    st_str = data.get("serverTime")
    assert st_str is not None
    assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", st_str)

    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    now_cst = datetime.datetime.now(tz8)
    parsed_st = datetime.datetime.strptime(st_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz8)
    # 接口返回的 serverTime 与当前 UTC+8 墙钟误差应在 5 秒以内
    diff = abs((now_cst - parsed_st).total_seconds())
    assert diff < 5, f"serverTime {st_str} 未与 UTC+8 墙钟对齐 (diff={diff}s)"
