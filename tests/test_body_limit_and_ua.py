"""
tests/test_body_limit_and_ua.py - 请求体大小防护 (413 Payload Too Large) 与 出站 User-Agent 仿真测试

借鉴自:
1. linguo2625469/workbuddy2api-panel: server.max_body_mb 请求体超限返回 413 request_body_too_large，保护本地与上游
2. ardeyouxipianyi/workbuddy2api-intl & turbomind66/workbuddy2api-python: 官方客户端 User-Agent 规范仿真与环境变量覆盖
"""

import json
import pytest
from starlette.testclient import TestClient
import converter


def _client():
    return TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})


def test_body_limit_allows_normal_payload(monkeypatch):
    """正常大小的请求体应正常放行（不被 413 拦截）。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 1024 * 1024)  # 1MB
    client = _client()
    
    # 一个极小的合法 JSON 请求
    res = client.post(
        "/v1/chat/completions",
        json={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
    )
    # 不应报 413
    assert res.status_code != 413


def test_body_limit_blocks_oversized_content_length(monkeypatch):
    """当 Content-Length 头部超出上限时，网关直接拦截并返回 413。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 100)  # 设为极小的 100 字节
    client = _client()

    large_content = "a" * 200
    res = client.post(
        "/v1/chat/completions",
        json={"model": "auto", "messages": [{"role": "user", "content": large_content}]},
    )
    assert res.status_code == 413
    data = res.json()
    assert data["error"]["code"] == "request_body_too_large"
    assert "exceeds" in data["error"]["message"].lower() or "上限" in data["error"]["message"]


def test_body_limit_blocks_oversized_anthropic_messages(monkeypatch):
    """针对 Anthropic /v1/messages 端点，超限时同样拦截返回 413。"""
    monkeypatch.setattr(converter, "MAX_BODY_BYTES", 100)
    client = _client()

    large_content = "a" * 200
    res = client.post(
        "/v1/messages",
        json={"model": "deepseek-v4-pro", "max_tokens": 10, "messages": [{"role": "user", "content": large_content}]},
    )
    assert res.status_code == 413
    data = res.json()
    assert data["type"] == "error"
    assert data["error"]["type"] == "invalid_request_error"
    assert "too_large" in data["error"]["message"].lower() or "exceeds" in data["error"]["message"].lower() or "上限" in data["error"]["message"]


def test_user_agent_resolution(monkeypatch):
    """测试 User-Agent 的智能解析与环境变量覆盖机制。"""
    # 1. 默认仿真官方客户端 User-Agent
    monkeypatch.delenv("WORKBUDDY2API_USER_AGENT", raising=False)
    monkeypatch.delenv("CODEBUDDY2OPENAI_USER_AGENT", raising=False)
    default_ua = converter._get_user_agent(domain="www.codebuddy.cn")
    assert "CodeBuddy" in default_ua or "CLI" in default_ua

    # 国际版仿真
    intl_ua = converter._get_user_agent(domain="www.workbuddy.ai")
    assert "WorkBuddy" in intl_ua

    # 2. 环境变量覆盖
    monkeypatch.setenv("WORKBUDDY2API_USER_AGENT", "CustomClient/1.0.0")
    assert converter._get_user_agent() == "CustomClient/1.0.0"
