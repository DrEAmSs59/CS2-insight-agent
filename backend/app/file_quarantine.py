"""Recoverable file removal used by destructive API operations.

Files are moved to the application data directory before database state is
changed.  If the database operation fails, callers restore the files.  A
successful operation intentionally leaves the files in ``trash/`` so a user or
support engineer can recover them after an unexpected failure.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import uuid

from .env_utils import get_data_dir


@dataclass(frozen=True)
class QuarantinedFile:
    original: Path
    quarantined: Path


@dataclass
class QuarantineBatch:
    directory: Path
    files: list[QuarantinedFile]

    def restore(self) -> None:
        errors: list[str] = []
        for item in reversed(self.files):
            if not item.quarantined.exists():
                continue
            try:
                item.original.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(item.quarantined), str(item.original))
            except OSError as exc:
                errors.append(f"{item.original}: {exc}")
        if errors:
            raise OSError("Failed to restore quarantined files: " + "; ".join(errors))


def quarantine_files(paths: list[str | Path], namespace: str) -> QuarantineBatch:
    unique: list[Path] = []
    seen: set[str] = set()
    for raw_path in paths:
        path = Path(raw_path).expanduser().resolve()
        key = str(path).casefold()
        if key in seen or not path.is_file():
            continue
        seen.add(key)
        unique.append(path)

    directory = get_data_dir() / "trash" / namespace / uuid.uuid4().hex
    batch = QuarantineBatch(directory=directory, files=[])
    if not unique:
        return batch

    files_dir = directory / "files"
    files_dir.mkdir(parents=True, exist_ok=False)
    try:
        for index, source in enumerate(unique):
            target = files_dir / f"{index:04d}-{source.name}"
            shutil.move(str(source), str(target))
            batch.files.append(QuarantinedFile(original=source, quarantined=target))
        manifest = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "namespace": namespace,
            "files": [
                {"original": str(item.original), "quarantined": str(item.quarantined)}
                for item in batch.files
            ],
        }
        (directory / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return batch
    except Exception:
        batch.restore()
        raise
