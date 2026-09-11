"""
request_pacer.py - 请求并发削峰与平滑器

用于高并发 Agent 调用时削峰填谷，平滑请求节奏，防止脉冲流量触发腾讯上游 6004 频率限制。
"""

import asyncio
import time
from typing import Any, Dict, Optional


class _PacerContext:
    def __init__(self, pacer: "RequestPacer", model: Optional[str] = None):
        self._pacer = pacer
        self._model = model
        self._acquired = False

    async def __aenter__(self):
        await self._pacer._enter(self._model)
        self._acquired = True
        return self._pacer

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._acquired:
            self._pacer._exit(self._model, had_error=(exc_type is not None))
        return False


class RequestPacer:
    """请求并发与速率平滑器。

    提供基于 asyncio.Semaphore 的最大并发控制以及最小请求间隔控制，
    防止脉冲突发流量触发上游频控限流。
    """

    def __init__(
        self,
        max_concurrency: int = 5,
        min_interval_ms: float = 0.0,
        model_min_intervals_ms: Optional[Dict[str, float]] = None,
        by_model: bool = False,
    ):
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be at least 1")
        self._max_concurrency = max_concurrency
        self._min_interval_ms = float(min_interval_ms)
        self._model_min_intervals_ms = dict(model_min_intervals_ms) if model_min_intervals_ms else {}
        self._by_model = by_model

        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._waiting_count = 0
        self._current_concurrency = 0
        self._total_requests = 0
        self._total_success = 0
        self._total_errors = 0

        # Pacing timelines (monotonic seconds)
        self._next_allowed_time: Dict[str, float] = {}

    @property
    def max_concurrency(self) -> int:
        return self._max_concurrency

    @property
    def min_interval_ms(self) -> float:
        return self._min_interval_ms

    @property
    def by_model(self) -> bool:
        return self._by_model

    def acquire(self, model: Optional[str] = None) -> _PacerContext:
        """获取并发上下文管理器。"""
        return _PacerContext(self, model)

    def _reserve_delay(self, model: Optional[str]) -> float:
        """计算并预占下一次允许调用的时间窗口，返回需睡眠的秒数。

        注意：在 asyncio 事件循环的单线程调度中，无 await 的同步代码具有原子性，
        因此多个任务获取信号量后计算延时不会产生竞态条件。
        """
        now = time.monotonic()
        delays = []

        # 1. 全局间隔 (若非 by_model 且配置了 min_interval_ms)
        if not self._by_model and self._min_interval_ms > 0:
            interval_sec = self._min_interval_ms / 1000.0
            last_allowed = self._next_allowed_time.get("__global__", 0.0)
            scheduled = max(now, last_allowed)
            delays.append(max(0.0, scheduled - now))
            self._next_allowed_time["__global__"] = scheduled + interval_sec

        # 2. 模型级间隔 (若 by_model 或该模型在 model_min_intervals_ms 中有单独配置)
        m_interval_ms = 0.0
        if model and model in self._model_min_intervals_ms:
            m_interval_ms = self._model_min_intervals_ms[model]
        elif self._by_model and self._min_interval_ms > 0:
            m_interval_ms = self._min_interval_ms

        if m_interval_ms > 0:
            key = model or "__default_model__"
            interval_sec = m_interval_ms / 1000.0
            last_allowed = self._next_allowed_time.get(key, 0.0)
            scheduled = max(now, last_allowed)
            delays.append(max(0.0, scheduled - now))
            self._next_allowed_time[key] = scheduled + interval_sec

        return max(delays) if delays else 0.0

    async def _enter(self, model: Optional[str]):
        self._waiting_count += 1
        try:
            await self._semaphore.acquire()
        finally:
            self._waiting_count -= 1

        self._current_concurrency += 1
        self._total_requests += 1

        delay = self._reserve_delay(model)
        if delay > 0:
            try:
                await asyncio.sleep(delay)
            except BaseException:
                # 若在 sleep 期间被取消或异常中断，回退并发计数并释放信号量
                self._current_concurrency -= 1
                self._semaphore.release()
                raise

    def _exit(self, model: Optional[str], had_error: bool):
        self._current_concurrency -= 1
        if had_error:
            self._total_errors += 1
        else:
            self._total_success += 1
        self._semaphore.release()

    def metrics(self) -> Dict[str, Any]:
        """返回实时运行指标字典。"""
        return {
            "current_concurrency": self._current_concurrency,
            "active_requests": self._current_concurrency,
            "queued_requests": self._waiting_count,
            "waiting_requests": self._waiting_count,
            "total_requests": self._total_requests,
            "total_success": self._total_success,
            "total_errors": self._total_errors,
            "max_concurrency": self._max_concurrency,
        }
