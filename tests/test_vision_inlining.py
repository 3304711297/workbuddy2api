"""
tests/test_vision_inlining.py - 多模态远程图片自动转 Data-URI 测试

借鉴自 neipor/codebuddy-cli2api (MIT):
腾讯后端对 image_url 强制要求 data URI (data:image/...;base64,...)，
遇到 http(s) 远程图片链接直接抛 400 invalid parameter value。
网关层自动异步拉取图片并内联嵌入，解除视觉模型的多模态输入限制。

安全约束（本文件同时覆盖）：
- SSRF 防护：拒绝回环/私网/链路本地/云元数据地址（含 redirect 逐跳校验）；
- 单图大小上限（默认 8MB，WORKBUDDY2API_MAX_IMAGE_MB）；
- 仅接受 image/* 类型响应。
"""

import base64
from contextlib import asynccontextmanager

import pytest

import converter
from converter import (
    _inline_remote_images,
    _url_is_safe_for_fetch,
    _url_to_data_uri,
)

FAKE_PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


class FakeStreamResponse:
    """模拟 httpx 流式响应。"""

    def __init__(self, status_code=200, headers=None, body=FAKE_PNG):
        self.status_code = status_code
        self.headers = headers if headers is not None else {"content-type": "image/png"}
        self._body = body

    async def aiter_bytes(self):
        if self._body:
            yield self._body


def _install_stream_stub(monkeypatch, response: FakeStreamResponse, safe_override=True):
    """把 httpx.AsyncClient.stream 替换为返回固定响应的桩，并放行 SSRF 校验。"""
    if safe_override:
        monkeypatch.setattr(converter, "_url_is_safe_for_fetch", lambda url: (True, ""))

    class FakeStreamCtx:
        async def __aenter__(self):
            return response

        async def __aexit__(self, *a):
            return False

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, **kwargs):
            return FakeStreamCtx()

        async def get(self, url, *a, **kw):
            return response

    monkeypatch.setattr(converter.httpx, "AsyncClient", FakeAsyncClient)


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
    _install_stream_stub(monkeypatch, FakeStreamResponse())

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
    assert base64.b64decode(encoded_b64) == FAKE_PNG


@pytest.mark.anyio
async def test_responses_endpoint_e2e_inlines_input_image(monkeypatch):
    """端到端验证 /v1/responses 接收 input_image 能够自动转换为 data URI。"""
    _install_stream_stub(monkeypatch, FakeStreamResponse())

    from responses_compat import responses_request_to_chat
    req = {
        "model": "glm-5v-turbo",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "https://example.com/vision.png"}
                ],
            }
        ],
    }
    chat = responses_request_to_chat(req)
    inlined = await _inline_remote_images(chat["messages"])
    img_url = inlined[0]["content"][0]["image_url"]["url"]
    assert img_url.startswith("data:image/png;base64,")


# ==================== SSRF 与大小限制防护 ====================

@pytest.mark.parametrize("bad_url,expect_keyword", [
    ("http://127.0.0.1/secret.png", "内网"),
    ("http://localhost/admin.png", "本机"),
    ("http://10.0.0.5/internal.png", "内网"),
    ("http://192.168.1.1/router.png", "内网"),
    ("http://172.16.3.4/x.png", "内网"),
    ("http://169.254.169.254/latest/meta-data/", "内网"),
    ("http://[::1]/v6.png", "内网"),
    ("http://[fe80::1]/ll.png", "内网"),
    ("http://metadata.google.internal/computeMetadata/v1/", "本机"),
    ("file:///etc/passwd", "协议"),
    ("ftp://example.com/x.png", "协议"),
    ("http://0.0.0.0/x.png", "内网"),
])
def test_ssrf_guard_blocks_dangerous_urls(bad_url, expect_keyword):
    """内网/回环/元数据/非法协议地址必须被 SSRF 守卫拒绝。"""
    ok, reason = _url_is_safe_for_fetch(bad_url)
    assert ok is False
    assert reason, f"{bad_url} 应给出拒绝原因"


@pytest.mark.parametrize("good_url", [
    "http://8.8.8.8/img.png",
    "https://1.1.1.1/img.png",
])
def test_ssrf_guard_allows_public_ips(good_url):
    """公网 IP 直连应放行。"""
    ok, reason = _url_is_safe_for_fetch(good_url)
    assert ok is True, f"{good_url} 应放行，实际拒绝: {reason}"


@pytest.mark.anyio
async def test_ssrf_blocked_url_not_downloaded(monkeypatch):
    """被 SSRF 守卫拒绝的地址绝不发起下载，原样返回。"""
    called = {"n": 0}

    class Boom:
        def __init__(self, *a, **kw):
            called["n"] += 1

    monkeypatch.setattr(converter.httpx, "AsyncClient", Boom)
    url = "http://127.0.0.1:8787/private.png"
    out = await _url_to_data_uri(url)
    assert out == url
    assert called["n"] == 0, "被拒绝的地址不应创建任何 HTTP 客户端"


@pytest.mark.anyio
async def test_oversize_image_by_content_length_rejected(monkeypatch):
    """Content-Length 超限时立即拒绝，不读取正文。"""
    huge = str(converter.MAX_IMAGE_BYTES + 1)
    _install_stream_stub(monkeypatch, FakeStreamResponse(
        headers={"content-type": "image/png", "content-length": huge},
    ))
    url = "https://example.com/huge.png"
    out = await _url_to_data_uri(url)
    assert out == url, "超限图片应保留原 URL（拒绝内联）"


@pytest.mark.anyio
async def test_oversize_image_by_actual_bytes_rejected(monkeypatch):
    """无 Content-Length 时，实际字节超限需在流式读取中中止。"""
    monkeypatch.setattr(converter, "MAX_IMAGE_BYTES", 16)  # 极小上限
    _install_stream_stub(monkeypatch, FakeStreamResponse(body=b"x" * 1024))
    url = "https://example.com/big.png"
    out = await _url_to_data_uri(url)
    assert out == url


@pytest.mark.anyio
async def test_non_image_content_type_rejected(monkeypatch):
    """返回 text/html 等非图片类型时拒绝内联（防止把网页当图片塞给上游）。"""
    _install_stream_stub(monkeypatch, FakeStreamResponse(
        headers={"content-type": "text/html"},
        body=b"<html>not an image</html>",
    ))
    url = "https://example.com/page.html"
    out = await _url_to_data_uri(url)
    assert out == url


@pytest.mark.anyio
async def test_redirect_chain_revalidated(monkeypatch):
    """重定向到内网地址时必须被逐跳校验拦截（防「公网跳内网」SSRF）。"""
    redirect_resp = FakeStreamResponse(
        status_code=302,
        headers={"location": "http://192.168.1.1/internal.png"},
    )

    class FakeStreamCtx:
        async def __aenter__(self):
            return redirect_resp

        async def __aexit__(self, *a):
            return False

    class FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        def stream(self, method, url, **kwargs):
            return FakeStreamCtx()

    # 首跳放行（公网），第二跳由真实守卫判定内网 → 必须拒绝
    monkeypatch.setattr(
        converter, "_url_is_safe_for_fetch",
        lambda url: (True, "") if "example.com" in url else (False, "内网"),
    )
    monkeypatch.setattr(converter.httpx, "AsyncClient", FakeAsyncClient)

    url = "https://example.com/redirect.png"
    out = await _url_to_data_uri(url)
    assert out == url, "重定向到内网必须被拦截，不得内联"


@pytest.mark.anyio
async def test_remote_image_disabled_by_config(monkeypatch):
    """WORKBUDDY2API_MAX_IMAGE_MB=0 等价配置时应完全跳过远程下载。"""
    monkeypatch.setattr(converter, "MAX_IMAGE_BYTES", 0)
    called = {"n": 0}

    class Boom:
        def __init__(self, *a, **kw):
            called["n"] += 1

    monkeypatch.setattr(converter.httpx, "AsyncClient", Boom)
    url = "https://example.com/x.png"
    out = await _url_to_data_uri(url)
    assert out == url
    assert called["n"] == 0
