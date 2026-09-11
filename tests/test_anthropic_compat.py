"""Unit tests for Anthropic Messages protocol compatibility layer.

Tests cover:
1. Stateless request translator (translate_anthropic_request)
2. Stateless response translator (translate_openai_response_to_anthropic)
3. Stateful streaming SSE translator (AnthropicStreamTranslator)
"""

from __future__ import annotations

import json
import pytest

from anthropic_compat import (
    translate_anthropic_request,
    translate_openai_response_to_anthropic,
    _strip_attribution,
)
from anthropic_stream import AnthropicStreamTranslator


# ============================================================================
# Helper: Parse SSE events
# ============================================================================

def parse_sse_events(raw_events: list[str]) -> list[dict]:
    """Parse a list of raw SSE event strings into structured dictionaries."""
    parsed = []
    for raw in raw_events:
        lines = [line.strip() for line in raw.strip().splitlines() if line.strip()]
        event_type = None
        data = None
        for line in lines:
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_str = line[5:].strip()
                data = json.loads(data_str)
        if event_type or data:
            parsed.append({"event": event_type, "data": data})
    return parsed


# ============================================================================
# 1. Request Translation Tests
# ============================================================================

class TestTranslateAnthropicRequest:
    """Tests for translate_anthropic_request."""

    def test_basic_text_request(self):
        body = {
            "model": "claude-3-5-sonnet-20241022",
            "messages": [
                {"role": "user", "content": "Hello, world!"}
            ],
            "max_tokens": 1024,
            "temperature": 0.7,
            "stream": False,
        }
        res = translate_anthropic_request(body)
        assert res["model"] == "claude-3-5-sonnet-20241022"
        assert res["max_tokens"] == 1024
        assert res["temperature"] == 0.7
        assert res["stream"] is False
        assert len(res["messages"]) == 1
        assert res["messages"][0] == {"role": "user", "content": "Hello, world!"}

    def test_system_prompt_as_string_with_attribution_stripped(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "system": "x-anthropic-billing-header: cc-attribution-12345\nYou are a helpful coding assistant.",
            "messages": [{"role": "user", "content": "hi"}],
        }
        res = translate_anthropic_request(body)
        assert len(res["messages"]) == 2
        assert res["messages"][0]["role"] == "system"
        assert res["messages"][0]["content"] == "You are a helpful coding assistant."
        assert "x-anthropic-billing-header" not in res["messages"][0]["content"]

    def test_system_prompt_as_list_of_blocks(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: attribution-only"},
                {"type": "text", "text": "Rule 1: Be concise."},
                {"type": "text", "text": "Rule 2: Write clean code."},
            ],
            "messages": [{"role": "user", "content": "test"}],
        }
        res = translate_anthropic_request(body)
        assert res["messages"][0]["role"] == "system"
        assert res["messages"][0]["content"] == "Rule 1: Be concise.\n\nRule 2: Write clean code."
        assert "x-anthropic-billing-header" not in res["messages"][0]["content"]

    def test_system_prompt_only_attribution(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "system": "x-anthropic-billing-header: only-attribution",
            "messages": [{"role": "user", "content": "test"}],
        }
        res = translate_anthropic_request(body)
        # Empty system prompt should not create a system message
        assert len(res["messages"]) == 1
        assert res["messages"][0]["role"] == "user"

    def test_messages_with_text_blocks(self):
        body = {
            "model": "claude-3-5-sonnet-20241022",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Paragraph 1"},
                        {"type": "text", "text": "Paragraph 2"},
                    ],
                }
            ],
        }
        res = translate_anthropic_request(body)
        assert len(res["messages"]) == 1
        assert res["messages"][0]["role"] == "user"
        assert res["messages"][0]["content"] == "Paragraph 1\nParagraph 2"

    def test_assistant_tool_use_translation(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "What is the weather?"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Checking the weather for you."},
                        {
                            "type": "tool_use",
                            "id": "call_weather_1",
                            "name": "get_current_weather",
                            "input": {"city": "Tokyo", "units": "celsius"},
                        },
                    ],
                },
            ],
        }
        res = translate_anthropic_request(body)
        assert len(res["messages"]) == 2
        asst_msg = res["messages"][1]
        assert asst_msg["role"] == "assistant"
        assert asst_msg["content"] == "Checking the weather for you."
        assert "tool_calls" in asst_msg
        assert len(asst_msg["tool_calls"]) == 1
        tc = asst_msg["tool_calls"][0]
        assert tc["id"] == "call_weather_1"
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "get_current_weather"
        parsed_args = json.loads(tc["function"]["arguments"])
        assert parsed_args == {"city": "Tokyo", "units": "celsius"}

    def test_user_tool_result_translation_and_role_order(self):
        """Verify tool_result block converts to role: 'tool' and precedes follow-up user message."""
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {"role": "user", "content": "What is the weather?"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_123",
                            "name": "get_weather",
                            "input": {"city": "London"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_123",
                            "content": "Cloudy, 15°C",
                        },
                        {
                            "type": "text",
                            "text": "What about tomorrow?",
                        },
                    ],
                },
            ],
        }
        res = translate_anthropic_request(body)
        messages = res["messages"]
        assert len(messages) == 4

        # 1. user
        assert messages[0]["role"] == "user"
        # 2. assistant with tool_calls
        assert messages[1]["role"] == "assistant"
        assert messages[1]["tool_calls"][0]["id"] == "call_123"
        # 3. tool message MUST follow immediately after assistant
        assert messages[2]["role"] == "tool"
        assert messages[2]["tool_call_id"] == "call_123"
        assert messages[2]["content"] == "Cloudy, 15°C"
        # 4. user follow-up text
        assert messages[3]["role"] == "user"
        assert messages[3]["content"] == "What about tomorrow?"

    def test_tool_result_with_complex_content(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_json_1",
                            "content": [
                                {"type": "text", "text": "Line 1"},
                                {"type": "text", "text": "Line 2"},
                            ],
                        }
                    ],
                }
            ],
        }
        res = translate_anthropic_request(body)
        assert len(res["messages"]) == 1
        assert res["messages"][0]["role"] == "tool"
        assert res["messages"][0]["tool_call_id"] == "call_json_1"
        assert res["messages"][0]["content"] == "Line 1\nLine 2"

    def test_multimodal_image_translation(self):
        body = {
            "model": "claude-3-5-sonnet-20241022",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Describe this image:"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "iVBORw0KGgoAAAANSUhEUg==",
                            },
                        },
                    ],
                }
            ],
        }
        res = translate_anthropic_request(body)
        user_msg = res["messages"][0]
        assert user_msg["role"] == "user"
        assert isinstance(user_msg["content"], list)
        assert user_msg["content"][0] == {"type": "text", "text": "Describe this image:"}
        assert user_msg["content"][1] == {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="},
        }

    def test_tools_and_tool_choice_mapping(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "calculate 5*5"}],
            "tools": [
                {
                    "name": "calculator",
                    "description": "Perform arithmetic calculations",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "expr": {"type": "string", "description": "Expression"}
                        },
                        "required": ["expr"],
                    },
                }
            ],
            "tool_choice": {"type": "tool", "name": "calculator"},
        }
        res = translate_anthropic_request(body)
        assert "tools" in res
        assert len(res["tools"]) == 1
        t = res["tools"][0]
        assert t["type"] == "function"
        assert t["function"]["name"] == "calculator"
        assert t["function"]["description"] == "Perform arithmetic calculations"
        assert t["function"]["parameters"]["properties"]["expr"]["type"] == "string"

        assert res["tool_choice"] == {
            "type": "function",
            "function": {"name": "calculator"},
        }

    @pytest.mark.parametrize(
        "anthropic_choice, expected_openai",
        [
            ("auto", "auto"),
            ("any", "required"),
            ("none", "none"),
            ({"type": "auto"}, "auto"),
            ({"type": "any"}, "required"),
            ({"type": "none"}, "none"),
        ],
    )
    def test_tool_choice_variants(self, anthropic_choice, expected_openai):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "tool_choice": anthropic_choice,
        }
        res = translate_anthropic_request(body)
        assert res["tool_choice"] == expected_openai

    def test_sampling_and_stop_sequences_passthrough(self):
        body = {
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 512,
            "temperature": 0.2,
            "top_p": 0.95,
            "stop_sequences": ["STOP", "END"],
            "stream": True,
        }
        res = translate_anthropic_request(body)
        assert res["max_tokens"] == 512
        assert res["temperature"] == 0.2
        assert res["top_p"] == 0.95
        assert res["stop"] == ["STOP", "END"]
        assert res["stream"] is True


# ============================================================================
# 2. Response Translation Tests
# ============================================================================

class TestTranslateOpenAIResponseToAnthropic:
    """Tests for translate_openai_response_to_anthropic."""

    def test_standard_text_response(self):
        openai_resp = {
            "id": "chatcmpl-99abc",
            "object": "chat.completion",
            "created": 1700000000,
            "model": "deepseek-v4.1-flash",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Hello there! How can I assist you?",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 15,
                "completion_tokens": 8,
                "total_tokens": 23,
            },
        }
        res = translate_openai_response_to_anthropic(openai_resp)
        assert res["id"] == "msg_99abc"
        assert res["type"] == "message"
        assert res["role"] == "assistant"
        assert res["model"] == "deepseek-v4.1-flash"
        assert res["stop_reason"] == "end_turn"
        assert res["stop_sequence"] is None
        assert res["usage"] == {"input_tokens": 15, "output_tokens": 8}
        assert len(res["content"]) == 1
        assert res["content"][0] == {
            "type": "text",
            "text": "Hello there! How can I assist you?",
        }

    def test_response_with_reasoning_content(self):
        openai_resp = {
            "id": "chatcmpl-think1",
            "model": "deepseek-v4.1-flash",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "reasoning_content": "The user is asking a basic question. I should respond politely.",
                        "content": "Hello! I am ready to help.",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
        }
        res = translate_openai_response_to_anthropic(openai_resp)
        assert len(res["content"]) == 2
        assert res["content"][0] == {
            "type": "thinking",
            "thinking": "The user is asking a basic question. I should respond politely.",
        }
        assert res["content"][1] == {
            "type": "text",
            "text": "Hello! I am ready to help.",
        }

    def test_response_with_tool_calls(self):
        openai_resp = {
            "id": "msg_toolcall_01",
            "model": "deepseek-v4.1-flash",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_fn_1",
                                "type": "function",
                                "function": {
                                    "name": "lookup_user",
                                    "arguments": '{"uid": 1001}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 12, "completion_tokens": 16},
        }
        res = translate_openai_response_to_anthropic(openai_resp)
        assert res["stop_reason"] == "tool_use"
        assert len(res["content"]) == 1
        tool_block = res["content"][0]
        assert tool_block["type"] == "tool_use"
        assert tool_block["id"] == "call_fn_1"
        assert tool_block["name"] == "lookup_user"
        assert tool_block["input"] == {"uid": 1001}

    def test_stop_reason_mapping(self):
        for oai_finish, ant_stop in [
            ("stop", "end_turn"),
            ("length", "max_tokens"),
            ("tool_calls", "tool_use"),
            ("function_call", "tool_use"),
            ("content_filter", "stop_sequence"),
        ]:
            resp = {
                "choices": [
                    {
                        "message": {"content": "ok"},
                        "finish_reason": oai_finish,
                    }
                ]
            }
            res = translate_openai_response_to_anthropic(resp)
            assert res["stop_reason"] == ant_stop


# ============================================================================
# 3. Streaming SSE State Machine Tests
# ============================================================================

class TestAnthropicStreamTranslator:
    """Tests for AnthropicStreamTranslator."""

    def test_text_streaming_event_sequence(self):
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")

        raw_events = []
        raw_events.extend(
            translator.feed_chunk({
                "id": "chatcmpl-test-stream",
                "model": "deepseek-v4.1-flash",
                "choices": [{"delta": {"role": "assistant", "content": "Hello"}}],
            })
        )
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {"content": " world!"}}],
            })
        )
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 3},
            })
        )
        raw_events.extend(translator.feed_line("data: [DONE]"))

        parsed = parse_sse_events(raw_events)
        event_types = [p["event"] for p in parsed]

        # Canonical sequence:
        # message_start -> content_block_start -> content_block_delta -> content_block_delta -> content_block_stop -> message_delta -> message_stop
        assert event_types == [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]

        # Verify message_start payload
        start_msg = parsed[0]["data"]["message"]
        assert start_msg["id"] == "msg_test-stream"
        assert start_msg["model"] == "deepseek-v4.1-flash"
        assert start_msg["role"] == "assistant"

        # Verify content_block_start payload
        assert parsed[1]["data"]["index"] == 0
        assert parsed[1]["data"]["content_block"]["type"] == "text"

        # Verify deltas
        assert parsed[2]["data"]["delta"]["type"] == "text_delta"
        assert parsed[2]["data"]["delta"]["text"] == "Hello"
        assert parsed[3]["data"]["delta"]["text"] == " world!"

        # Verify content_block_stop
        assert parsed[4]["data"]["index"] == 0

        # Verify message_delta
        assert parsed[5]["data"]["delta"]["stop_reason"] == "end_turn"
        assert parsed[5]["data"]["usage"]["output_tokens"] == 3

        # Verify message_stop
        assert parsed[6]["data"]["type"] == "message_stop"

    def test_reasoning_followed_by_text_stream(self):
        """Verify thinking block begins at index 0 and closes cleanly before text starts at index 1."""
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")

        raw_events = []
        # 1. Reasoning chunk
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {"reasoning_content": "Thinking step 1..."}}],
            })
        )
        # 2. Second reasoning chunk
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {"reasoning_content": " step 2."}}],
            })
        )
        # 3. Content chunk (thinking stops, text starts)
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {"content": "Final answer."}}],
            })
        )
        # 4. Finish reason
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 15},
            })
        )
        raw_events.extend(translator.feed_line("data: [DONE]"))

        parsed = parse_sse_events(raw_events)
        types = [p["event"] for p in parsed]

        assert types == [
            "message_start",
            "content_block_start",  # index 0: thinking
            "content_block_delta",  # thinking delta 1
            "content_block_delta",  # thinking delta 2
            "content_block_stop",   # index 0 stop
            "content_block_start",  # index 1: text
            "content_block_delta",  # text delta
            "content_block_stop",   # index 1 stop
            "message_delta",
            "message_stop",
        ]

        # Verify index 0 was thinking
        assert parsed[1]["data"]["index"] == 0
        assert parsed[1]["data"]["content_block"]["type"] == "thinking"
        assert parsed[2]["data"]["delta"]["type"] == "thinking_delta"
        assert parsed[2]["data"]["delta"]["thinking"] == "Thinking step 1..."
        assert parsed[4]["data"]["index"] == 0

        # Verify index 1 was text
        assert parsed[5]["data"]["index"] == 1
        assert parsed[5]["data"]["content_block"]["type"] == "text"
        assert parsed[6]["data"]["delta"]["type"] == "text_delta"
        assert parsed[6]["data"]["delta"]["text"] == "Final answer."
        assert parsed[7]["data"]["index"] == 1

    def test_tool_use_streaming(self):
        """Verify tool_use block start, input_json_delta accumulation, and tool_use stop_reason."""
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")

        raw_events = []
        # Chunk 1: tool call init
        raw_events.extend(
            translator.feed_chunk({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_calc_99",
                                    "type": "function",
                                    "function": {"name": "calculator", "arguments": ""},
                                }
                            ]
                        }
                    }
                ]
            })
        )
        # Chunk 2: tool call args part 1
        raw_events.extend(
            translator.feed_chunk({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": '{"expr": '},
                                }
                            ]
                        }
                    }
                ]
            })
        )
        # Chunk 3: tool call args part 2
        raw_events.extend(
            translator.feed_chunk({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": '"2+2"}'},
                                }
                            ]
                        }
                    }
                ]
            })
        )
        # Chunk 4: finish_reason
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 12},
            })
        )
        raw_events.extend(translator.feed_line("data: [DONE]"))

        parsed = parse_sse_events(raw_events)
        types = [p["event"] for p in parsed]

        assert types == [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]

        # Verify tool block start
        assert parsed[1]["data"]["index"] == 0
        tool_start = parsed[1]["data"]["content_block"]
        assert tool_start["type"] == "tool_use"
        assert tool_start["id"] == "call_calc_99"
        assert tool_start["name"] == "calculator"

        # Verify input_json_delta
        assert parsed[2]["data"]["delta"]["type"] == "input_json_delta"
        assert parsed[2]["data"]["delta"]["partial_json"] == '{"expr": '
        assert parsed[3]["data"]["delta"]["partial_json"] == '"2+2"}'

        # Verify stop reason
        assert parsed[5]["data"]["delta"]["stop_reason"] == "tool_use"

    def test_multiple_tool_calls_stream(self):
        """Verify multiple tool calls in stream increment index and start/stop cleanly."""
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")

        raw_events = []
        # Tool call 0
        raw_events.extend(
            translator.feed_chunk({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "function": {"name": "tool_a", "arguments": '{"a": 1}'},
                                }
                            ]
                        }
                    }
                ]
            })
        )
        # Tool call 1
        raw_events.extend(
            translator.feed_chunk({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 1,
                                    "id": "call_2",
                                    "function": {"name": "tool_b", "arguments": '{"b": 2}'},
                                }
                            ]
                        }
                    }
                ]
            })
        )
        raw_events.extend(
            translator.feed_chunk({
                "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
            })
        )
        raw_events.extend(translator.feed_line("data: [DONE]"))

        parsed = parse_sse_events(raw_events)
        types = [p["event"] for p in parsed]

        # Expect:
        # message_start
        # content_block_start (index 0)
        # content_block_delta (index 0)
        # content_block_stop (index 0)
        # content_block_start (index 1)
        # content_block_delta (index 1)
        # content_block_stop (index 1)
        # message_delta
        # message_stop
        assert types == [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
        assert parsed[1]["data"]["index"] == 0
        assert parsed[3]["data"]["index"] == 0
        assert parsed[4]["data"]["index"] == 1
        assert parsed[6]["data"]["index"] == 1

    def test_feed_line_sse_parsing(self):
        """Verify feed_line properly parses SSE prefix, skips comments/pings, and handles [DONE]."""
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")

        # Comment lines should return empty list
        assert translator.feed_line(": ping") == []
        assert translator.feed_line("") == []

        # Real data chunk
        line = 'data: {"id":"chatcmpl-line","choices":[{"delta":{"content":"Hi"}}]}'
        events = translator.feed_line(line)
        assert len(events) == 3  # message_start + content_block_start + content_block_delta
        # Let's parse them
        parsed = parse_sse_events(events)
        assert parsed[0]["event"] == "message_start"
        assert parsed[1]["event"] == "content_block_start"
        assert parsed[2]["event"] == "content_block_delta"

        # Feed [DONE]
        done_events = translator.feed_line("data: [DONE]")
        done_parsed = parse_sse_events(done_events)
        done_types = [p["event"] for p in done_parsed]
        assert "content_block_stop" in done_types
        assert "message_delta" in done_types
        assert "message_stop" in done_types

    def test_finalize_handles_early_termination(self):
        """Verify finalize closes active blocks and emits message_delta / message_stop if stream cuts."""
        translator = AnthropicStreamTranslator(model="deepseek-v4.1-flash")
        translator.feed_chunk({
            "choices": [{"delta": {"content": "Incomplete sentence..."}}],
        })
        # Premature EOF without finish_reason or [DONE]
        events = translator.finalize()
        parsed = parse_sse_events(events)
        types = [p["event"] for p in parsed]
        assert types == ["content_block_stop", "message_delta", "message_stop"]
        assert parsed[1]["data"]["delta"]["stop_reason"] == "end_turn"

        # Calling finalize again should return empty list (idempotent)
        assert translator.finalize() == []
