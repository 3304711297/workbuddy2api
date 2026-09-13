"""P3 backlog C: responses function_call without call_id must fail fast, not invent one."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from responses_compat import responses_request_to_chat


def _body(items):
    return {"model": "m", "input": items}


def test_function_call_missing_id_rejected():
    body = _body([{"type": "function_call", "name": "shell", "arguments": "{}"}])
    with pytest.raises(ValueError, match="function_call"):
        responses_request_to_chat(body)


def test_function_call_with_call_id_passes_through():
    body = _body([
        {"type": "message", "role": "user", "content": "run it"},
        {"type": "function_call", "call_id": "call_1", "name": "shell",
         "arguments": '{"cmd":"ls"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": "file.txt"},
    ])
    out = responses_request_to_chat(body)
    assert out["messages"][1]["tool_calls"][0]["id"] == "call_1"
    assert out["messages"][2] == {"role": "tool", "tool_call_id": "call_1", "content": "file.txt"}
