"""Anthropic Messages protocol compatibility layer for OpenAI backends.

Provides stateless bidirectional translation between Anthropic Messages API
and OpenAI Chat Completions API.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any, Dict, List, Optional, Union

_ATTRIBUTION_PREFIX = "x-anthropic-billing-header:"

# Claude Code 的**客户端侧用量提示**：随 token-usage 附件开关，以元消息形式追加在
# 会话尾部。两种形态（可裸放，也可被 `<system-reminder>` 包住）：
#   ① `Token usage: 190010/180000; -10010 remaining`
#   ② `<total_tokens>15000000 tokens left</total_tokens>`（补零的倒计时）
# 这些是**客户端自己的账**，对上游模型没有任何信息价值：白占上下文、占掉提示词
# 缓存位（Claude Code 会把它们标成 cache_control: ephemeral），而倒计时里的负数更会
# 被模型当成"我快没额度了"的错误指令去读（本仓 `_looks_like_harness_user` 已把
# `<system-reminder>` 整体列为 harness 标记，说明这类注入在本仓是被识别为噪声的）。
#
# 采纳自 orangeboyChen/codebuddy2api #178（上游为 TS 实现同名规则，本仓按 Python 复刻）。
# 复刻时刻意保留其两个设计取舍：
#   1. **带壳形态先匹配**，裸形态后匹配 —— 否则壳标签会残留在正文里；
#   2. 倒计时**必须带数字载荷**（`<N> token(s) left`）才算提示 ——
#      否则用户自己贴的 `<total_tokens>` 片段（例如 schema 示例）会被误删。
_TOTAL_TOKENS_COUNTDOWN = (
    r"<total_tokens>\s*-?[\d,._]+\s*tokens?\s+left\s*</total_tokens>"
)

_CLIENT_USAGE_HINT_RES = [
    # ① Token usage 带壳 / 裸形态
    re.compile(r"<system-reminder>\s*Token usage:[^<]*</system-reminder>", re.IGNORECASE),
    re.compile(r"Token usage:\s*-?\d+\s*/\s*-?\d+\s*;\s*-?\d+\s+remaining", re.IGNORECASE),
    # ② total_tokens 倒计时带壳 / 裸形态（必须在 ① 之后，保证壳先被一起吃掉）
    re.compile(r"<system-reminder>\s*" + _TOTAL_TOKENS_COUNTDOWN + r"\s*</system-reminder>",
               re.IGNORECASE),
    re.compile(_TOTAL_TOKENS_COUNTDOWN, re.IGNORECASE),
]


def _strip_client_usage_hints(text: str) -> str:
    """剥离 Claude Code 注入的客户端用量提示，返回剥离后的文本。

    ⚠️ 只删提示本身，**同一块里的真实正文必须原样保留**（上游 #178 专门有一条
    用例守这个：`<total_tokens>…</total_tokens>\\nfix the failing test` 剥离后
    仍要留下 `fix the failing test`）。因此这里做的是**子串替换**，不是整条丢消息。

    剥离后若为空串，就如实返回空串（由调用方决定「丢弃整条」还是「留空壳」）——
    不要回退成原文，否则调用方的空值判定永远不成立。
    """
    if not text:
        return text
    for rx in _CLIENT_USAGE_HINT_RES:
        text = rx.sub("", text)
    return text.strip()


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
    return _strip_client_usage_hints("\n".join(filtered)).strip()


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


def _format_tool_result_content(content: Any) -> Any:
    """Format Anthropic tool_result content for an OpenAI tool message.

    ⚠️ 多模态块必须**保留为结构**，不能降级成文本：Agent 的截图类工具会把图片放在
    tool_result 里（`{"type":"image","source":{...}}`）。旧实现走 `json.dumps(item)`
    把它变成一段 JSON 文本，模型收到的是字符串而非图片——且 Agent 每轮回传完整历史，
    这张图会**每轮重新丢一次**，全程无报错、完全静默。
    纯文本块仍按原语义用 "\\n" 连接（既有契约 test_anthropic_compat 锁定）。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[Any] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif item.get("type") == "image":
                    parts.append(_translate_content_part(item))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            elif isinstance(item, str):
                parts.append(item)
            else:
                parts.append(json.dumps(item, ensure_ascii=False))
        # 全文本 → 保持历史形态（"\\n" 连接的字符串）；含图片 → 返回结构化部件数组
        if all(isinstance(p, str) for p in parts):
            return "\n".join(parts)
        return parts
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
                cleaned = _strip_client_usage_hints(content)
                # 整条只是客户端用量提示（剥离后空）→ 丢掉这条元消息，不留空壳
                if cleaned.strip() or not content.strip():
                    openai_msgs.append({"role": "assistant", "content": cleaned})
                continue
            if isinstance(content, list):
                text_parts: List[str] = []
                thinking_parts: List[str] = []
                tool_calls: List[dict] = []
                signature_val: Optional[str] = None

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text", "")
                        if text:
                            text_parts.append(_strip_client_usage_hints(text))
                    elif btype == "thinking":
                        thinking = block.get("thinking", "")
                        if thinking:
                            thinking_parts.append(thinking)
                        sig = block.get("signature")
                        if sig and isinstance(sig, str):
                            signature_val = sig
                    elif btype == "redacted_thinking":
                        # Anthropic redacted_thinking block，在 reasoning_content 中保留占位避免思维链中断
                        data = block.get("data", "")
                        placeholder = f"[redacted_thinking: {data[:16]}...]" if data else "[redacted_thinking]"
                        thinking_parts.append(placeholder)
                    elif btype == "tool_use":
                        if not block.get("id"):
                            raise ValueError(
                                "tool_use block missing required 'id': "
                                "inventing one would break tool_result correlation on retry"
                            )
                        inp = block.get("input", {})
                        if isinstance(inp, (dict, list)):
                            arg_str = json.dumps(inp, ensure_ascii=False)
                        elif isinstance(inp, str):
                            arg_str = inp
                        else:
                            arg_str = json.dumps(inp, ensure_ascii=False)

                        tool_calls.append({
                            "id": block.get("id"),
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": arg_str,
                            },
                        })

                asst_msg: Dict[str, Any] = {"role": "assistant"}
                # 保留完整的 Anthropic 原始结构 Sidecar（用于内部上下文保真与多轮回传）
                asst_msg["_anthropic_original_content"] = copy.deepcopy(content)
                if signature_val:
                    asst_msg["_anthropic_signature"] = signature_val

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
                cleaned = _strip_client_usage_hints(content)
                # 整条只是客户端用量提示 → 丢弃；否则保留剥离后的正文
                if cleaned.strip() or not content.strip():
                    openai_msgs.append({"role": "user", "content": cleaned})
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
                        texts = [_strip_client_usage_hints(b.get("text", ""))
                                 for b in user_blocks if b.get("type") == "text"]
                        joined = "\n".join(t for t in texts if t.strip())
                        # 整条只是客户端用量提示 → 丢弃这条元消息，不留空 user
                        if joined.strip() or all(not t.strip() for t in texts):
                            openai_msgs.append({"role": "user", "content": joined})
                    else:
                        parts = [_translate_content_part(b) for b in user_blocks]
                        openai_msgs.append({
                            "role": "user",
                            "content": parts,
                        })

        elif role == "system":
            if isinstance(content, str):
                cleaned = _strip_attribution(content)
                if cleaned.strip() or not content.strip():
                    openai_msgs.append({"role": "system", "content": cleaned})
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


def strip_anthropic_sidecar(target: Any) -> Any:
    """从 messages 列表或 payload 请求体中剔除以 `_anthropic_` 开头的私有内部元字段，确保发往上游的数据符合规范。"""
    if isinstance(target, list):
        cleaned_list = []
        for item in target:
            if isinstance(item, dict):
                cleaned_item = {k: v for k, v in item.items() if not (isinstance(k, str) and k.startswith("_anthropic_"))}
                cleaned_list.append(cleaned_item)
            else:
                cleaned_list.append(item)
        return cleaned_list
    elif isinstance(target, dict):
        cleaned_dict = {}
        for k, v in target.items():
            if isinstance(k, str) and k.startswith("_anthropic_"):
                continue
            if k == "messages" and isinstance(v, list):
                cleaned_dict[k] = strip_anthropic_sidecar(v)
            else:
                cleaned_dict[k] = v
        return cleaned_dict
    return target


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
    fr = (str(finish_reason).strip().lower() if finish_reason and isinstance(finish_reason, (str, bytes)) else "")
    if has_tool_use or fr in ("tool_calls", "function_call"):
        stop_reason = "tool_use"
    elif fr in ("length", "max_tokens"):
        stop_reason = "max_tokens"
    elif fr in ("content_filter", "sensitive", "safety"):
        stop_reason = "stop_sequence"
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
