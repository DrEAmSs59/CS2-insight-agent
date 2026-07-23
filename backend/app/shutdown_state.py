"""Bridge between FastAPI shutdown requests and the uvicorn launcher."""

from __future__ import annotations

import threading
from typing import Callable


_lock = threading.Lock()
_request_shutdown: Callable[[], None] | None = None


def register_server_shutdown(callback: Callable[[], None]) -> None:
    global _request_shutdown
    with _lock:
        _request_shutdown = callback


def request_server_shutdown() -> bool:
    with _lock:
        callback = _request_shutdown
    if callback is None:
        return False
    callback()
    return True
