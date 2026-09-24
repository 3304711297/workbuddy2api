import pytest
from fastapi.testclient import TestClient
import converter
import responses_compat

def test_responses_missing_previous_response_id_returns_400(monkeypatch):
    """Direction B 契约：
    当客户端显式传了 previous_response_id 但本地 response store 找不到该 ID 时，
    禁止静默分叉（Silent Context Fork），必须直接返回 HTTP 400，
    且错误码必须精确为 OpenAI 官方规范的 previous_response_not_found。
    """
    # 1. 直接测试 responses_compat.responses_request_to_chat
    req = {
        "model": "deepseek-chat",
        "previous_response_id": "resp_non_existent_12345",
        "input": "continue task",
    }
    with pytest.raises(responses_compat.PreviousResponseNotFoundError) as exc_info:
        responses_compat.responses_request_to_chat(req)
    
    assert exc_info.value.response_id == "resp_non_existent_12345"

    # 2. 通过 FastAPI 端点测试 HTTP 400 契约
    class FakeCred:
        def get_active_uid(self):
            return "uid-resp-1"
        def get_headers(self):
            return {"Authorization": "Bearer fake", "User-Agent": "test"}

    fake_cred = FakeCred()
    monkeypatch.setattr(converter, "_cred", lambda: fake_cred)
    monkeypatch.setattr(converter, "_get_rotator", lambda: converter.AccountRotator(cred_mgr=fake_cred, mode="off"))

    client = TestClient(converter.app, headers={"Host": "127.0.0.1:8787"})
    resp = client.post(
        "/v1/responses",
        json={
            "model": "deepseek-chat",
            "previous_response_id": "resp_missing_999",
            "input": "where are we?",
        },
        headers={"Authorization": "Bearer any"}
    )
    assert resp.status_code == 400
    data = resp.json()
    assert "error" in data
    err = data["error"]
    assert err.get("code") == "previous_response_not_found"
    assert err.get("param") == "previous_response_id"
    assert "resp_missing_999" in err.get("message", "")
    assert err.get("type") == "invalid_request_error"
