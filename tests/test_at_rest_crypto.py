# -*- coding: utf-8 -*-
"""tests/test_at_rest_crypto.py - 桌面端 at-rest 加密凭据（`$wbEncrypted` 信封）解密。

背景：新版 WorkBuddy 桌面端把 `.info` 里的 `accessToken` / `refreshToken` /
`account.nickname` 从明文改成 `{"$wbEncrypted": 1, "envelope": base64(...)}`，
信封是 AES-256-GCM，密钥来自客户端**构建期内置**的载荷（不是用户密钥）。
不处理信封时，网关会把整段字典当 token 拼进 Authorization 头 → 上游 401。

本文件锁定四件事：
  1. AES-256-GCM 实现本身正确（NIST KAT 向量，不是自嗨 round-trip）；
  2. AAD / keyId / 信封结构逐字节对齐客户端（格式一改必然变红）；
  3. 密钥获取的降级顺序（env 覆盖 → 内存缓存 → 桌面端内置绑定），
     以及拿不到密钥时**必须是可行动的报错**而不是静默 401；
  4. 明文凭据（老版本 / macOS 旧版 / accounts.json）原路径不受影响。
"""

import base64
import hashlib
import json

import pytest

import wb_atrest


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _payload(text: str) -> str:
    """构造客户端 loggerGet() 返回的密钥载荷 JSON。"""
    return json.dumps({"version": 1, "atRestSecretKey": text}, separators=(",", ":"))


def _key_from_secret(secret_text: str) -> bytes:
    return hashlib.sha256(secret_text.encode("utf-8")).digest()


# 32 字节规范 base64（客户端要求 isCanonical32ByteBase64）
_SECRET_B64 = _b64(bytes(range(32)))
_KEY = _key_from_secret(_SECRET_B64)


# ---------------------------------------------------------------------------
# 1. 密码学正确性：NIST GCM 规范向量（空 AAD）
# ---------------------------------------------------------------------------

def test_aes256_gcm_matches_nist_empty_plaintext_vector():
    """Test Case 13：K=0^256, IV=0^96, P=空 → T=530f8afb..."""
    key = b"\x00" * 32
    nonce = b"\x00" * 12
    opened = wb_atrest.gcm_open(key, nonce, b"", b"", bytes.fromhex("530f8afbc74536b9a963b4f1c4cb738b"))
    assert opened == b""


def test_aes256_gcm_matches_nist_one_block_vector():
    """Test Case 14：同一密钥/IV，P=0^128 → C=cea7403d..., T=d0d1c8a7..."""
    key = b"\x00" * 32
    nonce = b"\x00" * 12
    opened = wb_atrest.gcm_open(
        key, nonce, b"",
        bytes.fromhex("cea7403d4d606b6e074ec5d3baf39d18"),
        bytes.fromhex("d0d1c8a799996bf0265b98b5d48ab919"),
    )
    assert opened == b"\x00" * 16


def test_gcm_rejects_tampered_tag():
    sealed = wb_atrest.seal_frame(_KEY, b"hello", "field")
    env = json.loads(base64.b64decode(sealed["envelope"]).decode("utf-8"))
    tag = bytearray(base64.b64decode(env["authTag"]))
    tag[0] ^= 0xFF
    env["authTag"] = _b64(bytes(tag))
    tampered = {"$wbEncrypted": 1, "envelope": _b64(json.dumps(env).encode("utf-8"))}
    with pytest.raises(wb_atrest.AtRestError):
        wb_atrest.open_envelope(_KEY, tampered, "field")


# ---------------------------------------------------------------------------
# 2. 格式契约：AAD / keyId / 信封结构
# ---------------------------------------------------------------------------

def test_derive_key_id_is_sha256_prefix_16():
    assert wb_atrest.derive_key_id(_KEY) == hashlib.sha256(_KEY).hexdigest()[:16]


def test_field_aad_is_byte_exact():
    """AAD 必须逐字节对齐客户端：WB-AAD\\0 | 0x01 | LP(WBEV1) | LP(sym-v1) | u32(1) | LP(keyId) | 2 | 0 | 0。"""
    key_id = "0123456789abcdef"
    expect = (
        b"WB-AAD\x00" + b"\x01"
        + (5).to_bytes(4, "big") + b"WBEV1"
        + (6).to_bytes(4, "big") + b"sym-v1"
        + (1).to_bytes(4, "big")
        + (16).to_bytes(4, "big") + b"0123456789abcdef"
        + bytes([2, 0, 0])
    )
    assert wb_atrest.aad(key_id, 1, "field") == expect


def test_file_aad_uses_other_framing_magic_and_code():
    key_id = "0123456789abcdef"
    expect = (
        b"WB-AAD\x00" + b"\x01"
        + (5).to_bytes(4, "big") + b"WBEF1"
        + (6).to_bytes(4, "big") + b"sym-v1"
        + (1).to_bytes(4, "big")
        + (16).to_bytes(4, "big") + b"0123456789abcdef"
        + bytes([1, 0, 0])
    )
    assert wb_atrest.aad(key_id, 1, "file") == expect


def test_seal_frame_roundtrip_and_envelope_shape():
    sealed = wb_atrest.seal_frame(_KEY, "晚街".encode("utf-8"), "field")
    assert set(sealed) == {"$wbEncrypted", "envelope"}
    assert sealed["$wbEncrypted"] == 1
    env = json.loads(base64.b64decode(sealed["envelope"]).decode("utf-8"))
    assert set(env) == {"suite", "keyId", "nonce", "authTag", "ciphertext"}
    assert env["suite"] == 1
    assert env["keyId"] == wb_atrest.derive_key_id(_KEY)
    assert len(base64.b64decode(env["nonce"])) == 12
    assert len(base64.b64decode(env["authTag"])) == 16
    assert wb_atrest.open_envelope(_KEY, sealed, "field") == "晚街".encode("utf-8")


def test_is_envelope_accepts_dict_and_serialized_json_string():
    sealed = wb_atrest.seal_frame(_KEY, b"x", "field")
    assert wb_atrest.is_envelope(sealed) is True
    assert wb_atrest.is_envelope(json.dumps(sealed)) is True
    assert wb_atrest.is_envelope("eyJhbGciOiJIUzI1NiJ9.plain.jwt") is False
    assert wb_atrest.is_envelope("") is False
    assert wb_atrest.is_envelope(None) is False


def test_open_envelope_rejects_key_id_mismatch_with_actionable_message():
    other = hashlib.sha256(b"another-secret").digest()
    sealed = wb_atrest.seal_frame(other, b"x", "field")
    with pytest.raises(wb_atrest.AtRestError) as ei:
        wb_atrest.open_envelope(_KEY, sealed, "field")
    assert "keyId" in str(ei.value)


# ---------------------------------------------------------------------------
# 3. 密钥获取：env 覆盖 → 缓存 → 桌面端内置绑定
# ---------------------------------------------------------------------------

def test_resolve_key_accepts_payload_json_via_env(monkeypatch):
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _payload(_SECRET_B64))
    wb_atrest.forget_key()
    assert wb_atrest.resolve_key() == _KEY
    wb_atrest.forget_key()


def test_resolve_key_accepts_normalized_key_via_env(monkeypatch):
    """也接受归一化后的 32 字节密钥（base64），方便用户手工粘贴。"""
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _b64(_KEY))
    wb_atrest.forget_key()
    assert wb_atrest.resolve_key() == _KEY
    wb_atrest.forget_key()


def test_resolve_key_rejects_garbage_env(monkeypatch):
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", "not-base64-at-all")
    wb_atrest.forget_key()
    with pytest.raises(wb_atrest.AtRestError) as ei:
        wb_atrest.resolve_key()
    assert "WORKBUDDY_AT_REST_KEY" in str(ei.value)
    wb_atrest.forget_key()


def test_resolve_key_without_desktop_client_raises_actionable_error(monkeypatch):
    monkeypatch.delenv("WORKBUDDY_AT_REST_KEY", raising=False)
    monkeypatch.setattr(wb_atrest, "find_desktop_exe", lambda: None)
    wb_atrest.forget_key()
    with pytest.raises(wb_atrest.AtRestError) as ei:
        wb_atrest.resolve_key()
    msg = str(ei.value)
    assert "WorkBuddy" in msg and "安装" in msg
    wb_atrest.forget_key()


def test_helper_failure_surfaces_stderr_hint(monkeypatch):
    monkeypatch.delenv("WORKBUDDY_AT_REST_KEY", raising=False)
    monkeypatch.setattr(wb_atrest, "find_desktop_exe", lambda: "X:/fake/WorkBuddy.exe")

    class _Proc:
        returncode = 1
        stdout = ""
        stderr = "linked binding missing"

    monkeypatch.setattr(wb_atrest.subprocess, "run", lambda *a, **k: _Proc())
    wb_atrest.forget_key()
    with pytest.raises(wb_atrest.AtRestError) as ei:
        wb_atrest.resolve_key()
    assert "密钥" in str(ei.value)
    wb_atrest.forget_key()


def test_cached_key_avoids_repeat_helper(monkeypatch):
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _payload(_SECRET_B64))
    wb_atrest.forget_key()
    calls = []
    monkeypatch.setattr(wb_atrest, "find_desktop_exe", lambda: calls.append(1) or None)
    assert wb_atrest.resolve_key() == _KEY
    assert wb_atrest.resolve_key() == _KEY
    assert calls == []  # env 命中的密钥进缓存，不再探测安装路径
    wb_atrest.forget_key()


# ---------------------------------------------------------------------------
# 4. 会话字段解密（含明文原样返回、昵称降级）
# ---------------------------------------------------------------------------

def _session_with_envelopes():
    return {
        "auth": {
            "accessToken": wb_atrest.seal_frame(_KEY, b"access-plain", "field"),
            "refreshToken": wb_atrest.seal_frame(_KEY, b"refresh-plain", "field"),
            "expiresAt": 1796355013900,
        },
        "account": {"uid": "u-1", "nickname": wb_atrest.seal_frame(_KEY, "晚街".encode("utf-8"), "field")},
    }


def test_decrypt_session_secrets_opens_tokens_and_nickname(monkeypatch):
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _payload(_SECRET_B64))
    wb_atrest.forget_key()
    session = _session_with_envelopes()
    wb_atrest.decrypt_session_secrets(session)
    assert session["auth"]["accessToken"] == "access-plain"
    assert session["auth"]["refreshToken"] == "refresh-plain"
    assert session["account"]["nickname"] == "晚街"
    assert session["auth"]["expiresAt"] == 1796355013900
    wb_atrest.forget_key()


def test_decrypt_session_secrets_leaves_plaintext_untouched(monkeypatch):
    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _payload(_SECRET_B64))
    wb_atrest.forget_key()
    session = {"auth": {"accessToken": "plain-1", "refreshToken": "plain-2"},
               "account": {"nickname": "nick"}}
    wb_atrest.decrypt_session_secrets(session)
    assert session["auth"]["accessToken"] == "plain-1"
    assert session["account"]["nickname"] == "nick"
    wb_atrest.forget_key()


def test_nickname_failure_degrades_without_raising(monkeypatch):
    monkeypatch.delenv("WORKBUDDY_AT_REST_KEY", raising=False)
    monkeypatch.setattr(wb_atrest, "find_desktop_exe", lambda: None)
    wb_atrest.forget_key()
    session = {"auth": {}, "account": {"uid": "u-1",
                                       "nickname": wb_atrest.seal_frame(_KEY, b"x", "field")}}
    wb_atrest.decrypt_session_secrets(session)
    assert session["account"]["nickname"] in ("", None)
    wb_atrest.forget_key()


def test_token_decrypt_failure_raises_actionable_error(monkeypatch):
    """token 解不开必须炸出可行动报错，绝不能把信封当 token 发给上游换回 401。"""
    monkeypatch.delenv("WORKBUDDY_AT_REST_KEY", raising=False)
    monkeypatch.setattr(wb_atrest, "find_desktop_exe", lambda: None)
    wb_atrest.forget_key()
    session = {"auth": {"accessToken": wb_atrest.seal_frame(_KEY, b"x", "field")}, "account": {}}
    with pytest.raises(wb_atrest.AtRestError):
        wb_atrest.decrypt_session_secrets(session)
    wb_atrest.forget_key()


# ---------------------------------------------------------------------------
# 5. 与 CredentialManager 的接线
# ---------------------------------------------------------------------------

def test_credential_manager_decrypts_encrypted_info(tmp_path, monkeypatch):
    """端到端：加密 `.info` 经 CredentialManager 读出来必须是明文 token。"""
    import converter

    monkeypatch.setenv("WORKBUDDY_AT_REST_KEY", _payload(_SECRET_B64))
    wb_atrest.forget_key()
    monkeypatch.setattr(converter, "_accounts_file", lambda: tmp_path / "missing-accounts.json")

    payload = _session_with_envelopes()
    info = tmp_path / "workbuddy-desktop.info"
    info.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    cred = converter.CredentialManager(info)
    assert cred.peek_active_session()["auth"]["accessToken"] == "access-plain"
    assert cred.peek_active_session()["account"]["nickname"] == "晚街"
    wb_atrest.forget_key()
