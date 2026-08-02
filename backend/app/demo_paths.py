"""Path resolution shared by Demo upload, analysis and replay APIs."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException

UPLOAD_DIR = Path(tempfile.gettempdir()) / "cs2_insight_demos"
UPLOAD_DIR.mkdir(exist_ok=True)


def resolve_demo_path(path: str, *, upload_dir: Path = UPLOAD_DIR) -> Path:
    """Resolve an absolute Demo path or a filename inside the upload cache."""
    raw = (path or "").strip()
    if not raw:
        raise HTTPException(400, "Demo 路径为空")
    candidate = Path(raw)
    if candidate.is_file():
        return candidate.resolve()
    cached = (upload_dir / candidate.name).resolve()
    if cached.is_file():
        return cached
    raise HTTPException(404, f"未找到 Demo 文件: {raw}")


async def resolve_working_demo_path(
    path: str,
    *,
    demo_db: Any | None = None,
    upload_dir: Path = UPLOAD_DIR,
) -> Path:
    """Prefer library cached working copy; fall back to absolute / upload-dir resolve.

    Historical demos keep ``demo_files.path`` as the original file. Callers that
    parse/play/record should use this helper so I/O hits the cache after materialize.
    """
    raw = (path or "").strip()
    if not raw:
        raise HTTPException(400, "Demo 路径为空")

    if demo_db is not None:
        from .demo_cache import ensure_row_cached

        row = await demo_db.get_demo_by_path(raw)
        if row is None:
            row = await demo_db.get_demo_by_cached_path(raw)
        if row is not None:
            try:
                return await ensure_row_cached(demo_db, row)
            except FileNotFoundError as exc:
                raise HTTPException(404, str(exc)) from exc

    return resolve_demo_path(raw, upload_dir=upload_dir)
