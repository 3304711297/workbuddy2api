"""Anthropic Messages protocol compatibility layer for OpenAI backends.

Provides stateless bidirectional translation between Anthropic Messages API
and OpenAI Chat Completions API.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional, Union

_ATTRIBUTION_PREFIX = "x-anthropic-billing-header:"


def _strip_attribution(text: str) -> str:
    """Strip Claude Code attribution billing header lines."""
    if not text:
        return ""
    lines = text.splitlines()
    filtered = [
        line
        for line in lines
        if not line.strip().lower().startswith(_ATTRIBUTION_PREFIX)
    ]
    return "\n".join(filtered).strip()


def _extract_system_prompt(system_raw: Union[str, List[Any], None]) -> Optional[str]:
    """Extract and sanitize system prompt into a single string.

    Supports strings and lists of text blocks (with Claude Code attribution
    header stripped).
    """
    if not system_raw:
        return None
    if isinstance(system_raw, str):
        cleaned = _strip_attribution(system_raw)
        return cleaned if cleaned else None
    if isinstance(system_raw, list):
        parts: List[str] = []
        for item in system_raw:
            if isinstance(item, str):
                cleaned = _strip_attribution(item)
                if cleaned:
                    parts.append(cleaned)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    cleaned = _strip_attribution(item.get("text", ""))
                    if cleaned:
                        parts.append(cleaned)
        joined = "\n\n".join(parts).strip()
        return joined if joined else None
    return None


def _format_tool_result_content(content: Any) -> str:
    """Format Anthropic tool_result content into a string for OpenAI tool message."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            elif isinstance(item, str):
                parts.append(item)
            else:
                parts.append(json.dumps(item, ensure_ascii=False))
        return "\n".join(parts)
    if isinstance(content, (dict, int, float, bool)):
        return json.dumps(content, ensure_ascii=False)
    return str(content or "")


def _translate_content_part(block: dict) -> dict:
    """Translate an Anthropic block (text/image) to an OpenAI content part."""
    b_type = block.get("type")
    if b_type == "text":
        return {"type": "text", "text": block.get("text", "")}
    if b_type == "image":
        src = block.get("source", {})
        stype = src.get("type")
        if stype == "base64":
            media_type = src.get("media_type", "image/png")
            data = src.get("data", "")
            return {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}"},
            }
        elif stype == "url":
            return {
                "type": "image_url",
                "image_url": {"url": src.get("url", "")},
            }
        else:
            return {
                "type": "image_url",
                "image_url": {"url": src.get("data", "")},
            }
    return {"type": "text", "text": json.dumps(block, ensure_ascii=False)}


def _translate_anthropic_messages(messages: List[dict]) -> List[dict]:
    """Translate Anthropic messages list to OpenAI messages list.

    Maintains legal OpenAI role order (role: 'tool' follows immediately after
    the assistant message with tool_calls).
    """
    openai_msgs: List[dict] = []

    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")

        if role == "assistant":
            if isinstance(content, str):
                openai_msgs.append({"role": "assistant", "content": content})
            elif isinstance(content, list):
                text_parts: List[str] = []
                thinking_parts: List[str] = []
                tool_calls: List[dict] = []

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text", "")
                        if text:
                            text_parts.append(text)
                    elif btype == "thinking":
                        thinking = block.get("thinking", "")
                        if thinking:
                            thinking_parts.append(thinking)
                    elif btype == "tool_use":
                        inp = block.get("input", {})
                        if isinstance(inp, (dict, list)):
                            arg_str = json.dumps(inp, ensure_ascii=False)
                        elif isinstance(inp, str):
                            arg_str = inp
                        else:
                            arg_str = json.dumps(inp, ensure_ascii=False)

                        tool_calls.append({
                            "id": block.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": arg_str,
                            },
                        })

                asst_msg: Dict[str, Any] = {"role": "assistant"}
                if text_parts:
                    asst_msg["content"] = "\n".join(text_parts)
                elif tool_calls:
                    asst_msg["content"] = None
                else:
                    asst_msg["content"] = ""

                if tool_calls:
                    asst_msg["tool_calls"] = tool_calls
                if thinking_parts:
                    asst_msg["reasoning_content"] = "\n".join(thinking_parts)

                openai_msgs.append(asst_msg)

        elif role == "user":
            if isinstance(content, str):
                openai_msgs.append({"role": "user", "content": content})
            elif isinstance(content, list):
                tool_results: List[dict] = []
                user_blocks: List[dict] = []

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "tool_result":
                        tool_results.append(block)
                    else:
                        user_blocks.append(block)

                # Tool results MUST come first so they immediately follow
                # the assistant message carrying tool_calls.
                for tr in tool_results:
                    call_id = tr.get("tool_use_id") or tr.get("id", "")
                    tr_content = _format_tool_result_content(tr.get("content", ""))
                    openai_msgs.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": tr_content,
                    })

                # Follow-up user blocks (if any)
                if user_blocks:
                    has_images = any(b.get("type") == "image" for b in user_blocks)
                    if not has_images:
                        texts = [b.get("text", "") for b in user_blocks if b.get("type") == "text"]
                        openai_msgs.append({
                            "role": "user",
                            "content": "\n".join(texts),
                        })
                    else:
                        parts = [_translate_content_part(b) for b in user_blocks]
                        openai_msgs.append({
                            "role": "user",
                            "content": parts,
                        })

        elif role == "system":
            if isinstance(content, str):
                openai_msgs.append({"role": "system", "content": _strip_attribution(content)})
            elif isinstance(content, list):
                sys_text = _extract_system_prompt(content)
                if sys_text:
                    openai_msgs.append({"role": "system", "content": sys_text})

    return openai_msgs


def _translate_tools(tools: List[dict]) -> List[dict]:
    """Translate Anthropic tools to OpenAI function tools."""
    openai_tools: List[dict] = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "function" and "function" in t:
            openai_tools.append(t)
            continue

        name = t.get("name", "")
        fn_obj: Dict[str, Any] = {
            "name": name,
            "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
        }
        if "description" in t:
            fn_obj["description"] = t["description"]

        openai_tools.append({
            "type": "function",
            "function": fn_obj,
        })
    return openai_tools


def _translate_tool_choice(choice: Any) -> Any:
    """Translate Anthropic tool_choice to OpenAI tool_choice.

    Mappings:
    - 'auto' -> 'auto'
    - 'any' -> 'required'
    - {'type': 'auto'} -> 'auto'
    - {'type': 'any'} -> 'required'
    - {'type': 'tool', 'name': name} -> {'type': 'function', 'function': {'name': name}}
    """
    if isinstance(choice, str):
        if choice == "auto":
            return "auto"
        if choice == "any":
            return "required"
        if choice == "none":
            return "none"
        return choice
    if isinstance(choice, dict):
        ctype = choice.get("type")
        if ctype == "auto":
            return "auto"
        if ctype == "any":
            return "required"
        if ctype == "none":
            return "none"
        if ctype == "tool":
            return {
                "type": "function",
                "function": {"name": choice.get("name", "")},
            }
        if ctype == "function":
            return choice
    return choice


def translate_anthropic_request(body: dict) -> dict:
    """Translate an Anthropic /v1/messages request body to OpenAI /v1/chat/completions format.

    - model: extracted and passed through.
    - system: extracted from string or blocks (with attribution stripped) into role: system.
    - messages: user/assistant converted with tool_use and tool_result mapping.
    - tools & tool_choice: converted to OpenAI function format.
    - max_tokens, temperature, top_p, stop, stream: passed through.
    """
    openai_req: Dict[str, Any] = {}

    if "model" in body:
        openai_req["model"] = body["model"]

    openai_messages: List[dict] = []

    # System prompt
    sys_content = _extract_system_prompt(body.get("system"))
    if sys_content:
        openai_messages.append({"role": "system", "content": sys_content})

    # Messages (Anthropic 规范：messages 为必填且非空数组)
    if "messages" not in body or not isinstance(body.get("messages"), list) or len(body["messages"]) == 0:
        raise ValueError("messages: Field required and must be a non-empty list")

    openai_messages.extend(_translate_anthropic_messages(body["messages"]))

    openai_req["messages"] = openai_messages

    # Tools
    if "tools" in body and body["tools"]:
        openai_req["tools"] = _translate_tools(body["tools"])

    # Tool choice
    if "tool_choice" in body and body["tool_choice"] is not None:
        openai_req["tool_choice"] = _translate_tool_choice(body["tool_choice"])

    # Token limits
    if "max_tokens" in body:
        openai_req["max_tokens"] = body["max_tokens"]
    elif "max_output_tokens" in body:
        openai_req["max_tokens"] = body["max_output_tokens"]

    # Sampling parameters
    if "temperature" in body and body["temperature"] is not None:
        openai_req["temperature"] = body["temperature"]
    if "top_p" in body and body["top_p"] is not None:
        openai_req["top_p"] = body["top_p"]

    # Stop sequences
    if "stop_sequences" in body and body["stop_sequences"]:
        openai_req["stop"] = body["stop_sequences"]

    # Thinking / Extended Reasoning 参数贯通
    if "thinking" in body and isinstance(body["thinking"], dict):
        th = body["thinking"]
        th_type = th.get("type")
        if th_type == "disabled":
            openai_req["reasoning_effort"] = "disable"
            openai_req["chat_template_kwargs"] = {"enable_thinking": False}
            openai_req["thinking"] = {"type": "disabled"}
        elif th_type == "enabled":
            budget = th.get("budget_tokens")
            openai_req["chat_template_kwargs"] = {"enable_thinking": True}
            if budget is not None and isinstance(budget, (int, float)):
                b_int = int(budget)
                openai_req["thinking_budget"] = b_int
                if b_int <= 1024:
                    openai_req["reasoning_effort"] = "low"
                elif b_int <= 4096:
                    openai_req["reasoning_effort"] = "medium"
                else:
                    openai_req["reasoning_effort"] = "high"
            else:
                openai_req["reasoning_effort"] = "high"

    # Stream flag
    openai_req["stream"] = bool(body.get("stream", False))

    return openai_req


def translate_openai_response_to_anthropic(openai_resp: dict) -> dict:
    """Translate an OpenAI /v1/chat/completions response to Anthropic /v1/messages format.

    - id: ensures msg_ prefix.
    - type: 'message', role: 'assistant'.
    - content: list of text, thinking, and tool_use blocks.
    - model: passed through.
    - stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'.
    - usage: {input_tokens, output_tokens}.
    """
    raw_id = str(openai_resp.get("id") or f"msg_{uuid.uuid4().hex}")
    if raw_id.startswith("chatcmpl-"):
        msg_id = f"msg_{raw_id[9:]}"
    elif not raw_id.startswith("msg_"):
        msg_id = f"msg_{raw_id}"
    else:
        msg_id = raw_id

    model = openai_resp.get("model", "")
    choices = openai_resp.get("choices", [])

    content_blocks: List[dict] = []
    finish_reason: Optional[str] = None

    if choices:
        choice = choices[0]
        message = choice.get("message", {})
        finish_reason = choice.get("finish_reason")

        # 1. Reasoning / thinking content
        reasoning = message.get("reasoning_content") or message.get("reasoning")
        if reasoning:
            content_blocks.append({
                "type": "thinking",
                "thinking": reasoning,
            })

        # 2. Text content
        text_content = message.get("content")
        if text_content:
            content_blocks.append({
                "type": "text",
                "text": text_content,
            })

        # 3. Tool calls
        tool_calls = message.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                tc_id = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
                fn = tc.get("function", {})
                name = fn.get("name", "")
                raw_args = fn.get("arguments", "{}")
                if isinstance(raw_args, str):
                    try:
                        args = json.loads(raw_args)
                    except Exception:
                        args = raw_args
                elif isinstance(raw_args, dict):
                    args = raw_args
                else:
                    args = {}

                content_blocks.append({
                    "type": "tool_use",
                    "id": tc_id,
                    "name": name,
                    "input": args,
                })

    # Map finish_reason
    has_tool_use = any(b.get("type") == "tool_use" for b in content_blocks)
    if finish_reason == "stop":
        stop_reason = "end_turn"
    elif finish_reason in ("tool_calls", "function_call"):
        stop_reason = "tool_use"
    elif finish_reason == "length":
        stop_reason = "max_tokens"
    elif finish_reason == "content_filter":
        stop_reason = "stop_sequence"
    elif has_tool_use:
        stop_reason = "tool_use"
    else:
        stop_reason = "end_turn"

    # Usage
    raw_usage = openai_resp.get("usage", {})
    usage = {
        "input_tokens": raw_usage.get("prompt_tokens", 0),
        "output_tokens": raw_usage.get("completion_tokens", 0),
    }
    details = raw_usage.get("prompt_tokens_details") or {}
    if "cached_tokens" in details:
        usage["cache_read_input_tokens"] = details["cached_tokens"]

    return {
        "id": msg_id,
        "type": "message",
        "role": "assistant",
        "content": content_blocks,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage,
    }
