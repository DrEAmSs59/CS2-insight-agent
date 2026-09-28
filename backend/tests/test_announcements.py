from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from app import announcements


class _AnnouncementServer:
    def __init__(self, body: object, status: int = 200) -> None:
        self.body = body
        self.status = status
        self.requests: list[dict[str, list[str]]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                server.requests.append(parse_qs(urlparse(self.path).query))
                payload = json.dumps(server.body).encode("utf-8")
                self.send_response(server.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/auth/v1/public/announcements"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _item(**overrides):
    return {
        "id": "a1",
        "level": "info",
        "body_zh": "服务器维护通知",
        "body_en": "Maintenance notice",
        "link_url": "https://ciacut.cc/notice",
        **overrides,
    }


@pytest.fixture
def serve(monkeypatch):
    servers: list[_AnnouncementServer] = []

    def start(body: object, status: int = 200) -> _AnnouncementServer:
        server = _AnnouncementServer(body, status)
        servers.append(server)
        monkeypatch.setenv("CS2_INSIGHT_ANNOUNCEMENTS_URL", server.url)
        announcements.clear_cache()
        return server

    yield start
    for server in servers:
        server.close()
    announcements.clear_cache()


def test_requests_announcements_for_the_free_edition_by_default(serve, monkeypatch):
    monkeypatch.delenv("CS2_INSIGHT_EDITION", raising=False)
    server = serve({"announcements": [_item()]})

    result = announcements.get_announcements()

    assert server.requests[0]["edition"] == ["free"]
    assert result == {
        "edition": "free",
        "announcements": [
            {
                "id": "a1",
                "level": "info",
                "body_zh": "服务器维护通知",
                "body_en": "Maintenance notice",
                "link_url": "https://ciacut.cc/notice",
            }
        ],
    }


def test_pro_shell_requests_pro_announcements(serve, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_EDITION", "pro")
    server = serve({"announcements": []})

    assert announcements.get_announcements()["edition"] == "pro"
    assert server.requests[0]["edition"] == ["pro"]


def test_unknown_edition_falls_back_to_free(serve, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_EDITION", "enterprise")
    server = serve({"announcements": []})

    announcements.get_announcements()

    assert server.requests[0]["edition"] == ["free"]


def test_invalid_fields_are_dropped_or_normalized(serve):
    serve(
        {
            "announcements": [
                _item(id="plain-http", link_url="http://example.com"),
                _item(id="bad-level", level="danger"),
                _item(id="too-long", body_zh="字" * 501),
                _item(id="", body_zh="missing id"),
                _item(id="no-body", body_zh="   "),
                _item(id="html", body_zh="<b>保持原文</b>", body_en=123),
            ]
        }
    )

    items = {item["id"]: item for item in announcements.get_announcements()["announcements"]}

    assert set(items) == {"plain-http", "bad-level", "html"}
    assert items["plain-http"]["link_url"] is None
    assert items["bad-level"]["level"] == "info"
    assert items["html"]["body_zh"] == "<b>保持原文</b>"
    assert items["html"]["body_en"] is None


def test_at_most_three_announcements_are_returned(serve):
    serve({"announcements": [_item(id=f"a{index}") for index in range(5)]})

    assert [item["id"] for item in announcements.get_announcements()["announcements"]] == [
        "a0",
        "a1",
        "a2",
    ]


def test_results_are_cached_until_refresh_is_forced(serve):
    server = serve({"announcements": [_item()]})

    announcements.get_announcements()
    announcements.get_announcements()
    assert len(server.requests) == 1

    announcements.get_announcements(force_refresh=True)
    assert len(server.requests) == 2


@pytest.mark.parametrize("status, body", [(503, {"detail": "busy"}), (200, ["not", "an", "object"])])
def test_server_errors_yield_no_announcements(serve, status, body):
    serve(body, status)

    assert announcements.get_announcements()["announcements"] == []


def test_unreachable_server_yields_no_announcements(monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_ANNOUNCEMENTS_URL", "http://127.0.0.1:9/unreachable")
    announcements.clear_cache()

    assert announcements.get_announcements()["announcements"] == []
    announcements.clear_cache()


def test_route_returns_announcements(serve):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import desktop

    serve({"announcements": [_item()]})
    app = FastAPI()
    app.include_router(desktop.router)
    with TestClient(app) as client:
        response = client.get("/api/app/announcements")

    assert response.status_code == 200
    assert response.json()["announcements"][0]["id"] == "a1"
