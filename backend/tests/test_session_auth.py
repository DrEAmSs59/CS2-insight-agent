from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app import main


def test_cors_does_not_trust_arbitrary_websites():
    middleware = next(
        item for item in main.app.user_middleware if item.cls is CORSMiddleware
    )

    assert "*" not in middleware.kwargs["allow_origins"]
    assert middleware.kwargs["allow_credentials"] is False
    assert "http://tauri.localhost" in middleware.kwargs["allow_origins"]
    assert "http://localhost:5173" in middleware.kwargs["allow_origins"]


def test_tauri_media_origin_receives_cors_response_headers():
    response = TestClient(main.app).get(
        "/api/health",
        headers={"Origin": "http://tauri.localhost"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://tauri.localhost"
    assert "content-range" in response.headers["access-control-expose-headers"].lower()
