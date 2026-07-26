"""Path resolution shared by Demo upload, analysis and replay APIs."""

import tempfile
from pathlib import Path

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
