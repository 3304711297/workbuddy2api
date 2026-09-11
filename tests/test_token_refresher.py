import asyncio
import time
from unittest.mock import MagicMock
import pytest
from token_refresher import BackgroundTokenRefresher


def test_is_near_expiry_logic():
    now = time.time()
    threshold = 1800.0  # 30 mins

    # 1. Near expiry (in 600s, < 1800s) with ms timestamp
    session_near = {
        "auth": {
            "accessToken": "tok1",
            "expiresAt": int((now + 600) * 1000),
            "refreshExpiresAt": int((now + 86400) * 1000),
        }
    }
    refresher = BackgroundTokenRefresher(
        get_session_callback=lambda: session_near,
        refresh_callback=lambda: None,
        threshold_seconds=threshold,
    )
    assert refresher.is_near_expiry() is True

    # 2. Far from expiry (in 5000s, > 1800s)
    session_fresh = {
        "auth": {
            "accessToken": "tok2",
            "expiresAt": int((now + 5000) * 1000),
            "refreshExpiresAt": int((now + 86400) * 1000),
        }
    }
    refresher_fresh = BackgroundTokenRefresher(
        get_session_callback=lambda: session_fresh,
        refresh_callback=lambda: None,
        threshold_seconds=threshold,
    )
    assert refresher_fresh.is_near_expiry() is False

    # 3. Already expired (-10s)
    session_expired = {
        "auth": {
            "accessToken": "tok3",
            "expiresAt": int((now - 10) * 1000),
        }
    }
    refresher_expired = BackgroundTokenRefresher(
        get_session_callback=lambda: session_expired,
        refresh_callback=lambda: None,
        threshold_seconds=threshold,
    )
    assert refresher_expired.is_near_expiry() is True

    # 4. expiresAt is far, but refreshExpiresAt is near
    session_refresh_near = {
        "auth": {
            "accessToken": "tok4",
            "expiresAt": int((now + 7200) * 1000),
            "refreshExpiresAt": int((now + 1000) * 1000),
        }
    }
    refresher_r_near = BackgroundTokenRefresher(
        get_session_callback=lambda: session_refresh_near,
        refresh_callback=lambda: None,
        threshold_seconds=threshold,
    )
    assert refresher_r_near.is_near_expiry() is True

    # 5. Missing or invalid timestamps -> False
    session_empty = {"auth": {}}
    refresher_empty = BackgroundTokenRefresher(
        get_session_callback=lambda: session_empty,
        refresh_callback=lambda: None,
        threshold_seconds=threshold,
    )
    assert refresher_empty.is_near_expiry() is False


def test_check_and_refresh_triggered_and_not_triggered():
    async def _run():
        now = time.time()
        # Case A: Not near expiry -> should NOT trigger
        called_a = False

        async def cb_a():
            nonlocal called_a
            called_a = True

        refresher_a = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 7200) * 1000)}},
            refresh_callback=cb_a,
            threshold_seconds=1800.0,
        )
        res_a = await refresher_a.check_and_refresh()
        assert res_a is False
        assert called_a is False
        assert refresher_a.refresh_count == 0

        # Case B: Near expiry -> should trigger
        called_b = False

        async def cb_b():
            nonlocal called_b
            called_b = True

        refresher_b = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 600) * 1000)}},
            refresh_callback=cb_b,
            threshold_seconds=1800.0,
        )
        res_b = await refresher_b.check_and_refresh()
        assert res_b is True
        assert called_b is True
        assert refresher_b.refresh_count == 1
        assert refresher_b.last_refresh_time is not None

    asyncio.run(_run())


def test_credential_manager_duck_typing():
    async def _run():
        now = time.time()
        # Mock CredentialManager
        mock_cm = MagicMock()
        mock_cm.get_active_session.return_value = {
            "auth": {
                "accessToken": "old_token",
                "expiresAt": int((now + 500) * 1000),
            }
        }
        mock_cm._refresh = MagicMock()

        refresher = BackgroundTokenRefresher(
            credential_manager=mock_cm,
            threshold_seconds=1800.0,
        )

        res = await refresher.check_and_refresh()
        assert res is True
        mock_cm.get_active_session.assert_called()
        mock_cm._refresh.assert_called_once()
        assert refresher.refresh_count == 1

    asyncio.run(_run())


def test_credential_manager_plain_sync_class():
    async def _run():
        now = time.time()

        class FakeCredentialManager:
            def __init__(self):
                self.refreshed = False
                self.session = {
                    "auth": {
                        "accessToken": "sync_old",
                        "expiresAt": int((now + 100) * 1000),
                    }
                }

            def get_active_session(self):
                return self.session

            def _refresh(self):
                # 普通同步方法，非 async def
                self.refreshed = True
                self.session["auth"]["expiresAt"] = int((time.time() + 3600) * 1000)

        fake_cm = FakeCredentialManager()
        refresher = BackgroundTokenRefresher(
            credential_manager=fake_cm,
            threshold_seconds=1800.0,
        )

        res = await refresher.check_and_refresh()
        assert res is True
        assert fake_cm.refreshed is True
        assert refresher.refresh_count == 1

    asyncio.run(_run())


def test_sync_refresh_callback():
    async def _run():
        now = time.time()
        called = False

        def sync_cb():
            # 普通同步回调，非 async def
            nonlocal called
            called = True

        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 200) * 1000)}},
            refresh_callback=sync_cb,
            threshold_seconds=1800.0,
        )
        res = await refresher.check_and_refresh()
        assert res is True
        assert called is True

    asyncio.run(_run())


def test_reentrancy_lock():
    async def _run():
        now = time.time()
        in_flight = 0
        max_in_flight = 0

        async def slow_refresh():
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.08)
            in_flight -= 1

        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 500) * 1000)}},
            refresh_callback=slow_refresh,
            threshold_seconds=1800.0,
        )

        # Launch two check_and_refresh calls concurrently
        t1 = asyncio.create_task(refresher.check_and_refresh())
        await asyncio.sleep(0.01)
        t2 = asyncio.create_task(refresher.check_and_refresh())

        res1, res2 = await asyncio.gather(t1, t2)
        # Exactly one should acquire and refresh, the other skipped
        assert (res1 is True and res2 is False) or (res1 is False and res2 is True)
        assert max_in_flight == 1
        assert refresher.refresh_count == 1

    asyncio.run(_run())


def test_exception_defense_and_fail_count():
    async def _run():
        now = time.time()

        async def failing_refresh():
            raise ConnectionResetError("Remote disconnected")

        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 500) * 1000)}},
            refresh_callback=failing_refresh,
            threshold_seconds=1800.0,
        )

        # Should not raise exception
        res = await refresher.check_and_refresh()
        assert res is False
        assert refresher.fail_count == 1
        assert refresher.refresh_count == 0

        # Try again
        res2 = await refresher.check_and_refresh()
        assert res2 is False
        assert refresher.fail_count == 2

    asyncio.run(_run())


def test_background_loop_start_and_graceful_stop():
    async def _run():
        now = time.time()
        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: {"auth": {"expiresAt": int((now + 5000) * 1000)}},
            refresh_callback=lambda: None,
            check_interval_seconds=60.0,
        )

        assert refresher.is_running is False
        task = refresher.start()
        assert refresher.is_running is True
        assert task is not None

        # Redundant start returns existing task
        assert refresher.start() is task

        # Graceful stop
        await refresher.stop(timeout=1.0)
        assert refresher.is_running is False
        assert task.done()

        # Redundant stop is safe
        await refresher.stop(timeout=1.0)
        assert refresher.is_running is False

    asyncio.run(_run())


def test_background_loop_periodic_inspection():
    async def _run():
        now = time.time()
        # Initially fresh, then expires
        session_data = {"auth": {"expiresAt": int((now + 5000) * 1000)}}
        refresh_invoked = asyncio.Event()

        async def refresh_cb():
            # simulate refresh updating expiry
            session_data["auth"]["expiresAt"] = int((time.time() + 99999) * 1000)
            refresh_invoked.set()

        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: session_data,
            refresh_callback=refresh_cb,
            check_interval_seconds=0.05,
            threshold_seconds=1800.0,
        )

        refresher.start()
        await asyncio.sleep(0.08)
        assert refresh_invoked.is_set() is False

        # Now simulate token nearing expiry
        session_data["auth"]["expiresAt"] = int((time.time() + 500) * 1000)

        # Wait for periodic inspection to pick it up
        await asyncio.wait_for(refresh_invoked.wait(), timeout=0.5)
        assert refresh_invoked.is_set() is True
        assert refresher.refresh_count == 1

        await refresher.stop()

    asyncio.run(_run())


def test_background_loop_retry_backoff_on_failure():
    async def _run():
        now = time.time()
        session_data = {"auth": {"expiresAt": int((now + 500) * 1000)}}
        attempts = 0
        success_event = asyncio.Event()

        async def faulty_refresh():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise TimeoutError(f"Simulated network timeout {attempts}")
            # 3rd attempt succeeds
            session_data["auth"]["expiresAt"] = int((time.time() + 99999) * 1000)
            success_event.set()

        refresher = BackgroundTokenRefresher(
            get_session_callback=lambda: session_data,
            refresh_callback=faulty_refresh,
            check_interval_seconds=1.0,
            base_retry_seconds=0.03,
            max_retry_seconds=0.1,
            threshold_seconds=1800.0,
        )

        refresher.start()
        await asyncio.wait_for(success_event.wait(), timeout=1.0)

        assert attempts == 3
        assert refresher.refresh_count == 1
        assert refresher.fail_count == 0

        await refresher.stop()

    asyncio.run(_run())
