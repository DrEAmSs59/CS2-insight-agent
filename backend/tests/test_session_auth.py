import asyncio

from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import main, session_auth


def _request(*, token: str = "", query: bytes = b"") -> Request:
    headers = []
    if token:
        headers.append((b"x-cs2-insight-token", token.encode("ascii")))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/app/runtime-state",
            "raw_path": b"/api/app/runtime-state",
            "query_string": query,
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 19871),
        }
    )


def test_http_api_rejects_missing_desktop_token(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "expected-token")
    called = False

    async def call_next(_request):
        nonlocal called
        called = True
        return JSONResponse({"ok": True})

    response = asyncio.run(main.require_desktop_session(_request(), call_next))

    assert response.status_code == 401
    assert not called


def test_http_api_accepts_header_credential(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "expected-token")

    async def call_next(_request):
        return JSONResponse({"ok": True})

    response = asyncio.run(
        main.require_desktop_session(
            _request(token="expected-token"),
            call_next,
        )
    )

    assert response.status_code == 200


def test_http_api_accepts_and_strips_query_credential(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "expected-token")
    request = _request(
        query=b"layer=lower&_session=expected-token",
    )

    async def call_next(authorized_request):
        assert authorized_request.scope["query_string"] == b"layer=lower"
        return JSONResponse({"ok": True})

    response = asyncio.run(main.require_desktop_session(request, call_next))

    assert response.status_code == 200


def test_websocket_requires_marker_and_matching_token(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "expected-token")

    assert session_auth.authorize_websocket_protocols(None) == (False, None)
    assert session_auth.authorize_websocket_protocols("cs2-insight, wrong-token") == (False, None)
    assert session_auth.authorize_websocket_protocols(
        "cs2-insight, expected-token"
    ) == (True, "cs2-insight")
    assert session_auth.overlay_session_fragment() == "#session=expected-token"


def test_auth_is_disabled_for_manual_browser_backend(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "")

    assert session_auth.session_token_matches(None)
    assert session_auth.authorize_websocket_protocols(None) == (True, None)
    assert session_auth.overlay_session_fragment() == ""


def test_cors_does_not_trust_arbitrary_websites():
    middleware = next(
        item for item in main.app.user_middleware if item.cls is CORSMiddleware
    )

    assert "*" not in middleware.kwargs["allow_origins"]
    assert middleware.kwargs["allow_credentials"] is False
    assert "http://tauri.localhost" in middleware.kwargs["allow_origins"]
    assert "http://localhost:5173" in middleware.kwargs["allow_origins"]
