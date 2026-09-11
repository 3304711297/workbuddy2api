"""Anthropic streaming SSE state machine translator.

Translates OpenAI streaming chunk events (data: {"choices": [{"delta": ...}]})
into Anthropic official Messages API SSE stream events:
- message_start
- content_block_start
- content_block_delta
- content_block_stop
- message_delta
- message_stop
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional, Union


def _format_sse(event: str, data: dict) -> str:
    """Format an event name and dict payload into standard SSE format."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class AnthropicStreamTranslator:
    """State machine translator for converting OpenAI chunk streams to Anthropic SSE events.

    Tracks transitions between reasoning/thinking blocks, text blocks, and tool_use blocks,
    maintaining strict block indexing and proper Anthropic event lifecycle.
    """

    def __init__(
        self,
        model: Optional[str] = None,
        message_id: Optional[str] = None,
        input_tokens: int = 0,
    ) -> None:
        self.model: str = model or "claude-3-5-sonnet-20241022"
        self._model_explicit: bool = bool(model)

        raw_id = message_id or f"msg_{uuid.uuid4().hex}"
        if raw_id.startswith("chatcmpl-"):
            self.message_id = f"msg_{raw_id[9:]}"
        elif not raw_id.startswith("msg_"):
            self.message_id = f"msg_{raw_id}"
        else:
            self.message_id = raw_id

        self.input_tokens: int = input_tokens
        self.output_tokens: int = 0
        self._estimated_tokens: int = 0

        self.current_block_index: int = 0
        self.active_block_type: Optional[str] = None  # "thinking" | "text" | "tool_use"
        self.active_tool_index: Optional[int] = None
        self.active_tool_id: Optional[str] = None
        self.active_tool_name: Optional[str] = None

        self._message_start_emitted: bool = False
        self._message_delta_emitted: bool = False
        self._message_stop_emitted: bool = False
        self._finish_reason: Optional[str] = None
        self._had_tool_call: bool = False
        self._finished: bool = False

    def _make_message_start(self) -> str:
        self._message_start_emitted = True
        return _format_sse(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": self.input_tokens,
                        "output_tokens": 1,
                    },
                },
            },
        )

    def _map_finish_reason(self, reason: Optional[str]) -> str:
        if reason == "stop":
            return "end_turn"
        if reason in ("tool_calls", "function_call"):
            return "tool_use"
        if reason == "length":
            return "max_tokens"
        if reason == "content_filter":
            return "stop_sequence"
        if self._had_tool_call:
            return "tool_use"
        return "end_turn"

    def _close_active_block(self) -> List[str]:
        events: List[str] = []
        if self.active_block_type is not None:
            events.append(
                _format_sse(
                    "content_block_stop",
                    {
                        "type": "content_block_stop",
                        "index": self.current_block_index,
                    },
                )
            )
            self.current_block_index += 1
            self.active_block_type = None
            self.active_tool_index = None
            self.active_tool_id = None
            self.active_tool_name = None
        return events

    def feed_chunk(self, chunk: dict) -> List[str]:
        """Process an already parsed OpenAI chunk dictionary and return Anthropic SSE events."""
        if self._finished:
            return []

        events: List[str] = []

        # Update model if not explicitly specified at init
        if not self._model_explicit and chunk.get("model"):
            self.model = chunk["model"]

        # Update message_id from chunk if still default/empty and not emitted yet
        if chunk.get("id") and not self._message_start_emitted:
            raw_id = str(chunk["id"])
            if raw_id.startswith("chatcmpl-"):
                self.message_id = f"msg_{raw_id[9:]}"
            elif not raw_id.startswith("msg_"):
                self.message_id = f"msg_{raw_id}"
            else:
                self.message_id = raw_id

        # Update usage if available
        if "usage" in chunk and chunk["usage"]:
            raw_usage = chunk["usage"]
            if "completion_tokens" in raw_usage:
                self.output_tokens = raw_usage["completion_tokens"]
            if "prompt_tokens" in raw_usage:
                self.input_tokens = raw_usage["prompt_tokens"]

        choices = chunk.get("choices", [])
        if not choices:
            return events

        # Emit message_start prior to any content processing
        if not self._message_start_emitted:
            events.append(self._make_message_start())

        choice = choices[0]
        delta = choice.get("delta", {})
        finish_reason = choice.get("finish_reason")

        # 1. Reasoning / thinking content
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        if reasoning:
            self._estimated_tokens += max(1, len(reasoning) // 4)
            if self.active_block_type != "thinking":
                events.extend(self._close_active_block())
                self.active_block_type = "thinking"
                events.append(
                    _format_sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": self.current_block_index,
                            "content_block": {
                                "type": "thinking",
                                "thinking": "",
                            },
                        },
                    )
                )
            events.append(
                _format_sse(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": self.current_block_index,
                        "delta": {
                            "type": "thinking_delta",
                            "thinking": reasoning,
                        },
                    },
                )
            )

        # 2. Text content
        content = delta.get("content")
        if content:
            self._estimated_tokens += max(1, len(content) // 4)
            if self.active_block_type != "text":
                events.extend(self._close_active_block())
                self.active_block_type = "text"
                events.append(
                    _format_sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": self.current_block_index,
                            "content_block": {
                                "type": "text",
                                "text": "",
                            },
                        },
                    )
                )
            events.append(
                _format_sse(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": self.current_block_index,
                        "delta": {
                            "type": "text_delta",
                            "text": content,
                        },
                    },
                )
            )

        # 3. Tool calls
        tool_calls = delta.get("tool_calls")
        if tool_calls:
            self._had_tool_call = True
            # If thinking or text was active, close it
            if self.active_block_type in ("thinking", "text"):
                events.extend(self._close_active_block())

            for tc in tool_calls:
                tc_idx = tc.get("index", 0)
                fn = tc.get("function", {})

                # If starting a new tool block
                if self.active_block_type != "tool_use" or self.active_tool_index != tc_idx:
                    events.extend(self._close_active_block())
                    self.active_block_type = "tool_use"
                    self.active_tool_index = tc_idx
                    self.active_tool_id = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
                    self.active_tool_name = fn.get("name", "")
                    events.append(
                        _format_sse(
                            "content_block_start",
                            {
                                "type": "content_block_start",
                                "index": self.current_block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": self.active_tool_id,
                                    "name": self.active_tool_name,
                                    "input": {},
                                },
                            },
                        )
                    )
                else:
                    if tc.get("id") and not self.active_tool_id:
                        self.active_tool_id = tc["id"]
                    if fn.get("name") and not self.active_tool_name:
                        self.active_tool_name = fn["name"]

                args_delta = fn.get("arguments")
                if args_delta:
                    self._estimated_tokens += max(1, len(args_delta) // 4)
                    events.append(
                        _format_sse(
                            "content_block_delta",
                            {
                                "type": "content_block_delta",
                                "index": self.current_block_index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": args_delta,
                                },
                            },
                        )
                    )

        # 4. Finish reason
        if finish_reason is not None:
            self._finish_reason = finish_reason
            events.extend(self._close_active_block())

            if not self._message_delta_emitted:
                stop_reason = self._map_finish_reason(finish_reason)
                tokens_out = self.output_tokens if self.output_tokens > 0 else max(1, self._estimated_tokens)
                events.append(
                    _format_sse(
                        "message_delta",
                        {
                            "type": "message_delta",
                            "delta": {
                                "stop_reason": stop_reason,
                                "stop_sequence": None,
                            },
                            "usage": {
                                "output_tokens": tokens_out,
                            },
                        },
                    )
                )
                self._message_delta_emitted = True

        return events

    def feed_line(self, line: str) -> List[str]:
        """Process a raw SSE text line (e.g. 'data: {...}' or 'data: [DONE]')."""
        line = line.strip()
        if not line:
            return []
        if line.startswith(":"):
            return []
        if line.startswith("data:"):
            payload = line[5:].strip()
        else:
            payload = line

        if payload == "[DONE]":
            return self.finalize()

        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            return []

        return self.feed_chunk(chunk)

    def feed(self, item: Union[str, dict]) -> List[str]:
        """Convenience feed method accepting either raw line string or chunk dictionary."""
        if isinstance(item, dict):
            return self.feed_chunk(item)
        if isinstance(item, str):
            return self.feed_line(item)
        return []

    def finalize(self) -> List[str]:
        """Close any unclosed blocks and emit message_delta / message_stop if not emitted."""
        if self._finished:
            return []

        events: List[str] = []
        if not self._message_start_emitted:
            events.append(self._make_message_start())

        # Close any active block
        events.extend(self._close_active_block())

        # Emit message_delta if not yet emitted
        if not self._message_delta_emitted:
            stop_reason = self._map_finish_reason(self._finish_reason)
            tokens_out = self.output_tokens if self.output_tokens > 0 else max(1, self._estimated_tokens)
            events.append(
                _format_sse(
                    "message_delta",
                    {
                        "type": "message_delta",
                        "delta": {
                            "stop_reason": stop_reason,
                            "stop_sequence": None,
                        },
                        "usage": {
                            "output_tokens": tokens_out,
                        },
                    },
                )
            )
            self._message_delta_emitted = True

        # Emit message_stop if not yet emitted
        if not self._message_stop_emitted:
            events.append(
                _format_sse(
                    "message_stop",
                    {
                        "type": "message_stop",
                    },
                )
            )
            self._message_stop_emitted = True

        self._finished = True
        return events
