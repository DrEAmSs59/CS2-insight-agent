from fastapi.middleware.cors import CORSMiddleware

from app import main


def test_cors_does_not_trust_arbitrary_websites():
    middleware = next(
        item for item in main.app.user_middleware if item.cls is CORSMiddleware
    )

    assert "*" not in middleware.kwargs["allow_origins"]
    assert middleware.kwargs["allow_credentials"] is False
    assert "http://tauri.localhost" in middleware.kwargs["allow_origins"]
    assert "http://localhost:5173" in middleware.kwargs["allow_origins"]
