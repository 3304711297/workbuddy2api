# -*- coding: utf-8 -*-
"""wb_atrest.py — 桌面端 at-rest 加密凭据（`$wbEncrypted` 信封）的解密。

背景
----
新版 WorkBuddy 桌面端把 `.info` 文件里的 `auth.accessToken` / `auth.refreshToken`
（以及国内版的 `account.nickname` / `account.phoneNumber`）从明文改成加密信封：

    {"$wbEncrypted": 1, "envelope": "<base64(JSON{suite,keyId,nonce,authTag,ciphertext})>"}

不处理信封时，网关会把整个字典 `str()` 成 token 拼进 `Authorization` 头，
上游必然回 **401 Authorization Required**（issue #37 的现场）。

格式（逐字节对齐客户端 `packages/at-rest-crypto`）
--------------------------------------------------
    key       = sha256(atRestSecretKey_文本)          # 注意：哈希的是 base64 **文本**，不是解码后的字节
    keyId     = sha256(key).hex[0:16]
    AAD       = "WB-AAD\\0" | 0x01 | LP(framingMagic) | LP("sym-v1") | u32(suite)
                | LP(keyId) | framingCode | 0x00 | 0x00          （LP = u32be 长度 + utf8）
    framing   : file -> WBEF1/1（keyblob 槽），field -> WBEV1/2（.info 里的字段）
    envelope  = base64(JSON{suite,keyId,nonce,authTag,ciphertext})，AES-256-GCM

密钥从哪来
----------
`atRestSecretKey` 是客户端**构建期内置**的常量（不是用户密钥、不在 keyblob 里、
磁盘上也无明文），只能向「写下这个文件的那份构建」本身询问：用 Electron 的
`ELECTRON_RUN_AS_NODE` 模式启动已安装的桌面端可执行文件，调它的原生绑定

    process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()

取回同一份载荷，再本地派生密钥。整个过程不开窗口、不读 Keychain、不出网；
密钥只留在**进程内存**（`_KEY_CACHE`），不落盘、不进日志。

纯 Python AES-256-GCM 是刻意选择：本项目与绿色包不带 node 依赖、也不装 pip 包，
而这条链路只在读凭据时跑几次，用第三方库换来的速度不值得多一个运行期依赖。

格式细节与「向客户端自身询问密钥」的思路参考 MIT 许可的
`ardeyouxipianyi/workbuddy2api-hub`（wb_atrest.py）与 `jlcodes99/cockpit-tools`
（workbuddy_auth_crypto.rs），实现为本仓库重写。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

#: 信封标记字段（`{"$wbEncrypted": 1, "envelope": "..."}`）
ENVELOPE_KEY = "$wbEncrypted"

#: framing -> (magic, code)。file 用于 keyblob 槽，field 用于 .info 字段。
FRAMING = {"file": ("WBEF1", 1), "field": ("WBEV1", 2)}

SCHEME = "sym-v1"
SUITE = 1

#: 密钥来源覆盖（可填 loggerGet 的载荷 JSON 或归一化后的 32 字节密钥 base64）
ENV_KEY = "WORKBUDDY_AT_REST_KEY"
#: 显式指定桌面端可执行文件
ENV_EXE = "WORKBUDDY_APP_EXECUTABLE"

_HELPER_TIMEOUT_SEC = 15.0
#: CREATE_NO_WINDOW：取密钥的子进程不该闪黑框（本仓库 git 子进程同口径）
_CREATE_NO_WINDOW = 0x08000000

#: 在 Node 模式下向客户端自身索取构建载荷，只把派生后的密钥写到 stdout
_HELPER_SCRIPT = r"""
try {
  const c = require('crypto');
  const p = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (p.version !== 1 || typeof p.atRestSecretKey !== 'string') process.exit(2);
  const b = Buffer.from(p.atRestSecretKey, 'base64');
  if (b.length !== 32 || b.toString('base64') !== p.atRestSecretKey || b.every(x => x === 0)) process.exit(2);
  const k = c.createHash('sha256').update(p.atRestSecretKey, 'utf8').digest();
  process.stdout.write(k.toString('base64'));
  k.fill(0); b.fill(0);
} catch (_) { process.exit(2); }
"""


class AtRestError(RuntimeError):
    """at-rest 解密链路的可预期失败（缺客户端、密钥不符、信封结构异常）。"""


# ---------------------------------------------------------------------------
# 信封读写
# ---------------------------------------------------------------------------

def _lp(text: str) -> bytes:
    raw = text.encode("utf-8")
    return len(raw).to_bytes(4, "big") + raw


def aad(key_id: str, suite: int = SUITE, framing: str = "field") -> bytes:
    """AAD 必须逐字节对齐客户端，否则 GCM 校验必然失败。"""
    magic, code = FRAMING[framing]
    return b"".join((
        b"WB-AAD\0", b"\x01",
        _lp(magic), _lp(SCHEME), int(suite).to_bytes(4, "big"), _lp(key_id),
        bytes([code]), b"\x00", b"\x00",
    ))


def derive_key_id(key: bytes) -> str:
    """protectorKeyId / envelope.keyId 的算法：sha256(key) 的前 16 个 hex。"""
    return hashlib.sha256(key).hexdigest()[:16]


def is_envelope(value: Any) -> bool:
    """是不是一个 `$wbEncrypted` 信封（而不是明文 token）。

    兼容历史形态：老版本曾把整个信封 JSON 序列化成字符串塞进字段里。
    """
    if isinstance(value, dict):
        return ENVELOPE_KEY in value and isinstance(value.get("envelope"), str)
    if isinstance(value, str):
        head = value.lstrip()[:64]
        return head.startswith("{") and ENVELOPE_KEY in head
    return False


def parse_envelope(value: Any) -> dict:
    """把 envelope（base64 字符串或 `$wbEncrypted` 字典）拆成 GCM 四段。"""
    raw = value
    if isinstance(raw, dict):
        raw = raw.get("envelope")
    elif isinstance(raw, str) and raw.lstrip().startswith("{"):
        try:
            nested = json.loads(raw)
        except Exception as exc:
            raise AtRestError(f"信封 JSON 解析失败：{exc}") from exc
        raw = nested.get("envelope") if isinstance(nested, dict) else None
    try:
        env = json.loads(base64.b64decode(str(raw)).decode("utf-8"))
    except Exception as exc:
        raise AtRestError(f"envelope 不是 base64(JSON)：{exc}") from exc
    try:
        return {
            "suite": int(env.get("suite") or SUITE),
            "keyId": str(env.get("keyId") or ""),
            "nonce": base64.b64decode(env["nonce"]),
            "authTag": base64.b64decode(env["authTag"]),
            "ciphertext": base64.b64decode(env["ciphertext"]),
        }
    except Exception as exc:
        raise AtRestError(f"envelope 缺字段：{exc}") from exc


def open_envelope(key: bytes, value: Any, framing: str = "field") -> bytes:
    """解开一个信封，返回明文字节。keyId 不符时立刻报错（不浪费一次 GCM 计算）。"""
    env = parse_envelope(value)
    expect = derive_key_id(key)
    if env["keyId"] and env["keyId"] != expect:
        raise AtRestError(
            f"信封 keyId {env['keyId']} 与当前密钥（{expect}）不匹配：客户端换过构建密钥，需重新取密钥"
        )
    return gcm_open(key, env["nonce"], aad(env["keyId"] or expect, env["suite"], framing),
                    env["ciphertext"], env["authTag"])


def seal_frame(key: bytes, plaintext: bytes, framing: str = "field") -> dict:
    """把明文封成 `$wbEncrypted` 信封（自检 / 单测 / 回写同格式时需要）。"""
    if isinstance(plaintext, str):
        plaintext = plaintext.encode("utf-8")
    key_id = derive_key_id(key)
    nonce = os.urandom(12)
    aad_bytes = aad(key_id, SUITE, framing)
    aes = _AES256(key)
    h = int.from_bytes(aes.encrypt_block(b"\x00" * 16), "big")
    j0 = _j0(aes, nonce)
    ct = _gctr(aes, j0, plaintext)
    tag = (int.from_bytes(aes.encrypt_block(j0), "big") ^ _ghash(h, aad_bytes, ct)).to_bytes(16, "big")
    envelope = {
        "suite": SUITE, "keyId": key_id,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "authTag": base64.b64encode(tag).decode("ascii"),
        "ciphertext": base64.b64encode(ct).decode("ascii"),
    }
    blob = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    return {ENVELOPE_KEY: SUITE, "envelope": base64.b64encode(blob).decode("ascii")}


def decrypt_field(key: bytes, value: Any, framing: str = "field") -> Any:
    """解密一个可能加密、也可能本来就是明文的字段。

    明文原样返回；信封返回明文 `str`；`None` 返回 ""。
    """
    if value is None or value == "":
        return ""
    if not is_envelope(value):
        return value
    return open_envelope(key, value, framing).decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# 纯 Python AES-256 + GCM（只需正向分组加密）
# ---------------------------------------------------------------------------

def _build_sbox() -> list[int]:
    sbox = [0] * 256
    p = q = 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= (q << 1) & 0xFF
        q ^= (q << 2) & 0xFF
        q ^= (q << 4) & 0xFF
        if q & 0x80:
            q ^= 0x09
        sbox[p] = (q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6))
                   ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4)) ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


_SBOX = _build_sbox()
_MUL2 = [((i << 1) ^ 0x1B) & 0xFF if i & 0x80 else (i << 1) for i in range(256)]
_MUL3 = [_MUL2[i] ^ i for i in range(256)]
_REDUCTION = 0xE1000000000000000000000000000000


def _mix_columns(s: list[int]) -> list[int]:
    out = [0] * 16
    for c in range(4):
        a0, a1, a2, a3 = s[4 * c:4 * c + 4]
        out[4 * c + 0] = _MUL2[a0] ^ _MUL3[a1] ^ a2 ^ a3
        out[4 * c + 1] = a0 ^ _MUL2[a1] ^ _MUL3[a2] ^ a3
        out[4 * c + 2] = a0 ^ a1 ^ _MUL2[a2] ^ _MUL3[a3]
        out[4 * c + 3] = _MUL3[a0] ^ a1 ^ a2 ^ _MUL2[a3]
    return out


class _AES256:
    """AES-256 分组加密，状态按列主序排成 16 字节。"""

    __slots__ = ("_w",)

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise AtRestError(f"AES-256 需要 32 字节密钥，得到 {len(key)}")
        words = [list(key[4 * i:4 * i + 4]) for i in range(8)]
        rcon = 1
        for i in range(8, 60):
            t = list(words[i - 1])
            if i % 8 == 0:
                t = t[1:] + t[:1]
                t = [_SBOX[b] for b in t]
                t[0] ^= rcon
                rcon = _MUL2[rcon]
            elif i % 8 == 4:
                t = [_SBOX[b] for b in t]
            words.append([words[i - 8][j] ^ t[j] for j in range(4)])
        self._w = words

    def encrypt_block(self, block: bytes) -> bytes:
        w = self._w
        s = [block[i] ^ w[i // 4][i % 4] for i in range(16)]
        for rnd in range(1, 14):
            s = [_SBOX[b] for b in s]
            s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]      # ShiftRows
            s = _mix_columns(s)
            base = rnd * 4
            s = [s[i] ^ w[base + i // 4][i % 4] for i in range(16)]
        s = [_SBOX[b] for b in s]
        s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]
        s = [s[i] ^ w[56 + i // 4][i % 4] for i in range(16)]
        return bytes(s)


def _gf_mul(x: int, y: int) -> int:
    """GF(2^128) 乘法（GCM 块哈希），约简多项式 x^128+x^7+x^2+x+1。"""
    z = 0
    v = y
    for i in range(128):
        if (x >> (127 - i)) & 1:
            z ^= v
        v = (v >> 1) ^ _REDUCTION if v & 1 else v >> 1
    return z


def _blocks(data: bytes) -> list[bytes]:
    if len(data) % 16:
        data = data + b"\x00" * (16 - len(data) % 16)
    return [data[i:i + 16] for i in range(0, len(data), 16)]


def _ghash(h: int, aad_bytes: bytes, ciphertext: bytes) -> int:
    x = 0
    tail = (len(aad_bytes) * 8).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    for block in _blocks(aad_bytes) + _blocks(ciphertext) + [tail]:
        x = _gf_mul(x ^ int.from_bytes(block, "big"), h)
    return x


def _j0(aes: _AES256, nonce: bytes) -> bytes:
    if len(nonce) == 12:
        return nonce + b"\x00\x00\x00\x01"
    h = int.from_bytes(aes.encrypt_block(b"\x00" * 16), "big")
    return _ghash(h, b"", nonce).to_bytes(16, "big")


def _gctr(aes: _AES256, j0: bytes, data: bytes) -> bytes:
    out = bytearray()
    counter = int.from_bytes(j0, "big")
    for off in range(0, len(data), 16):
        counter = (counter & ~0xFFFFFFFF) | ((counter + 1) & 0xFFFFFFFF)
        stream = aes.encrypt_block(counter.to_bytes(16, "big"))
        out += bytes(a ^ b for a, b in zip(data[off:off + 16], stream))
    return bytes(out)


def gcm_open(key: bytes, nonce: bytes, aad_bytes: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    """AES-256-GCM 解密（先验 tag 再解，密文被改动一律拒绝）。"""
    aes = _AES256(key)
    h = int.from_bytes(aes.encrypt_block(b"\x00" * 16), "big")
    j0 = _j0(aes, nonce)
    expect = int.from_bytes(aes.encrypt_block(j0), "big") ^ _ghash(h, aad_bytes, ciphertext)
    if not hmac.compare_digest(expect.to_bytes(16, "big"), tag):
        raise AtRestError("GCM 校验失败：密钥不对或信封被改动过")
    return _gctr(aes, j0, ciphertext)


# ---------------------------------------------------------------------------
# 密钥获取
# ---------------------------------------------------------------------------

#: 进程内密钥缓存（只存内存，不落盘、不进日志）
_KEY_CACHE: dict[str, Any] = {"key": None, "source": ""}
_KEY_LOCK = threading.Lock()
#: 取密钥失败后的负缓存，避免每个请求都 fork 一次客户端
_KEY_FAILED: dict[str, Any] = {"error": None}

_B64_KEY_RE = __import__("re").compile(r"^[A-Za-z0-9+/]{43}=$")


def cached_key() -> bytes | None:
    """已取到并校验过的密钥（没有则 None）。"""
    return _KEY_CACHE["key"]


def forget_key() -> None:
    """丢弃内存里的密钥与失败负缓存（客户端换钥 / 单测隔离用）。"""
    with _KEY_LOCK:
        _KEY_CACHE["key"] = None
        _KEY_CACHE["source"] = ""
        _KEY_FAILED["error"] = None


def _key_from_secret_text(secret: str) -> bytes:
    """客户端 `normalizeAtRestKeyPayload` 的口径：哈希 base64 **文本**。"""
    raw = secret.strip()
    if not _B64_KEY_RE.match(raw):
        raise AtRestError("atRestSecretKey 必须是 32 字节的规范 base64")
    pad = base64.b64decode(raw)
    if pad == b"\x00" * 32:
        raise AtRestError("atRestSecretKey 是零值哨兵，拒绝使用")
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _key_from_env(raw: str) -> bytes:
    """支持两种写法：loggerGet 的载荷 JSON，或归一化后的 32 字节密钥 base64。"""
    text = raw.strip()
    if text.startswith("{"):
        try:
            payload = json.loads(text)
        except Exception as exc:
            raise AtRestError(f"{ENV_KEY} 载荷 JSON 解析失败：{exc}") from exc
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise AtRestError(f"{ENV_KEY} 载荷缺少 version=1")
        return _key_from_secret_text(str(payload.get("atRestSecretKey") or ""))
    try:
        decoded = base64.b64decode(text, validate=True)
    except Exception as exc:
        raise AtRestError(f"{ENV_KEY} 既不是载荷 JSON 也不是 base64：{exc}") from exc
    if len(decoded) != 32:
        raise AtRestError(f"{ENV_KEY} 解码后应为 32 字节密钥，实际 {len(decoded)} 字节")
    return decoded


def _desktop_candidates() -> list[Path]:
    """桌面端可执行文件的候选路径（不写死；可用 ENV_EXE 覆盖）。"""
    names = ("WorkBuddy.exe", "WorkBuddyAI.exe", "WorkBuddy", "WorkBuddyAI")
    bases: list[Path] = []
    for env in ("LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE"):
        root = os.environ.get(env)
        if not root:
            continue
        for name in ("WorkBuddy", "workbuddy"):
            bases.append(Path(root) / name)
            bases.append(Path(root) / "Programs" / name)
    out: list[Path] = []
    for base in bases:
        for name in names:
            out.append(base / name)
    # 绿色版常直接装在盘根（本机就是 D:\WorkBuddy）
    for drive in ("C:", "D:", "E:", "F:"):
        for name in ("WorkBuddy", "workbuddy"):
            for exe in names:
                out.append(Path(f"{drive}/{name}/{exe}"))
    return out


def find_desktop_exe() -> str | None:
    """定位已安装的桌面端可执行文件；找不到返回 None。"""
    explicit = os.environ.get(ENV_EXE)
    if explicit:
        return explicit if Path(explicit).exists() else None
    for candidate in _desktop_candidates():
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def _run_helper(exe: str) -> bytes:
    """用客户端自身的 Node 模式取回构建载荷并派生密钥。"""
    env = dict(os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    env.pop("NODE_OPTIONS", None)   # 外部 NODE_OPTIONS 会污染 Node 模式
    kwargs: dict[str, Any] = {
        "args": [exe, "-e", _HELPER_SCRIPT],
        "capture_output": True,
        "text": True,
        "timeout": _HELPER_TIMEOUT_SEC,
        "env": env,
        "stdin": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    try:
        proc = subprocess.run(**kwargs)
    except subprocess.TimeoutExpired as exc:
        raise AtRestError("读取 WorkBuddy 构建密钥超时，请重试") from exc
    except OSError as exc:
        raise AtRestError(f"无法启动 WorkBuddy 客户端读取密钥：{exc}") from exc
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or len(out) != 44:
        detail = (proc.stderr or "").strip()[:200]
        raise AtRestError(
            "当前 WorkBuddy 客户端未提供可用的官方密钥接口"
            + (f"（{detail}）" if detail else "")
            + "：请更新客户端后重试，或设置 "
            + ENV_KEY
            + " 手工提供密钥"
        )
    try:
        key = base64.b64decode(out, validate=True)
    except Exception as exc:
        raise AtRestError(f"客户端返回的密钥不是合法 base64：{exc}") from exc
    if len(key) != 32:
        raise AtRestError(f"客户端返回的密钥长度异常（{len(key)} 字节）")
    return key


def resolve_key(refresh: bool = False) -> bytes:
    """取得 at-rest 主密钥（信封里的 keyId 指向的那把）。

    优先级：env 覆盖 → 进程内缓存 → 向已安装客户端索取。
    失败一律抛 `AtRestError`——绝不能让一个信封被当成 token 发出去换回 401。
    """
    with _KEY_LOCK:
        if not refresh:
            if _KEY_CACHE["key"] is not None:
                return _KEY_CACHE["key"]
            if _KEY_FAILED["error"] is not None:
                raise AtRestError(_KEY_FAILED["error"])

    override = os.environ.get(ENV_KEY)
    if override:
        key = _key_from_env(override)     # 显式覆盖的错误直接抛给用户，不做负缓存
        with _KEY_LOCK:
            _KEY_CACHE.update({"key": key, "source": "env"})
        return key

    exe = find_desktop_exe()
    if not exe:
        message = (
            "无法读取桌面端加密凭据：未找到 WorkBuddy 桌面客户端安装路径。"
            f"请安装/更新客户端，或设置 {ENV_EXE} 指向可执行文件，"
            f"或用 {ENV_KEY} 手工提供密钥。"
        )
        with _KEY_LOCK:
            _KEY_FAILED["error"] = message
        raise AtRestError(message)

    try:
        key = _run_helper(exe)
    except AtRestError as exc:
        with _KEY_LOCK:
            _KEY_FAILED["error"] = str(exc)
        raise
    with _KEY_LOCK:
        _KEY_CACHE.update({"key": key, "source": exe})
        _KEY_FAILED["error"] = None
    return key


# ---------------------------------------------------------------------------
# 会话级接线
# ---------------------------------------------------------------------------

#: 必须解开的字段（解不开就报错：继续下去只会换回上游 401）
_TOKEN_FIELDS = ("accessToken", "refreshToken", "token")
#: 可降级的字段（解不开退回空值，不影响鉴权链路）
_SOFT_FIELDS = ("nickname", "phoneNumber")


def decrypt_session_secrets(session: Any, *, key: bytes | None = None) -> Any:
    """就地把会话里的加密凭据字段解密成明文，返回同一个对象。

    - `auth.accessToken` / `auth.refreshToken` / 顶层 `accessToken`：解不开抛
      `AtRestError`（可行动报错 > 静默 401）；
    - `account.nickname` / `account.phoneNumber` / `user.nickname`：解不开退回空串；
    - 明文（老版本、accounts.json）原样保留，一次密钥都不取。
    """
    if not isinstance(session, dict):
        return session

    token_holders = [h for h in (session.get("auth"), session) if isinstance(h, dict)]
    token_targets = [(h, f) for h in token_holders for f in _TOKEN_FIELDS if is_envelope(h.get(f))]
    soft_targets = [
        (h, f)
        for h in (session.get("account"), session.get("user"))
        if isinstance(h, dict)
        for f in _SOFT_FIELDS
        if is_envelope(h.get(f))
    ]
    if not token_targets and not soft_targets:
        return session          # 全是明文：一次密钥都不取

    if not token_targets:
        # 只有昵称这类可降级字段：取不到密钥就退回空串，不该让整个会话读取失败
        try:
            key = key if key is not None else resolve_key()
        except AtRestError:
            for holder, field in soft_targets:
                holder[field] = ""
            return session
        for holder, field in soft_targets:
            try:
                holder[field] = decrypt_field(key, holder[field])
            except AtRestError:
                holder[field] = ""
        return session

    key = key if key is not None else resolve_key()

    for holder, field in token_targets:
        holder[field] = decrypt_field(key, holder[field])

    for holder, field in soft_targets:
        try:
            holder[field] = decrypt_field(key, holder[field])
        except AtRestError:
            holder[field] = ""
    return session
