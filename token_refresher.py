"""
token_refresher.py - 后台主动令牌续期器

定时巡检当前活跃凭据过期时间，当 expiresAt 或 refreshExpiresAt 临近过期时，
主动异步触发刷新，避免用户调用时产生被动等待延迟。
"""

import asyncio
import inspect
import logging
import time
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("workbuddy2api.token_refresher")


class BackgroundTokenRefresher:
    """后台主动令牌续期器。

    支持后台定时巡检、提前续期触发、防重入互斥、异常退避重试及优雅退出。
    """

    def __init__(
        self,
        credential_manager: Any = None,
        refresh_callback: Optional[Callable[[], Any]] = None,
        get_session_callback: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        check_interval_seconds: float = 300.0,
        threshold_seconds: float = 1800.0,
        logger: Optional[logging.Logger] = None,
        base_retry_seconds: float = 5.0,
        max_retry_seconds: float = 60.0,
    ):
        if credential_manager is None and refresh_callback is None and get_session_callback is None:
            raise ValueError("Must provide at least credential_manager or refresh_callback")

        self._credential_manager = credential_manager
        self._refresh_callback = refresh_callback
        self._get_session_callback = get_session_callback
        self._check_interval_seconds = float(check_interval_seconds)
        self._threshold_seconds = float(threshold_seconds)
        self.logger = logger or logging.getLogger("workbuddy2api.token_refresher")
        self._base_retry_seconds = float(base_retry_seconds)
        self._max_retry_seconds = float(max_retry_seconds)

        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._refresh_lock = asyncio.Lock()

        self._refresh_count: int = 0
        self._fail_count: int = 0
        self._last_refresh_time: Optional[float] = None

    @property
    def check_interval_seconds(self) -> float:
        return self._check_interval_seconds

    @property
    def threshold_seconds(self) -> float:
        return self._threshold_seconds

    @property
    def refresh_count(self) -> int:
        return self._refresh_count

    @property
    def fail_count(self) -> int:
        return self._fail_count

    @property
    def last_refresh_time(self) -> Optional[float]:
        return self._last_refresh_time

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def get_session(self) -> Optional[Dict[str, Any]]:
        """获取当前活跃会话字典。"""
        try:
            if self._get_session_callback is not None:
                return self._get_session_callback()
            if self._credential_manager is not None:
                # 优先尝试只读查看（避免触发同步网络刷新）
                if hasattr(self._credential_manager, "peek_active_session"):
                    sess = self._credential_manager.peek_active_session()
                    if isinstance(sess, dict):
                        return sess
                if hasattr(self._credential_manager, "get_active_session"):
                    sess = self._credential_manager.get_active_session()
                    if isinstance(sess, dict):
                        return sess
                if hasattr(self._credential_manager, "_session"):
                    sess = self._credential_manager._session()
                    if isinstance(sess, dict):
                        return sess
                if callable(self._credential_manager):
                    sess = self._credential_manager()
                    if isinstance(sess, dict):
                        return sess
        except Exception as e:
            self.logger.warning("Failed to retrieve active session: %s", e)
        return None

    def is_near_expiry(self) -> bool:
        """检查凭据中的 expiresAt 或 refreshExpiresAt 是否距离当前时间小于阈值。"""
        try:
            session = self.get_session()
            if not session or not isinstance(session, dict):
                return False

            auth = session.get("auth") if isinstance(session.get("auth"), dict) else session
            if not isinstance(auth, dict):
                return False

            now = time.time()
            timestamps = []
            for key in ("expiresAt", "expires_at", "refreshExpiresAt", "refresh_expires_at"):
                val = auth.get(key)
                if val is not None:
                    try:
                        ts = float(val)
                        if ts > 0:
                            timestamps.append(ts)
                    except (ValueError, TypeError):
                        continue

            if not timestamps:
                return False

            # 任意一个时间戳（access token 或 refresh token）低于阈值即触发续期
            for ts in timestamps:
                ts_sec = ts / 1000.0 if ts > 1e11 else ts
                remaining = ts_sec - now
                if remaining < self._threshold_seconds:
                    return True

            return False
        except Exception as e:
            self.logger.warning("Error checking token expiry: %s", e)
            return False

    async def _invoke_callable(self, target: Callable[[], Any], run_in_thread: bool = False) -> Any:
        """调用目标函数，兼容普通同步方法与 async def 协程方法。

        检查 callable 返回值：
        - 如果是协程函数 (inspect.iscoroutinefunction) 或返回值为 coroutine/awaitable 则 await；
        - 如果是普通同步方法，支持 asyncio.to_thread 或直接调用，不要假定它一定是 async 函数。
        """
        if inspect.iscoroutinefunction(target):
            return await target()

        if run_in_thread:
            res = await asyncio.to_thread(target)
        else:
            res = target()

        if inspect.isawaitable(res):
            return await res
        return res

    async def _do_refresh(self):
        """执行刷新逻辑（无锁，由外层保证互斥）。"""
        if self._refresh_callback is not None:
            await self._invoke_callable(self._refresh_callback, run_in_thread=False)
        elif self._credential_manager is not None:
            # 优先匹配 converter.py 中标准的 CredentialManager._refresh 同步方法
            fn = None
            if hasattr(self._credential_manager, "_refresh"):
                fn = getattr(self._credential_manager, "_refresh")
            elif hasattr(self._credential_manager, "refresh"):
                fn = getattr(self._credential_manager, "refresh")
            elif hasattr(self._credential_manager, "async_refresh"):
                fn = getattr(self._credential_manager, "async_refresh")
            elif callable(self._credential_manager):
                fn = self._credential_manager

            if fn is not None and callable(fn):
                await self._invoke_callable(fn, run_in_thread=True)
            else:
                raise RuntimeError(
                    "CredentialManager does not have a recognizable refresh method (_refresh/refresh/async_refresh)"
                )
        else:
            raise RuntimeError("No refresh callback or CredentialManager provided")

    async def check_and_refresh(self) -> bool:
        """检查凭据是否临近过期，若临期则触发刷新。

        返回:
            True 表示触发并成功完成了刷新；
            False 表示无需刷新、刷新正在进行中或刷新失败。
        """
        # 防重入检测
        if self._refresh_lock.locked():
            self.logger.debug("Token refresh already in progress; skipping.")
            return False

        if not self.is_near_expiry():
            return False

        async with self._refresh_lock:
            # 获取锁后二次校验，避免并发竞争导致的重复刷新
            if not self.is_near_expiry():
                return False

            try:
                await self._do_refresh()
                self._last_refresh_time = time.time()
                self._refresh_count += 1
                self._fail_count = 0
                self.logger.info("Background token refresh completed successfully.")
                return True
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._fail_count += 1
                self.logger.warning("Background token refresh failed (fail count %d): %s", self._fail_count, e)
                return False

    async def force_refresh(self) -> bool:
        """强制触发刷新，无论是否临期。"""
        if self._refresh_lock.locked():
            self.logger.debug("Token force_refresh skipped: already in progress.")
            return False

        async with self._refresh_lock:
            try:
                await self._do_refresh()
                self._last_refresh_time = time.time()
                self._refresh_count += 1
                self._fail_count = 0
                self.logger.info("Token force_refresh completed successfully.")
                return True
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._fail_count += 1
                self.logger.warning("Token force_refresh failed (fail count %d): %s", self._fail_count, e)
                return False

    def start(self) -> asyncio.Task:
        """启动后台巡检任务。"""
        if self._task is not None and not self._task.done():
            return self._task
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_loop(), name="BackgroundTokenRefresher")
        return self._task

    async def stop(self, timeout: float = 5.0):
        """停止后台巡检任务并等待其退出。"""
        self._stop_event.set()
        if self._task is not None:
            if not self._task.done():
                self._task.cancel()
                try:
                    await asyncio.wait_for(self._task, timeout=timeout)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
            self._task = None

    async def _run_loop(self):
        """后台轮询主循环，具备异常防御与退避重试机制。"""
        self.logger.debug("BackgroundTokenRefresher loop started.")
        try:
            while not self._stop_event.is_set():
                error_occurred = False

                if self.is_near_expiry():
                    if not self._refresh_lock.locked():
                        async with self._refresh_lock:
                            if self.is_near_expiry():
                                try:
                                    await self._do_refresh()
                                    self._last_refresh_time = time.time()
                                    self._refresh_count += 1
                                    self._fail_count = 0
                                    self.logger.info("Background periodic token refresh succeeded.")
                                except asyncio.CancelledError:
                                    raise
                                except Exception as e:
                                    error_occurred = True
                                    self._fail_count += 1
                                    self.logger.warning(
                                        "Background token refresh failed in loop (fail count %d): %s",
                                        self._fail_count,
                                        e,
                                    )

                # 计算下一次检查的休眠等待时长
                if error_occurred:
                    # 指数退避重试（上限 max_retry_seconds）
                    delay = min(
                        self._max_retry_seconds,
                        self._base_retry_seconds * (2 ** min(self._fail_count - 1, 6)),
                    )
                else:
                    delay = self._check_interval_seconds

                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    # 若 stop_event 被 set，立即退出循环
                    break
                except asyncio.TimeoutError:
                    # 延时结束，进入下一轮巡检
                    pass
                except asyncio.CancelledError:
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.logger.error("Fatal unexpected error in BackgroundTokenRefresher loop: %s", e)
        finally:
            self.logger.debug("BackgroundTokenRefresher loop stopped.")
