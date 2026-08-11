"""FastAPI translation kept at the outer edge of LiteCut services."""

from __future__ import annotations

from typing import Any, Awaitable, TypeVar

from fastapi import HTTPException

from ...api_errors import error_detail
from .services import LiteCutServiceError

T = TypeVar("T")


async def service_call(awaitable: Awaitable[T]) -> T:
    try:
        return await awaitable
    except LiteCutServiceError as exc:
        detail: Any = exc.detail
        if exc.code and isinstance(detail, str):
            detail = error_detail(detail)
        elif isinstance(detail, dict) and detail.get("reason") and detail.get("code"):
            detail = error_detail(str(detail["code"]), reason=str(detail["reason"]))
        raise HTTPException(exc.status_code, detail) from exc
