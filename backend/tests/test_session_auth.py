from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app import main, session_auth


def test_gsi_http_api_does_not_require_desktop_token(monkeypatch):
    monkeypatch.setattr(session_auth, "_SESSION_TOKEN", "expected-token")
    monkeypatch.setattr(main, "notify_gsi_payload", lambda _payload: True)

    response = TestClient(main.app).post("/api/gsi/cs2", json={"map": {"name": "de_dust2"}})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "ready": True}


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
