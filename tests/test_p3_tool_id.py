"""P3 backlog B: tool_use without id must fail fast, not invent one."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from anthropic_compat import translate_anthropic_request


def _body(content):
    return {"model": "m", "max_tokens": 10, "messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": content},
    ]}


def test_tool_use_missing_id_rejected():
    body = _body([{"type": "tool_use", "name": "read", "input": {}}])
    with pytest.raises(ValueError, match="tool_use"):
        translate_anthropic_request(body)


def test_tool_use_empty_id_rejected():
    body = _body([{"type": "tool_use", "id": "", "name": "read", "input": {}}])
    with pytest.raises(ValueError, match="tool_use"):
        translate_anthropic_request(body)


def test_tool_use_with_id_passes_through():
    body = _body([{"type": "tool_use", "id": "toolu_123", "name": "read",
                   "input": {"path": "a"}}])
    out = translate_anthropic_request(body)
    assert out["messages"][1]["tool_calls"][0]["id"] == "toolu_123"
