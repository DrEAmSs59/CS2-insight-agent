"""Streaming file hashes for dedupe (demo / zip)."""

from __future__ import annotations

import hashlib
from pathlib import Path

_DEFAULT_CHUNK = 1024 * 1024


def file_md5_hex(path: Path, *, chunk_size: int = _DEFAULT_CHUNK) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()
