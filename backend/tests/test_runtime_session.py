import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.runtime_session import runtime_session_dependency, runtime_session_state
from app import cs2_config_backup, demo_playback_service, runtime_session


@pytest.fixture(autouse=True)
def isolated_exit_state(monkeypatch):
    monkeypatch.setattr(runtime_session, "_owner", None)
    monkeypatch.setattr(runtime_session, "_closing", False)
    monkeypatch.setattr(
        demo_playback_service, "demo_playback_service", demo_playback_service.DemoPlaybackService()
    )


def _request(path: str) -> Request:
    return Request({"type": "http", "method": "POST", "path": path, "headers": []})


def test_runtime_session_rejects_overlap_and_releases_owner():
    async def scenario():
        first = runtime_session_dependency(_request("/api/recording/execute"))
        await first.__anext__()
        assert runtime_session_state()["owner"]["operation"] == "/api/recording/execute"

        second = runtime_session_dependency(_request("/api/demo/play"))
        with pytest.raises(HTTPException) as exc_info:
            await second.__anext__()
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "RUNTIME_SESSION_BUSY"

        await first.aclose()
        assert runtime_session_state() == {"busy": False, "owner": None}

        third = runtime_session_dependency(_request("/api/demo/play"))
        await third.__anext__()
        await third.aclose()

    asyncio.run(scenario())


def test_idle_insight_allows_exit_without_adopting_user_cs2(monkeypatch):
    # The process list may contain a user's own CS2, but idle Insight has no
    # owned session and must not even use that list to decide ownership.
    monkeypatch.setattr(cs2_config_backup, "is_cs2_running", pytest.fail)
    assert runtime_session.prepare_app_exit()["allowed"] is True


def test_recording_blocks_exit_through_launch_and_cleanup(monkeypatch):
    running = True
    monkeypatch.setattr(cs2_config_backup, "is_cs2_running", lambda: running)

    async def scenario():
        nonlocal running
        session = runtime_session_dependency(_request("/api/recording/queue"))
        await session.__anext__()
        try:
            # Preparation is also protected, but an existing unrelated process
            # is not labelled as an Insight launch before Popen succeeds.
            assert runtime_session.prepare_app_exit()["reason"] == "session_busy"
            runtime_session.mark_runtime_cs2_launched(123)
            result = runtime_session.prepare_app_exit()
            assert result["allowed"] is False
            assert result["reason"] == "managed_cs2_running"
            assert result["owner"]["cs2_pid"] == 123
            assert runtime_session._closing is False

            # CS2 exiting is insufficient: the request still owns restoration.
            running = False
            result = runtime_session.prepare_app_exit()
            assert result["allowed"] is False
            assert result["reason"] == "session_busy"
        finally:
            await session.aclose()

        running = True  # A subsequent user-launched game does not reuse ownership.
        assert runtime_session.prepare_app_exit()["allowed"] is True

    asyncio.run(scenario())


def test_playback_blocks_exit_after_its_http_request_finishes(monkeypatch):
    from types import SimpleNamespace

    service = demo_playback_service.demo_playback_service
    service._active = SimpleNamespace(session_id="playback-1", process=SimpleNamespace(pid=456))
    monkeypatch.setattr(cs2_config_backup, "is_cs2_running", lambda: True)
    result = runtime_session.prepare_app_exit()
    assert result["allowed"] is False
    assert result["reason"] == "managed_cs2_running"
    assert result["owner"]["id"] == "playback-1"
    assert runtime_session_state()["busy"] is False
    service._active = None
    assert runtime_session.prepare_app_exit()["allowed"] is True


def test_approved_exit_prevents_a_concurrent_new_launch():
    assert runtime_session.prepare_app_exit()["allowed"] is True
    # Retrying a lost HTTP response is safe and leaves the reservation in place.
    assert runtime_session.prepare_app_exit()["allowed"] is True

    async def scenario():
        session = runtime_session_dependency(_request("/api/demo/play"))
        with pytest.raises(HTTPException) as exc_info:
            await session.__anext__()
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "APP_CLOSING"
        assert runtime_session_state()["busy"] is False

    asyncio.run(scenario())
