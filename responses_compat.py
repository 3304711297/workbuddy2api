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


class PreviousResponseNotFoundError(Exception):
    """当客户端指定 previous_response_id 但本地 response store 找不到该前序响应时抛出。"""
    def __init__(self, response_id: str):
        super().__init__(f"Previous response with id '{response_id}' was not found.")
        self.response_id = response_id


_RESPONSE_HISTORY_CACHE: dict[str, list[dict]] = {}
_MAX_CACHED_RESPONSES = 256


def cache_response_messages(resp_id: str, messages: list[dict]) -> None:
    """缓存某个 response_id 对应的完整消息流历史，用于后续 previous_response_id 延续。"""
    if not resp_id or not isinstance(resp_id, str) or not messages:
        return
    if len(_RESPONSE_HISTORY_CACHE) >= _MAX_CACHED_RESPONSES:
        # 简单 FIFO 驱逐最旧的 32 条
        for k in list(_RESPONSE_HISTORY_CACHE.keys())[:32]:
            _RESPONSE_HISTORY_CACHE.pop(k, None)
    _RESPONSE_HISTORY_CACHE[resp_id] = [dict(m) for m in messages]


def get_cached_response_messages(resp_id: str) -> list[dict] | None:
    """获取缓存的历史消息列表。"""
    return _RESPONSE_HISTORY_CACHE.get(resp_id)


def _rand_id(prefix: str = "resp_") -> str:
    return prefix + os.urandom(12).hex()


def responses_request_to_chat(body: dict) -> dict:
    """将 Responses API 请求体转换为 Chat Completions 请求体。

    关键映射：
    - input -> messages（支持字符串或多类型结构化列表：user, developer, function_call, function_call_output）
    - instructions -> 置顶 system message（必须处于 context 第一项，防历史挤占）
    - developer 角色归一为 system
    - max_output_tokens -> max_tokens
    - tools 扁平格式转为 Chat 嵌套格式
    - previous_response_id -> 拼接历史缓存
    """
    messages: list[dict] = []

    # previous_response_id 支持：从响应缓存中复原前序轮次的历史上下文
    # 严格对齐 OpenAI Responses 协议规范：若显式指定但缓存 miss，必须阻断报错，杜绝静默上下文分叉
    prev_id = body.get("previous_response_id")
    if prev_id and isinstance(prev_id, str):
        cached_history = get_cached_response_messages(prev_id)
        if cached_history is None:
            raise PreviousResponseNotFoundError(prev_id)
        messages.extend(cached_history)

    # input -> messages
    inp = body.get("input", [])
    if isinstance(inp, str):
        if inp.strip():
            messages.append({"role": "user", "content": inp})
    elif isinstance(inp, list):
        messages.extend(_convert_input_items(inp))

    # instructions: 置顶为第一项 system 消息（若已存在历史，当前 instructions 仍必须置于最前）
    instructions = body.get("instructions")
    if instructions:
        messages.insert(0, {"role": "system", "content": str(instructions)})

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
    pending_reasoning: str = ""

    def _flush_assistant():
        nonlocal pending_assistant_content, pending_tool_calls, pending_reasoning
        if pending_assistant_content is not None or pending_tool_calls:
            msg: dict[str, Any] = {
                "role": "assistant",
                "content": pending_assistant_content or "",
            }
            if pending_tool_calls:
                msg["tool_calls"] = pending_tool_calls[:]
            if pending_reasoning:
                msg["reasoning_content"] = pending_reasoning
                pending_reasoning = ""
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
            # 前向 reasoning 若没能挂到任何 assistant 轮次上即作废，
            # 否则会漂到后面某个毫不相干的 assistant 消息上。
            pending_reasoning = ""
            mapped_role = "system" if role == "developer" else role
            content = _extract_content(item.get("content", ""))
            messages.append({"role": mapped_role, "content": content})
            continue

        # 1.1 独立 input_image 输入项（OpenAI Responses 规范）
        if item_type == "input_image":
            _flush_assistant()
            iu = item.get("image_url")
            url = iu if isinstance(iu, str) else (iu.get("url") if isinstance(iu, dict) else item.get("url", ""))
            messages.append({"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}}]})
            continue

        # 2. 助手消息
        if item_type in (None, "message") and role == "assistant":
            _flush_assistant()
            content = _extract_content(item.get("content", ""))
            pending_assistant_content = content
            continue

        # 3. reasoning -> 暂存，随所属 assistant 轮次一并落地（多轮思维链回传）
        # Responses 客户端（Codex CLI 等）会把上一轮的思维链 item 一并回传。
        # 规范输出序为 reasoning 紧邻其所属 assistant 消息之前，故暂存后由
        # _flush_assistant 附着到该轮；同一轮出现多条时顺序拼接。
        if item_type == "reasoning":
            text = _extract_reasoning_text(item)
            if not text:
                continue
            pending_reasoning = f"{pending_reasoning}\n{text}" if pending_reasoning else text
            continue

        # 4. function_call -> 归集至前驱 assistant 消息的 tool_calls
        if item_type == "function_call":
            if pending_assistant_content is None:
                pending_assistant_content = ""
            call_id = item.get("call_id") or item.get("id")
            if not call_id:
                raise ValueError(
                    "function_call item missing required 'call_id': "
                    "inventing one would break function_call_output correlation on retry"
                )
            pending_tool_calls.append({
                "id": call_id,
                "type": "function",
                "function": {
                    "name": item.get("name", ""),
                    "arguments": item.get("arguments", "{}"),
                },
            })
            continue

        # 5. function_call_output -> tool 消息
        if item_type == "function_call_output":
            _flush_assistant()
            output = item.get("output", "")
            content = _extract_content(output)
            if isinstance(content, (list, tuple)) and len(content) == 0:
                content = ""
            messages.append({
                "role": "tool",
                "tool_call_id": item.get("call_id", ""),
                # ⚠️ 必须复用 _extract_content（而非 str()）：Agent 会把截图等工具结果
                # 以 [{"type":"input_image","image_url":...}] 形态回传。用 str() 会把它
                # 变成 Python repr（单引号、非 JSON），模型收到一段乱码文本——且因为每轮
                # 都回传完整历史，这张图会**每轮重新丢一次**，完全静默。
                # 纯文本输出仍走 _extract_content 的字符串直通分支，行为不变。
                "content": content,
            })
            continue

        # 6. 其他类型保底
        if role:
            _flush_assistant()
            content = _extract_content(item.get("content", ""))
            messages.append({"role": role, "content": content})

    _flush_assistant()
    return messages


def _extract_reasoning_text(item: dict) -> str:
    """从 Responses 的 reasoning item 中提取可回填的思维链文本。

    Responses 规范把思维链放在 `summary`（摘要段数组或字符串）；部分实现
    （含 CodeBuddy 上游）也会落在 `content`，形态为字符串或部件数组。
    两者都取不到时返回空串，由调用方决定丢弃（不得注入空 reasoning_content）。
    """
    summary = item.get("summary")
    text = ""
    if isinstance(summary, list):
        text = "\n".join(
            p.get("text", "")
            for p in summary
            if isinstance(p, dict) and p.get("text")
        )
    elif isinstance(summary, str):
        text = summary
    if text:
        return text

    content = item.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # reasoning 的 content 部件类型是 reasoning_text；兼容部分实现的
        # text / output_text / summary_text 变体，避免因部件名差异再次静默丢失。
        parts = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") in ("reasoning_text", "text", "output_text", "summary_text") and p.get("text"):
                    parts.append(p["text"])
            elif isinstance(p, str):
                parts.append(p)
        return "\n".join(parts)
    return ""


def _extract_content(content: Any) -> str | list[dict]:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")

    has_image = any(
        isinstance(p, dict) and p.get("type") in ("input_image", "image_url")
        for p in content
    )
    if not has_image:
        parts = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") in ("input_text", "text", "output_text"):
                    parts.append(p.get("text", ""))
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)

    # 包含多模态图片的复合列表，转换为 OpenAI Chat 格式
    result: list[dict] = []
    for p in content:
        if isinstance(p, str):
            result.append({"type": "text", "text": p})
        elif isinstance(p, dict):
            ptype = p.get("type")
            if ptype in ("input_text", "text", "output_text"):
                result.append({"type": "text", "text": p.get("text", "")})
            elif ptype in ("input_image", "image_url"):
                iu = p.get("image_url")
                if isinstance(iu, str):
                    result.append({"type": "image_url", "image_url": {"url": iu}})
                elif isinstance(iu, dict):
                    result.append({"type": "image_url", "image_url": iu})
                elif "url" in p:
                    result.append({"type": "image_url", "image_url": {"url": p["url"]}})
    return result


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


def _tool_index(value: Any) -> int:
    """把上游 tool_call 的 `index` 归一为 int（字符串/缺失/负数一律容错）。

    ⚠️ 本模块用 index 做 `self._tool_calls` 的键，并据此**分配 output_idx**。上游若用
    字符串下发（`"10"` vs `"2"`），字典序会把并行工具调用排错位，客户端拿到的
    `function_call` 顺序与实际执行顺序不一致（>9 个并行工具时必现）。归一后按键排序稳定。
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if value >= 0 else 0
    if isinstance(value, float):
        return int(value) if value >= 0 else 0
    if isinstance(value, str):
        try:
            n = int(value.strip())
            return n if n >= 0 else 0
        except (TypeError, ValueError):
            return 0
    return 0


class ResponsesStreamConverter:
    """将 ChatCompletions SSE 流实时转换为 Responses API 语义事件流。"""

    def __init__(self, model: str = "unknown"):
        self.resp_id = _rand_id("resp_")
        self.msg_id = _rand_id("msg_")
        self.model = model
        self.created_at = int(time.time())
        self.sequence_number = 0

        self._emitted_created = False
        self._emitted_msg_item = False
        self._emitted_content_part = False

        self._content = ""
        self._reasoning_content = ""
        self._tool_calls: dict[int, dict] = {}
        self._usage: dict | None = None
        self._failed = False
        self._saw_terminal = False   # 见 finish() 的截断哨兵
        # P0-3：message 与 function_call item 共享一个单调递增的 output_index 分配器，
        # 保证同一流内每个 output item 的 index 唯一（不再依赖"文本是否先到"的时序假设）
        self._next_output_index = 0
        self._msg_output_idx: int | None = None

    def _alloc_output_index(self) -> int:
        """分配下一个唯一的 output_index。"""
        idx = self._next_output_index
        self._next_output_index += 1
        return idx

    def feed_chunk(self, chunk: dict) -> str:
        """处理已解析的单个 ChatCompletions JSON chunk，输出 Responses SSE 行。"""
        events: list[str] = []

        if self._failed:
            return ""

        # 终止标记：任一 choice 给出 finish_reason 即视为上游已正常收尾
        for _choice in chunk.get("choices") or []:
            if isinstance(_choice, dict) and _choice.get("finish_reason"):
                self._saw_terminal = True

        # 上游错误 chunk 拦截
        if "error" in chunk and isinstance(chunk["error"], dict):
            self._failed = True
            err_data = chunk["error"]
            err_msg = str(err_data.get("message") or "upstream error")
            err_code = str(err_data.get("code") or "502")
            if not self._emitted_created:
                resp = self._build_response_obj("in_progress")
                events.append(self._fmt("response.created", {"response": resp}))
                self._emitted_created = True
            resp_failed = self._build_response_obj("failed")
            resp_failed["error"] = {
                "message": err_msg,
                "code": err_code,
            }
            events.append(self._fmt("response.failed", {"response": resp_failed}))
            return "".join(events)

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
            delta = choice.get("delta") or {}

            # 思考/推理链增量累积（支持多轮思维链延续）
            rc = delta.get("reasoning_content") or delta.get("reasoning")
            if rc and isinstance(rc, str):
                self._reasoning_content += rc

            # 文本内容增量
            content = delta.get("content")
            if content:
                if not self._emitted_msg_item:
                    self._msg_output_idx = self._alloc_output_index()
                    events.append(self._fmt("response.output_item.added", {
                        "response_id": self.resp_id,
                        "output_index": self._msg_output_idx,
                        "item": self._build_msg_item("in_progress", empty=True),
                    }))
                    self._emitted_msg_item = True

                if not self._emitted_content_part:
                    events.append(self._fmt("response.content_part.added", {
                        "response_id": self.resp_id,
                        "item_id": self.msg_id,
                        "output_index": self._msg_output_idx,
                        "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": []},
                    }))
                    self._emitted_content_part = True

                self._content += content
                events.append(self._fmt("response.output_text.delta", {
                    "response_id": self.resp_id,
                    "item_id": self.msg_id,
                    "output_index": self._msg_output_idx,
                    "content_index": 0,
                    "delta": content,
                }))

            # 工具调用增量（P0-2：上游可能下发 "tool_calls": null，必须 None 安全）
            for tc in delta.get("tool_calls") or []:
                idx = _tool_index(tc.get("index", 0))
                if idx not in self._tool_calls:
                    # P0-3：从单调计数器分配，message 与 function_call 永不共享 index
                    oi = self._alloc_output_index()
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
                        "response_id": self.resp_id,
                        "output_index": slot["output_idx"],
                        "item": self._build_fc_item(slot, "in_progress"),
                    }))
                    slot["emitted"] = True

                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]
                    events.append(self._fmt("response.function_call_arguments.delta", {
                        "response_id": self.resp_id,
                        "item_id": slot["fc_id"],
                        "call_id": slot["id"],
                        "output_index": slot["output_idx"],
                        "delta": fn["arguments"],
                    }))

        return "".join(events)

    def finish(self) -> str:
        """流结束时补齐未关闭的 item/part 及发送 response.completed 事件。

        ⚠️ 截断哨兵：上游零终止标记（既无 finish_reason）却断流时**不得**报 completed。
        否则客户端把半句话当完整答案消费，而日志只有一行正常 200 —— 静默失败。
        此时改为下发 `response.failed`，并保留已产出的部分正文（诚实内容面）。
        """
        if self._failed:
            return ""

        if not self._saw_terminal and (self._content or self._tool_calls or self._emitted_msg_item):
            events: list[str] = []
            if not self._emitted_created:
                resp = self._build_response_obj("in_progress")
                events.append(self._fmt("response.created", {"response": resp}))
                self._emitted_created = True
            resp_failed = self._build_response_obj("failed")
            resp_failed["error"] = {
                "message": "upstream stream interrupted before a completion marker; "
                           "the answer may be truncated",
                "code": "upstream_stream_interrupted",
            }
            events.append(self._fmt("response.failed", {"response": resp_failed}))
            self._failed = True
            return "".join(events)

        events: list[str] = []

        if self._emitted_content_part:
            events.append(self._fmt("response.output_text.done", {
                "response_id": self.resp_id,
                "item_id": self.msg_id,
                "output_index": self._msg_output_idx,
                "content_index": 0,
                "text": self._content,
            }))
            events.append(self._fmt("response.content_part.done", {
                "response_id": self.resp_id,
                "item_id": self.msg_id,
                "output_index": self._msg_output_idx,
                "content_index": 0,
                "part": {"type": "output_text", "text": self._content, "annotations": []},
            }))

        if self._emitted_msg_item:
            events.append(self._fmt("response.output_item.done", {
                "response_id": self.resp_id,
                "output_index": self._msg_output_idx,
                "item": self._build_msg_item("completed"),
            }))

        for idx in sorted(self._tool_calls):
            tc = self._tool_calls[idx]
            if tc.get("emitted"):
                oi = tc["output_idx"]
                events.append(self._fmt("response.function_call_arguments.done", {
                    "response_id": self.resp_id,
                    "item_id": tc["fc_id"],
                    "call_id": tc["id"],
                    "output_index": oi,
                    "arguments": tc["args"],
                }))
                events.append(self._fmt("response.output_item.done", {
                    "response_id": self.resp_id,
                    "output_index": oi,
                    "item": self._build_fc_item(tc, "completed"),
                }))

        events.append(self._fmt("response.completed", {
            "response": self._build_response_obj("completed"),
        }))
        return "".join(events)

    def build_assistant_message(self) -> dict:
        """从流式累积状态还原同构的 assistant message，保留完整的 content、tool_calls 与 reasoning_content。"""
        msg: dict[str, Any] = {"role": "assistant"}
        if self._content:
            msg["content"] = self._content
        else:
            msg["content"] = ""
        if self._reasoning_content:
            msg["reasoning_content"] = self._reasoning_content
        if self._tool_calls:
            tcs = []
            for idx in sorted(self._tool_calls):
                tc = self._tool_calls[idx]
                tcs.append({
                    "id": tc.get("id") or tc.get("fc_id") or _rand_id("call_"),
                    "type": "function",
                    "function": {
                        "name": tc.get("name") or "",
                        "arguments": tc.get("args") or "",
                    },
                })
            msg["tool_calls"] = tcs
        return msg

    def _fmt(self, event_type: str, data: dict) -> str:
        payload = {"type": event_type, "sequence_number": self.sequence_number, **data}
        self.sequence_number += 1
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