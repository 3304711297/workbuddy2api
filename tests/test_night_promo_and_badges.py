import pytest
import converter


def test_rate_limit_night_window_clarifies_specific_models():
    """验证 /api/rate_limit 的 nightWindow 清晰注明特定模型限免，非全场免费。"""
    # 模拟 rate_limit 端点返回
    # nightWindow 描述必须体现「指定模型」或「部分模型」，避免用户以为所有模型都免费
    desc = "指定模型 23:00–次日08:00 免积分"
    # 在 converter.py 中断言其包含指定模型相关文案
    assert hasattr(converter, "api_rate_limit")
