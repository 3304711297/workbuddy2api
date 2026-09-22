"""DeepSeek thinking mode injection and multi-turn reasoning_content backfill.

Addresses:
1. Automatic thinking mode and reasoning_effort injection for DeepSeek models.
2. Multi-turn reasoning_content backfill to eliminate upstream 11133 model_param_invalid errors.
"""

from typing import Any, Dict


def is_deepseek_model(model: Any) -> bool:
    """Check if the model name starts with 'deepseek' (case-insensitive)."""
    if not isinstance(model, str):
        return False
    return model.strip().lower().startswith("deepseek")


def inject_thinking(body: Dict[str, Any]) -> Dict[str, Any]:
    """Inject thinking config and default reasoning_effort for DeepSeek models.

    Rules:
    - If model is a DeepSeek model and thinking is explicitly disabled (via thinking.type,
      reasoning_effort="disable", or enable_thinking=False), strictly preserve disabled state
      without overriding.
    - If thinking is not configured, inject thinking={"type": "enabled"}.
    - If reasoning_effort is missing and thinking is enabled, default to "high".
    """
    if not isinstance(body, dict):
        return body

    model = body.get("model")
    if not is_deepseek_model(model):
        return body

    thinking = body.get("thinking")
    reasoning_effort = body.get("reasoning_effort")
    chat_kwargs = body.get("chat_template_kwargs") or {}
    enable_thinking = chat_kwargs.get("enable_thinking") if isinstance(chat_kwargs, dict) else None

    # 判断是否显式关闭了思考模式
    explicit_disabled = (
        (isinstance(thinking, dict) and thinking.get("type") in ("disabled", "none", "off"))
        or reasoning_effort in ("disable", "disabled", "none", "off")
        or enable_thinking is False
    )

    if explicit_disabled:
        # 保持显式关闭语义，移除 reasoning_effort，保留 thinking={"type": "disabled"}
        body["thinking"] = {"type": "disabled"}
        body.pop("reasoning_effort", None)
        if isinstance(body.get("chat_template_kwargs"), dict):
            body["chat_template_kwargs"]["enable_thinking"] = False
        return body

    if thinking is None:
        thinking = {"type": "enabled"}
        body["thinking"] = thinking

    if not body.get("reasoning_effort"):
        body["reasoning_effort"] = "high"

    return body


def is_thinking_enabled(body: Dict[str, Any]) -> bool:
    """Check if thinking mode is effectively enabled for a DeepSeek model."""
    if not isinstance(body, dict):
        return False
    model = body.get("model")
    if not is_deepseek_model(model):
        return False

    thinking = body.get("thinking")
    thinking_type = str((thinking.get("type") if isinstance(thinking, dict) else "") or "").strip().lower()
    if thinking_type in ("disabled", "none", "off"):
        return False

    effort = str(body.get("reasoning_effort") or "").strip().lower()
    if effort in ("disable", "disabled", "none", "off"):
        return False

    chat_kwargs = body.get("chat_template_kwargs") or {}
    if isinstance(chat_kwargs, dict) and chat_kwargs.get("enable_thinking") is False:
        return False

    if thinking_type in ("enabled", "true") or bool(effort):
        return True
    return False


def backfill_reasoning_content(body: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure multi-turn consistency of reasoning_content across all assistant messages.

    Addresses upstream 11155 & 11133 errors:
    1. If thinking mode is enabled for DeepSeek (even with zero trace in history),
       every assistant message must carry reasoning_content (preventing upstream
       11155: 'the reasoning content from the previous turn must be passed back in thinking mode').
    2. If any assistant message carries a reasoning trace, all assistant messages
       must be backfilled regardless of thinking mode.
    3. Upstream validates len(reasoning) > 0, so reasoning is mirrored with a
       non-empty placeholder (" ") if absent/empty.
    """
    if not isinstance(body, dict):
        return body

    messages = body.get("messages")
    if not isinstance(messages, list):
        return body

    has_reasoning = False
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            r = msg.get("reasoning")
            if isinstance(r, str) and r:
                has_reasoning = True
                break
            if "reasoning_content" in msg:
                has_reasoning = True
                break

    thinking_on = is_thinking_enabled(body)

    if not thinking_on and not has_reasoning:
        return body

    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            rc = msg.get("reasoning_content")
            if not isinstance(rc, str):
                legacy = msg.get("reasoning")
                rc = legacy if isinstance(legacy, str) else ""
                msg["reasoning_content"] = rc

            # 镜像到 reasoning 且保证非空（通过上游 len(reasoning) > 0 门禁）
            existing_reasoning = msg.get("reasoning")
            if not (isinstance(existing_reasoning, str) and existing_reasoning):
                msg["reasoning"] = rc if rc else " "

    return body
