"""Server announcements shown at the top of the guide page."""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode

DEFAULT_ANNOUNCEMENTS_URL = "https://ciacut.cc/auth/v1/public/announcements"
_EDITIONS = {"free", "pro"}
_LEVELS = {"info", "warning"}
_MAX_ITEMS = 3
_MAX_BODY_CHARS = 500
_MAX_ID_CHARS = 64
_MAX_URL_CHARS = 2048
_FETCH_TIMEOUT_SEC = 3.0
# The auth server shares a 3 Mbps uplink with licensing, so clients poll rarely.
_TTL_SEC = 30 * 60
_ERROR_TTL_SEC = 5 * 60
_USER_AGENT = "CS2-Insight-Agent-Announcements/1.0"

_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def current_edition() -> str:
    edition = (os.environ.get("CS2_INSIGHT_EDITION") or "").strip().lower()
    return edition if edition in _EDITIONS else "free"


def _announcements_url() -> str:
    return (os.environ.get("CS2_INSIGHT_ANNOUNCEMENTS_URL") or "").strip() or DEFAULT_ANNOUNCEMENTS_URL


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > _MAX_BODY_CHARS:
        return None
    return text


def _sanitize(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > _MAX_ID_CHARS:
        return None
    body_zh = _text(item.get("body_zh"))
    if body_zh is None:
        return None
    link_url = item.get("link_url")
    if not (isinstance(link_url, str) and link_url.startswith("https://") and len(link_url) <= _MAX_URL_CHARS):
        link_url = None
    level = item.get("level")
    return {
        "id": item_id.strip(),
        "level": level if level in _LEVELS else "info",
        "body_zh": body_zh,
        "body_en": _text(item.get("body_en")),
        "link_url": link_url,
    }


def _fetch(edition: str) -> list[dict[str, Any]]:
    url = f"{_announcements_url()}?{urlencode({'edition': edition})}"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": _USER_AGENT})
    with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT_SEC) as response:
        payload = json.loads(response.read().decode("utf-8"))
    raw_items = payload.get("announcements") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        raise ValueError("announcement payload must contain a list")
    items = [item for item in map(_sanitize, raw_items) if item is not None]
    return items[:_MAX_ITEMS]


def get_announcements(*, force_refresh: bool = False) -> dict[str, Any]:
    edition = current_edition()
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(edition)
        if cached is not None and not force_refresh and now < cached[0]:
            return {"edition": edition, "announcements": list(cached[1])}

    try:
        items = _fetch(edition)
        expiry = now + _TTL_SEC
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeError):
        items = []
        expiry = now + _ERROR_TTL_SEC

    with _cache_lock:
        _cache[edition] = (expiry, items)
    return {"edition": edition, "announcements": list(items)}
