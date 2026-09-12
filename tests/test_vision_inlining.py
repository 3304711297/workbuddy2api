"""
tests/test_vision_inlining.py - 多模态远程图片自动转 Data-URI 测试

借鉴自 neipor/codebuddy-cli2api (MIT):
腾讯后端对 image_url 强制要求 data URI (data:image/...;base64,...)，
遇到 http(s) 远程图片链接直接抛 400 invalid parameter value。
网关层自动异步拉取图片并内联嵌入，解除视觉模型的多模态输入限制。
"""

import base64
import pytest
import converter
from converter import _inline_remote_images, _url_to_data_uri


@pytest.mark.anyio
async def test_data_uri_kept_intact():
    """已经是 data URI 的图片保持原样，不重复处理。"""
    raw_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    messages = [
        {"role": "user", "content": [
            {"type": "text", "text": "look at this"},
            {"type": "image_url", "image_url": {"url": raw_data}}
        ]}
    ]
    processed = await _inline_remote_images(messages)
    assert processed[0]["content"][1]["image_url"]["url"] == raw_data


@pytest.mark.anyio
async def test_remote_http_image_inlined(monkeypatch):
    """远程 http 图片自动被下载并转为 base64 data URI。"""
    fake_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    
    class FakeResp:
        status_code = 200
        headers = {"content-type": "image/png"}
        content = fake_bytes

    async def fake_get(self, url, *args, **kwargs):
        return FakeResp()

    import httpx
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    messages = [
        {"role": "user", "content": [
            {"type": "text", "text": "describe image"},
            {"type": "image_url", "image_url": {"url": "https://example.com/test.png"}}
        ]}
    ]
    processed = await _inline_remote_images(messages)
    result_url = processed[0]["content"][1]["image_url"]["url"]
    assert result_url.startswith("data:image/png;base64,")
    encoded_b64 = result_url.split(",", 1)[1]
    assert base64.b64decode(encoded_b64) == fake_bytes
