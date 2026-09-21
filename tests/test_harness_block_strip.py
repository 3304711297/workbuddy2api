"""契约测试：harness 样板的**块级剥离**（不再是「命中即整条丢」）。

背景
----
`responses_projection` 的 aggressive 投影原本对 harness 消息做**整条丢弃**：只要
`_content_to_text()` 里出现任一 marker（`<system-reminder>` / `# AGENTS.md instructions` /
`<environment_context>` …），整条消息就从发往后端的上下文里消失。

真实风险：harness 经常把**样板与真实指令塞在同一条里**，例如

    "# AGENTS.md instructions\\n<environment_context>\\nsandbox\\n</environment_context>\\n"
    + "Real ask: 把 utils.py 里的 off-by-one 修掉"

整条丢会把用户的真实意图一起删掉 —— 模型看不到需求，表现为"答非所问"或凭空发挥，
而日志里只剩一行 `dropped_harness_messages += 1`，观测面完全正常。

修法（对齐 anthropic_compat 的 `_strip_client_usage_hints` 粒度）：**块级剥离** ——
挖掉样板区块与样板行，剩下的正文若有实质内容就保留该条，只有剥完为空才整条丢。

反向纪律
--------
纯脚手架消息**仍然必须整条消失**（这是本模块存在的理由，不能因为改了粒度就不丢了）；
真实 system 指引（仓库规则等）必须照旧保留。
"""

from responses_projection import (
    BASE_SYSTEM_PROMPT,
    project_responses_chat_body,
    _strip_harness_blocks,
)


def _project(messages, tools=None):
    return project_responses_chat_body(
        {"messages": messages, "tools": tools or [{"type": "function",
                                                   "function": {"name": "exec_command"}}]})


def _dropped_user_texts(projected):
    return [m["content"] for m in projected["messages"] if m["role"] == "user"]


# ───────────────────── ① 直接对剥离函数：只挖样板，留下真话 ─────────────────────

def test_mixed_user_message_keeps_real_instruction():
    """**核心用例**：样板 + 真实指令同条 → 剥离后真实指令必须留下。"""
    raw = ("# AGENTS.md instructions\n"
           "<environment_context>\nsandbox: seatbelt\n</environment_context>\n"
           "Real ask: fix the off-by-one in utils.py")
    out = _strip_harness_blocks(raw)
    assert "Real ask: fix the off-by-one in utils.py" in out
    assert "environment_context" not in out
    assert "AGENTS.md" not in out


def test_system_reminder_block_is_removed_but_neighbours_kept():
    raw = "before\n<system-reminder>\nnoise\n</system-reminder>\nafter"
    out = _strip_harness_blocks(raw)
    assert "system-reminder" not in out and "noise" not in out
    assert "before" in out and "after" in out


def test_pure_harness_strips_to_empty():
    """纯脚手架 → 必须剥成空串（调用方据此整条丢）。"""
    for raw in (
        "<environment_context>\nsandbox\n</environment_context>",
        "# AGENTS.md instructions",
        "<system-reminder>\nonly noise\n</system-reminder>",
        "You are a coding agent running in the Codex CLI",
        "",
    ):
        assert _strip_harness_blocks(raw) == "", raw


def test_real_guidance_untouched():
    raw = "Repository policy: Always ensure tests pass before pushing."
    assert _strip_harness_blocks(raw) == raw


# ───────────────────── ② 端到端：混合消息不得消失 ─────────────────────

def test_mixed_harness_user_message_survives_projection():
    """端到端：混合条必须活下来，且真实指令出现在投影结果里。"""
    projected, stats = _project([
        {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
        {"role": "user",
         "content": "# AGENTS.md instructions\n<environment_context>\nsandbox\n"
                    "</environment_context>\nReal ask: refactor main.py"},
    ])
    assert stats["mode"] == "aggressive"
    blob = " ".join(_dropped_user_texts(projected))
    assert "Real ask: refactor main.py" in blob, "混合条的真实指令不得被整条丢弃"
    assert "environment_context" not in blob


def test_mixed_harness_system_message_becomes_guidance():
    """端到端：system 混合条剥离后若还有规则，应作为真实指引保留下来。"""
    projected, _ = _project([
        {"role": "system",
         "content": "You are a coding agent running in the Codex CLI.\n"
                    "Repository policy: Always ensure tests pass before pushing."},
        {"role": "user", "content": "Fix the bug in utils.py"},
    ])
    system_contents = [m["content"] for m in projected["messages"] if m["role"] == "system"]
    assert any("Always ensure tests pass before pushing" in t for t in system_contents)
    assert not any("Codex CLI" in t for t in system_contents), "harness 自述行不得当指引留下"


# ───────────────────── ③ 反向：纯脚手架照旧整条丢 ─────────────────────

def test_pure_harness_messages_still_dropped():
    """反向纪律：纯脚手架的 user/system 条必须照旧整条消失（不能修过头）。"""
    projected, stats = _project([
        {"role": "system", "content": "You are a coding agent running in the Codex CLI.\n# AGENTS.md spec"},
        {"role": "user",
         "content": "# AGENTS.md instructions\n<environment_context>\nsandbox\n</environment_context>"},
        {"role": "user", "content": "Real user ask: refactor main.py"},
    ])
    assert stats["dropped_harness_messages"] >= 2
    assert projected["messages"][0]["role"] == "system"
    assert BASE_SYSTEM_PROMPT in projected["messages"][0]["content"]
    assert projected["messages"][-1]["content"] == "Real user ask: refactor main.py"


def test_pure_harness_never_reaches_upstream():
    """纯脚手架内容一个字都不该出现在投影后的上下文里。"""
    projected, _ = _project([
        {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
        {"role": "user", "content": "<system-reminder>\nToken usage: 1/2; 3 remaining\n</system-reminder>"},
        {"role": "user", "content": "hello"},
    ])
    blob = " ".join(str(m.get("content", "")) for m in projected["messages"])
    assert "system-reminder" not in blob
    assert "Codex CLI" not in blob
