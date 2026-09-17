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
