"""Local parse-worker IPC: pickle by default, JSON accepted for old payloads."""

from __future__ import annotations

import json
import pickle
from pathlib import Path
from typing import Any


def dump_message(path: str | Path, payload: Any) -> None:
    Path(path).write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))


def load_message(path: str | Path) -> Any:
    raw = Path(path).read_bytes()
    trimmed = raw.lstrip(b"\xef\xbb\xbf \t\r\n")
    if trimmed[:1] in (b"{", b"["):
        return json.loads(raw.decode("utf-8-sig"))
    return pickle.loads(raw)
