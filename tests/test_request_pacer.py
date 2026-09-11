import asyncio
import time
import pytest
from request_pacer import RequestPacer


def test_invalid_arguments():
    with pytest.raises(ValueError, match="max_concurrency must be at least 1"):
        RequestPacer(max_concurrency=0)


def test_concurrency_limit():
    async def _run():
        max_concurrency = 3
        pacer = RequestPacer(max_concurrency=max_concurrency)

        active_count = 0
        max_active_observed = 0

        async def task_worker():
            nonlocal active_count, max_active_observed
            async with pacer.acquire():
                active_count += 1
                if active_count > max_active_observed:
                    max_active_observed = active_count
                await asyncio.sleep(0.05)
                active_count -= 1

        tasks = [asyncio.create_task(task_worker()) for _ in range(10)]
        await asyncio.gather(*tasks)

        assert max_active_observed == max_concurrency
        assert active_count == 0
        m = pacer.metrics()
        assert m["current_concurrency"] == 0
        assert m["total_requests"] == 10
        assert m["queued_requests"] == 0

    asyncio.run(_run())


def test_fifo_ordering():
    async def _run():
        pacer = RequestPacer(max_concurrency=1)
        completion_order = []
        ready_event = asyncio.Event()

        async def blocker():
            async with pacer.acquire():
                ready_event.set()
                await asyncio.sleep(0.06)
                completion_order.append(0)

        async def queued_worker(idx: int):
            async with pacer.acquire():
                completion_order.append(idx)

        # Start blocker task
        t0 = asyncio.create_task(blocker())
        await ready_event.wait()

        # Queue workers in strict sequence
        t1 = asyncio.create_task(queued_worker(1))
        await asyncio.sleep(0.01)
        t2 = asyncio.create_task(queued_worker(2))
        await asyncio.sleep(0.01)
        t3 = asyncio.create_task(queued_worker(3))

        await asyncio.gather(t0, t1, t2, t3)
        assert completion_order == [0, 1, 2, 3]

    asyncio.run(_run())


def test_exception_release_and_recovery():
    async def _run():
        pacer = RequestPacer(max_concurrency=1)

        with pytest.raises(RuntimeError, match="Intentional failure"):
            async with pacer.acquire():
                raise RuntimeError("Intentional failure")

        # Metrics should show 0 current concurrency
        m = pacer.metrics()
        assert m["current_concurrency"] == 0
        assert m["queued_requests"] == 0
        assert m["total_requests"] == 1
        assert m["total_errors"] == 1

        # Subsequent request should acquire without blocking
        acquired = False
        async with pacer.acquire():
            acquired = True

        assert acquired is True
        assert pacer.metrics()["total_requests"] == 2
        assert pacer.metrics()["total_success"] == 1
        assert pacer.metrics()["current_concurrency"] == 0

    asyncio.run(_run())


def test_metrics_accuracy():
    async def _run():
        pacer = RequestPacer(max_concurrency=2)
        m0 = pacer.metrics()
        assert m0["current_concurrency"] == 0
        assert m0["queued_requests"] == 0
        assert m0["total_requests"] == 0

        hold_event = asyncio.Event()
        release_event = asyncio.Event()

        async def worker():
            async with pacer.acquire("model-test"):
                hold_event.set()
                await release_event.wait()

        t1 = asyncio.create_task(worker())
        t2 = asyncio.create_task(worker())
        await hold_event.wait()
        await asyncio.sleep(0.01)

        # Now max_concurrency (2) should be running
        # Queue a 3rd task
        t3 = asyncio.create_task(worker())
        await asyncio.sleep(0.02)

        m_busy = pacer.metrics()
        assert m_busy["current_concurrency"] == 2
        assert m_busy["queued_requests"] == 1

        # Unblock all
        release_event.set()
        await asyncio.gather(t1, t2, t3)

        m_end = pacer.metrics()
        assert m_end["current_concurrency"] == 0
        assert m_end["queued_requests"] == 0
        assert m_end["total_requests"] == 3

    asyncio.run(_run())


def test_global_min_interval():
    async def _run():
        interval_ms = 50.0
        pacer = RequestPacer(max_concurrency=5, min_interval_ms=interval_ms)

        timestamps = []

        async def worker():
            async with pacer.acquire():
                timestamps.append(time.monotonic())

        # Dispatch 3 requests concurrently
        tasks = [asyncio.create_task(worker()) for _ in range(3)]
        await asyncio.gather(*tasks)

        assert len(timestamps) == 3
        diff1 = timestamps[1] - timestamps[0]
        diff2 = timestamps[2] - timestamps[1]

        # Expected spacing around 50ms (0.05s); allow small timing tolerance (>= 40ms)
        assert diff1 >= 0.04, f"diff1 too short: {diff1:.4f}s"
        assert diff2 >= 0.04, f"diff2 too short: {diff2:.4f}s"

    asyncio.run(_run())


def test_model_level_min_interval():
    async def _run():
        # by_model=True separates intervals across different models
        pacer = RequestPacer(max_concurrency=5, min_interval_ms=50.0, by_model=True)

        times = {}

        async def worker(model: str, req_id: str):
            async with pacer.acquire(model):
                times[req_id] = time.monotonic()

        # Model A request 1 and Model B request 1 should run without waiting for each other
        t_a1 = asyncio.create_task(worker("model-a", "a1"))
        t_b1 = asyncio.create_task(worker("model-b", "b1"))
        # Model A request 2 should wait for Model A request 1 interval
        t_a2 = asyncio.create_task(worker("model-a", "a2"))

        await asyncio.gather(t_a1, t_b1, t_a2)

        # a1 and b1 started almost simultaneously
        cross_diff = abs(times["b1"] - times["a1"])
        assert cross_diff < 0.03, f"Cross-model requests should not block each other: {cross_diff:.4f}s"

        # a2 was spaced from a1 by ~50ms
        same_model_diff = times["a2"] - times["a1"]
        assert same_model_diff >= 0.04, f"Same model interval too short: {same_model_diff:.4f}s"

    asyncio.run(_run())


def test_model_min_intervals_ms_override():
    async def _run():
        # Specific model override: model-slow gets 60ms, others get 0ms
        pacer = RequestPacer(
            max_concurrency=5,
            min_interval_ms=0.0,
            model_min_intervals_ms={"model-slow": 60.0},
        )

        times_slow = []
        times_fast = []

        async def worker_slow():
            async with pacer.acquire("model-slow"):
                times_slow.append(time.monotonic())

        async def worker_fast():
            async with pacer.acquire("model-fast"):
                times_fast.append(time.monotonic())

        t_s1 = asyncio.create_task(worker_slow())
        t_s2 = asyncio.create_task(worker_slow())
        t_f1 = asyncio.create_task(worker_fast())
        t_f2 = asyncio.create_task(worker_fast())

        await asyncio.gather(t_s1, t_s2, t_f1, t_f2)

        fast_diff = abs(times_fast[1] - times_fast[0])
        assert fast_diff < 0.02, "Fast model requests should have no pacing delay"

        slow_diff = abs(times_slow[1] - times_slow[0])
        assert slow_diff >= 0.045, "Slow model requests should respect configured model interval"

    asyncio.run(_run())


def test_cancellation_during_pacing_sleep():
    async def _run():
        # Large interval so task 2 will sleep in pacing
        pacer = RequestPacer(max_concurrency=5, min_interval_ms=500.0)

        t1_entered = asyncio.Event()

        async def worker1():
            async with pacer.acquire():
                t1_entered.set()
                await asyncio.sleep(0.01)

        async def worker2():
            async with pacer.acquire():
                pass

        t1 = asyncio.create_task(worker1())
        await t1_entered.wait()

        # worker2 enters, acquires semaphore, but sleeps 500ms for pacing
        t2 = asyncio.create_task(worker2())
        await asyncio.sleep(0.05)

        # Cancel t2 while it is sleeping in pacing delay
        t2.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t2

        await t1
        # Concurrency should be back to 0, semaphore released
        assert pacer.metrics()["current_concurrency"] == 0

        # Subsequent request should acquire without blocking
        async with pacer.acquire():
            pass
        assert pacer.metrics()["current_concurrency"] == 0

    asyncio.run(_run())


def test_cancellation_preserves_semaphore():
    async def _run():
        pacer = RequestPacer(max_concurrency=1)

        gate = asyncio.Event()

        async def blocker():
            async with pacer.acquire():
                gate.set()
                await asyncio.sleep(0.1)

        t0 = asyncio.create_task(blocker())
        await gate.wait()

        # Task 1 queues up
        async def waiter():
            async with pacer.acquire():
                pass

        t1 = asyncio.create_task(waiter())
        await asyncio.sleep(0.01)
        assert pacer.metrics()["queued_requests"] == 1

        # Cancel waiter while queued
        t1.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t1

        assert pacer.metrics()["queued_requests"] == 0

        await t0
        # After blocker finishes, semaphore is fully available
        assert pacer.metrics()["current_concurrency"] == 0

        # Ensure another task can acquire immediately
        async with pacer.acquire():
            pass
        assert pacer.metrics()["total_requests"] == 2

    asyncio.run(_run())
