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


def backfill_reasoning_content(body: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure multi-turn consistency of reasoning_content across all assistant messages.

    If any assistant message in the conversation history contains a non-empty
    'reasoning' or an existing 'reasoning_content', all assistant messages in
    the context must carry 'reasoning_content' (defaulting to empty string ""
    if absent), preventing upstream 11133 model_param_invalid errors.
    """
    if not isinstance(body, dict):
        return body

    messages = body.get("messages")
    if not isinstance(messages, list):
        return body

    has_reasoning = any(
        isinstance(msg, dict)
        and msg.get("role") == "assistant"
        and (bool(msg.get("reasoning")) or "reasoning_content" in msg)
        for msg in messages
    )

    if not has_reasoning:
        return body

    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            if msg.get("reasoning_content") is None:
                msg["reasoning_content"] = msg.get("reasoning") or ""

    return body
