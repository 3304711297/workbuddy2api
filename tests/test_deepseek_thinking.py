"""Unit tests for deepseek_thinking module.

Covers:
- is_deepseek_model
- inject_thinking
- backfill_reasoning_content
- edge cases, multi-turn consistency, and 11133 prevention
"""

import pytest
from deepseek_thinking import (
    is_deepseek_model,
    inject_thinking,
    backfill_reasoning_content,
)


class TestIsDeepseekModel:
    def test_standard_deepseek_models(self):
        assert is_deepseek_model("deepseek-v4.1-flash") is True
        assert is_deepseek_model("deepseek-v4-pro") is True
        assert is_deepseek_model("deepseek-chat") is True
        assert is_deepseek_model("deepseek-coder") is True
        assert is_deepseek_model("deepseek-reasoner") is True
        assert is_deepseek_model("deepseek") is True

    def test_case_insensitivity_and_whitespace(self):
        assert is_deepseek_model("DeepSeek-V3") is True
        assert is_deepseek_model("DEEPSEEK-R1") is True
        assert is_deepseek_model("  deepseek-v4-pro  ") is True

    def test_non_deepseek_models(self):
        assert is_deepseek_model("gpt-4o") is False
        assert is_deepseek_model("claude-3-7-sonnet") is False
        assert is_deepseek_model("glm-5.3") is False
        assert is_deepseek_model("hy3") is False
        assert is_deepseek_model("not-deepseek") is False

    def test_empty_or_invalid_inputs(self):
        assert is_deepseek_model("") is False
        assert is_deepseek_model("   ") is False
        assert is_deepseek_model(None) is False
        assert is_deepseek_model(123) is False
        assert is_deepseek_model({}) is False


class TestInjectThinking:
    def test_non_deepseek_model_unmodified(self):
        body = {
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hello"}],
        }
        res = inject_thinking(body)
        assert "thinking" not in res
        assert "reasoning_effort" not in res
        assert res is body

    def test_deepseek_without_thinking_injects_enabled_and_high(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "enabled"}
        assert res["reasoning_effort"] == "high"

    def test_deepseek_preserves_explicit_reasoning_effort(self):
        for effort in ["low", "medium", "high", "xhigh", "max", "ultra"]:
            body = {
                "model": "deepseek-v4-pro",
                "reasoning_effort": effort,
                "messages": [{"role": "user", "content": "hi"}],
            }
            res = inject_thinking(body)
            assert res["thinking"] == {"type": "enabled"}
            assert res["reasoning_effort"] == effort

    def test_deepseek_disabled_removes_reasoning_effort(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "thinking": {"type": "disabled"},
            "reasoning_effort": "high",
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in res

    def test_deepseek_disabled_without_reasoning_effort_remains_clean(self):
        body = {
            "model": "deepseek-v4-pro",
            "thinking": {"type": "disabled"},
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in res

    def test_deepseek_reasoning_effort_disable_maps_to_thinking_disabled(self):
        """当客户端（如 Claude Code / Hermes）传入 reasoning_effort=disable 时，映射为 thinking.disabled。"""
        body = {
            "model": "deepseek-v4.1-flash",
            "reasoning_effort": "disable",
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in res

    def test_deepseek_explicitly_enabled_supplies_missing_effort(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "thinking": {"type": "enabled"},
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "enabled"}
        assert res["reasoning_effort"] == "high"

    def test_deepseek_explicitly_enabled_preserves_effort(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "thinking": {"type": "enabled"},
            "reasoning_effort": "low",
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = inject_thinking(body)
        assert res["thinking"] == {"type": "enabled"}
        assert res["reasoning_effort"] == "low"

    def test_non_dict_body_handled_gracefully(self):
        assert inject_thinking(None) is None
        assert inject_thinking("not a dict") == "not a dict"


class TestBackfillReasoningContent:
    def test_no_messages_or_empty_messages(self):
        body = {"model": "deepseek-v4.1-flash", "messages": []}
        res = backfill_reasoning_content(body)
        assert res["messages"] == []

        body2 = {"model": "deepseek-v4.1-flash"}
        res2 = backfill_reasoning_content(body2)
        assert "messages" not in res2

    def test_only_user_messages_unmodified(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant"},
                {"role": "user", "content": "Hello"},
            ],
        }
        res = backfill_reasoning_content(body)
        assert "reasoning_content" not in res["messages"][0]
        assert "reasoning_content" not in res["messages"][1]

    def test_all_assistant_messages_without_reasoning_unmodified(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "Hi"},
                {"role": "assistant", "content": "Hello!"},
                {"role": "user", "content": "How are you?"},
                {"role": "assistant", "content": "I am doing well."},
            ],
        }
        res = backfill_reasoning_content(body)
        assert "reasoning_content" not in res["messages"][1]
        assert "reasoning_content" not in res["messages"][3]

    def test_backfill_when_one_assistant_has_reasoning_content(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "Question 1"},
                {
                    "role": "assistant",
                    "content": "Answer 1",
                    "reasoning_content": "Thought 1",
                },
                {"role": "user", "content": "Question 2"},
                {"role": "assistant", "content": "Answer 2"},
            ],
        }
        res = backfill_reasoning_content(body)
        # Assistant 1 retains its reasoning_content
        assert res["messages"][1]["reasoning_content"] == "Thought 1"
        # Assistant 2 is backfilled with empty string
        assert res["messages"][3]["reasoning_content"] == ""
        # User messages never get reasoning_content
        assert "reasoning_content" not in res["messages"][0]
        assert "reasoning_content" not in res["messages"][2]

    def test_backfill_when_assistant_has_non_empty_reasoning_field(self):
        body = {
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "user", "content": "Question 1"},
                {
                    "role": "assistant",
                    "content": "Answer 1",
                    "reasoning": "Anthropic style reasoning",
                },
                {"role": "user", "content": "Question 2"},
                {"role": "assistant", "content": "Answer 2"},
            ],
        }
        res = backfill_reasoning_content(body)
        # Assistant 1 fills reasoning_content from reasoning
        assert res["messages"][1]["reasoning_content"] == "Anthropic style reasoning"
        # Assistant 2 is backfilled with ""
        assert res["messages"][3]["reasoning_content"] == ""

    def test_backfill_when_assistant_has_empty_reasoning_content_triggers_consistency(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "Question 1"},
                {"role": "assistant", "content": "Answer 1", "reasoning_content": ""},
                {"role": "user", "content": "Question 2"},
                {"role": "assistant", "content": "Answer 2"},
            ],
        }
        res = backfill_reasoning_content(body)
        assert res["messages"][1]["reasoning_content"] == ""
        assert res["messages"][3]["reasoning_content"] == ""

    def test_backfill_normalizes_none_reasoning_content_to_empty_string(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {
                    "role": "assistant",
                    "content": "Answer 1",
                    "reasoning_content": "Something",
                },
                {"role": "assistant", "content": "Answer 2", "reasoning_content": None},
            ],
        }
        res = backfill_reasoning_content(body)
        assert res["messages"][0]["reasoning_content"] == "Something"
        assert res["messages"][1]["reasoning_content"] == ""

    def test_multi_turn_11133_scenario(self):
        # Simulates 3 turns:
        # turn 1: user + assistant (with reasoning_content)
        # turn 2: user + assistant (without reasoning_content - caused 11133 upstream)
        # turn 3: user + assistant (without reasoning_content)
        # turn 4: user asking new question
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "t1"},
                {"role": "assistant", "content": "a1", "reasoning_content": "r1"},
                {"role": "user", "content": "t2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "t3"},
                {"role": "assistant", "content": "a3"},
                {"role": "user", "content": "t4"},
            ],
        }
        res = backfill_reasoning_content(body)
        assert res["messages"][1]["reasoning_content"] == "r1"
        assert res["messages"][3]["reasoning_content"] == ""
        assert res["messages"][5]["reasoning_content"] == ""
        for idx in (0, 2, 4, 6):
            assert "reasoning_content" not in res["messages"][idx]

    def test_non_dict_body_handled_gracefully(self):
        assert backfill_reasoning_content(None) is None
        assert backfill_reasoning_content(123) == 123
