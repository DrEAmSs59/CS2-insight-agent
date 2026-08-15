"""Atomic demo upload storage and trusted-source verification."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import UploadFile

from ...file_hash import file_md5_hex

logger = logging.getLogger(__name__)


def save_uploaded_demo(file: UploadFile, destination: Path) -> str:
    """Save one upload atomically and return the MD5 calculated during that read."""
    if not destination.name or destination.name in {".", ".."}:
        raise ValueError(f"invalid upload destination name: {destination!r}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5()
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.partial")
    try:
        with temporary.open("wb") as writer:
            while chunk := file.file.read(1024 * 1024):
                writer.write(chunk)
                digest.update(chunk)
        try:
            os.replace(temporary, destination)
        except OSError:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                logger.warning(
                    "Could not remove locked upload destination before replace: %s",
                    destination,
                )
            os.replace(temporary, destination)
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
    return digest.hexdigest()


def decode_upload_source_paths(raw: Optional[str], count: int) -> list[Optional[str]]:
    """Decode Electron source paths; malformed browser input safely means no paths."""
    if not raw:
        return [None] * count
    try:
        decoded = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        logger.warning("Ignoring malformed demo upload source_paths_json")
        return [None] * count
    if not isinstance(decoded, list) or len(decoded) != count:
        logger.warning(
            "Ignoring demo upload source paths with unexpected count: expected=%d",
            count,
        )
        return [None] * count
    return [item.strip() if isinstance(item, str) and item.strip() else None for item in decoded]


def verified_upload_source_path(
    raw_source_path: Optional[str],
    uploaded_path: Path,
    uploaded_md5: str,
) -> Path:
    """Use an Electron local path only when it is the exact uploaded demo."""
    if not raw_source_path:
        logger.info(
            "Browser demo upload has no local source path; using uploaded copy: %s",
            uploaded_path,
        )
        return uploaded_path
    try:
        source = Path(raw_source_path).resolve(strict=True)
        if not source.is_file() or source.suffix.lower() != ".dem":
            raise ValueError("source is not a .dem file")
        if source.stat().st_size != uploaded_path.stat().st_size:
            raise ValueError("source size does not match upload")
        if file_md5_hex(source) != uploaded_md5:
            raise ValueError("source content does not match upload")
    except (OSError, ValueError) as exc:
        logger.warning(
            "Demo upload source path was not trusted; using temporary copy: source=%r reason=%s",
            raw_source_path,
            exc,
        )
        return uploaded_path
    logger.info("Verified original demo path for persistent repair: %s", source)
    return source


def upload_source_scope(persistent_path: Path, uploaded_path: Path) -> str:
    try:
        return "uploaded_copy" if persistent_path.resolve() == uploaded_path.resolve() else "original"
    except OSError:
        return "uploaded_copy"
