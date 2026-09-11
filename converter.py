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
import asyncio
import datetime
import ipaddress
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
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

try:
    from anthropic_compat import translate_anthropic_request, translate_openai_response_to_anthropic
    from anthropic_stream import AnthropicStreamTranslator
except ImportError:
    translate_anthropic_request = None
    translate_openai_response_to_anthropic = None
    AnthropicStreamTranslator = None

try:
    from request_pacer import RequestPacer
except ImportError:
    RequestPacer = None

try:
    from token_refresher import BackgroundTokenRefresher
except ImportError:
    BackgroundTokenRefresher = None

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

BACKEND = "https://copilot.tencent.com"
DEFAULT_DOMAIN = "www.codebuddy.cn"
USER_AGENT = "codebuddy2openai/2.0"

# ---------------------------------------------------------------------------
# 平台相关：定位 auth 目录与 WSL 宿主穿透
# ---------------------------------------------------------------------------

def _is_wsl() -> bool:
    """检测当前是否运行在 WSL (Windows Subsystem for Linux) 环境下。"""
    if sys.platform != "linux":
        return False
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return True
    try:
        proc_ver = Path("/proc/version").read_text(encoding="utf-8", errors="ignore").lower()
        return "microsoft" in proc_ver or "wsl" in proc_ver
    except Exception:
        return False


def _wsl_win_local_appdata() -> list[Path]:
    """在 WSL 下探测宿主 Windows 的 AppData/Local 候选目录。"""
    results: list[Path] = []
    users_root = Path("/mnt/c/Users")
    if not users_root.is_dir():
        return results

    # 1. 优先尝试与当前 Linux 用户名同名的 Windows 用户目录（默认安全策略）
    import getpass
    try:
        cur_user = getpass.getuser()
        c = users_root / cur_user / "AppData" / "Local"
        if c.is_dir():
            results.append(c)
    except Exception:
        pass

    # 2. 遍历 /mnt/c/Users：仅在显式开启 --scan-all-users 时执行，防多用户机器跨用户误读他人凭据
    if CONFIG.get("scan_all_users"):
        ignore = {"public", "default", "default user", "all users", "desktop.ini"}
        try:
            for entry in users_root.iterdir():
                if entry.name.lower() not in ignore and not entry.name.startswith("."):
                    local = entry / "AppData" / "Local"
                    if local.is_dir() and local not in results:
                        results.append(local)
        except Exception:
            pass
    return results


def auth_dirs() -> list[Path]:
    home = Path.home()
    plat = sys.platform
    if plat == "darwin":
        return [home / "Library" / "Application Support" / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    if plat == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return [local / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    xdg = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    dirs = [xdg / "CodeBuddyExtension" / "Data" / "Public" / "auth"]

    # WSL 环境或显式开启 --wsl：自动追加宿主 Windows 桌面端的凭据目录
    if _is_wsl() or CONFIG.get("wsl"):
        for win_local in _wsl_win_local_appdata():
            candidate = win_local / "CodeBuddyExtension" / "Data" / "Public" / "auth"
            if candidate not in dirs:
                dirs.append(candidate)

    return dirs


def _accounts_file() -> Path:
    """accounts.json 路径，与桌面端 Rust local_app_dir() 同源（调用时读环境变量，便于测试）。"""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "codebuddy2openai" / "accounts.json"
    if sys.platform == "win32":
        return Path.home() / "AppData" / "Local" / "codebuddy2openai" / "accounts.json"

    # Linux / WSL
    local_acc = Path.home() / ".local" / "share" / "codebuddy2openai" / "accounts.json"
    if local_acc.is_file():
        return local_acc

    # WSL 穿透：读取 Windows 宿主已保存的桌面端多账号状态
    if _is_wsl() or CONFIG.get("wsl"):
        for win_local in _wsl_win_local_appdata():
            candidate = win_local / "codebuddy2openai" / "accounts.json"
            if candidate.is_file():
                return candidate

    return local_acc


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


def init_cred() -> None:
    """初始化全局凭据管理器 CONFIG['cred']。

    数据源优先级：accounts.json（多账号真源）→ legacy .info（兼容回退）。
    即使 find_auth_file() 返回 None（纯新环境、仅桌面端 OAuth 登录写入 accounts.json），
    只要 accounts.json 存在且含有效活跃会话，仍会构造 CredentialManager，
    避免服务启动后所有请求直接 503。
    """
    af = find_auth_file()
    try:
        CONFIG["cred"] = CredentialManager(af)
    except Exception as e:  # 凭据不可读时不阻断启动，交由 /health 与请求层按需报错
        _log(f"凭据初始化失败：{e}")
        CONFIG["cred"] = None


# ---------------------------------------------------------------------------
# 设备风控头提供器（X-Device-Token，借鉴 xiaofan6ya/workbuddy2api，MIT License）
#
# 背景：WorkBuddy 桌面端给签到/对话等敏感请求注入 Turing Shield SDK 生成的
# `X-Device-Token`；缺失时上游风控可能识别为「非真实客户端」。本实现通过
# 仓库根的 turing_helper.js（Node）调用桌面端自带 SDK 原生模块取 token：
#   1. helper 自动发现本机 WorkBuddy 安装位置（不写死路径，支持环境变量覆盖）
#   2. 取不到/SDK 不可用时优雅降级为不带该头，绝不阻塞主流程
#   3. 进程内缓存 10 分钟（设备 token 长期有效，helper 内部另有磁盘缓存+旧值兜底）
# ---------------------------------------------------------------------------

_TURING_TOKEN_CACHE: Optional[str] = None
_TURING_TOKEN_AT: float = 0.0
_TURING_TTL_SEC = 600.0


def _find_node_runtime() -> str:
    """定位可用的 node 运行时：系统 PATH → WorkBuddy managed node → 裸 'node'。"""
    import shutil

    exe = shutil.which("node")
    if exe:
        return exe
    # WorkBuddy 桌面端自带 managed node（GUI.for.Cores 风格工作区）
    base = Path(os.environ.get("LOCALAPPDATA", "")) / ".workbuddy" / "binaries" / "node"
    for cand in (base / "node.exe", base / "workspace" / "node.exe"):
        if cand.is_file():
            return str(cand)
    return "node"


def _get_turing_device_token() -> Optional[str]:
    """取得设备风控 token（进程内缓存 10 分钟）；任何失败返回 None，不抛异常。"""
    global _TURING_TOKEN_CACHE, _TURING_TOKEN_AT
    now = time.time()
    if _TURING_TOKEN_CACHE is not None and (now - _TURING_TOKEN_AT) < _TURING_TTL_SEC:
        return _TURING_TOKEN_CACHE
    try:
        helper = Path(__file__).resolve().parent / "turing_helper.cjs"
        if not helper.is_file():
            return None
        import subprocess

        node = _find_node_runtime()
        # 短超时：SDK 联网取 token 正常 1~3s，异常时尽快放弃不拖累请求
        proc = subprocess.run(
            [node, str(helper)],
            capture_output=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout.decode("utf-8", "replace").strip())
        token = (data.get("token") or "").strip()
        if not token:
            return None
        _TURING_TOKEN_CACHE = token
        _TURING_TOKEN_AT = now
        return token
    except Exception as exc:
        _log(f"获取 device token 失败（优雅降级为不带 X-Device-Token）: {exc}")
        return None


# ---------------------------------------------------------------------------
# Auth 凭据管理（读 + 自动刷新 + 回写）
# ---------------------------------------------------------------------------

class CredentialManager:
    """从 auth 文件或 accounts.json 读取凭据；token 临近过期时自动刷新并回写。"""

    def __init__(self, path: Path | None = None):
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
        if not self.path:
            raise RuntimeError(
                "无可用凭据：accounts.json 缺少有效活跃会话，且未找到 legacy .info 文件"
            )
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
            raise RuntimeError(f"无法读取 auth 凭据（accounts.json 与 .info 均不可用，path={self.path}）")
        return self._cached

    def get_active_session(self) -> dict:
        """获取当前活跃会话字典（包含 auth 与 account 节点）。"""
        with self._lock:
            if self._is_expired():
                self._refresh()
            return self._session()

    def peek_active_session(self) -> dict:
        """只读查看当前活跃会话字典，不触发被动同步网络刷新。"""
        with self._lock:
            return self._session()

    def _is_expired(self) -> bool:
        s = self._session()
        expires_at = (s.get("auth") or {}).get("expiresAt") or 0
        # 提前 60s 判定过期
        return time.time() * 1000 >= (expires_at - 60_000)

    def _save_tokens(self, arg1: dict, arg2: dict | None = None):
        """明确 accounts.json 为真源，.info 为兼容镜像。
        若 accounts.json 存在，必须成功写回；写失败时中止提交流程，防止脏状态。
        """
        if arg2 is not None:
            s, new_auth = arg1, arg2
        else:
            new_auth = arg1
            s = self._session()
        s_candidate = dict(s)
        s_candidate["auth"] = new_auth

        # 1. 明确 accounts.json 为真源：若 accounts.json 存在，必须成功写回，失败抛异常阻断提交
        acc_path = _accounts_file()
        if acc_path.is_file():
            try:
                cfg = json.loads(acc_path.read_text(encoding="utf-8"))
                active_uid = cfg.get("active_uid")
                if not active_uid or active_uid not in cfg.get("accounts", {}):
                    raise ValueError(f"accounts.json 缺少 active_uid 或活跃账号 {active_uid} 不存在")
                cfg["accounts"][active_uid]["auth"] = new_auth
                tmp_acc = acc_path.with_suffix(acc_path.suffix + ".tmp")
                with open(tmp_acc, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=2)
                os.replace(tmp_acc, acc_path)
            except Exception as e:
                _log(f"写入 accounts.json 失败：{e}")
                raise RuntimeError(f"写入真源 accounts.json 失败：{e}") from e

        # 2. .info 为兼容镜像：回写单文件凭据
        if self.path:
            try:
                tmp = self.path.with_suffix(self.path.suffix + ".tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(s_candidate, f, ensure_ascii=False, indent=2)
                os.replace(tmp, self.path)
            except Exception as e:
                _log(f"写入 .info 兼容镜像失败：{e}", level="debug")

        s["auth"] = new_auth
        self._cached = s
        mtimes = [self.path.stat().st_mtime] if self.path and self.path.is_file() else []
        try:
            acc_p = _accounts_file()
            if acc_p.is_file():
                mtimes.append(acc_p.stat().st_mtime)
        except OSError:
            pass
        self._mtime = max(mtimes) if mtimes else 0.0

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
        self._save_tokens(s, new_auth)

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
        # 设备风控头：桌面端所有敏感请求均携带（Turing Shield SDK 生成）。
        # 取不到时优雅降级为不带该头（借鉴 xiaofan6ya/workbuddy2api，MIT）。
        tok = _get_turing_device_token()
        if tok:
            h["X-Device-Token"] = tok
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
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gemini-3.5-flash",
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
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v3-2-volc",
    "hunyuan-2.0-thinking",
    "hunyuan-chat",
    "default",
]

_MODELS_URL = f"{BACKEND}/v2/enterprises/personal/models"
_WORKBUDDY_MODELS_URL = "https://www.codebuddy.ai/v3/config"
_MODELS_TRANSPORT_OVERRIDE = None
_MODELS_CACHE: dict[str, dict] = {}  # uid -> {"models": list[str], "expires_at": float}
_MODELS_WINDOWS: dict[str, int] = {}  # model_id -> 上游窗口（maxInputTokens/maxAllowedSize）


def _merge_model_ids(static_models: list[str], dynamic_models: list[str] | None = None, custom_models: list[str] | None = None) -> list[str]:
    """合并静态基础模型、动态云端模型与用户自定义配置模型，去重并保持顺序。"""
    seen = set()
    result = []
    for m in static_models or []:
        if m and m not in seen:
            seen.add(m)
            result.append(m)
    for m in dynamic_models or []:
        if m and m not in seen:
            seen.add(m)
            result.append(m)
    for m in custom_models or []:
        if m and m not in seen:
            seen.add(m)
            result.append(m)
    return result


def _reported_context_length(model_id: str, settings: dict, windows: dict):
    """解析上报给客户端的上下文窗口（/v1/models 条目顶层 context_length）。

    优先级：控制台手改值（model_settings.json 的 context_window）> 上游默认值
    （maxInputTokens / maxAllowedSize，由 _fetch_remote_models 采集）。
    无有效值时返回 None，响应不携带该字段（客户端自行回退）。
    """
    cfg = settings.get(model_id)
    if isinstance(cfg, dict):
        ctx = cfg.get("context_window")
        if isinstance(ctx, int) and not isinstance(ctx, bool) and ctx > 0:
            return ctx
    w = windows.get(model_id)
    if isinstance(w, int) and not isinstance(w, bool) and w > 0:
        return w
    return None


async def _fetch_remote_models(*, transport=None) -> list[str]:
    """尝试从云端获取动态模型列表，按 UID 隔离缓存，失败时优雅降级返回缓存或空列表，并在 debug 级别输出可观测诊断日志。"""
    global _MODELS_CACHE
    now = time.time()

    token = ""
    uid = ""
    cred = CONFIG.get("cred")
    if cred is not None:
        try:
            session = cred.get_active_session()
            auth = session.get("auth") or {}
            account = session.get("account") or {}
            token = auth.get("accessToken") or ""
            uid = account.get("uid") or ""
        except Exception as e:
            _log(f"动态模型凭据读取降级 (CredentialManager): {_sanitize_log_text(str(e))}", level="debug")
    if not token:
        try:
            path = _accounts_file()
            if path.is_file():
                cfg = json.loads(path.read_text(encoding="utf-8"))
                uid, session = _load_active_session(cfg)
                auth = session.get("auth") or {}
                token = auth.get("accessToken") or ""
        except Exception as e:
            _log(f"动态模型凭据读取降级 (accounts.json): {_sanitize_log_text(str(e))}", level="debug")

    cache_key = str(uid).strip() or "default"
    cached = _MODELS_CACHE.get(cache_key, {})
    cached_models = cached.get("models") or []
    if cached_models and now < cached.get("expires_at", 0.0):
        return list(cached_models)

    use_transport = transport or _MODELS_TRANSPORT_OVERRIDE
    if not token and use_transport is None:
        _log("动态模型拉取降级: 未获取到可用登录凭据或Token", level="debug")
        return list(cached_models)

    headers = {
        "Authorization": f"Bearer {token}" if token else "",
        "X-User-Id": str(uid),
        "User-Agent": USER_AGENT,
    }
    endpoints = [
        ("CodeBuddy", _MODELS_URL),
        ("WorkBuddy", _WORKBUDDY_MODELS_URL),
    ]

    async def _fetch_source(client: httpx.AsyncClient, label: str, url: str) -> tuple[list[str], dict[str, int]]:
        req_headers = dict(headers)
        if "codebuddy.ai" in url or "workbuddy" in label.lower():
            req_headers["User-Agent"] = "WorkBuddy/2.0.0"
        try:
            r = await client.get(url, headers=req_headers)
            if r.status_code == 200:
                try:
                    body = r.json()
                except Exception as e:
                    _log(f"动态模型拉取降级 [{label}]: 响应JSON解析失败 ({_sanitize_log_text(str(e))})", level="debug")
                    return [], {}

                if isinstance(body, dict) and body.get("code") == 0 and isinstance(body.get("data"), dict):
                    raw_models = body["data"].get("models")
                    if isinstance(raw_models, list):
                        m_list = []
                        w_map = {}
                        for m in raw_models:
                            if isinstance(m, dict):
                                mid = m.get("id")
                                if mid and mid != "hunyuan-image-v3.0":
                                    m_list.append(str(mid))
                                    w = m.get("maxInputTokens")
                                    if not isinstance(w, int):
                                        w = m.get("maxAllowedSize")
                                    if isinstance(w, int) and w > 0:
                                        w_map[str(mid)] = w
                        return m_list, w_map
                    else:
                        _log(f"动态模型拉取降级 [{label}]: models字段缺失或非列表 (type={type(raw_models).__name__})", level="debug")
                else:
                    err_code = body.get("code") if isinstance(body, dict) else "unknown"
                    _log(f"动态模型拉取降级 [{label}]: 响应结构异常或业务状态码错误 (code={err_code})", level="debug")
            else:
                _log(f"动态模型拉取降级 [{label}]: HTTP {r.status_code}", level="debug")
        except httpx.TimeoutException as e:
            _log(f"动态模型拉取降级 [{label}]: 请求超时 ({_sanitize_log_text(str(e))})", level="debug")
        except httpx.HTTPError as e:
            _log(f"动态模型拉取降级 [{label}]: 网络/HTTP异常 ({_sanitize_log_text(str(e))})", level="debug")
        except json.JSONDecodeError as e:
            _log(f"动态模型拉取降级 [{label}]: 响应JSON解析失败 ({_sanitize_log_text(str(e))})", level="debug")
        except Exception as e:
            _log(f"动态模型拉取降级 [{label}]: 未知异常 ({_sanitize_log_text(str(e))})", level="debug")
        return [], {}

    try:
        client_kwargs = {"timeout": 10}
        if use_transport is not None:
            client_kwargs["transport"] = use_transport
        async with httpx.AsyncClient(**client_kwargs) as c:
            results = await asyncio.gather(
                *(_fetch_source(c, label, url) for label, url in endpoints),
                return_exceptions=True
            )

        combined_models: list[str] = []
        combined_windows: dict[str, int] = {}
        seen = set()

        for res in results:
            if isinstance(res, tuple) and len(res) == 2:
                m_list, w_map = res
                for mid in m_list:
                    if mid not in seen:
                        seen.add(mid)
                        combined_models.append(mid)
                combined_windows.update(w_map)

        if combined_models:
            if combined_windows:
                _MODELS_WINDOWS.update(combined_windows)
            _MODELS_CACHE[cache_key] = {"models": combined_models, "expires_at": now + 60.0}
            return list(combined_models)
        else:
            _log("动态模型拉取降级: 双端返回有效模型列表均为空", level="debug")
    except Exception as e:
        _log(f"动态模型拉取降级: 未知异常 ({_sanitize_log_text(str(e))})", level="debug")

    return list((_MODELS_CACHE.get(cache_key) or {}).get("models") or [])


# 后端请求体里出现过的额外字段（透传时若客户端给了就保留）
PASSTHROUGH_BODY_KEYS = {
    "model", "messages", "tools", "tool_choice", "temperature",
    "max_tokens", "max_completion_tokens", "top_p", "stream",
    "stream_options", "stop", "presence_penalty", "frequency_penalty",
    "n", "response_format", "seed", "user", "reasoning_effort",
    "verbosity", "reasoning_summary", "chat_template_kwargs",
}

# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

CONFIG: dict = {"host": "127.0.0.1", "port": 8787, "api_key": "",
                "cred": None, "log_path": None, "log_level": "info",
                "log_payloads": False, "usage_log": None, "unsafe_expose": False,
                "desensitize": False, "wsl": False, "scan_all_users": False,
                # 流式 tool_calls 损坏防御（实验性阻塞聚合重试）：默认关闭（优先原生真流式透传，杜绝 60s/140s 超时）
                # 可通过 --repair-stream-tools 或环境变量 CODEBUDDY2OPENAI_REPAIR_STREAM_TOOLS=1 开启
                "repair_stream_tools": os.environ.get("CODEBUDDY2OPENAI_REPAIR_STREAM_TOOLS", "0").lower() in ("1", "true", "yes"),
                # 剥掉流式 delta 里的空 content:""/reasoning_content:""（GLM reasoning 周期
                # 会被 AI SDK 当成"文本开始"提前掐断，产生上百个碎片 Thought 块）。
                # 借鉴 DistPub/workbuddy2api；WORKBUDDY_STRIP_EMPTY_DELTA=0 关闭。
                "strip_empty_delta": os.environ.get("WORKBUDDY_STRIP_EMPTY_DELTA", "1") not in ("0", "false", "no"),
                # 流式推理净化与穿插解耦：实时流式下发 reasoning，并在 tool_calls 参数流中剥离混入的 reasoning
                # （避免工具参数 JSON 被截断/污染）。WORKBUDDY_COALESCE_REASONING=0 关闭。
                "coalesce_reasoning": os.environ.get("WORKBUDDY_COALESCE_REASONING", "1") not in ("0", "false", "no")}  # cred: CredentialManager | None

# 并发削峰与流量节奏平滑器
_REQUEST_PACER = RequestPacer(
    max_concurrency=int(os.environ.get("CODEBUDDY2OPENAI_MAX_CONCURRENCY", "5")),
    min_interval_ms=float(os.environ.get("CODEBUDDY2OPENAI_MIN_INTERVAL_MS", "50")),
) if RequestPacer else None

# 后台主动令牌续期任务
_TOKEN_REFRESHER: Optional[Any] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _TOKEN_REFRESHER
    if BackgroundTokenRefresher is not None:
        cred = CONFIG.get("cred")
        if cred is not None:
            _TOKEN_REFRESHER = BackgroundTokenRefresher(
                credential_manager=cred,
                check_interval_seconds=float(os.environ.get("CODEBUDDY2OPENAI_REFRESH_INTERVAL", "300")),
                threshold_seconds=float(os.environ.get("CODEBUDDY2OPENAI_REFRESH_THRESHOLD", "1800")),
            )
            _TOKEN_REFRESHER.start()
            _log("后台主动令牌续期任务已启动 (巡检间隔: 300s, 提前续期阈值: 1800s)")
    yield
    if _TOKEN_REFRESHER is not None:
        await _TOKEN_REFRESHER.stop()
        _TOKEN_REFRESHER = None
        _log("后台主动令牌续期任务已停止")


app = FastAPI(title="codebuddy2openai", version="2.0", lifespan=lifespan)


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
            if not _is_loopback_host(_extract_hostname(host_header)):
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
        r'("?(?:accessToken|refreshToken|token|api[_-]?key|password)"?\s*[:=]\s*["\']?)[^"\'\s,{}]+(["\']?)',
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


def _log_payload(msg: str):
    """记录完整请求/响应 body 或原始 SSE。
    必须显式指定 --log-payloads（或环境变量 CODEBUDDY2OPENAI_LOG_PAYLOADS=1）
    且 log_level 为 trace 时才会落盘，防止高级调试模式下将长会话 Prompt 正文写入日志文件。
    """
    if CONFIG.get("log_payloads"):
        _log(msg, level="trace")


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
                  ttft_ms=None, error=None,
                  retry_count: int = 0, retry_reason: str | None = None):
    """向 CONFIG['usage_log'] 追加一行用量统计（JSONL，append 模式，每行写完即落盘）。

    行格式：{"ts": <epoch毫秒>, "model": str, "ok": bool, "input_tokens": int|null,
             "output_tokens": int|null, "latency_ms": int, "ttft_ms": int|null,
             "error": str|null, "retry_count": int, "retry_reason": str|null}
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
            "retry_count": int(retry_count or 0),
            "retry_reason": (_truncate(str(retry_reason), 100) if retry_reason else None),
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


# ---------------------------------------------------------------------------
# 频率限制自曝端点（GET /api/rate_limit —— 上游 code 6004 冷却状态与滚动用量）
# ---------------------------------------------------------------------------

# 上游频率限制状态（仅记录真实发生的 6004 报文，不做任何推测）：
#   {model: {"code":6004, "message":…, "resetAtMs":…, "firstSeenMs":…, "lastSeenMs":…}}
_RATE_LIMIT_STATE: dict[str, dict] = {}
_RATE_LIMIT_LOCK = threading.Lock()

# 6004 报文：{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-08 22:11:33 UTC+8 重置，…"}
_RATE_LIMIT_RE = re.compile(
    r"\"code\"\s*:\s*6004.*?将在\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*UTC\+8\s*重置"
)


def _record_rate_limit(model: str, err_text: str) -> None:
    """从上游错误体里识别 6004 并记录重置时刻（幂等，同一 reset 只更新 last_seen）。"""
    m = _RATE_LIMIT_RE.search(err_text or "")
    if not m:
        return
    try:
        reset_ms = int(
            datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
            .replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
            .timestamp()
            * 1000
        )
    except Exception:
        return
    with _RATE_LIMIT_LOCK:
        prev = _RATE_LIMIT_STATE.get(model)
        entry = {
            "code": 6004,
            "message": (err_text or "")[:300],
            "resetAtMs": reset_ms,
            "resetLocal": m.group(1)[11:],
            "firstSeenMs": prev["firstSeenMs"] if prev and prev.get("resetAtMs") == reset_ms else int(time.time() * 1000),
            "lastSeenMs": int(time.time() * 1000),
        }
        _RATE_LIMIT_STATE[model] = entry


def _rolling_usage(model: str) -> dict:
    """从 usage.jsonl 统计该模型今日(UTC+8)及近 5h/24h 的成功请求与 tokens（只读本地文件）。"""
    path = CONFIG.get("usage_log")
    if not path or not os.path.exists(path):
        return {}
    now_ms = time.time() * 1000
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    now_dt = datetime.datetime.now(tz8)
    today_start_ms = now_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
    is_night_free = (now_dt.hour >= 23 or now_dt.hour < 8)

    reqs_today = tok_today = err_today = 0
    reqs5 = reqs24 = tok5 = tok24 = err5 = 0
    last429 = None
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                ts = rec.get("ts")
                if not ts or rec.get("model") != model or (now_ms - ts) > 24 * 3600 * 1000:
                    continue
                tokens = (rec.get("input_tokens") or 0) + (rec.get("output_tokens") or 0)
                if rec.get("ok"):
                    reqs24 += 1
                    tok24 += tokens
                    if (now_ms - ts) <= 5 * 3600 * 1000:
                        reqs5 += 1
                        tok5 += tokens
                    if ts >= today_start_ms:
                        reqs_today += 1
                        tok_today += tokens
                elif rec.get("error") == "HTTP 429":
                    if (now_ms - ts) <= 5 * 3600 * 1000:
                        err5 += 1
                    if ts >= today_start_ms:
                        err_today += 1
                    if last429 is None or ts > last429:
                        last429 = ts
    except Exception:
        return {}
    return {
        "reqsToday": reqs_today,
        "tokensToday": tok_today,
        "err429_today": err_today,
        "reqs5h": reqs5,
        "reqs24h": reqs24,
        "tokens5h": tok5,
        "tokens24h": tok24,
        "err429_5h": err5,
        "last429Local": time.strftime("%m-%d %H:%M:%S", time.localtime(last429 / 1000)) if last429 else None,
        "nightFree": is_night_free,
    }


@app.get("/api/rate_limit")
async def api_rate_limit():
    """各模型上游频率限制（6004）状态与滚动用量观测（只读，不消耗配额）。"""
    models: dict[str, dict] = {}
    now_ms = time.time() * 1000
    with _RATE_LIMIT_LOCK:
        snapshot = dict(_RATE_LIMIT_STATE)
    for model, e in snapshot.items():
        remaining = max(0, int((e["resetAtMs"] - now_ms) / 1000))
        # 冷却已结束的条目仅为历史痕迹：state 由 ok 细化为 expired，
        # 使消费方能区分「当前正被限 / 历史曾限过（已恢复）／从未限过（无条目）」。
        # 注意：resetLocal/message 必须保留——前端用它展示「冷却已于 X 结束」。
        models[model] = {
            "state": "limited" if remaining > 0 else "expired",
            "resetAt": datetime.datetime.fromtimestamp(
                e["resetAtMs"] / 1000, tz=datetime.timezone.utc
            ).isoformat(),
            "resetLocal": e["resetLocal"],
            "remainingSec": remaining,
            "message": e["message"],
            "lastSeenLocal": time.strftime("%m-%d %H:%M:%S", time.localtime(e["lastSeenMs"] / 1000)),
        }
    # 活跃凭据对应的账号昵称（辅助定位多账号场景）
    nickname = ""
    try:
        cred = CONFIG.get("cred")
        if cred is not None:
            session = cred.get_active_session()
            nickname = (session.get("account") or {}).get("nickname") or ""
    except Exception:
        pass

    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    now_dt = datetime.datetime.now(tz8)
    is_night_free = (now_dt.hour >= 23 or now_dt.hour < 8)

    return {
        "models": models,
        "rollingUsage": {m: _rolling_usage(m) for m in snapshot or {}},
        "nightFree": is_night_free,
        "nightWindow": {
            "active": is_night_free,
            "start": "23:00",
            "end": "08:00",
            "desc": "23:00–次日08:00 免费调用",
        },
        "nickname": nickname,
        "serverTime": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


@app.get("/v1/models")
async def list_models(authorization: Optional[str] = Header(default=None),
                     x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key")):
    _check_auth(authorization, x_api_key)
    dynamic_models = await _fetch_remote_models()
    settings = _load_model_settings()
    custom_models = list(settings.keys())
    all_models = _merge_model_ids(DEFAULT_MODELS, dynamic_models, custom_models)
    # 剔除别名行：MODEL_MAP 中映射到其他正式名的键（如 hy3 -> hy3-x）只作请求侧
    # 兼容存在，列表只上报正式名，避免同一模型出现多行。
    all_models = [m for m in all_models if MODEL_MAP.get(m, m) == m]
    data = []
    for m in all_models:
        item = {"id": m, "object": "model", "created": 1700000000, "owned_by": "codebuddy"}
        ctx = _reported_context_length(m, settings, _MODELS_WINDOWS)
        if ctx is not None:
            item["context_length"] = ctx
        data.append(item)
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
    # system+assistant 角色里的"合规声明高频词/竞争品牌词"插入零宽空格，不改用户输入。
    # （assistant 历史回复实测同样触发 11128 拦截，借鉴 DistPub/workbuddy2api）
    if CONFIG.get("desensitize"):
        body = desensitize_body(body, roles=("system", "assistant"))

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
    _log(f"[{rid}] ▶ REQUEST {model_name} | stream={client_wants_stream} | msgs={len(messages)}" + (f" | tools={tool_names}" if tool_names else ""))
    if last_user:
        _log(f"[{rid}] last_user={_truncate(last_user, 60)!r}", level="debug")
    # 完整请求体（发往后端的实际内容；若启用脱敏，这里已是脱敏后）
    _log_payload(f"[{rid}] ── REQUEST BODY (发往后端) ──\n{json.dumps(body, ensure_ascii=False, indent=2)}")

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    has_tools = bool(payload.get("tools"))
    need_tool_repair = client_wants_stream and has_tools and CONFIG.get("repair_stream_tools", True)
    pacer_ctx = _REQUEST_PACER.acquire(model_name) if _REQUEST_PACER else None

    if client_wants_stream and not need_tool_repair:
        async def _paced_stream():
            try:
                if pacer_ctx:
                    await pacer_ctx.__aenter__()
                async for chunk in _stream_upstream(url, headers, body, model_name, t0, rid):
                    yield chunk
            finally:
                if pacer_ctx:
                    await pacer_ctx.__aexit__(None, None, None)

        return StreamingResponse(
            _paced_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    if client_wants_stream and need_tool_repair:
        async def _paced_safe_stream():
            try:
                if pacer_ctx:
                    await pacer_ctx.__aenter__()
                async for chunk in _safe_stream_upstream(url, headers, body, model_name, t0, rid):
                    yield chunk
            finally:
                if pacer_ctx:
                    await pacer_ctx.__aexit__(None, None, None)

        return StreamingResponse(
            _paced_safe_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 非流式：后端只支持流式，这里把后端 SSE 聚合成单个 chat.completion 响应
    try:
        async with (pacer_ctx if pacer_ctx else asyncio.nullcontext()):
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
        # 6004 频率限制：从 detail 原始报文提取重置时刻（detail 可能是 dict 或 str）
        try:
            _dl = json.dumps(e.detail, ensure_ascii=False) if not isinstance(e.detail, str) else e.detail
            _record_rate_limit(model_name, _dl)
        except Exception:
            pass
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


@app.post("/v1/messages")
async def anthropic_messages(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="x-api-key"),
    anthropic_version: Optional[str] = Header(default=None, alias="anthropic-version"),
):
    """Anthropic Messages 协议兼容端点（支持 Claude Code CLI / Cline 等工具原生接入）。"""
    auth_key = x_api_key or authorization
    try:
        _check_auth(auth_key, auth_key)
    except HTTPException as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"type": "error", "error": {"type": "authentication_error", "message": "invalid api key"}},
        )
    cred = _cred()

    try:
        raw_body = await request.json()
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": f"bad json: {e}"}},
        )

    if translate_anthropic_request is None or translate_openai_response_to_anthropic is None:
        return JSONResponse(
            status_code=500,
            content={"type": "error", "error": {"type": "api_error", "message": "anthropic_compat module not available"}},
        )

    try:
        payload = translate_anthropic_request(raw_body)
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": str(e)}},
        )

    client_wants_stream = bool(payload.get("stream"))
    model_name = payload.get("model", "auto")
    mapped_model = MODEL_MAP.get(model_name, model_name)

    body = {k: payload[k] for k in PASSTHROUGH_BODY_KEYS if k in payload}
    body.setdefault("model", "auto")
    body["stream"] = True
    if "stream_options" not in body:
        body["stream_options"] = {"include_usage": True}

    if CONFIG.get("desensitize"):
        body = desensitize_body(body, roles=("system", "assistant"))

    body["model"] = mapped_model

    user_settings = _load_model_settings()
    custom_cfg = user_settings.get(model_name) or user_settings.get(mapped_model) or {}

    custom_effort = custom_cfg.get("reasoning_effort")
    if custom_effort:
        if custom_effort == "disable":
            body.pop("reasoning_effort", None)
            body["chat_template_kwargs"] = {"enable_thinking": False}
        else:
            body["reasoning_effort"] = custom_effort
            if "chat_template_kwargs" not in body:
                body["chat_template_kwargs"] = {"enable_thinking": True}

    custom_ctx = custom_cfg.get("context_window")
    if custom_ctx and isinstance(custom_ctx, int) and custom_ctx > 0:
        if "max_tokens" not in body:
            body["max_tokens"] = min(custom_ctx, 64000)

    rid = os.urandom(4).hex()
    _log(f"[{rid}] ▶ ANTHROPIC /v1/messages {model_name} | stream={client_wants_stream}")

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    pacer_ctx = _REQUEST_PACER.acquire(model_name) if _REQUEST_PACER else None

    if client_wants_stream:
        async def _anthropic_stream_gen():
            translator = AnthropicStreamTranslator(model=raw_body.get("model", model_name))
            upstream_gen = _stream_upstream(url, headers, body, model_name, t0, rid)
            buf = ""
            try:
                if pacer_ctx:
                    await pacer_ctx.__aenter__()
                async for chunk in upstream_gen:
                    text = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else str(chunk)
                    buf += text
                    lines = buf.split("\n")
                    buf = lines.pop()
                    for line in lines:
                        ln = line.strip()
                        if ln:
                            for ev in translator.feed_line(ln):
                                yield ev.encode("utf-8")
                if buf.strip():
                    for ev in translator.feed_line(buf.strip()):
                        yield ev.encode("utf-8")
                for ev in translator.finalize():
                    yield ev.encode("utf-8")
            finally:
                if pacer_ctx:
                    await pacer_ctx.__aexit__(None, None, None)

        return StreamingResponse(
            _anthropic_stream_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 非流式
    try:
        async with (pacer_ctx if pacer_ctx else asyncio.nullcontext()):
            async with httpx.AsyncClient(timeout=300) as c:
                async with c.stream("POST", url, headers=headers, json=body) as r:
                    if r.status_code != 200:
                        raw = await r.aread()
                        _log(f"[{rid}] ✗ HTTP {r.status_code} | {model_name} | {_truncate(raw.decode('utf-8','replace'),200)}")
                        _record_usage(model_name, False, t0, error=f"HTTP {r.status_code}")
                        _record_rate_limit(model_name, raw.decode("utf-8", "replace"))
                        raise HTTPException(
                            status_code=r.status_code,
                            detail={"type": "error", "error": {"type": "api_error", "message": raw.decode("utf-8", "replace")[:500]}},
                        )
                    collected, ttft_ms = await _collect_stream(r, t0)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        _log(f"[{rid}] ✗ 网络错误 | {model_name} | {e}")
        _record_usage(model_name, False, t0, error=f"upstream error: {e}")
        raise HTTPException(
            status_code=502,
            detail={"type": "error", "error": {"type": "api_error", "message": f"upstream error: {e}"}},
        )
    except Exception as e:
        _record_usage(model_name, False, t0, error=f"{type(e).__name__}: {e}")
        raise

    _log_finish(model_name, t0, collected, rid)
    _u = collected.get("usage") or {}
    _record_usage(model_name, True, t0,
                  input_tokens=_u.get("prompt_tokens"),
                  output_tokens=_u.get("completion_tokens"),
                  ttft_ms=ttft_ms)

    anthropic_resp = translate_openai_response_to_anthropic(collected)
    if "model" in raw_body:
        anthropic_resp["model"] = raw_body["model"]
    return JSONResponse(content=anthropic_resp)


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
    _log_payload(f"{prefix}── RESPONSE BODY ──\n{json.dumps(result, ensure_ascii=False, indent=2)}")


async def _collect_stream(response: httpx.Response, t0: float = 0.0) -> tuple[dict, int | None]:
    """消费后端的 OpenAI SSE 流，聚合成单个非流式 chat.completion 对象。

    合并所有 chunk 的 delta（content / reasoning_content / tool_calls），并取 usage / finish_reason。
    返回 (聚合结果, ttft_ms)：ttft_ms 为首个含内容或推理 delta 到达时刻距 t0 的毫秒数
    （t0 为 0 或全程无内容时为 None），供用量统计复用。
    """
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
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
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoning:
                if ttft_ms is None and t0:
                    ttft_ms = int((time.time() - t0) * 1000)
                reasoning_parts.append(reasoning)
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
    if reasoning_parts:
        message["reasoning_content"] = "".join(reasoning_parts)
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


def _validate_tool_calls(tool_calls: list[dict] | None) -> tuple[bool, str]:
    """校验聚合后的 tool_calls 是否完整无损。返回 (is_valid, error_reason)。"""
    if not tool_calls:
        return True, ""
    for i, tc in enumerate(tool_calls):
        if not isinstance(tc, dict):
            return False, f"tool_calls[{i}] 不是 dict"
        fn = tc.get("function") or {}
        name = fn.get("name")
        if not name or not str(name).strip():
            return False, f"tool_calls[{i}].name 为空或缺失"
        args = fn.get("arguments", "")
        # 腾讯后端流式损坏典型表现：空字符串或乱码分片导致的残缺 JSON
        if args is not None and str(args).strip():
            try:
                json.loads(args)
            except Exception as exc:
                return False, f"tool_calls[{i}].arguments 不是有效 JSON ({exc}): {args[:100]!r}"
    return True, ""


async def _pseudo_stream_response(collected: dict, model_name: str = "?", t0: float = 0.0,
                                  rid: str = "", ttft_ms: int | None = None,
                                  retry_count: int = 0, retry_reason: str | None = None):
    """将聚合校验后的完整响应转换为标准 OpenAI SSE 流，供客户端消费。"""
    cid = collected.get("id") or ("chatcmpl-" + os.urandom(12).hex())
    created = collected.get("created") or int(time.time())
    model = collected.get("model") or model_name
    choices = collected.get("choices") or []
    choice = choices[0] if choices else {}
    msg = choice.get("message") or {}
    role = msg.get("role", "assistant")
    content = msg.get("content")
    reasoning = msg.get("reasoning_content") or msg.get("reasoning")
    tool_calls = msg.get("tool_calls")
    finish_reason = choice.get("finish_reason") or ("tool_calls" if tool_calls else "stop")
    usage = collected.get("usage")

    chunk_size = 32

    def _chunk(delta: dict) -> bytes:
        """构造一个标准 OpenAI SSE chunk（finish_reason 恒为 None）。"""
        payload = {
            "id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        }
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")

    # role 只在首个实际下发的 chunk 中出现一次（不管理由是 reasoning/content/tool_calls）
    role_sent = False

    def _with_role(delta: dict) -> dict:
        nonlocal role_sent
        if not role_sent:
            role_sent = True
            return {"role": role, **delta}
        return delta

    # 1. 思考过程（reasoning_content）—— 独立字段下发，绝不并入 content
    if reasoning:
        for j in range(0, len(reasoning), chunk_size):
            yield _chunk(_with_role({"reasoning_content": reasoning[j:j + chunk_size]}))

    # 2. 正文内容（content）—— 与 reasoning / tool_calls 完全独立，不再互斥
    if content:
        for j in range(0, len(content), chunk_size):
            yield _chunk(_with_role({"content": content[j:j + chunk_size]}))

    # 3. 工具调用（tool_calls）—— 首包带出结构，再切片输出 arguments
    if tool_calls:
        for idx, tc in enumerate(tool_calls):
            fn = tc.get("function") or {}
            first_chunk = {
                "id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{
                    "index": 0,
                    "delta": _with_role({
                        "tool_calls": [{
                            "index": idx,
                            "id": tc.get("id"),
                            "type": tc.get("type", "function"),
                            "function": {"name": fn.get("name"), "arguments": ""},
                        }],
                    }),
                    "finish_reason": None,
                }],
            }
            yield f"data: {json.dumps(first_chunk, ensure_ascii=False)}\n\n".encode("utf-8")

            # 切片输出 arguments，让客户端体验如同原生流式
            raw_args = fn.get("arguments") or ""
            for j in range(0, len(raw_args), chunk_size):
                yield _chunk({"tool_calls": [{"index": idx,
                                              "function": {"arguments": raw_args[j:j + chunk_size]}}]})

    # 4. 尾包：包含 finish_reason 与可选的 usage
    end_chunk = {
        "id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
    }
    if usage:
        end_chunk["usage"] = usage
    yield f"data: {json.dumps(end_chunk, ensure_ascii=False)}\n\n".encode("utf-8")
    yield b"data: [DONE]\n\n"

    # 日志与用量统计
    _log_finish(model_name, t0, collected, rid)
    _u = usage or {}
    _record_usage(model_name, True, t0,
                  input_tokens=_u.get("prompt_tokens"),
                  output_tokens=_u.get("completion_tokens"),
                  ttft_ms=ttft_ms,
                  retry_count=retry_count,
                  retry_reason=retry_reason)


async def _safe_stream_upstream(url: str, headers: dict, body: dict,
                                model_name: str = "?", t0: float = 0.0, rid: str = ""):
    """针对带 tools 的流式请求，进行聚合校验与防损坏重试，再伪流式下发。

    解决上游 Issue #3：腾讯后端（copilot.tencent.com）在流式返回 tool_calls 时偶发
    function.name 为空或 arguments 乱码分片，导致 Claude Code / Codex 等 Agent 陷入死循环。
    """
    prefix = f"[{rid}] " if rid else ""
    max_attempts = 2
    collected = None
    ttft_ms = None
    retry_count = 0
    retry_reason = None

    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=300) as c:
                async with c.stream("POST", url, headers=headers, json=body) as r:
                    if r.status_code != 200:
                        raw = await r.aread()
                        _log(f"{prefix}✗ HTTP {r.status_code} | {model_name} | {_truncate(raw.decode('utf-8','replace'),200)}")
                        _record_usage(model_name, False, t0, error=f"HTTP {r.status_code}",
                                      retry_count=retry_count, retry_reason=retry_reason)
                        yield _err_event(raw, r.status_code)
                        return
                    # 聚合等待期间定期下发 SSE 注释保活心跳，防止中间代理或客户端 60s 静默超时
                    collect_task = asyncio.create_task(_collect_stream(r, t0))
                    while not collect_task.done():
                        done, _ = await asyncio.wait({collect_task}, timeout=5.0)
                        if not done:
                            yield b": ping\n\n"
                    collected, ttft_ms = await collect_task
        except httpx.HTTPError as e:
            _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
            _record_usage(model_name, False, t0, error=f"upstream error: {e}",
                          retry_count=retry_count, retry_reason=retry_reason)
            yield _err_event(str(e).encode(), 502)
            return

        choice = (collected.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        tool_calls = msg.get("tool_calls") or []

        # 校验 tool_calls 完整性
        valid, reason = _validate_tool_calls(tool_calls)
        if valid or attempt >= max_attempts:
            if not valid:
                _log(f"{prefix}⚠️ tool_calls 校验未通过 ({reason})，已达最大重试次数，尝试原样下发")
                retry_reason = reason
            elif attempt > 1:
                _log(f"{prefix}✅ tool_calls 重试成功修复 (attempt {attempt})")
            break

        retry_count += 1
        retry_reason = reason
        _log(f"{prefix}⚠️ 检测到腾讯后端流式 tool_calls 损坏 ({reason})，自动重试 ({attempt}/{max_attempts})...")
        await asyncio.sleep(0.5)

    if collected is None:
        yield _err_event(b'{"error":{"message":"tool_calls aggregate failed","type":"upstream_error"}}', 502)
        return

    # 伪流式输出
    async for chunk in _pseudo_stream_response(collected, model_name, t0, rid, ttft_ms,
                                              retry_count=retry_count, retry_reason=retry_reason):
        yield chunk


def _safe_err_raw(raw: bytes, status: int) -> dict:
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {"error": {"message": raw.decode("utf-8", "replace")[:500], "type": "upstream_error", "code": status}}


# ---------------------------------------------------------------------------
# 流式 delta 净化与 reasoning 合并（借鉴 DistPub/workbuddy2api，MIT License）
# strip_empty_delta：剥掉 SSE delta 里的空 content/"" 与空 reasoning_content/""，
#   避免 AI SDK 把空 content 误判为「文本已开始」而产生大量碎片 Thought 块。
# coalesce_reasoning：把零散 reasoning 分片合并为一段，在首个推进对话的 delta
#   （content/tool_calls/finish）之前整段释放，并从 tool_calls 参数流里剥离混入的
#   reasoning，避免工具参数 JSON 被截断/污染。
# 两者均可通过 CONFIG 环境变量关闭（WORKBUDDY_STRIP_EMPTY_DELTA=0 / WORKBUDDY_COALESCE_REASONING=0）。
# ---------------------------------------------------------------------------

_EMPTY_DELTA_KEYS = ("content", "reasoning_content")


def _is_empty_delta_content(value: str) -> bool:
    return value is None or (isinstance(value, str) and value == "")


def _sanitize_delta_obj(obj: Any) -> tuple[bool, Any]:
    """尝试清洗 SSE data JSON；返回 (changed, new_obj)。

    - 若不是 Chat delta 形状（choices/delta 都在），原样返回 (False, obj)
    - 清洗规则：遍历每个 choice.delta
        * 若 content == "" 且 reasoning_content 非空 → 删 content
        * 若 content == "" 且 reasoning_content 也空 → 整个 delta 若仍含
          tool_calls/role 等"非空"字段就保留，但若 delta 完全空（只两个空字段）→ 整 choice 删
        * reasoning_content == "" 同样处理
    """
    if not isinstance(obj, dict):
        return False, obj
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return False, obj
    changed = False
    new_choices: list = []
    for ch in choices:
        if not isinstance(ch, dict):
            new_choices.append(ch)
            continue
        delta = ch.get("delta")
        if not isinstance(delta, dict):
            new_choices.append(ch)
            continue

        # 复制 delta 用于清洗
        new_delta = dict(delta)
        delta_changed = False

        for k in _EMPTY_DELTA_KEYS:
            if k not in new_delta:
                continue  # 键不存在≠空串：纯 reasoning delta 没有 content 键，不能因此删帧
            v = new_delta[k]
            if _is_empty_delta_content(v):
                # 仅当存在"非空兄弟字段"时删除这个空字段；
                # 若 delta 里只有这一个空字段，则把整个 choice 也丢掉
                if len(new_delta) == 1:
                    delta = None  # 标记整 choice 删除
                    delta_changed = True
                    break
                if k in new_delta:
                    del new_delta[k]
                    delta_changed = True

        if delta is None:
            # 整个 choice 没有任何有效 delta 字段
            # 但若 choice 仍带 finish_reason（典型收尾 chunk），就保留 finish_reason
            if ch.get("finish_reason"):
                new_choices.append({"index": ch.get("index", 0),
                                    "delta": {},
                                    "finish_reason": ch["finish_reason"]})
                changed = True
            else:
                # 整 choice 丢弃
                changed = True
                continue
        elif delta_changed:
            new_ch = dict(ch)
            new_ch["delta"] = new_delta
            new_choices.append(new_ch)
            changed = True
        else:
            new_choices.append(ch)

    if not changed:
        return False, obj
    new_obj = dict(obj)
    new_obj["choices"] = new_choices
    return True, new_obj


def _sanitize_sse_data(data: str) -> str:
    """清洗单个 SSE data 行（去掉 'data:' 前缀后的 payload）。
    非 JSON / 非 Chat delta 形状 → 原样返回。
    """
    if data == "[DONE]":
        return data
    try:
        obj = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return data
    changed, new_obj = _sanitize_delta_obj(obj)
    if not changed:
        return data
    # ensure_ascii=False 保留中文，separators 紧凑减少字节
    return json.dumps(new_obj, ensure_ascii=False, separators=(",", ":"))


def _maybe_sanitize_line(line: str) -> str:
    """对单条 SSE 行做"按行"清洗：保留 event:/id:/retry: 等控制行；
    data: 行解析 payload 并清洗后重新拼回 data: 前缀。
    关闭时（CONFIG['strip_empty_delta'] = False）原样返回。
    """
    if not CONFIG.get("strip_empty_delta"):
        return line
    if not line or not line.startswith("data:"):
        return line
    payload = line[5:].lstrip()
    if not payload or payload == "[DONE]":
        return line
    try:
        obj = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return line
    _, new_obj = _sanitize_delta_obj(obj)
    if obj is new_obj:
        return line
    return "data: " + json.dumps(new_obj, ensure_ascii=False, separators=(",", ":"))


def _reasoning_text(obj: Any) -> str:
    """从 SSE data JSON 里取第一个 choice.delta 的 reasoning_content（若有）。"""
    try:
        ch = (obj.get("choices") or [{}])[0]
        delta = ch.get("delta") or {}
        r = delta.get("reasoning_content")
        return r if isinstance(r, str) else ""
    except Exception:
        return ""


def _has_non_reasoning_delta(obj: Any) -> bool:
    """该 SSE data 是否携带"会推进对话/工具"的可见内容（content / tool_calls /
    finish_reason / error）。纯 reasoning（或只有 role 收尾）不算。
    """
    if not isinstance(obj, dict):
        return True
    if obj.get("error"):
        return True
    try:
        ch = (obj.get("choices") or [{}])[0]
    except Exception:
        return True
    if not isinstance(ch, dict):
        return True
    delta = ch.get("delta") or {}
    if not isinstance(delta, dict):
        return True
    if ch.get("finish_reason"):
        return True
    # 只要 delta 里出现非空 content / tool_calls，就算"可见推进"
    c = delta.get("content")
    if isinstance(c, str) and c:
        return True
    if delta.get("tool_calls"):
        return True
    if delta.get("refusal"):
        return True
    return False


def _remove_reasoning_from_delta(obj: Any) -> Any:
    """把某个推进 delta 里夹带的 reasoning_content 整段剥掉，返回新对象。

    用于 content 起笔帧或 tool_calls 帧与 reasoning 同帧的情形：推理 token 若混在
    tool_calls 的 arguments 里会让参数 JSON 截断/坏掉；若混在 content 起笔帧里会让
    客户端误判"文本已开始"而提前结束 Thought 周期。剥走后，调用方负责把这段
    reasoning 单独以纯 reasoning delta 释放。无 reasoning 时原样返回同一对象。
    """
    if not isinstance(obj, dict):
        return obj
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return obj
    changed = False
    new_choices: list = []
    for ch in choices:
        if not isinstance(ch, dict):
            new_choices.append(ch)
            continue
        delta = ch.get("delta")
        if not isinstance(delta, dict):
            new_choices.append(ch)
            continue
        rc = delta.get("reasoning_content")
        if not isinstance(rc, str) or not rc:
            new_choices.append(ch)
            continue
        new_delta = dict(delta)
        new_delta.pop("reasoning_content", None)
        new_ch = dict(ch)
        new_ch["delta"] = new_delta
        new_choices.append(new_ch)
        changed = True
    if not changed:
        return obj
    new_obj = dict(obj)
    new_obj["choices"] = new_choices
    return new_obj


def _encode_sse_chunk(obj: Any) -> bytes:
    return b"data: " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n\n"


def _parse_sse_data_objects(evt: bytes) -> list[Any]:
    """把一个完整 SSE 帧（可能含多行 data:）解析成 payload 对象列表。非 data 行忽略。"""
    out: list[Any] = []
    for ln in evt.split(b"\n"):
        s = ln.lstrip()
        if not s.startswith(b"data:"):
            continue
        payload = s[5:].strip()
        if not payload or payload in (b"[DONE]", b"[done]"):
            out.append(None)  # 占位表示 [DONE]
            continue
        try:
            out.append(json.loads(payload))
        except (json.JSONDecodeError, ValueError):
            # 无法解析的数据行原样透传，不参与合并（交给客户端容错）
            out.append(payload)
    return out


class _ReasoningCoalescer:
    """网关层"流式推理净化与穿插解耦器"：
    1. 纯 reasoning 分片实时流式转发给客户端，杜绝静默积压导致的 60s/140s 超时；
    2. 当 reasoning 与 content 起笔帧或 tool_calls 帧混合时，实时拆解：优先下发
       独立的 reasoning 纯帧，并从推进帧（如工具调用）中剥离混入的 reasoning，
       避免工具参数 JSON 损坏或客户端 Thought 块错乱。
    """

    __slots__ = ()

    def __init__(self) -> None:
        pass

    def _flush_reasoning(self) -> list[bytes]:
        return []

    def feed(self, evt: bytes) -> list[bytes]:
        if not evt:
            return []
        if not CONFIG.get("coalesce_reasoning"):
            # 关闭：原样透传（不重组、不剥离）
            return [evt]

        objs = _parse_sse_data_objects(evt)
        if not objs:
            return [evt]

        merged: list[bytes] = []
        for o in objs:
            if o is None:
                # [DONE]：原样放 [DONE]
                merged.append(b"data: [DONE]\n\n")
                continue
            if not isinstance(o, dict):
                merged.append(evt)
                continue

            rc = _reasoning_text(o)                 # 本 delta 的 reasoning（若有）
            advancing = _has_non_reasoning_delta(o)  # 是否带 content/tool_calls/finish

            # 1. 纯 reasoning（不带推进内容）→ 实时流式下发，杜绝静默阻塞！
            if rc and not advancing:
                merged.append(_encode_sse_chunk(o))
                continue

            # 2. 推进内容到来（content / tool_calls / finish 等）
            if advancing:
                if rc:
                    # 若该推进 delta 自身夹带 reasoning（如与 tool_calls 同帧）：
                    # 先下发纯 reasoning 独立分片，再将 reasoning 从推进帧剥离后下发，
                    # 避免工具 arguments JSON 被思考文本破坏。
                    split_rc = {"choices": [{"index": 0, "delta": {"reasoning_content": rc}}]}
                    merged.append(_encode_sse_chunk(split_rc))
                    o = _remove_reasoning_from_delta(o)
                merged.append(_encode_sse_chunk(o))
                continue

            # 3. 其余（role: "assistant" 等标记帧）原样转发保持帧完整
            merged.append(_encode_sse_chunk(o))
        return merged

    def flush(self) -> list[bytes]:
        return []


class _SseLineBuffer:
    """字节级 SSE 行缓冲解析器。

    上游可能把一行 SSE 拆到多个 TCP chunk 里发（GLM 流经常出现），所以不能
    假设每次 aiter_bytes 拿到的是完整行。每调一次 feed(chunk) 就把内部
    缓冲里能切的完整行（以 \n 分隔）切出来，返回行列表（不含换行符）。
    """

    __slots__ = ("_buf",)

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        if not chunk:
            return []
        self._buf.extend(chunk)
        out: list[bytes] = []
        while True:
            idx = self._buf.find(b"\n")
            if idx < 0:
                break
            line = bytes(self._buf[:idx])
            del self._buf[:idx + 1]
            if line.endswith(b"\r"):
                line = line[:-1]
            out.append(line)
        return out

    def flush(self) -> list[bytes]:
        if not self._buf:
            return []
        line = bytes(self._buf)
        self._buf.clear()
        if line.endswith(b"\r"):
            line = line[:-1]
        return [line]


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
    forwarded_parts: list[bytes] = []  # 累积清洗后实际转发给客户端的 SSE
    prefix = f"[{rid}] " if rid else ""
    coal = _ReasoningCoalescer()
    line_buf = _SseLineBuffer()

    def _record_event_stats(cleaned: bytes):
        """从清洗后的 SSE 事件里解析统计信息（usage/finish/tool_names/审核拦截）。"""
        nonlocal finish_reason, saw_filter, ttft_ms
        text_repr = cleaned.decode("utf-8", "replace")
        if "content-filter" in text_repr or "敏感" in text_repr or "审核" in text_repr:
            saw_filter = True
        for ln in cleaned.split(b"\n"):
            s = ln.lstrip()
            if not s.startswith(b"data:"):
                continue
            d = s[5:].lstrip()
            if d == b"[DONE]":
                continue
            try:
                obj = json.loads(d)
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

    def _feed_and_coalesce(chunk: bytes):
        """字节 chunk → 行缓冲 → 完整事件清洗 → reasoning 合并 → (转发事件列表)。"""
        nonlocal buf
        for line in line_buf.feed(chunk):
            buf += line + b"\n"
        # buf 现在累积了完整行；按空行切完整 SSE 事件
        events = []
        while b"\n\n" in buf:
            evt, buf = buf.split(b"\n\n", 1)
            events.append(evt)
        out: list[bytes] = []
        for evt in events:
            cleaned_lines = []
            for ln in evt.split(b"\n"):
                cleaned_lines.append(_maybe_sanitize_line(ln.decode("utf-8", "replace")))
            cleaned = ("\n".join(cleaned_lines) + "\n\n").encode("utf-8")
            _record_event_stats(cleaned)
            forwarded_parts.append(cleaned)
            out += coal.feed(cleaned)
        return out

    try:
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    _log(f"{prefix}✗ HTTP {r.status_code} | {model_name} | {_truncate(err.decode('utf-8','replace'),200)}")
                    _log(f"{prefix}── ERROR BODY ──\n{err.decode('utf-8','replace')}", level="debug")
                    # 上游错误：先记一条失败统计（tokens 未知填 null）再返回错误事件
                    _record_usage(model_name, False, t0, error=f"HTTP {r.status_code}")
                    # 6004 频率限制：记录重置时刻，供 /api/rate_limit 自曝
                    _record_rate_limit(model_name, err.decode("utf-8", "replace"))
                    yield _err_event(err, r.status_code)
                    return
                async for chunk in r.aiter_bytes():
                    if chunk:
                        raw_parts.append(chunk)
                        # 空段清洗 + reasoning 合并后转发（借鉴 DistPub/workbuddy2api）
                        for evt in _feed_and_coalesce(chunk):
                            yield evt
                # 流尾兜底：残余行与残余 reasoning
                for evt in coal.flush():
                    yield evt
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
    _log_payload(f"{prefix}── RESPONSE RAW SSE ──\n{b''.join(raw_parts).decode('utf-8','replace')}")
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

# ---------------------------------------------------------------------------
# 每日签到（手动按钮触发；借鉴 xiaofan6ya/workbuddy2api，MIT License）
#
# 用户拍板（2026-09-08）：不做自动定时签到，GUI 放"签到"按钮手动点击。
# 端点（逆向自 WorkBuddy 桌面端 main/tar.js）：
#   POST /v2/billing/meter/checkin-activity-status —— 活动状态
#   POST /v2/billing/meter/daily-checkin           —— 领取（每日 100 积分）
# 业务码：1001=今日已领 1002=无资格 1003=活动已结束。
# 风控要点：请求经 CredentialManager 注入 X-Device-Token，与桌面端一致。
# ---------------------------------------------------------------------------

_CHECKIN_STATUS_URL = f"{BACKEND}/v2/billing/meter/checkin-activity-status"
_CHECKIN_CLAIM_URL = f"{BACKEND}/v2/billing/meter/daily-checkin"

_CHECKIN_CODE_MAP = {
    1001: "already_claimed",     # 逆向文档口径
    10001: "already_claimed",    # 实测：已签到时上游返回 HTTP 400 + code 10001
    1002: "not_eligible",
    1003: "event_ended",
}


def _checkin_post(url: str, headers: dict) -> dict:
    """同步 POST 签到端点，返回后端 JSON（失败抛 RuntimeError）。

    实测：今日已签到时上游返回 HTTP 400 + {"code":10001,"msg":"今天已签到，请明天再来"}。
    该情形是可预期的业务态而非错误，返回错误体交由调用方按 code 归一处理。
    """
    with httpx.Client(timeout=15) as c:
        r = c.post(url, headers=headers, json={})
    if r.status_code == 200:
        return r.json()
    try:
        err_body = r.json()
    except Exception:
        raise RuntimeError(f"HTTP {r.status_code}")
    code = err_body.get("code")
    if code in _CHECKIN_CODE_MAP:
        return err_body  # 业务码错误体（如已签到），交由调用方归一
    raise RuntimeError(f"HTTP {r.status_code}: {err_body.get('msg') or ''}")


def _get_checkin_cred() -> CredentialManager:
    cred = CONFIG.get("cred")
    if cred is not None:
        return cred
    path = find_auth_file()
    if not path:
        raise RuntimeError("未找到登录凭据（请先在桌面端登录）")
    return CredentialManager(path)


@app.get("/api/checkin/status")
async def checkin_status(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    """查询签到活动状态（today_checked_in / active / end_time 等）。"""
    _check_auth(authorization, x_api_key)
    try:
        cred = _get_checkin_cred()
        headers = cred.get_headers()
        body = _checkin_post(_CHECKIN_STATUS_URL, headers)
    except Exception as e:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    if body.get("code") not in (0, None):
        return {"ok": False, "error": body.get("msg") or body}
    return {"ok": True, "data": body.get("data") or {}}


@app.post("/api/checkin/claim")
async def checkin_claim(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    """执行每日签到领取（GUI 按钮手动触发；成功返回 credit / streak_days）。"""
    _check_auth(authorization, x_api_key)
    try:
        cred = _get_checkin_cred()
        headers = cred.get_headers()
        # 先查活动状态：今日已签到则不再发领取请求（幂等 + 减少无效风控暴露）
        st_body = _checkin_post(_CHECKIN_STATUS_URL, headers)
        st = (st_body.get("data") or {}) if st_body.get("code") in (0, None) else {}
        if st.get("today_checked_in"):
            return {
                "ok": False,
                "status": "already_claimed",
                "msg": "今天已签到，请明天再来",
                "credit": st.get("today_credit") or 0,
                "streak_days": st.get("streak_days") or 0,
                "activity": {"active": st.get("active"), "end_time": st.get("end_time")},
            }
        body = _checkin_post(_CHECKIN_CLAIM_URL, headers)
    except Exception as e:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    code = body.get("code")
    if code and code != 0:
        payload = body.get("data") or {}
        return {
            "ok": False,
            "code": code,
            "status": _CHECKIN_CODE_MAP.get(code, "unknown"),
            "msg": body.get("msg") or "",
            "credit": payload.get("credit") or 0,
            "streak_days": payload.get("streak_days") or 0,
        }
    payload = body.get("data") or {}
    return {
        "ok": True,
        "credit": payload.get("credit") or 0,
        "streak_days": payload.get("streak_days") or 0,
    }


def preflight() -> bool:
    af = find_auth_file()
    sys.stderr.write("==== 预检 ====\n")
    sys.stderr.write(f"平台      : {sys.platform}\n")
    sys.stderr.write(f"Python    : {sys.version.split()[0]}\n")
    sys.stderr.write(f"后端      : {BACKEND} (直连，原生 function calling)\n")
    sys.stderr.write(f"登录文件  : {af or '(未找到 .info，将以 accounts.json 为真源)'}\n")
    if auth_dirs():
        sys.stderr.write(f"已查目录  : {', '.join(str(d) for d in auth_dirs())}\n")
    ok = True
    try:
        # 无 .info 时仍尝试以 accounts.json 为真源读取活跃会话（多账号体系为唯一真源）
        cm = CredentialManager(af)
        info = cm.summary()
        sys.stderr.write(f"账号      : {info.get('nickname')} / {info.get('enterpriseName')}\n")
        sys.stderr.write(f"token过期 : {'是(将自动刷新)' if info['token_expired'] else '否'}\n")
    except Exception as e:
        sys.stderr.write("\n[警告] 未找到可用登录凭据。请在桌面端完成登录（CodeBuddy/WorkBuddy）。\n")
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
    ap.add_argument("--log-payloads", action="store_true",
                    help="在 trace 日志级别下，额外将完整请求体（含 prompt）、响应体及原始 SSE 落盘。"
                         "默认关闭以避免长会话 Prompt 正文写入日志文件。可通过 CODEBUDDY2OPENAI_LOG_PAYLOADS=1 开启。")
    ap.add_argument("--usage-log", default=None, metavar="PATH",
                    help="开启用量统计：每个聊天请求（流式/非流式）完成后向该文件追加一行 JSONL"
                         "（ts/model/ok/input_tokens/output_tokens/latency_ms/ttft_ms/error/retry_count/retry_reason）。"
                         "不传则不记录。")
    ap.add_argument("--desensitize", action="store_true",
                    help="启用脱敏：对 system 消息里的合规模板敏感词（DoS/exploit/credential 等）"
                         "插入零宽空格，缓解被后端内容审核误拦。默认关闭。")
    ap.add_argument("--wsl", action="store_true",
                    help="显式开启 WSL 模式：穿透读取 Windows 宿主系统的登录凭据与 accounts.json"
                         "（在 WSL 环境下通常自动检测生效，此开关用于显式开启）。")
    ap.add_argument("--scan-all-users", action="store_true",
                    help="在 WSL 模式下，遍历 /mnt/c/Users 下全部 Windows 用户目录以寻找 CodeBuddy 凭据。"
                         "默认关闭（仅匹配与当前 Linux 用户同名的 Windows 用户），避免多用户机器上的跨用户凭据误读。")
    ap.add_argument("--repair-stream-tools", action="store_true", default=None,
                    help="启用流式 tool_calls 损坏防御（实验性阻塞聚合重试）：针对腾讯后端在流式输出下偶发"
                         " function.name 为空或 arguments 乱码的问题，在请求含 tools 时进行聚合校验与自动重试。"
                         "注意：长思考或大输出模型可能导致首字延迟增加。默认关闭（原生真流式直通）。")
    ap.add_argument("--no-repair-stream-tools", action="store_false", dest="repair_stream_tools",
                    help="禁用流式 tool_calls 损坏防御，强制全量原始 SSE 直通。")
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
    CONFIG["wsl"] = args.wsl
    CONFIG["scan_all_users"] = args.scan_all_users or os.environ.get("CODEBUDDY2OPENAI_SCAN_ALL_USERS", "").lower() in ("1", "true", "yes")
    if args.repair_stream_tools is not None:
        CONFIG["repair_stream_tools"] = args.repair_stream_tools
    else:
        CONFIG["repair_stream_tools"] = os.environ.get("CODEBUDDY2OPENAI_REPAIR_STREAM_TOOLS", "0").lower() in ("1", "true", "yes")
    CONFIG["log_path"] = args.log if args.log else os.environ.get("CODEBUDDY2OPENAI_LOG")
    CONFIG["log_level"] = args.log_level
    CONFIG["log_payloads"] = args.log_payloads or os.environ.get("CODEBUDDY2OPENAI_LOG_PAYLOADS", "").lower() in ("1", "true", "yes")
    CONFIG["usage_log"] = args.usage_log if args.usage_log else os.environ.get("CODEBUDDY2OPENAI_USAGE_LOG")
    init_cred()

    if not args.skip_check:
        preflight()

    sys.stderr.write(f"\n✅ 监听 http://{args.host}:{args.port}（直连后端，原生 function calling）\n")
    sys.stderr.write("   GET  /v1/models\n")
    sys.stderr.write("   POST /v1/chat/completions   (原生 tools/tool_calls，支持流式)\n")
    sys.stderr.write("   POST /v1/messages           (Anthropic Messages 协议，支持 Claude Code 等)\n")
    sys.stderr.write("   GET  /health\n")
    sys.stderr.write("   GET  /api/usage_summary     (当前账号积分概览，Hermes 配额看板数据源)\n")
    sys.stderr.write("   GET  /api/rate_limit        (上游频率限制 6004 状态与滚动用量，Hermes 配额看板数据源)\n")
    if args.api_key:
        sys.stderr.write("   鉴权已启用（API key 已设置）\n")
    elif not _is_loopback_host(args.host) and args.unsafe_expose:
        sys.stderr.write("   ⚠️ 警告：非回环暴露且无鉴权 (--unsafe-expose)\n")
    if CONFIG["log_path"]:
        payload_flag = "已开启 (--log-payloads)" if CONFIG["log_payloads"] else "已禁用 (需 --log-payloads)"
        sys.stderr.write(f"   日志      : {CONFIG['log_path']} (级别: {CONFIG['log_level']} | Payload 落盘: {payload_flag})\n")
    if args.wsl:
        scan_mode = "全用户扫描 (--scan-all-users)" if CONFIG["scan_all_users"] else "仅当前用户"
        sys.stderr.write(f"   WSL模式   : 已显式启用（穿透宿主 Windows 凭据目录 | {scan_mode}）\n")
    if CONFIG["usage_log"]:
        sys.stderr.write(f"   用量统计  : {CONFIG['usage_log']}\n")
    if args.desensitize:
        sys.stderr.write("   脱敏      : 已启用（system 合规词零宽处理）\n")
    if args.wsl:
        sys.stderr.write("   WSL模式   : 已显式启用（穿透宿主 Windows 凭据目录）\n")
    if CONFIG.get("repair_stream_tools"):
        sys.stderr.write("   工具防御  : 已显式启用（阻塞聚合校验重试模式）\n")
    else:
        sys.stderr.write("   流式管线  : 原生真流式直通（实时下发推理与工具调用）\n")
    sys.stderr.write("按 Ctrl+C 退出。\n\n")

    # 启动时写一条标记
    _log(f"==== converter 启动 ====")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
