# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Ephemeral authentication for the Tauri-owned localhost backend."""

from __future__ import annotations

import os
import secrets
from urllib.parse import parse_qsl, urlencode

from fastapi import Request


SESSION_TOKEN_HEADER = "X-CS2-Insight-Token"
SESSION_TOKEN_QUERY = "_session"
SESSION_WEBSOCKET_PROTOCOL = "cs2-insight"

# Consume the inherited secret before the backend launches OBS, CS2 or FFmpeg.
# Those child processes do not need to inherit the desktop control token.
_SESSION_TOKEN = os.environ.pop("CS2_INSIGHT_SESSION_TOKEN", "").strip()


def session_auth_enabled() -> bool:
    return bool(_SESSION_TOKEN)


def session_token_matches(candidate: str | None) -> bool:
    if not _SESSION_TOKEN:
        return True
    value = str(candidate or "").strip()
    return bool(value) and secrets.compare_digest(value, _SESSION_TOKEN)


def request_session_token(request: Request) -> str:
    return str(
        request.headers.get(SESSION_TOKEN_HEADER)
        or request.query_params.get(SESSION_TOKEN_QUERY)
        or ""
    )


def strip_session_token_query(scope: dict) -> None:
    """Remove the URL credential before routing and access logging."""
    raw = scope.get("query_string") or b""
    if not raw or SESSION_TOKEN_QUERY.encode("ascii") not in raw:
        return
    try:
        pairs = parse_qsl(raw.decode("utf-8"), keep_blank_values=True)
        clean = [(key, value) for key, value in pairs if key != SESSION_TOKEN_QUERY]
        scope["query_string"] = urlencode(clean, doseq=True).encode("utf-8")
    except (UnicodeError, ValueError):
        # Authentication already consumed the value. A malformed remainder is
        # left untouched so the owning endpoint can return its normal 4xx.
        return


def authorize_websocket_protocols(protocol_header: str | None) -> tuple[bool, str | None]:
    if not _SESSION_TOKEN:
        return True, None
    offered = [value.strip() for value in str(protocol_header or "").split(",") if value.strip()]
    if SESSION_WEBSOCKET_PROTOCOL not in offered:
        return False, None
    if not any(session_token_matches(value) for value in offered):
        return False, None
    return True, SESSION_WEBSOCKET_PROTOCOL


def overlay_session_fragment() -> str:
    return f"#session={_SESSION_TOKEN}" if _SESSION_TOKEN else ""
