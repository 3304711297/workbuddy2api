"""回归测试：脱敏词表品牌词扩张 + 脱敏角色扩张（借鉴 DistPub/workbuddy2api）。

背景：实测 assistant 角色消息（模型自述身份/历史回复）与 system 一样会触发
腾讯 11128 审核拦截；竞争品牌词（Claude/OpenAI/Gemini 等）也是触发源之一。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desensitize  # noqa: E402
import converter  # noqa: E402


def test_brand_terms_in_wordlist():
    """品牌词已入表（长词在前，正则按词长降序编译）。"""
    for term in ("Claude", "OpenAI", "Gemini", "Kimi", "Qwen", "Cursor",
                 "OpenCode", "Anthropic", "agent-identity"):
        assert term in desensitize.SENSITIVE_TERMS, term


def test_desensitize_text_zero_widths_brands():
    text = "I am Claude, made by Anthropic; also try OpenAI Gemini Kimi Qwen Cursor"
    out = desensitize.desensitize_text(text)
    assert out != text, "品牌词必须被零宽处理"
    # 每个品牌词都应被 ZWSP 打断（词首字符后插 ZWSP → 原连续子串不复存在）
    for term in ("Claude", "Anthropic", "OpenAI", "Gemini", "Kimi", "Qwen", "Cursor"):
        assert term not in out, f"{term} 应被打断"
        split = term[0] + desensitize._ZWSP + term[1:]
        assert split in out, f"{term} 应以零宽拆分形式出现"


def test_desensitize_body_covers_assistant_role():
    """chat_completions 的脱敏调用点必须覆盖 assistant 角色（历史回复实测触发拦截）。"""
    import inspect

    src = inspect.getsource(converter)
    call = [l.strip() for l in src.splitlines() if "desensitize_body(body" in l and "def " not in l]
    assert call, "未找到 desensitize_body 调用点"
    assert any('"assistant"' in c for c in call), f"调用点 roles 未含 assistant: {call}"

    # 行为验证：显式传 roles 后 assistant 被脱敏、user 不动
    body = {
        "messages": [
            {"role": "assistant", "content": "I am Claude by Anthropic"},
            {"role": "user", "content": "claude 是什么"},
        ]
    }
    out = converter.desensitize_body(body, roles=("system", "assistant"))
    msgs = out["messages"]
    zw = desensitize._ZWSP
    assert "Claude" not in msgs[0]["content"] and zw in msgs[0]["content"]
    assert "Anthropic" not in msgs[0]["content"]
    assert msgs[1]["content"] == "claude 是什么"
