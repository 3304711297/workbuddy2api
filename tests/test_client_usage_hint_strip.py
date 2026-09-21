"""契约测试：Claude Code 客户端用量提示的剥离（采纳自 orangeboyChen/codebuddy2api #178）。

背景
----
Claude Code 在 token-usage 附件开启时，会把**客户端自己的账**以元消息形式追加在
会话尾部，两种形态（可裸放，也可被 `<system-reminder>` 包住）：

    ① `Token usage: 190010/180000; -10010 remaining`
    ② `<total_tokens>15000000 tokens left</total_tokens>`（补零倒计时）

这些对上游模型没有任何信息价值：白占上下文、占掉提示词缓存位（客户端会给它们标
`cache_control: ephemeral`），而负数倒计时还会被模型当成"我快没额度了"的错误指令。
上游 #178 为其补了 4 条用例；本文件按同样的边界在本仓复刻，并额外覆盖本仓特有的
「空壳消息」风险。

反向纪律（同样重要，上游专门守这条）
------------------------------------
**只删提示本身，同块里的真实正文必须原样保留** —— `<total_tokens>…</total_tokens>\n
fix the failing test` 剥离后必须还留着 `fix the failing test`；用户自己贴的
`<total_tokens>` 片段（没有数字载荷，如 schema 示例）必须一字不动。
"""

import json

import anthropic_compat
from anthropic_compat import _strip_client_usage_hints, _translate_anthropic_messages


def _messages(msgs):
    body = anthropic_compat.translate_anthropic_request(
        {"model": "claude-sonnet-4.6", "max_tokens": 128, "messages": msgs})
    return body["messages"]


def _users(msgs):
    return [m for m in msgs if m["role"] == "user"]


# ───────────────────── ① 基线：裸形态与带壳形态都要剥 ─────────────────────

def test_strip_bare_token_usage_line():
    assert _strip_client_usage_hints("Token usage: 190010/180000; -10010 remaining") == ""


def test_strip_wrapped_token_usage_line():
    raw = "<system-reminder>\nToken usage: 190010/180000; -10010 remaining\n</system-reminder>"
    assert _strip_client_usage_hints(raw) == ""


def test_strip_bare_total_tokens_countdown():
    assert _strip_client_usage_hints("<total_tokens>15000000 tokens left</total_tokens>") == ""


def test_strip_wrapped_total_tokens_countdown():
    raw = ("<system-reminder>\n<total_tokens>14999841 tokens left</total_tokens>\n"
           "</system-reminder>\n")
    assert _strip_client_usage_hints(raw) == ""


def test_strip_negative_and_decorated_counts():
    """计数可能为负、可能带千分位/下划线/小数点（客户端账目溢出时形态不定）。"""
    for raw in (
        "<total_tokens>-10010 tokens left</total_tokens>",
        "<total_tokens>15,000,000 tokens left</total_tokens>",
        "<total_tokens>15000000.5 token left</total_tokens>",
        "<total_tokens>1_500 tokens left</total_tokens>",
    ):
        assert _strip_client_usage_hints(raw) == "", raw


# ───────────────────── ② 反向：真实正文与用户数据不得被删 ─────────────────────

def test_keeps_text_delivered_alongside_the_countdown():
    """**上游核心用例**：提示与真实正文同块 → 只删提示，正文留下。"""
    raw = "<total_tokens>15000000 tokens left</total_tokens>\nfix the failing test in lib/foo.ts"
    out = _strip_client_usage_hints(raw)
    assert "total_tokens>" not in out
    assert "fix the failing test in lib/foo.ts" in out


def test_keeps_wrapped_form_shell_free():
    """带壳形态必须把 `<system-reminder>` 壳一起去掉，不留孤立标签。"""
    raw = "<system-reminder><total_tokens>999 tokens left</total_tokens></system-reminder>"
    out = _strip_client_usage_hints(raw)
    assert "system-reminder" not in out and "total_tokens" not in out


def test_untouched_when_no_numeric_payload():
    """**关键反向用例**：用户自己贴的 `<total_tokens>` 片段（无数字载荷）必须一字不动。

    上游 #178 的注释点明了这个设计取舍：倒计时必须带 `<N> token(s) left` 载荷才算提示，
    否则 schema 示例/文档片段这类用户数据会被误删。
    """
    for raw in (
        "<total_tokens>some tokens left</total_tokens>",
        "<total_tokens>{{count}} tokens left</total_tokens>",
        "The element is <total_tokens> in our schema.",
        "total_tokens = 15000000",
    ):
        assert _strip_client_usage_hints(raw) == raw, raw


def test_plain_text_untouched():
    assert _strip_client_usage_hints("just a normal prompt") == "just a normal prompt"
    assert _strip_client_usage_hints("") == ""


# ───────────────────── ③ 端到端：整条元消息不得留空壳 ─────────────────────

def test_whole_meta_message_is_dropped_from_history():
    """整条只是用量提示 → 该消息必须从发给上游的消息表里消失（不留空壳）。"""
    msgs = _messages([
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "ok"},
        {"role": "assistant", "content": "<total_tokens>15000000 tokens left</total_tokens>"},
    ])
    blob = json.dumps(msgs, ensure_ascii=False)
    assert "total_tokens>" not in blob
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[-1]["content"] == "ok"


def test_meta_message_in_system_reminder_is_dropped():
    """带 `<system-reminder>` 壳的元消息（Claude Code 的另一种投递形态）同样整条消失。"""
    msgs = _messages([
        {"role": "user", "content": "first"},
        {"role": "user",
         "content": "<system-reminder>\n<total_tokens>14999841 tokens left</total_tokens>\n"
                    "</system-reminder>\n"},
    ])
    blob = json.dumps(msgs, ensure_ascii=False)
    assert "system-reminder" not in blob and "total_tokens>" not in blob
    assert [m["role"] for m in msgs] == ["user"]
    assert msgs[-1]["content"] == "first"


def test_meta_message_alongside_real_text_keeps_the_text():
    """端到端反向：提示与真实指令同条 → 消息保留，且只剩真实指令。"""
    msgs = _messages([
        {"role": "user",
         "content": [{"type": "text",
                      "text": "<total_tokens>15000000 tokens left</total_tokens>\n"
                              "fix the failing test in lib/foo.ts"}]},
    ])
    assert len(msgs) == 1
    assert "total_tokens>" not in json.dumps(msgs, ensure_ascii=False)
    assert "fix the failing test in lib/foo.ts" in msgs[-1]["content"]


def test_string_user_meta_message_dropped():
    """裸字符串形态的 user 元消息（不走 content 数组）同样整条丢弃。"""
    msgs = _messages([
        {"role": "user", "content": "real question"},
        {"role": "user", "content": "Token usage: 190010/180000; -10010 remaining"},
    ])
    assert [m["content"] for m in _users(msgs)] == ["real question"]


def test_empty_user_message_is_preserved():
    """⚠️ 本仓特有边界：**本来就没内容**的 user 消息必须原样保留。

    丢弃逻辑的判据是「剥离后为空 **且** 原文非空」，否则会把客户端故意发的空消息
    也一并吃掉，改动消息表长度。
    """
    msgs = _messages([{"role": "user", "content": ""}])
    assert [m["content"] for m in _users(msgs)] == [""]
    msgs2 = _messages([{"role": "user", "content": "   "}])
    assert len(_users(msgs2)) == 1


def test_attribution_and_hint_stripped_together():
    """system 入口同时要吃两种噪声：计费归属头 + 客户端用量提示。"""
    msgs = _messages([
        {"role": "system",
         "content": "x-anthropic-billing-header: 12345\nYou are helpful.\n"
                    "<total_tokens>15000000 tokens left</total_tokens>"},
        {"role": "user", "content": "hi"},
    ])
    sys_msg = [m for m in msgs if m["role"] == "system"][0]
    assert "billing-header" not in sys_msg["content"]
    assert "total_tokens>" not in sys_msg["content"]
    assert "You are helpful." in sys_msg["content"]
