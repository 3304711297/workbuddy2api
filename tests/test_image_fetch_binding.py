"""Offline outbound admission/binding contracts; no live destinations or attack probes."""
import ipaddress
import socket
from contextlib import asynccontextmanager

import httpx
import pytest

import converter


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    for name in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME"):
        monkeypatch.setenv(name, str(tmp_path))
    monkeypatch.setitem(converter.CONFIG, "log_path", "")


@pytest.mark.parametrize("address", ["100.64.0.1", "100.127.255.254", "169.254.169.254", "10.0.0.1", "127.0.0.1"])
def test_non_public_addresses_are_not_admitted(address):
    assert not converter._url_is_safe_for_fetch(f"http://{address}/image.png")[0]


@pytest.mark.anyio
async def test_url_level_and_fetch_path_share_one_validator(monkeypatch):
    """URL 级校验与真实下载路径必须共用 `_resolve_public_connect_ip`。

    背景：这两处历史上各写了一份 SSRF 判定，URL 级那份成了零调用点的死代码，
    「改了一处、真正生效的是另一处」会让改动者产生虚假信心。本用例把两条路径
    钉在同一个函数上：任一处重新内联自己的判定，`calls` 就不会有两条记录。
    """
    calls = []

    def fake_helper(host):
        calls.append(host)
        return None, "统一拒绝（测试桩）"

    monkeypatch.setattr(converter, "_resolve_public_connect_ip", fake_helper)

    assert converter._url_is_safe_for_fetch("http://images.example/a.png")[0] is False
    out = await converter._url_to_data_uri("http://images.example/a.png")
    assert out == "http://images.example/a.png", "被拒绝的地址必须原样返回、不得内联"
    assert calls == ["images.example", "images.example"], (
        "两条路径未共用同一判定函数 —— SSRF 校验又出现第二份实现："
        f"实际调用记录 {calls}"
    )


@pytest.mark.anyio
@pytest.mark.parametrize("scheme,address", [("http", "8.8.8.8"), ("https", "8.8.8.8"), ("https", "2606:4700:4700::1111")])
async def test_fetch_connects_to_validated_literal_with_original_authority(monkeypatch, scheme, address):
    dns_calls, requests, options = [], [], []

    def resolve(host, port, *args, **kwargs):
        dns_calls.append(host)
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)

    class Client:
        def __init__(self, **kwargs):
            options.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @asynccontextmanager
        async def stream(self, method, url, **kwargs):
            requests.append((httpx.URL(url), kwargs))
            yield httpx.Response(200, headers={"content-type": "image/png"}, content=b"png")

    monkeypatch.setattr(converter.httpx, "AsyncClient", Client)
    result = await converter._url_to_data_uri(f"{scheme}://images.example:8443/a.png?q=1")
    assert result == "data:image/png;base64,cG5n"
    assert len(requests) == 1
    target, kwargs = requests[0]
    assert target.host == address
    assert target.port == 8443
    assert target.raw_path == b"/a.png?q=1"
    assert kwargs["headers"]["Host"] == "images.example:8443"
    assert kwargs["extensions"]["sni_hostname"] == "images.example"
    assert options[0]["trust_env"] is False
    assert options[0].get("verify", True) is True
    assert dns_calls == ["images.example"]
