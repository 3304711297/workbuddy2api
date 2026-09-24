import pytest
import anthropic_compat

def test_anthropic_thinking_and_redacted_thinking_sidecar():
    """Direction C 契约：
    1. 当客户端（如 Claude Code）在多轮对话中回传 assistant 的 thinking、signature 或 redacted_thinking 时：
       - 不得静默丢弃
       - 必须在 assistant message 上保留 _anthropic_original_content sidecar
       - signature 必须保留在 sidecar / _anthropic_signature 中
       - redacted_thinking 不得导致解析异常，并在 reasoning_content 中保留占位
    2. 提供 strip_anthropic_sidecar 清洗函数，确保发往上游时彻底剔除 _anthropic_* 私有字段。
    """
    raw_messages = [
        {"role": "user", "content": "solve this puzzle"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Let me think about this step by step...",
                    "signature": "valid_signature_hash_xyz"
                },
                {
                    "type": "text",
                    "text": "The answer is 42."
                }
            ]
        },
        {"role": "user", "content": "are you sure?"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "redacted_thinking",
                    "data": "opaque_encrypted_blob_data"
                },
                {
                    "type": "text",
                    "text": "Yes, I am certain."
                }
            ]
        }
    ]

    req_body = {
        "model": "claude-3-7-sonnet",
        "messages": raw_messages,
        "max_tokens": 1024
    }

    translated = anthropic_compat.translate_anthropic_request(req_body)
    msgs = translated["messages"]

    # 验证第一条 assistant 消息
    asst1 = msgs[1]
    assert asst1["role"] == "assistant"
    assert asst1["content"] == "The answer is 42."
    assert "Let me think about this" in asst1["reasoning_content"]
    assert "_anthropic_original_content" in asst1
    assert asst1["_anthropic_original_content"] == raw_messages[1]["content"]
    assert asst1.get("_anthropic_signature") == "valid_signature_hash_xyz"

    # 验证第二条带 redacted_thinking 的 assistant 消息
    asst2 = msgs[3]
    assert asst2["role"] == "assistant"
    assert asst2["content"] == "Yes, I am certain."
    assert "_anthropic_original_content" in asst2
    assert asst2["_anthropic_original_content"] == raw_messages[3]["content"]
    assert asst2.get("reasoning_content") is not None

    # 验证 strip_anthropic_sidecar 清洗功能
    cleaned_msgs = anthropic_compat.strip_anthropic_sidecar(msgs)
    for m in cleaned_msgs:
        for k in m.keys():
            assert not k.startswith("_anthropic_"), f"发现残留私有字段: {k}"
