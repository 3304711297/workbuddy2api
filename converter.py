#!/usr/bin/env python3
"""
codebuddy2openai — 把 CodeBuddy / WorkBuddy 的订阅暴露成标准 OpenAI 兼容 API。

原理（直连后端，原生 function calling）：
  - 读取本机已登录的 CodeBuddy 桌面端凭据（auth 文件里的 token / uid / enterpriseId）。
  - 直接转发到 CodeBuddy 后端 `https://copilot.tencent.com/v2/chat/completions`。
    该后端本身就是标准 OpenAI chat/completions 协议（含原生 tools / tool_calls / SSE 流式）。
  - 转换器只做两件事：①注入鉴权 header（Authorization / X-User-Id 等）
    ②在本地 /v1/* 与后端 /v2/* 之间做路径映射与透传。
  - token 过期时自动调 `/v2/plugin/auth/token/refresh` 刷新，并回写 auth 文件。

跨平台：自动定位 auth 目录（macOS / Windows / Linux）。
依赖：fastapi + uvicorn + httpx（pip install fastapi "uvicorn[standard]" httpx）。

用法：
  python3 converter.py                       # 默认 127.0.0.1:8787
  python3 converter.py --port 9000
  python3 converter.py --api-key mysecret    # 启用客户端鉴权
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

try:
    from desensitize import desensitize_body
except ImportError:  # 模块缺失时降级为不脱敏
    def desensitize_body(body, roles=("system",)):
        return body

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

BACKEND = "https://copilot.tencent.com"
DEFAULT_DOMAIN = "www.codebuddy.cn"
USER_AGENT = "codebuddy2openai/2.0"

# ---------------------------------------------------------------------------
# 平台相关：定位 auth 目录
# ---------------------------------------------------------------------------

def auth_dirs() -> list[Path]:
    home = Path.home()
    plat = sys.platform
    if plat == "darwin":
        return [home / "Library" / "Application Support" / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    if plat == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return [local / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    xdg = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return [xdg / "CodeBuddyExtension" / "Data" / "Public" / "auth"]


def _accounts_file() -> Path:
    """accounts.json 路径，与桌面端 Rust local_app_dir() 同源（调用时读环境变量，便于测试）。"""
    base = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    return Path(base) / "codebuddy2openai" / "accounts.json"


def _load_active_session(cfg: dict) -> tuple[str, dict]:
    """从 accounts.json 结构中取活跃账号会话，返回 (uid, session)。

    结构不符/缺失时抛 ValueError（消息即对外 error 文案）。
    accounts.json 形如 {"active_uid": "<uid>", "accounts": {"<uid>": {auth:{...}, account:{...}}}}。
    """
    active_uid = cfg.get("active_uid") or ""
    accounts = cfg.get("accounts")
    if not active_uid or not isinstance(accounts, dict):
        raise ValueError("accounts.json 缺少 active_uid 或 accounts 结构")
    session = accounts.get(active_uid)
    if not isinstance(session, dict):
        raise ValueError(f"accounts.json 中不存在活跃账号 {active_uid} 的会话")
    return active_uid, session


def find_auth_file() -> Path | None:
    # 优先使用桌面客户端同步维护的 workbuddy-desktop.info
    for d in auth_dirs():
        if d.is_dir():
            desktop_info = d / "workbuddy-desktop.info"
            if desktop_info.is_file():
                return desktop_info
            for f in sorted(d.glob("*.info")):
                return f
    return None


# ---------------------------------------------------------------------------
# Auth 凭据管理（读 + 自动刷新 + 回写）
# ---------------------------------------------------------------------------

class CredentialManager:
    """从 auth 文件或 accounts.json 读取凭据；token 临近过期时自动刷新并回写。"""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._cached: dict | None = None
        self._mtime: float = 0.0

    def _read_raw(self) -> dict:
        # 优先从 accounts.json 读取当前活跃会话（与桌面端多账号状态无缝对齐）
        try:
            acc_path = _accounts_file()
            if acc_path.is_file():
                cfg = json.loads(acc_path.read_text(encoding="utf-8"))
                _, session = _load_active_session(cfg)
                if session and isinstance(session, dict):
                    return session
        except Exception:
            pass
        # 回退：从 .info 凭据文件读取
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _load_if_stale(self):
        """若 accounts.json 或 auth 文件 mtime 变了（外部刷新或切换账号），重新加载缓存。"""
        mtimes = []
        try:
            acc_path = _accounts_file()
            if acc_path.is_file():
                mtimes.append(acc_path.stat().st_mtime)
        except OSError:
            pass
        try:
            if self.path and self.path.is_file():
                mtimes.append(self.path.stat().st_mtime)
        except OSError:
            pass
        mt = max(mtimes) if mtimes else 0.0
        if self._cached is None or mt != self._mtime:
            self._cached = self._read_raw()
            self._mtime = mt

    def _session(self) -> dict:
        self._load_if_stale()
        if self._cached is None:
            raise RuntimeError(f"无法读取 auth 文件：{self.path}")
        return self._cached

    def get_active_session(self) -> dict:
        """获取当前活跃会话字典（包含 auth 与 account 节点）。"""
        with self._lock:
            if self._is_expired():
                self._refresh()
            return self._session()

    def _is_expired(self) -> bool:
        s = self._session()
        expires_at = (s.get("auth") or {}).get("expiresAt") or 0
        # 提前 60s 判定过期
        return time.time() * 1000 >= (expires_at - 60_000)

    def _refresh(self):
        """调后端刷新 token，写回 auth 文件与缓存。"""
        s = self._session()
        auth = s.get("auth") or {}
        headers = self._build_headers_from(auth, s.get("account") or {})
        headers["X-Refresh-Token"] = auth.get("refreshToken", "")
        headers["X-Auth-Refresh-Source"] = "plugin"
        url = f"{BACKEND}/v2/plugin/auth/token/refresh"
        try:
            with httpx.Client(timeout=15) as c:
                r = c.post(url, headers=headers, json={})
            data = r.json()
        except Exception as e:
            raise RuntimeError(f"刷新 token 网络失败：{e}")
        if data.get("code") != 0 or not data.get("data"):
            raise RuntimeError(f"刷新 token 失败：{data.get('msg', data)}")
        new_auth = data["data"]
        # 继承部分字段
        new_auth["domain"] = new_auth.get("domain") or auth.get("domain")
        new_auth["lastRefreshTime"] = int(time.time() * 1000)
        # 计算 expiresAt（若后端没直接给）
        if not new_auth.get("expiresAt") and new_auth.get("expiresIn"):
            new_auth["expiresAt"] = int(time.time() * 1000) + new_auth["expiresIn"] * 1000
        if not new_auth.get("refreshExpiresAt") and new_auth.get("refreshExpiresIn"):
            new_auth["refreshExpiresAt"] = int(time.time() * 1000) + new_auth["refreshExpiresIn"] * 1000
        s["auth"] = new_auth
        # 原子写回
        if self.path:
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(s, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

        # 同步回写 accounts.json 中的活跃账号
        try:
            acc_path = _accounts_file()
            if acc_path.is_file():
                cfg = json.loads(acc_path.read_text(encoding="utf-8"))
                active_uid = cfg.get("active_uid")
                if active_uid and active_uid in cfg.get("accounts", {}):
                    cfg["accounts"][active_uid]["auth"] = new_auth
                    tmp_acc = acc_path.with_suffix(acc_path.suffix + ".tmp")
                    with open(tmp_acc, "w", encoding="utf-8") as f:
                        json.dump(cfg, f, ensure_ascii=False, indent=2)
                    os.replace(tmp_acc, acc_path)
        except Exception:
            pass

        self._cached = s
        mtimes = [self.path.stat().st_mtime] if self.path and self.path.is_file() else []
        try:
            acc_p = _accounts_file()
            if acc_p.is_file():
                mtimes.append(acc_p.stat().st_mtime)
        except OSError:
            pass
        self._mtime = max(mtimes) if mtimes else 0.0

    def _build_headers_from(self, auth: dict, account: dict) -> dict:
        domain = auth.get("domain") or DEFAULT_DOMAIN
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {auth.get('accessToken','')}",
            "X-User-Id": account.get("uid", ""),
            "X-Enterprise-Id": account.get("enterpriseId", ""),
            "X-Tenant-Id": account.get("enterpriseId", ""),
            "X-Domain": domain,
            "User-Agent": USER_AGENT,
        }
        return h

    def get_headers(self) -> dict:
        """返回带最新 token 的后端请求 header；必要时先刷新。"""
        with self._lock:
            if self._is_expired():
                self._refresh()
            s = self._session()
            return self._build_headers_from(s.get("auth") or {}, s.get("account") or {})

    def summary(self) -> dict:
        s = self._session()
        auth = s.get("auth") or {}
        acct = s.get("account") or {}
        exp = auth.get("expiresAt", 0)
        return {
            "uid": acct.get("uid"),
            "nickname": acct.get("nickname"),
            "enterpriseName": acct.get("enterpriseName"),
            "token_expires_at": exp,
            "token_expired": self._is_expired(),
        }


# ---------------------------------------------------------------------------
# 模型列表与配置
# ---------------------------------------------------------------------------

def _model_settings_file() -> str:
    # %LOCALAPPDATA% 优先，缺省时从用户主目录派生（避免硬编码具体用户路径）
    base = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    d = os.path.join(base, "codebuddy2openai")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "model_settings.json")


def _load_model_settings() -> dict:
    p = _model_settings_file()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

MODEL_MAP = {
    "hy4": "hy4-preview",
    "hy4-preview": "hy4-preview",
    "hy4-preview-agent": "hy4-preview",
    "hunyuan-4": "hy4-preview",
    "hy3": "hy3-x",
    "hy3-preview": "hy3-x",
    "hy3-preview-agent": "hy3-x",
    "kimi-k3": "kimi-k3-1",
    "minimax-m3": "minimax-m3",
}

DEFAULT_MODELS = [
    "auto",
    "hy4-preview",
    "hy4-preview-x",
    "hy3",
    "hy3-x",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5.0",
    "glm-5v-turbo",
    "glm-4.7",
    "glm-4.6",
    "glm-4.6v",
    "minimax-m3",
    "minimax-m2.5",
    "kimi-k3-1",
    "kimi-k3",
    "kimi-k2.7",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2-thinking",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v3-2-volc",
    "hunyuan-2.0-thinking",
    "hunyuan-chat",
    "default",
]

# 后端请求体里出现过的额外字段（透传时若客户端给了就保留）
PASSTHROUGH_BODY_KEYS = {
    "model", "messages", "tools", "tool_choice", "temperature",
    "max_tokens", "max_completion_tokens", "top_p", "stream",
    "stream_options", "stop", "presence_penalty", "frequency_penalty",
    "n", "response_format", "seed", "user", "reasoning_effort",
    "verbosity", "reasoning_summary",
}

# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

app = FastAPI(title="codebuddy2openai", version="2.0")
CONFIG: dict = {"host": "127.0.0.1", "port": 8787, "api_key": "",
                "cred": None, "log_path": None, "log_level": "info",
                "usage_log": None, "unsafe_expose": False,
                "desensitize": False}  # cred: CredentialManager | None


# ---------------------------------------------------------------------------
# Host 校验（防 DNS rebinding）
# ---------------------------------------------------------------------------

# 仅允许本机回环主机名（Host 头可带端口后缀，IPv6 允许方括号形式）
_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _is_loopback_host(host: str) -> bool:
    """判定是否为本机回环主机名或 IP。"""
    h = (host or "").strip().lower()
    if h in {"127.0.0.1", "localhost", "::1"}:
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _extract_hostname(host_header: str) -> str:
    """从 Host 头提取纯主机名，兼容 host:port 与 [::1]:port 两种形式。"""
    host = host_header.strip().lower()
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end != -1 else host
    if host.count(":") == 1:  # host:port（裸 IPv6 不会恰好只有一个冒号）
        return host.split(":", 1)[0]
    return host


class LocalHostOnlyMiddleware(BaseHTTPMiddleware):
    """校验 Host 头，防 DNS rebinding。

    当绑定在回环地址时强制限制 Host 必须为回环主机名（防浏览器端 DNS rebinding 攻击）。
    对 /health 与 /v1/* 全部生效；GUI/CLI 正常用法 Host 均为本机回环，无行为变化。
    """

    async def dispatch(self, request: Request, call_next):
        bind_host = CONFIG.get("host", "127.0.0.1")
        if _is_loopback_host(bind_host):
            host_header = request.headers.get("host") or ""
            if _extract_hostname(host_header) not in _ALLOWED_HOSTS:
                return JSONResponse(
                    status_code=403,
                    content={"error": {"message": f"forbidden host: {host_header}",
                                       "type": "invalid_host"}},
                )
        return await call_next(request)


app.add_middleware(LocalHostOnlyMiddleware)


# ---------------------------------------------------------------------------
# 日志（写文件）
# ---------------------------------------------------------------------------

_LOG_LOCK = threading.Lock()


def _sanitize_log_text(text: str) -> str:
    """脱敏日志中的 Token、密钥和敏感认证头。"""
    text = re.sub(r'(Bearer\s+)[A-Za-z0-9_\-\.]{8,}', r'\1***', text)
    text = re.sub(
        r'("?(?:accessToken|refreshToken|token|api[_-]?key|password)"?\s*:\s*")[^"]+(")',
        r'\1***\2',
        text,
        flags=re.IGNORECASE,
    )
    return text


def _log(msg: str, level: str = "info"):
    """写一行日志到 CONFIG['log_path'] 指定的文件（追加，带时间戳）。

    支持 info / debug / trace 三级过滤与敏感字段自动脱敏。
    未设置 log_path 则直接丢弃。
    """
    path = CONFIG.get("log_path")
    if not path:
        return
    current_level = (CONFIG.get("log_level") or "info").lower()
    level_order = {"info": 1, "debug": 2, "trace": 3}
    if level_order.get(level.lower(), 1) > level_order.get(current_level, 1):
        return
    clean_msg = _sanitize_log_text(msg)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{level.upper()}] {clean_msg}\n"
    try:
        with _LOG_LOCK:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except OSError:
        pass  # 日志失败不应影响主流程




def _truncate(s: str, n: int = 80) -> str:
    s = str(s).replace("\n", " ").strip()
    return s[:n] + ("…" if len(s) > n else "")


# ---------------------------------------------------------------------------
# 用量统计（--usage-log / 环境变量 CODEBUDDY2OPENAI_USAGE_LOG）
# 每个聊天请求（流式与非流式）完成时追加一行 JSONL，供桌面端 usage_summary 聚合。
# 铁律：统计写盘整体 try/except 静默失败，任何异常不得影响请求本身的响应。
# ---------------------------------------------------------------------------

_USAGE_LOCK = threading.Lock()


def _usage_int(v) -> int | None:
    """token 数规范化：可转 int 的返回 int，缺失/非法一律 None（契约允许 null）。"""
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _record_usage(model: str, ok: bool, t0: float, *,
                  input_tokens=None, output_tokens=None,
                  ttft_ms=None, error=None):
    """向 CONFIG['usage_log'] 追加一行用量统计（JSONL，append 模式，每行写完即落盘）。

    行格式：{"ts": <epoch毫秒>, "model": str, "ok": bool, "input_tokens": int|null,
             "output_tokens": int|null, "latency_ms": int, "ttft_ms": int|null,
             "error": str|null}
    未启用 --usage-log 时直接丢弃；写入任何异常一律静默吞掉，绝不影响请求响应。
    """
    path = CONFIG.get("usage_log")
    if not path:
        return
    try:
        rec = {
            "ts": int(time.time() * 1000),
            "model": model,
            "ok": bool(ok),
            "input_tokens": _usage_int(input_tokens),
            "output_tokens": _usage_int(output_tokens),
            "latency_ms": int((time.time() - t0) * 1000) if t0 else 0,
            "ttft_ms": _usage_int(ttft_ms),
            "error": (_truncate(str(error), 200) if error else None),
        }
        with _USAGE_LOCK:  # 并发请求下保证逐行完整追加
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()  # 每行写完立即刷出，读取方（桌面端）可立即看到
    except Exception:
        pass  # 统计失败不影响主流程


def _check_auth(authorization: Optional[str], x_api_key: Optional[str]):
    key = CONFIG.get("api_key")
    if not key:
        return
    token = ""
    # 若直接以 Python 函数调用（未走 FastAPI 依赖注入），参数默认值可能为 Header 对象
    if authorization and isinstance(authorization, str) and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    if not token and x_api_key and isinstance(x_api_key, str):
        token = x_api_key
    if token != key:
        raise HTTPException(status_code=401, detail={"error": {"message": "invalid api key", "type": "auth_error"}})


def _cred() -> CredentialManager:
    if CONFIG["cred"] is None:
        raise HTTPException(status_code=503, detail={"error": {"message": "未找到登录凭据，请先在桌面端登录 CodeBuddy/WorkBuddy", "type": "auth_error"}})
    return CONFIG["cred"]


@app.get("/health")
def health():
    # 安全收窄：/health 无需鉴权即可访问，只暴露布尔/状态字段，
    # 不再返回 uid/nickname/enterpriseName/token 过期时间/auth 文件路径等敏感信息。
    # 身份信息请通过鉴权后的 /v1/* 接口或桌面控制台获取。
    cred = CONFIG["cred"]
    authenticated = False
    if cred is not None:
        try:
            cred.summary()
            authenticated = True
        except Exception:
            authenticated = False
    return {"status": "ok", "authenticated": authenticated}


# ---------------------------------------------------------------------------
# 积分数据源端点（GET /api/usage_summary —— Hermes token-stats 配额看板数据源）
# 返回结构与桌面端 Rust UsageSummary 完全对齐（uid/nickname/total/remain/used/
# is_paid_user/packages）；任何失败一律返回 {"error": "..."}，由调用方优雅降级。
# ---------------------------------------------------------------------------

_BILLING_URL = f"{BACKEND}/billing/meter/get-user-resource-summary"

# 测试注入点：pytest 通过 monkeypatch 注入 httpx.MockTransport；生产恒为 None
_BILLING_TRANSPORT_OVERRIDE = None


def _parse_usage_payload(data: dict) -> dict:
    """解析腾讯计费响应的 data 字段，聚合口径与桌面端 Rust usage_query 完全一致。

    容量为字符串（如 "1000.5"）转 float；缺失/非法按 0.0 计（比 Rust 的仅字符串
    解析更宽容的数字类型超集，对真实字符串载荷行为一致）。
    """
    total = remain = used = 0.0
    packages = []

    def _cap(entry: dict, key: str) -> float:
        v = entry.get(key)
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    for p in data.get("Packages") or []:
        if not isinstance(p, dict):
            continue
        pt, pr, pu = (_cap(p, "CycleTotalCapacity"),
                      _cap(p, "CycleRemainCapacity"),
                      _cap(p, "CycleUsedCapacity"))
        total += pt
        remain += pr
        used += pu
        packages.append({
            "code": p.get("PackageCode") or "",
            "total": pt,
            "remain": pr,
            "used": pu,
            "unit": p.get("CapacityUnit") or "credits",
        })
    return {
        "total": total,
        "remain": remain,
        "used": used,
        "is_paid_user": bool(data.get("IsPaidUser")),
        "packages": packages,
    }


async def _fetch_billing_usage(access_token: str, uid: str, *, transport=None) -> dict:
    """服务端直查腾讯计费接口；返回 UsageSummary 对齐 dict（不含身份字段）或 {"error": ...}。"""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "X-User-Id": uid,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    use_transport = transport or _BILLING_TRANSPORT_OVERRIDE
    try:
        client_kwargs = {"timeout": 15}
        if use_transport is not None:
            client_kwargs["transport"] = use_transport
        async with httpx.AsyncClient(**client_kwargs) as c:
            r = await c.post(_BILLING_URL, headers=headers, json={})
    except httpx.HTTPError as e:
        return {"error": f"计费接口网络失败: {e}"}
    if r.status_code != 200:
        return {"error": f"计费接口 HTTP {r.status_code}"}
    try:
        body = r.json()
    except Exception:
        return {"error": "计费接口响应非 JSON"}
    if body.get("code") != 0:
        msg = body.get("msg") or body
        return {"error": f"积分查询失败: {msg}"}
    data = body.get("data")
    if not isinstance(data, dict):
        return {"error": "积分响应缺少 data 字段"}
    return _parse_usage_payload(data)


@app.get("/api/usage_summary")
async def api_usage_summary(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    """当前活跃账号的积分概览（Hermes token-stats 插件对接此端点）。"""
    _check_auth(authorization, x_api_key)

    token = ""
    uid = ""
    nickname = ""

    cred = CONFIG.get("cred")
    if cred is not None:
        try:
            session = cred.get_active_session()
            auth = session.get("auth") or {}
            account = session.get("account") or {}
            token = auth.get("accessToken") or ""
            uid = account.get("uid") or ""
            nickname = account.get("nickname") or ""
        except Exception as e:
            return {"error": f"读取活跃凭据失败: {e}"}

    if not token:
        try:
            path = _accounts_file()
            if not path.is_file():
                return {"error": f"accounts.json 不存在: {path}"}
            cfg = json.loads(path.read_text(encoding="utf-8"))
            uid, session = _load_active_session(cfg)
        except json.JSONDecodeError as e:
            return {"error": f"accounts.json 解析失败: {e}"}
        except (OSError, ValueError) as e:
            return {"error": f"读取活跃账号失败: {e}"}

        auth = session.get("auth") or {}
        account = session.get("account") or {}
        token = auth.get("accessToken")
        if not token:
            return {"error": "活跃账号缺少 accessToken（请在桌面控制台重新授权或刷新 Token）"}
        nickname = account.get("nickname") or ""

    summary = await _fetch_billing_usage(token, uid)
    if "error" in summary:
        return summary
    # token 过期时腾讯侧会以 code!=0/HTTP 401 返回，已归一为上面的 error 路径
    return {"uid": uid, "nickname": nickname, **summary}


@app.get("/v1/models")
def list_models(authorization: Optional[str] = Header(default=None),
                x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key")):
    _check_auth(authorization, x_api_key)
    data = [{"id": m, "object": "model", "created": 1700000000, "owned_by": "codebuddy"}
            for m in DEFAULT_MODELS]
    return {"object": "list", "data": data}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request,
                           authorization: Optional[str] = Header(default=None),
                           x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key")):
    _check_auth(authorization, x_api_key)
    cred = _cred()

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail={"error": {"message": f"bad json: {e}", "type": "invalid_request_error"}})

    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(status_code=400, detail={"error": {"message": "messages is required", "type": "invalid_request_error"}})

    # 构造后端 body：只透传已知的合法字段
    client_wants_stream = bool(payload.get("stream"))
    body = {k: payload[k] for k in PASSTHROUGH_BODY_KEYS if k in payload}
    body.setdefault("model", "auto")
    # 后端只支持流式：始终以 stream=True 调后端，非流式由转换器聚合
    body["stream"] = True
    if "stream_options" not in body:
        body["stream_options"] = {"include_usage": True}

    # 可选：脱敏。缓解客户端合规模板（如 ZCode 的 system 声明）被后端误判为敏感词。
    # 只对 system 角色消息里的"合规声明高频词"插入零宽空格，不改用户输入。
    if CONFIG.get("desensitize"):
        body = desensitize_body(body, roles=("system",))

    # 日志：请求摘要
    model_name = payload.get("model", "auto")
    mapped_model = MODEL_MAP.get(model_name, model_name)
    body["model"] = mapped_model

    # 应用用户在控制台配置的自定义参数（上下文限制/思考强度等）
    user_settings = _load_model_settings()
    custom_cfg = user_settings.get(model_name) or user_settings.get(mapped_model) or {}

    # 1. 思考模式与思考强度
    custom_effort = custom_cfg.get("reasoning_effort")
    if custom_effort:
        if custom_effort == "disable":
            body.pop("reasoning_effort", None)
            body["chat_template_kwargs"] = {"enable_thinking": False}
        else:
            body["reasoning_effort"] = custom_effort
            if "chat_template_kwargs" not in body:
                body["chat_template_kwargs"] = {"enable_thinking": True}

    # 2. 上下文截断保护 / max_tokens
    custom_ctx = custom_cfg.get("context_window")
    if custom_ctx and isinstance(custom_ctx, int) and custom_ctx > 0:
        if "max_tokens" not in body:
            body["max_tokens"] = min(custom_ctx, 64000)

    tool_names = [t.get("function", {}).get("name") for t in (payload.get("tools") or [])
                  if isinstance(t, dict)]
    last_user = _last_user_text(messages)
    rid = os.urandom(4).hex()
    _log(f"[{rid}] ▶ REQUEST {model_name} | stream={client_wants_stream} | msgs={len(messages)}"
         + (f" | tools={tool_names}" if tool_names else "")
         + (f" | last_user={_truncate(last_user, 60)!r}" if last_user else ""))
    # 完整请求体（发往后端的实际内容；若启用脱敏，这里已是脱敏后）
    _log(f"[{rid}] ── REQUEST BODY (发往后端) ──\n{json.dumps(body, ensure_ascii=False, indent=2)}", level="trace")

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    if client_wants_stream:
        return StreamingResponse(
            _stream_upstream(url, headers, body, model_name, t0, rid),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 非流式：后端只支持流式，这里把后端 SSE 聚合成单个 chat.completion 响应
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            async with c.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    raw = await r.aread()
                    _log(f"[{rid}] ✗ HTTP {r.status_code} | {model_name} | {_truncate(raw.decode('utf-8','replace'),200)}")
                    _log(f"[{rid}] ── ERROR BODY ──\n{raw.decode('utf-8','replace')}", level="debug")
                    raise HTTPException(status_code=r.status_code, detail=_safe_err_raw(raw, r.status_code))
                collected, ttft_ms = await _collect_stream(r, t0)
    except HTTPException as e:
        # 上游错误（非 200 等）：记一条失败统计（ok=false）后原样抛出，不改变既有错误语义
        _record_usage(model_name, False, t0, error=f"HTTP {e.status_code}")
        raise
    except httpx.HTTPError as e:
        _log(f"[{rid}] ✗ 网络错误 | {model_name} | {e}")
        _record_usage(model_name, False, t0, error=f"upstream error: {e}")
        raise HTTPException(status_code=502, detail={"error": {"message": f"upstream error: {e}", "type": "upstream_error"}})
    except Exception as e:
        # 兜底：未预期异常同样记失败统计，再原样抛出
        _record_usage(model_name, False, t0, error=f"{type(e).__name__}: {e}")
        raise
    _log_finish(model_name, t0, collected, rid)
    # 用量统计：成功请求记一行（usage 与 _log_finish 取同一来源）
    _u = collected.get("usage") or {}
    _record_usage(model_name, True, t0,
                  input_tokens=_u.get("prompt_tokens"),
                  output_tokens=_u.get("completion_tokens"),
                  ttft_ms=ttft_ms)
    return JSONResponse(content=collected)


def _last_user_text(messages: list) -> str:
    """取最后一条 user 消息的文本，用于日志预览。"""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "text":
                    return str(blk.get("text", ""))
            return ""
        return str(content)
    return ""


def _log_finish(model_name: str, t0: float, result: dict, rid: str = ""):
    """记录一次完成的请求：耗时 / finish_reason / usage / 工具调用 / 审核拦截 + 完整响应。"""
    elapsed = time.time() - t0
    prefix = f"[{rid}] " if rid else ""
    choice = (result.get("choices") or [{}])[0]
    finish = choice.get("finish_reason")
    msg = choice.get("message") or {}
    tcs = msg.get("tool_calls") or []
    usage = result.get("usage") or {}
    tag = ""
    if finish == "content-filter":
        tag = " ⚠️内容审核拦截"
    tc_names = [t.get("function", {}).get("name") for t in tcs]
    _log(f"{prefix}◀ RESPONSE {model_name} | {elapsed:.1f}s | finish={finish}{tag}"
         + (f" | tool_calls={tc_names}" if tc_names else "")
         + f" | tokens={usage.get('total_tokens', '?')}")
    # 完整响应体
    _log(f"{prefix}── RESPONSE BODY ──\n{json.dumps(result, ensure_ascii=False, indent=2)}", level="trace")


async def _collect_stream(response: httpx.Response, t0: float = 0.0) -> tuple[dict, int | None]:
    """消费后端的 OpenAI SSE 流，聚合成单个非流式 chat.completion 对象。

    合并所有 chunk 的 delta（content / tool_calls），并取 usage / finish_reason。
    返回 (聚合结果, ttft_ms)：ttft_ms 为首个含内容 delta 到达时刻距 t0 的毫秒数
    （t0 为 0 或全程无内容时为 None），供用量统计复用。
    """
    content_parts: list[str] = []
    ttft_ms: int | None = None
    # tool_calls: index -> {id, name, arguments(分片拼接)}
    tool_calls: dict[int, dict] = {}
    model: str | None = None
    finish_reason: str | None = None
    usage: dict | None = None

    async for line in response.aiter_lines():
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        model = chunk.get("model") or model
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            if delta.get("content"):
                if ttft_ms is None and t0:
                    ttft_ms = int((time.time() - t0) * 1000)  # 首个含内容 chunk 即 TTFT
                content_parts.append(delta["content"])
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
                slot = tool_calls.setdefault(idx, {"id": None, "name": None, "arguments": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]

    tcs = None
    if tool_calls:
        tcs = [
            {"id": v["id"], "type": "function",
             "function": {"name": v["name"], "arguments": v["arguments"]}}
            for _, v in sorted(tool_calls.items())
        ]
        finish_reason = finish_reason or "tool_calls"

    message = {"role": "assistant", "content": "".join(content_parts) or None}
    if tcs:
        message["tool_calls"] = tcs
    return {
        "id": "chatcmpl-" + os.urandom(12).hex(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model or "unknown",
        "choices": [{"index": 0, "message": message,
                     "finish_reason": finish_reason or "stop"}],
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }, ttft_ms


def _safe_err_raw(raw: bytes, status: int) -> dict:
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {"error": {"message": raw.decode("utf-8", "replace")[:500], "type": "upstream_error", "code": status}}


async def _stream_upstream(url: str, headers: dict, body: dict,
                           model_name: str = "?", t0: float = 0.0, rid: str = ""):
    """把后端 SSE 原样转发给客户端（后端已是标准 OpenAI SSE，含 tool_calls）。

    同时轻量解析流，统计 finish_reason / tool_calls / usage 用于日志，不阻塞转发。
    完整原始 SSE 累积后落盘到日志（调试用）。
    """
    finish_reason = None
    tool_names: list[str] = []
    usage: dict = {}
    saw_filter = False
    ttft_ms: int | None = None   # 首个含内容 chunk 距 t0 的毫秒数（TTFT）
    err_msg: str | None = None   # 上游错误摘要（None 表示流正常结束）
    buf = b""
    raw_parts: list[bytes] = []   # 累积完整原始 SSE
    prefix = f"[{rid}] " if rid else ""

    def _feed(chunk: bytes):
        nonlocal finish_reason, saw_filter, buf, ttft_ms
        # 行缓冲解析：把累计的 chunk 按 data: 行切出来统计
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                continue
            try:
                obj = json.loads(data)
            except Exception:
                continue
            if obj.get("usage"):
                usage.update(obj["usage"])
            for ch in obj.get("choices") or []:
                if ch.get("finish_reason"):
                    finish_reason = ch["finish_reason"]
                delta = ch.get("delta") or {}
                # 首个含内容的 delta 即 TTFT（与桌面端 test_chat 的口径一致）
                if ttft_ms is None and t0 and delta.get("content"):
                    ttft_ms = int((time.time() - t0) * 1000)
                for tc in delta.get("tool_calls") or []:
                    nm = (tc.get("function") or {}).get("name")
                    if nm:
                        tool_names.append(nm)
            # 内容审核拦截常以 content-filter 或特殊中文文案返回
            try:
                text_repr = data.decode("utf-8", "replace")
            except Exception:
                text_repr = ""
            if "content-filter" in text_repr or "敏感" in text_repr or "审核" in text_repr:
                saw_filter = True

    try:
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    _log(f"{prefix}✗ HTTP {r.status_code} | {model_name} | {_truncate(err.decode('utf-8','replace'),200)}")
                    _log(f"{prefix}── ERROR BODY ──\n{err.decode('utf-8','replace')}", level="debug")
                    # 上游错误：先记一条失败统计（tokens 未知填 null）再返回错误事件
                    _record_usage(model_name, False, t0, error=f"HTTP {r.status_code}")
                    yield _err_event(err, r.status_code)
                    return
                async for chunk in r.aiter_bytes():
                    if chunk:
                        raw_parts.append(chunk)
                        _feed(chunk)
                        yield chunk
    except httpx.HTTPError as e:
        _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
        err_msg = f"upstream error: {e}"
        yield _err_event(str(e).encode(), 502)

    # 流结束：输出完成日志
    elapsed = time.time() - t0 if t0 else 0
    tag = " ⚠️内容审核拦截" if (saw_filter or finish_reason == "content-filter") else ""
    _log(f"{prefix}◀ RESPONSE {model_name} | {elapsed:.1f}s | stream finish={finish_reason}{tag}"
         + (f" | tool_calls={tool_names}" if tool_names else "")
         + f" | tokens={usage.get('total_tokens', '?')}")
    # 完整原始 SSE（后端返回的全部内容）
    _log(f"{prefix}── RESPONSE RAW SSE ──\n{b''.join(raw_parts).decode('utf-8','replace')}", level="trace")
    # 用量统计：正常结束 ok=true；上游错误 ok=false（失败也记一行）。
    # _record_usage 内部整体 try/except 静默失败，绝不影响已返回的流式响应。
    _record_usage(model_name, ok=(err_msg is None), t0=t0,
                  input_tokens=usage.get("prompt_tokens"),
                  output_tokens=usage.get("completion_tokens"),
                  ttft_ms=ttft_ms, error=err_msg)


def _safe_err(r: httpx.Response) -> dict:
    try:
        return {"error": r.json()}
    except Exception:
        return {"error": {"message": r.text[:500], "type": "upstream_error", "code": r.status_code}}


def _err_event(msg: bytes, status: int) -> bytes:
    # 以 OpenAI SSE 错误 chunk 形式返回
    import json as _json, time as _time
    chunk = {
        "error": {"message": msg.decode("utf-8", "replace")[:500], "type": "upstream_error", "code": status},
    }
    return f"data: {_json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def preflight() -> bool:
    af = find_auth_file()
    sys.stderr.write("==== 预检 ====\n")
    sys.stderr.write(f"平台      : {sys.platform}\n")
    sys.stderr.write(f"Python    : {sys.version.split()[0]}\n")
    sys.stderr.write(f"后端      : {BACKEND} (直连，原生 function calling)\n")
    sys.stderr.write(f"登录文件  : {af or '(未找到)'}\n")
    if auth_dirs():
        sys.stderr.write(f"已查目录  : {', '.join(str(d) for d in auth_dirs())}\n")
    ok = True
    if af is None:
        sys.stderr.write("\n[警告] 未找到登录文件。请在桌面端完成登录（CodeBuddy/WorkBuddy）。\n")
        ok = False
    else:
        try:
            cm = CredentialManager(af)
            info = cm.summary()
            sys.stderr.write(f"账号      : {info.get('nickname')} / {info.get('enterpriseName')}\n")
            sys.stderr.write(f"token过期 : {'是(将自动刷新)' if info['token_expired'] else '否'}\n")
        except Exception as e:
            sys.stderr.write(f"[警告] 读取凭据失败：{e}\n")
            ok = False
    sys.stderr.write("================\n")
    return ok


def main():
    ap = argparse.ArgumentParser(description="CodeBuddy -> OpenAI 兼容转换器（直连后端）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--api-key", default=os.environ.get("CODEBUDDY2OPENAI_KEY", ""),
                    help="可选：要求客户端携带的 API key（非回环监听时强制要求，回环默认不校验）")
    ap.add_argument("--unsafe-expose", action="store_true",
                    help="当监听非回环地址（如 0.0.0.0）且未设置 --api-key 时，显式确认以无鉴权方式向网络暴露服务（高风险）")
    ap.add_argument("--log", default=None, metavar="PATH",
                    help="开启日志并写到该文件（如 --log converter.log 或 --log /tmp/cb.log）。"
                         "不传则不记日志。")
    ap.add_argument("--log-level", default=os.environ.get("CODEBUDDY2OPENAI_LOG_LEVEL", "info"),
                    choices=["info", "debug", "trace"],
                    help="日志详细级别：info（默认，仅记录请求摘要与耗时，不落盘 prompt/response 正文）；"
                         "debug（含错误响应详情）；trace（完整记录请求体与响应流，自动脱敏 Token/Key）。")
    ap.add_argument("--usage-log", default=None, metavar="PATH",
                    help="开启用量统计：每个聊天请求（流式/非流式）完成后向该文件追加一行 JSONL"
                         "（ts/model/ok/input_tokens/output_tokens/latency_ms/ttft_ms/error）。"
                         "不传则不记录。")
    ap.add_argument("--desensitize", action="store_true",
                    help="启用脱敏：对 system 消息里的合规模板敏感词（DoS/exploit/credential 等）"
                         "插入零宽空格，缓解被后端内容审核误拦。默认关闭。")
    ap.add_argument("--skip-check", action="store_true", help="跳过启动预检")
    args = ap.parse_args()

    # 安全边界校验：非回环地址绑定必须具备访问鉴权
    if not _is_loopback_host(args.host):
        if not args.api_key and not args.unsafe_expose:
            sys.stderr.write(
                f"\n[安全拒绝] 服务绑定至非回环地址 (http://{args.host}:{args.port}) 时，"
                "必须配置 --api-key（或环境变量 CODEBUDDY2OPENAI_KEY）进行访问鉴权。\n"
                "若在受信任的隔离网络环境中确实需要无鉴权暴露，请显式指定 --unsafe-expose 启动参数。\n\n"
            )
            sys.exit(1)
        elif not args.api_key and args.unsafe_expose:
            sys.stderr.write(
                f"\n[安全警告] ⚠️ 服务已通过 --unsafe-expose 以无鉴权方式暴露至网络 (http://{args.host}:{args.port})！"
                "网络内任意客户端均可直接消耗您的账号额度。\n\n"
            )

    CONFIG["host"] = args.host
    CONFIG["port"] = args.port
    CONFIG["api_key"] = args.api_key
    CONFIG["unsafe_expose"] = args.unsafe_expose
    CONFIG["desensitize"] = args.desensitize
    CONFIG["log_path"] = args.log if args.log else os.environ.get("CODEBUDDY2OPENAI_LOG")
    CONFIG["log_level"] = args.log_level
    CONFIG["usage_log"] = args.usage_log if args.usage_log else os.environ.get("CODEBUDDY2OPENAI_USAGE_LOG")
    af = find_auth_file()
    CONFIG["cred"] = CredentialManager(af) if af else None

    if not args.skip_check:
        preflight()

    sys.stderr.write(f"\n✅ 监听 http://{args.host}:{args.port}（直连后端，原生 function calling）\n")
    sys.stderr.write("   GET  /v1/models\n")
    sys.stderr.write("   POST /v1/chat/completions   (原生 tools/tool_calls，支持流式)\n")
    sys.stderr.write("   GET  /health\n")
    sys.stderr.write("   GET  /api/usage_summary     (当前账号积分概览，Hermes 配额看板数据源)\n")
    if args.api_key:
        sys.stderr.write("   鉴权已启用（API key 已设置）\n")
    elif not _is_loopback_host(args.host) and args.unsafe_expose:
        sys.stderr.write("   ⚠️ 警告：非回环暴露且无鉴权 (--unsafe-expose)\n")
    if CONFIG["log_path"]:
        sys.stderr.write(f"   日志      : {CONFIG['log_path']} (级别: {CONFIG['log_level']})\n")
    if CONFIG["usage_log"]:
        sys.stderr.write(f"   用量统计  : {CONFIG['usage_log']}\n")
    if args.desensitize:
        sys.stderr.write("   脱敏      : 已启用（system 合规词零宽处理）\n")
    sys.stderr.write("按 Ctrl+C 退出。\n\n")

    # 启动时写一条标记
    _log(f"==== converter 启动 ====")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
