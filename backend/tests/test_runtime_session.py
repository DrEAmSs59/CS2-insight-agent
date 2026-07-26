import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.runtime_session import runtime_session_dependency, runtime_session_state


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
