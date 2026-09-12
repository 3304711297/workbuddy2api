"""tests/test_responses_projection.py - Codex CLI 长上下文投影压缩模块单测

验证 responses_projection.py:
1. conservative 模式（非 Agentic CLI 请求）
2. aggressive 模式（识别 exec_command 等 agentic tools 或 harness markers）
3. 剥离 Codex harness system/user 模板，保留真实指令
4. 收敛 tools schema 字段，裁剪无用 description
5. 尾部 ≤8 条关键上下文或 ≤7000 字符保留，早前历史自动压缩为规则摘要
6. 孤立 tool 消息的 assistant 调用链路回溯保全 (tool context expansion)
7. 锚点用户意图保全 (latest user anchor)
8. 超长 tool arguments / tool output 结构化收缩
"""

import json
import pytest

from responses_projection import (
    AGENTIC_TOOL_NAMES,
    BASE_SYSTEM_PROMPT,
    HARNESS_SYSTEM_MARKERS,
    HARNESS_USER_MARKERS,
    HISTORY_PREFIX,
    MAX_ASSISTANT_CHARS,
    MAX_SYSTEM_GUIDANCE_CHARS,
    MAX_TAIL_CHARS,
    MAX_TAIL_MESSAGES,
    MAX_TOOL_ARGS_CHARS,
    MAX_TOOL_OUTPUT_CHARS,
    MAX_USER_CHARS,
    project_responses_chat_body,
)


def test_conservative_mode_normal_chat():
    """验证普通非 Agentic 对话走 conservative 模式，不剥离系统提示，不折叠历史。"""
    body = {
        "model": "deepseek-v4-pro",
        "messages": [
            {"role": "system", "content": "You are a friendly general-purpose assistant."},
            {"role": "user", "content": "Hello! Write a poem about rust."},
            {"role": "assistant", "content": "Ferris the crab scuttles by..."},
            {"role": "user", "content": "Make it shorter."},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "calculator",
                    "description": "A simple calculator for math operations.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "expr": {"type": "string", "description": "Expression to evaluate"},
                        },
                        "required": ["expr"],
                    },
                },
            }
        ],
    }

    projected, stats = project_responses_chat_body(body)

    assert stats["mode"] == "conservative"
    assert stats["aggressive"] is False
    assert stats["original_messages"] == 4
    assert stats["projected_messages"] == 4

    # 验证普通 system 提示与对话被原样/保守保留
    msgs = projected["messages"]
    assert msgs[0]["role"] == "system"
    assert msgs[0]["content"] == "You are a friendly general-purpose assistant."
    assert msgs[1]["content"] == "Hello! Write a poem about rust."
    assert msgs[3]["content"] == "Make it shorter."

    # 验证 tool schema description 依然被收敛
    assert len(projected["tools"]) == 1
    fn = projected["tools"][0]["function"]
    assert fn["name"] == "calculator"
    assert "description" not in fn
    assert "description" not in fn["parameters"]["properties"]["expr"]


def test_aggressive_mode_triggered_by_agentic_tools():
    """验证包含 exec_command 等 agentic tools 时自动触发 aggressive 模式。"""
    for tool_name in ["exec_command", "apply_patch", "write_stdin", "update_plan"]:
        body = {
            "messages": [
                {"role": "user", "content": "List files in src"},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "parameters": {"type": "object"},
                    },
                }
            ],
        }
        projected, stats = project_responses_chat_body(body)
        assert stats["mode"] == "aggressive"
        assert stats["aggressive"] is True


def test_aggressive_mode_triggered_by_harness_markers():
    """验证无 agentic tools 但包含 Codex harness markers 时自动触发 aggressive 模式。"""
    body = {
        "messages": [
            {"role": "system", "content": "You are a coding agent running in the Codex CLI.\n# AGENTS.md spec"},
            {"role": "user", "content": "# AGENTS.md instructions\n<environment_context>\nsandbox\n</environment_context>"},
            {"role": "user", "content": "Real user ask: refactor main.py"},
        ],
        "tools": [],
    }
    projected, stats = project_responses_chat_body(body)
    assert stats["mode"] == "aggressive"
    assert stats["aggressive"] is True
    assert stats["dropped_harness_messages"] >= 2

    # 验证基础 system prompt 置顶
    assert projected["messages"][0]["role"] == "system"
    assert BASE_SYSTEM_PROMPT in projected["messages"][0]["content"]

    # 验证真实用户意图保留
    assert projected["messages"][-1]["content"] == "Real user ask: refactor main.py"


def test_preserve_non_harness_system_guidance():
    """验证剥离 Codex harness 时，能有效保留仓库自带规则与真实系统指引。"""
    body = {
        "messages": [
            {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
            {"role": "system", "content": "Repository policy: Always ensure tests pass before pushing."},
            {"role": "user", "content": "Fix the bug in utils.py"},
        ],
        "tools": [
            {"type": "function", "function": {"name": "exec_command"}}
        ],
    }

    projected, stats = project_responses_chat_body(body)
    assert stats["mode"] == "aggressive"
    assert stats["preserved_guidance_messages"] == 1

    system_contents = [m["content"] for m in projected["messages"] if m["role"] == "system"]
    assert any("Always ensure tests pass before pushing" in text for text in system_contents)


def test_history_compression_and_tail_messages_limit():
    """验证超过 MAX_TAIL_MESSAGES(8) 的历史消息自动被压缩为 Earlier conversation summary。"""
    messages = [
        {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
    ]
    # 添加 12 轮交互
    for i in range(12):
        messages.append({"role": "user", "content": f"User query {i}"})
        messages.append({
            "role": "assistant",
            "content": f"Assistant reply {i}",
            "tool_calls": [
                {
                    "id": f"call_{i}",
                    "type": "function",
                    "function": {"name": "exec_command", "arguments": json.dumps({"cmd": f"echo {i}"})},
                }
            ],
        })
        messages.append({
            "role": "tool",
            "tool_call_id": f"call_{i}",
            "content": f"Output:\nresult {i}\nProcess exited with code 0",
        })

    body = {
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }

    projected, stats = project_responses_chat_body(body)
    assert stats["mode"] == "aggressive"
    assert stats["summarized_history_messages"] > 0
    assert stats["tail_messages"] <= MAX_TAIL_MESSAGES + 2  # 可能因 tool context 扩展微调

    # 检查存在 Earlier conversation summary 摘要消息
    sys_msgs = [m for m in projected["messages"] if m["role"] == "system"]
    summary_msg = next((m for m in sys_msgs if HISTORY_PREFIX in m["content"]), None)
    assert summary_msg is not None
    assert "User asked:" in summary_msg["content"]
    assert "Tool exec_command returned:" in summary_msg["content"]


def test_tail_expansion_for_tool_context():
    """验证当 tail 包含 tool 消息时，其对应的 assistant(tool_calls) 哪怕在 tail 之前也会被纳入 tail。"""
    messages = [
        {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
        {"role": "user", "content": "Step 1"},
        {"role": "assistant", "content": "Doing step 1"},
        {"role": "user", "content": "Step 2"},
        {"role": "assistant", "content": "Doing step 2"},
        {"role": "user", "content": "Step 3"},
        {"role": "assistant", "content": "Doing step 3"},
        {"role": "user", "content": "Step 4"},
        {"role": "assistant", "content": "Doing step 4"},
        # 这一条 assistant 包含 call_critical
        {
            "role": "assistant",
            "content": "Executing critical step",
            "tool_calls": [
                {
                    "id": "call_critical",
                    "type": "function",
                    "function": {"name": "exec_command", "arguments": '{"cmd":"run"}'},
                }
            ],
        },
        # 后面紧跟 tool output
        {"role": "tool", "tool_call_id": "call_critical", "content": "Output:\nSuccess\nProcess exited with code 0"},
        {"role": "assistant", "content": "Completed successfully."},
    ]

    body = {
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }

    projected, stats = project_responses_chat_body(body)
    # 确保 tool 消息和其对应的 assistant tool_call 在输出中完整成对
    non_sys = [m for m in projected["messages"] if m["role"] != "system"]
    tool_msg_ids = [m.get("tool_call_id") for m in non_sys if m.get("role") == "tool"]
    assistant_call_ids = [
        tc.get("id")
        for m in non_sys if m.get("role") == "assistant"
        for tc in m.get("tool_calls", [])
    ]
    for tid in tool_msg_ids:
        if tid:
            assert tid in assistant_call_ids, f"Tool call id {tid} must have its assistant tool_call preserved"


def test_latest_user_anchor_preservation():
    """验证当最新 user 消息因大量 tool 轮次被推到 tail 之前时，作为 anchor_user 显式保全。"""
    messages = [
        {"role": "system", "content": "You are a coding agent running in the Codex CLI."},
        {"role": "user", "content": "CRITICAL_USER_GOAL: Fix issue 42"},
    ]
    # 连续产生 9 轮 assistant / tool 交互，将 user 挤出尾部 8 条
    for i in range(9):
        messages.append({
            "role": "assistant",
            "content": f"Step {i}",
            "tool_calls": [{"id": f"c_{i}", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}],
        })
        messages.append({
            "role": "tool",
            "tool_call_id": f"c_{i}",
            "content": f"Done {i}",
        })

    body = {
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }

    projected, stats = project_responses_chat_body(body)
    assert stats["anchor_user_preserved"] is True
    # 验证 CRITICAL_USER_GOAL 出现在消息列表中
    contents = [m.get("content", "") for m in projected["messages"]]
    assert any("CRITICAL_USER_GOAL: Fix issue 42" in c for c in contents)


def test_shrink_large_tool_arguments():
    """验证超长 tool arguments (>900 chars) 的智能截断与 apply_patch 特殊处理。"""
    # 1. apply_patch 超长
    large_patch = "diff --git a/file b/file\n" + ("+line\n" * 200)
    body_patch = {
        "messages": [
            {
                "role": "assistant",
                "content": "Applying patch",
                "tool_calls": [
                    {
                        "id": "c_patch",
                        "type": "function",
                        "function": {"name": "apply_patch", "arguments": json.dumps({"patch": large_patch})},
                    }
                ],
            }
        ],
        "tools": [{"type": "function", "function": {"name": "apply_patch"}}],
    }
    projected_patch, _ = project_responses_chat_body(body_patch)
    args_str = projected_patch["messages"][-1]["tool_calls"][0]["function"]["arguments"]
    assert "Large apply_patch payload omitted" in args_str

    # 2. 一般命令超长
    long_cmd = "echo " + ("a" * 1500)
    body_cmd = {
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c_cmd",
                        "type": "function",
                        "function": {"name": "exec_command", "arguments": json.dumps({"cmd": long_cmd})},
                    }
                ],
            }
        ],
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }
    projected_cmd, _ = project_responses_chat_body(body_cmd)
    args_cmd_str = projected_cmd["messages"][-1]["tool_calls"][0]["function"]["arguments"]
    parsed = json.loads(args_cmd_str)
    assert "truncated" in parsed["cmd"]


def test_summarize_large_tool_output():
    """验证多于 24 行或超长 tool output 会被提炼为退出码、首 10 行、省略提示、尾 6 行。"""
    lines = [
        "Chunk ID: abc12345",
        "Wall time: 0.123s",
        "Process exited with code 0",
        "Output:",
    ] + [f"result_data_line_{i}" for i in range(50)]
    full_output = "\n".join(lines)

    body = {
        "messages": [
            {"role": "user", "content": "Run tests"},
            {"role": "assistant", "content": "Running", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": full_output},
        ],
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }

    projected, _ = project_responses_chat_body(body)
    tool_msg = next(m for m in projected["messages"] if m.get("role") == "tool")
    content = tool_msg["content"]

    assert "Process exited with code 0" in content
    assert "Key output:" in content
    assert "result_data_line_0" in content
    assert "omitted" in content
    assert "Recent tail:" in content
    assert "result_data_line_49" in content
    assert "Chunk ID:" not in content
    assert "Wall time:" not in content


def test_schema_projection_removes_unnecessary_keys():
    """验证 parameters schema 仅保留合法的 SCHEMA_KEEP_KEYS，去掉 title, default, markdownDescription 等。"""
    tools = [
        {
            "type": "function",
            "function": {
                "name": "custom_tool",
                "description": "Should be removed",
                "parameters": {
                    "type": "object",
                    "title": "CustomToolParams",
                    "description": "Object description",
                    "properties": {
                        "param1": {
                            "type": "string",
                            "title": "Param 1",
                            "description": "First param",
                            "default": "val",
                        },
                        "items_list": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "title": "ItemObj",
                                "properties": {"id": {"type": "integer", "description": "id desc"}},
                            },
                        },
                    },
                    "required": ["param1"],
                },
                "strict": True,
            },
        }
    ]
    body = {"messages": [{"role": "user", "content": "hi"}], "tools": tools}
    projected, stats = project_responses_chat_body(body)

    fn = projected["tools"][0]["function"]
    assert "description" not in fn
    params = fn["parameters"]
    assert "title" not in params
    assert "description" not in params
    assert "title" not in params["properties"]["param1"]
    assert "description" not in params["properties"]["param1"]
    assert "default" not in params["properties"]["param1"]
    item_props = params["properties"]["items_list"]["items"]["properties"]["id"]
    assert "description" not in item_props
    assert "title" not in params["properties"]["items_list"]["items"]
    assert fn["strict"] is True


def test_structured_content_blocks_handling():
    """验证 input_text / text / output 等块状 content 能被正确解析为纯文本并参与投影。"""
    body = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Hello "},
                    {"type": "text", "text": "world"},
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "c_block",
                "content": [
                    {"output": "Process exited with code 0\nOutput:\nblock output line"}
                ],
            },
        ],
        "tools": [{"type": "function", "function": {"name": "exec_command"}}],
    }

    projected, _ = project_responses_chat_body(body)
    user_msg = next(m for m in projected["messages"] if m["role"] == "user")
    assert "Hello world" in user_msg["content"]
