"""Stable API error / status codes for frontend i18n (detail.code or response.code)."""

from __future__ import annotations

from typing import Any, Optional


def error_detail(code: str, **params: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code}
    if params:
        payload["params"] = params
    return payload


def ok_payload(code: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, **extra}
