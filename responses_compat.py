"""
responses_compat.py - OpenAI Responses API ↔ Chat Completions 协议双向适配层

为 Codex CLI / OpenCode 等原生采用 Responses wire format 的 Coding Agent 提供无缝支持。
架构与 anthropic_compat.py 保持同等级别的解耦模块化设计。
借鉴自 ShouZhuo0413/codebuddy2api 与 hawklithm/workbuddy2api (MIT)。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any


def _rand_id(prefix: str = "resp_") -> str:
    return prefix + os.urandom(12).hex()


def responses_request_to_chat(body: dict) -> dict:
    """将 Responses API 请求体转换为 Chat Completions 请求体。

    关键映射：
    - input -> messages（支持字符串或多类型结构化列表：user, developer, function_call, function_call_output）
    - instructions -> 置顶 system message
    - developer 角色归一为 system
    - max_output_tokens -> max_tokens
    - tools 扁平格式转为 Chat 嵌套格式
    """
    messages: list[dict] = []

    # instructions 置顶为 system 消息
    instructions = body.get("instructions")
    if instructions:
        messages.append({"role": "system", "content": str(instructions)})

    # input -> messages
    inp = body.get("input", [])
    if isinstance(inp, str):
        if inp.strip():
            messages.append({"role": "user", "content": inp})
    elif isinstance(inp, list):
        messages.extend(_convert_input_items(inp))

    chat: dict[str, Any] = {"messages": messages, "stream": True}

    if "model" in body:
        chat["model"] = body["model"]

    tools = body.get("tools")
    if tools and isinstance(tools, list):
        chat["tools"] = _convert_tools_for_chat(tools)
    if "tool_choice" in body:
        chat["tool_choice"] = body["tool_choice"]

    # 透传常见控制参数
    for key in (
        "temperature",
        "top_p",
        "stop",
        "seed",
        "presence_penalty",
        "frequency_penalty",
        "response_format",
        "reasoning_effort",
    ):
        if key in body:
            chat[key] = body[key]

    if "max_output_tokens" in body:
        chat["max_tokens"] = body["max_output_tokens"]
    elif "max_tokens" in body:
        chat["max_tokens"] = body["max_tokens"]

    return chat


def _convert_input_items(items: list) -> list[dict]:
    """将 Responses API 的 input 项数组转换为 Chat messages。"""
    messages: list[dict] = []
    pending_assistant_content: str | None = None
    pending_tool_calls: list[dict] = []

    def _flush_assistant():
        nonlocal pending_assistant_content, pending_tool_calls
        if pending_assistant_content is not None or pending_tool_calls:
            msg: dict[str, Any] = {
                "role": "assistant",
                "content": pending_assistant_content or "",
            }
            if pending_tool_calls:
                msg["tool_calls"] = pending_tool_calls[:]
            messages.append(msg)
            pending_assistant_content = None
            pending_tool_calls.clear()

    for item in items:
        if not isinstance(item, dict):
            continue

        item_type = item.get("type")
        role = item.get("role", "")

        # 1. 简单消息（user, system, developer）
        if item_type in (None, "message") and role in ("user", "system", "developer"):
            _flush_assistant()
            mapped_role = "system" if role == "developer" else role
            content = _extract_content(item.get("content", ""))
            messages.append({"role": mapped_role, "content": content})
            continue

        # 2. 助手消息
        if item_type in (None, "message") and role == "assistant":
            _flush_assistant()
            content = _extract_content(item.get("content", ""))
            pending_assistant_content = content
            continue

        # 3. function_call -> 归集至前驱 assistant 消息的 tool_calls
        if item_type == "function_call":
            if pending_assistant_content is None:
                pending_assistant_content = ""
            call_id = item.get("call_id") or item.get("id") or _rand_id("call_")
            pending_tool_calls.append({
                "id": call_id,
                "type": "function",
                "function": {
                    "name": item.get("name", ""),
                    "arguments": item.get("arguments", "{}"),
                },
            })
            continue

        # 4. function_call_output -> tool 消息
        if item_type == "function_call_output":
            _flush_assistant()
            messages.append({
                "role": "tool",
                "tool_call_id": item.get("call_id", ""),
                "content": str(item.get("output", "")),
            })
            continue

        # 5. 其他类型保底
        if role:
            _flush_assistant()
            content = _extract_content(item.get("content", ""))
            messages.append({"role": role, "content": content})

    _flush_assistant()
    return messages


def _extract_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") in ("input_text", "text", "output_text"):
                    parts.append(p.get("text", ""))
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return str(content or "")


def _convert_tools_for_chat(tools: list) -> list:
    """将 Responses 格式的 tools 转为 Chat Completions 嵌套格式。"""
    result = []
    for t in tools:
        if not isinstance(t, dict) or t.get("type") != "function":
            continue
        if "function" in t:
            result.append(t)
            continue
        fn: dict[str, Any] = {"name": t.get("name", "")}
        if "description" in t:
            fn["description"] = t["description"]
        if "parameters" in t:
            fn["parameters"] = t["parameters"]
        if "strict" in t:
            fn["strict"] = t["strict"]
        result.append({"type": "function", "function": fn})
    return result


class ResponsesStreamConverter:
    """将 ChatCompletions SSE 流实时转换为 Responses API 语义事件流。"""

    def __init__(self, model: str = "unknown"):
        self.resp_id = _rand_id("resp_")
        self.msg_id = _rand_id("msg_")
        self.model = model
        self.created_at = int(time.time())

        self._emitted_created = False
        self._emitted_msg_item = False
        self._emitted_content_part = False

        self._content = ""
        self._tool_calls: dict[int, dict] = {}
        self._usage: dict | None = None

    def feed_chunk(self, chunk: dict) -> str:
        """处理已解析的单个 ChatCompletions JSON chunk，输出 Responses SSE 行。"""
        events: list[str] = []

        if chunk.get("model"):
            self.model = chunk["model"]

        if not self._emitted_created:
            resp = self._build_response_obj("in_progress")
            events.append(self._fmt("response.created", {"response": resp}))
            events.append(self._fmt("response.in_progress", {"response": resp}))
            self._emitted_created = True

        if chunk.get("usage"):
            self._usage = chunk["usage"]

        for choice in chunk.get("choices", []):
            delta = choice.get("delta", {})

            # 文本内容增量
            content = delta.get("content")
            if content:
                if not self._emitted_msg_item:
                    events.append(self._fmt("response.output_item.added", {
                        "output_index": 0,
                        "item": self._build_msg_item("in_progress", empty=True),
                    }))
                    self._emitted_msg_item = True

                if not self._emitted_content_part:
                    events.append(self._fmt("response.content_part.added", {
                        "output_index": 0,
                        "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": []},
                    }))
                    self._emitted_content_part = True

                self._content += content
                events.append(self._fmt("response.output_text.delta", {
                    "output_index": 0,
                    "content_index": 0,
                    "delta": content,
                }))

            # 工具调用增量
            for tc in delta.get("tool_calls", []):
                idx = tc.get("index", 0)
                if idx not in self._tool_calls:
                    base = 1 if (self._emitted_msg_item or self._content) else 0
                    oi = base + len(self._tool_calls)
                    self._tool_calls[idx] = {
                        "id": tc.get("id", ""),
                        "name": "",
                        "args": "",
                        "fc_id": _rand_id("fc_"),
                        "output_idx": oi,
                        "emitted": False,
                    }
                slot = self._tool_calls[idx]
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function", {})
                if fn.get("name"):
                    slot["name"] = fn["name"]

                if not slot["emitted"]:
                    events.append(self._fmt("response.output_item.added", {
                        "output_index": slot["output_idx"],
                        "item": self._build_fc_item(slot, "in_progress"),
                    }))
                    slot["emitted"] = True

                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]
                    events.append(self._fmt("response.function_call_arguments.delta", {
                        "output_index": slot["output_idx"],
                        "delta": fn["arguments"],
                    }))

        return "".join(events)

    def finish(self) -> str:
        """流式结束，输出收尾事件（output_text.done、output_item.done、completed）。"""
        events: list[str] = []

        if self._emitted_content_part:
            events.append(self._fmt("response.output_text.done", {
                "output_index": 0,
                "content_index": 0,
                "text": self._content,
            }))
            events.append(self._fmt("response.content_part.done", {
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": self._content, "annotations": []},
            }))

        if self._emitted_msg_item:
            events.append(self._fmt("response.output_item.done", {
                "output_index": 0,
                "item": self._build_msg_item("completed"),
            }))

        for idx in sorted(self._tool_calls):
            tc = self._tool_calls[idx]
            if tc.get("emitted"):
                oi = tc["output_idx"]
                events.append(self._fmt("response.function_call_arguments.done", {
                    "output_index": oi,
                    "arguments": tc["args"],
                }))
                events.append(self._fmt("response.output_item.done", {
                    "output_index": oi,
                    "item": self._build_fc_item(tc, "completed"),
                }))

        events.append(self._fmt("response.completed", {
            "response": self._build_response_obj("completed"),
        }))
        return "".join(events)

    def _fmt(self, event_type: str, data: dict) -> str:
        payload = {"type": event_type, **data}
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def _build_msg_item(self, status: str = "in_progress", empty: bool = False) -> dict:
        content = [] if empty else [
            {"type": "output_text", "text": self._content, "annotations": []}
        ]
        return {
            "type": "message",
            "id": self.msg_id,
            "status": status,
            "role": "assistant",
            "content": content,
        }

    def _build_fc_item(self, tc: dict, status: str) -> dict:
        return {
            "type": "function_call",
            "id": tc["fc_id"],
            "call_id": tc["id"],
            "name": tc["name"],
            "arguments": tc["args"],
            "status": status,
        }

    def _build_response_obj(self, status: str) -> dict:
        output = []
        if self._emitted_msg_item or self._content:
            output.append(self._build_msg_item(status))
        for idx in sorted(self._tool_calls):
            tc = self._tool_calls[idx]
            if tc.get("emitted"):
                output.append(self._build_fc_item(tc, status))

        usage = None
        if self._usage:
            u = self._usage
            usage = {
                "input_tokens": u.get("prompt_tokens", u.get("input_tokens", 0)),
                "output_tokens": u.get("completion_tokens", u.get("output_tokens", 0)),
                "total_tokens": u.get("total_tokens", 0),
            }

        return {
            "id": self.resp_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "model": self.model,
            "output": output,
            "usage": usage,
        }


def chat_response_to_responses(chat_resp: dict, model: str = "") -> dict:
    """非流式响应转换：将标准的 Chat Completions 聚合响应包装为 Responses 规范对象。"""
    choice = (chat_resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    output = []

    content = msg.get("content") or ""
    if content or "tool_calls" not in msg:
        output.append({
            "type": "message",
            "id": _rand_id("msg_"),
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content, "annotations": []}],
        })

    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        output.append({
            "type": "function_call",
            "id": _rand_id("fc_"),
            "call_id": tc.get("id", ""),
            "name": fn.get("name", ""),
            "arguments": fn.get("arguments", "{}"),
            "status": "completed",
        })

    usage = None
    if "usage" in chat_resp:
        u = chat_resp["usage"]
        usage = {
            "input_tokens": u.get("prompt_tokens", 0),
            "output_tokens": u.get("completion_tokens", 0),
            "total_tokens": u.get("total_tokens", 0),
        }

    return {
        "id": chat_resp.get("id") or _rand_id("resp_"),
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "model": chat_resp.get("model") or model or "unknown",
        "output": output,
        "usage": usage,
    }
