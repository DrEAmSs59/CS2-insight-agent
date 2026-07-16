from fastapi.testclient import TestClient

from app import main


ORIGIN = "app://local"


def test_cors_preflight_bypasses_token_auth(monkeypatch):
    monkeypatch.setattr(main, "_AUTH_TOKEN", "secret")
    client = TestClient(main.app)

    response = client.options(
        "/api/health",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-CS2-Insight-Token",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_auth_rejection_includes_cors_headers(monkeypatch):
    monkeypatch.setattr(main, "_AUTH_TOKEN", "secret")
    client = TestClient(main.app)

    response = client.get("/api/health", headers={"Origin": ORIGIN})

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_valid_token_reaches_api(monkeypatch):
    monkeypatch.setattr(main, "_AUTH_TOKEN", "secret")
    client = TestClient(main.app)

    response = client.get(
        "/api/health",
        headers={"Origin": ORIGIN, "X-CS2-Insight-Token": "secret"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
