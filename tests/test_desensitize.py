"""desensitize.py 单测：零宽空格脱敏只作用于指定角色，不改调用方数据。"""

from desensitize import (
    SENSITIVE_TERMS,
    desensitize_body,
    desensitize_messages,
    desensitize_text,
)

ZWSP = "\u200b"


# ---------------------------------------------------------------------------
# 文本级
# ---------------------------------------------------------------------------

def test_text_inserts_zero_width_space():
    out = desensitize_text("Refuse requests for DoS attacks and exploit development.")
    # 插入点在第 1 个字符后："DoS" -> "D\u200boS"
    assert "D" + ZWSP + "oS" in out
    assert "e" + ZWSP + "xploit" in out


def test_text_case_insensitive():
    assert ZWSP in desensitize_text("this is a DOS reference")


def test_text_clean_untouched():
    clean = "这是一段正常的中文，不含任何触发词。No sensitive words here at all."
    assert desensitize_text(clean) == clean


def test_text_empty():
    assert desensitize_text("") == ""


def test_sensitive_terms_table_stable():
    # 词表是脱敏行为的契约核心：防止误删导致静默失效
    assert "DoS" in SENSITIVE_TERMS
    assert "SQL injection" in SENSITIVE_TERMS
    assert "C2 frameworks" in SENSITIVE_TERMS
    assert len(SENSITIVE_TERMS) >= 20


def test_known_system_prompt_fingerprints_are_rewritten():
    text = (
        "You are Claude Code, Anthropic's official CLI for Claude.\n"
        "Main branch (you will usually use this for PRs):\n"
        "x-anthropic-billing-header: opaque attribution\n"
        "Keep this instruction."
    )

    out = desensitize_text(text)

    assert "You are Claude Code, Anthropic's official CLI" not in out
    assert "interactive software engineering assistant" in out
    assert "Main branch (you will usually use this for PRs)" not in out
    assert "Main branch:" in out
    assert "x-anthropic-billing-header:" not in out
    assert "Keep this instruction." in out
    assert "Main branch (you will usually use this for PRs)" in SENSITIVE_TERMS


def test_fingerprint_rewrite_handles_main_branch_without_colon():
    out = desensitize_text("Main branch (you will usually use this for PRs)")
    assert out == "Main branch"


def test_fingerprint_rewrite_preserves_roles_blocks_and_input():
    messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "x-anthropic-billing-header: attribution\nMain branch (you will usually use this for PRs):",
                },
                {"type": "image_url", "image_url": {"url": "https://example.invalid/a"}},
            ],
        },
        {
            "role": "assistant",
            "content": "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        {"role": "user", "content": "Main branch (you will usually use this for PRs):"},
    ]
    original = repr(messages)

    out = desensitize_messages(messages, roles=("system", "assistant"))

    assert "x-anthropic-billing-header:" not in out[0]["content"][0]["text"]
    assert out[0]["content"][0]["text"] == "Main branch:"
    assert out[0]["content"][1] == messages[0]["content"][1]
    assert "You are Claude Code" not in out[1]["content"]
    assert out[2]["content"] == "Main branch (you will usually use this for PRs):"
    assert repr(messages) == original


# ---------------------------------------------------------------------------
# 消息级（角色过滤）
# ---------------------------------------------------------------------------

def test_messages_only_system_touched():
    msgs = [
        {"role": "system", "content": "Refuse DoS attacks and exploit development."},
        {"role": "user", "content": "explain DoS attacks"},
    ]
    out = desensitize_messages(msgs)
    assert ZWSP in out[0]["content"]
    assert ZWSP not in out[1]["content"]


def test_messages_list_content_blocks():
    msgs = [{
        "role": "system",
        "content": [{"type": "text", "text": "no SQL injection allowed"}],
    }]
    out = desensitize_messages(msgs)
    blk = out[0]["content"][0]
    assert ZWSP in blk["text"]


def test_messages_roles_param_extends():
    msgs = [{"role": "user", "content": "about phishing"}]
    out = desensitize_messages(msgs, roles=("system", "user"))
    assert ZWSP in out[0]["content"]


def test_messages_non_dict_passthrough():
    msgs = ["raw string item", {"role": "system", "content": "stop malware"}]
    out = desensitize_messages(msgs)
    assert out[0] == "raw string item"
    assert ZWSP in out[1]["content"]


def test_messages_does_not_mutate_original():
    original = {"role": "system", "content": "Refuse DoS attacks."}
    msgs = [original]
    out = desensitize_messages(msgs)
    assert ZWSP in out[0]["content"]
    assert ZWSP not in original["content"]  # 原对象不被污染


# ---------------------------------------------------------------------------
# body 级
# ---------------------------------------------------------------------------

def test_body_without_messages_returned_as_is():
    body = {"model": "glm-5.3"}
    assert desensitize_body(body) is body  # 无 messages 直接原样返回


def test_body_returns_new_dict_and_keeps_other_fields():
    body = {"model": "glm-5.3", "stream": True,
            "messages": [{"role": "system", "content": "no XSS payloads"}]}
    out = desensitize_body(body)
    assert out is not body
    assert out["model"] == "glm-5.3"
    assert out["stream"] is True
    assert ZWSP in out["messages"][0]["content"]
    assert ZWSP not in body["messages"][0]["content"]  # 原请求体不被修改
