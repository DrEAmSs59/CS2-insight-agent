"""Safe desktop data migration for the Electron -> Tauri transition.

The desktop shell calls this module before starting the FastAPI backend.  It
converges every supported historical layout on one user-facing directory:

    %APPDATA%/CS2 Insight Agent/data

Legacy sources are copied, validated and retained.  They are never deleted by
the migration, so a failed or interrupted upgrade remains recoverable.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import traceback
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional


CANONICAL_CONTAINER_NAME = "CS2 Insight Agent"
CANONICAL_DATA_DIR_NAME = "data"
MIGRATION_MARKER_NAME = ".desktop-data-migration-v1.json"
MIGRATION_ERROR_LOG_NAME = "desktop-data-migration-error.log"

# Ordered deliberately: an existing Tauri installation is newer than the
# Electron package-name layout and must win when both survived on disk.
LEGACY_CONTAINERS: tuple[tuple[str, str], ...] = (
    ("tauri-identifier", "com.cs2insightagent.app"),
    ("electron-package", "cs2-insight-agent"),
)

LEGACY_ROOT_FILES = (
    "cs2-insight.config.json",
    "cs2-insight.db",
    "cs2-insight.db-wal",
    "cs2-insight.db-shm",
)
LEGACY_ROOT_DIRECTORIES = (
    "logs",
    ".cs2_config_backup",
    ".obs_config_backups",
)


class DesktopDataMigrationError(RuntimeError):
    """Raised when migration cannot prove that the destination is usable."""


@dataclass(frozen=True)
class MigrationSource:
    label: str
    container: Path
    payload: Path
    layout: str  # "data-tree" or "legacy-root"


@dataclass(frozen=True)
class MigrationResult:
    canonical_data_root: str
    mode: str  # "existing", "migrated" or "new-install"
    source: Optional[str]
    source_layout: Optional[str]
    ignored_sources: tuple[str, ...]


def canonical_container(appdata: Path) -> Path:
    return appdata / CANONICAL_CONTAINER_NAME


def canonical_data_root(appdata: Path) -> Path:
    return canonical_container(appdata) / CANONICAL_DATA_DIR_NAME


def _directory_has_payload(path: Path) -> bool:
    if not path.is_dir():
        return False
    return any(item.is_file() for item in path.rglob("*"))


def _legacy_root_has_payload(container: Path) -> bool:
    return any((container / name).exists() for name in (*LEGACY_ROOT_FILES, *LEGACY_ROOT_DIRECTORIES))


def _source_for(label: str, container: Path) -> Optional[MigrationSource]:
    data = container / CANONICAL_DATA_DIR_NAME
    if _directory_has_payload(data):
        return MigrationSource(label=label, container=container, payload=data, layout="data-tree")
    if _legacy_root_has_payload(container):
        return MigrationSource(label=label, container=container, payload=container, layout="legacy-root")
    return None


def discover_legacy_sources(appdata: Path) -> list[MigrationSource]:
    sources: list[MigrationSource] = []
    for label, name in LEGACY_CONTAINERS:
        source = _source_for(label, appdata / name)
        if source is not None:
            sources.append(source)

    # A very old product-name layout can already occupy the canonical
    # container while still keeping config/database files at its root.
    product_legacy = _source_for("electron-product-name", canonical_container(appdata))
    if product_legacy is not None and product_legacy.layout == "legacy-root":
        sources.append(product_legacy)
    return sources


def _copy_legacy_root(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in LEGACY_ROOT_FILES:
        item = source / name
        if item.is_file():
            shutil.copy2(item, destination / name)
    for name in LEGACY_ROOT_DIRECTORIES:
        item = source / name
        if item.is_dir():
            shutil.copytree(item, destination / name, dirs_exist_ok=True)


def _copy_source(source: MigrationSource, destination: Path) -> None:
    if source.layout == "data-tree":
        shutil.copytree(source.payload, destination, dirs_exist_ok=True)
    else:
        _copy_legacy_root(source.payload, destination)


def _sqlite_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def _sqlite_quick_check(path: Path) -> None:
    try:
        connection = sqlite3.connect(_sqlite_uri(path), uri=True, timeout=10)
        try:
            row = connection.execute("PRAGMA quick_check").fetchone()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise DesktopDataMigrationError(f"无法读取 SQLite 数据库 {path}: {exc}") from exc
    if not row or str(row[0]).lower() != "ok":
        detail = row[0] if row else "no result"
        raise DesktopDataMigrationError(f"SQLite quick_check 失败：{detail}")


def _snapshot_sqlite(source_db: Path, destination_db: Path) -> None:
    """Create a consistent SQLite snapshot, including committed WAL content."""

    snapshot = destination_db.with_name(destination_db.name + ".migration-snapshot")
    snapshot.unlink(missing_ok=True)
    source_connection: Optional[sqlite3.Connection] = None
    destination_connection: Optional[sqlite3.Connection] = None
    try:
        source_connection = sqlite3.connect(_sqlite_uri(source_db), uri=True, timeout=10)
        destination_connection = sqlite3.connect(snapshot, timeout=10)
        source_connection.backup(destination_connection)
        destination_connection.commit()
    except sqlite3.Error as exc:
        raise DesktopDataMigrationError(f"无法创建 SQLite 一致性副本：{exc}") from exc
    finally:
        if destination_connection is not None:
            destination_connection.close()
        if source_connection is not None:
            source_connection.close()

    _sqlite_quick_check(snapshot)
    os.replace(snapshot, destination_db)
    destination_db.with_name(destination_db.name + "-wal").unlink(missing_ok=True)
    destination_db.with_name(destination_db.name + "-shm").unlink(missing_ok=True)


def validate_data_root(data_root: Path) -> None:
    config_path = data_root / "cs2-insight.config.json"
    if config_path.exists():
        try:
            parsed = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise DesktopDataMigrationError(f"配置文件无法解析：{config_path}: {exc}") from exc
        if not isinstance(parsed, dict):
            raise DesktopDataMigrationError(f"配置文件必须是 JSON 对象：{config_path}")

    database_path = data_root / "cs2-insight.db"
    if database_path.exists():
        _sqlite_quick_check(database_path)


def _write_json_atomically(path: Path, body: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(body, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _write_marker(appdata: Path, result: MigrationResult) -> None:
    marker = canonical_container(appdata) / MIGRATION_MARKER_NAME
    body = {
        "version": 1,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        **asdict(result),
    }
    _write_json_atomically(marker, body)


def _completed_migration(appdata: Path, destination: Path) -> Optional[MigrationResult]:
    """Return a trusted-enough completion marker without rescanning SQLite."""

    marker = canonical_container(appdata) / MIGRATION_MARKER_NAME
    if not marker.is_file() or not destination.is_dir():
        return None
    try:
        body = json.loads(marker.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    if body.get("version") != 1 or body.get("canonical_data_root") != str(destination):
        return None

    mode = body.get("mode")
    source = body.get("source")
    source_layout = body.get("source_layout")
    ignored_sources = body.get("ignored_sources")
    if mode not in {"existing", "migrated", "new-install"}:
        return None
    if source is not None and not isinstance(source, str):
        return None
    if source_layout not in {None, "data-tree", "legacy-root"}:
        return None
    if not isinstance(ignored_sources, list) or not all(
        isinstance(item, str) for item in ignored_sources
    ):
        return None
    return MigrationResult(
        canonical_data_root=str(destination),
        mode=mode,
        source=source,
        source_layout=source_layout,
        ignored_sources=tuple(ignored_sources),
    )


def _selected_source(sources: Iterable[MigrationSource]) -> tuple[Optional[MigrationSource], tuple[str, ...]]:
    source_list = list(sources)
    if not source_list:
        return None, ()
    selected = source_list[0]
    ignored = tuple(str(item.container) for item in source_list[1:])
    return selected, ignored


def migrate_desktop_data(appdata: Path) -> MigrationResult:
    appdata = appdata.expanduser().resolve()
    destination = canonical_data_root(appdata)
    container = canonical_container(appdata)

    completed = _completed_migration(appdata, destination)
    if completed is not None:
        destination.joinpath("logs").mkdir(parents=True, exist_ok=True)
        return completed

    if _directory_has_payload(destination):
        validate_data_root(destination)
        destination.joinpath("logs").mkdir(parents=True, exist_ok=True)
        sources = discover_legacy_sources(appdata)
        result = MigrationResult(
            canonical_data_root=str(destination),
            mode="existing",
            source=str(destination),
            source_layout="data-tree",
            ignored_sources=tuple(str(source.container) for source in sources),
        )
        _write_marker(appdata, result)
        return result

    sources = discover_legacy_sources(appdata)
    selected, ignored = _selected_source(sources)
    container.mkdir(parents=True, exist_ok=True)

    if selected is None:
        destination.mkdir(parents=True, exist_ok=True)
        destination.joinpath("logs").mkdir(parents=True, exist_ok=True)
        result = MigrationResult(
            canonical_data_root=str(destination),
            mode="new-install",
            source=None,
            source_layout=None,
            ignored_sources=(),
        )
        _write_marker(appdata, result)
        return result

    staging = Path(tempfile.mkdtemp(prefix="data.migrating-", dir=container))
    try:
        _copy_source(selected, staging)
        source_database = (
            selected.payload / "cs2-insight.db"
            if selected.layout == "data-tree"
            else selected.container / "cs2-insight.db"
        )
        if source_database.is_file():
            _snapshot_sqlite(source_database, staging / "cs2-insight.db")
        validate_data_root(staging)
        staging.joinpath("logs").mkdir(parents=True, exist_ok=True)

        if destination.exists():
            if _directory_has_payload(destination):
                raise DesktopDataMigrationError(
                    f"迁移目标在复制期间出现了数据，已中止以避免覆盖：{destination}"
                )
            shutil.rmtree(destination)
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    result = MigrationResult(
        canonical_data_root=str(destination),
        mode="migrated",
        source=str(selected.container),
        source_layout=selected.layout,
        ignored_sources=ignored,
    )
    _write_marker(appdata, result)
    return result


def _append_error_log(appdata: Path, error: BaseException) -> None:
    try:
        container = canonical_container(appdata)
        container.mkdir(parents=True, exist_ok=True)
        with (container / MIGRATION_ERROR_LOG_NAME).open("a", encoding="utf-8") as handle:
            handle.write(f"[{datetime.now(timezone.utc).isoformat()}] {error}\n")
            handle.write(traceback.format_exc())
            handle.write("\n")
    except OSError:
        pass


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Migrate CS2 Insight desktop user data")
    parser.add_argument("--appdata", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = migrate_desktop_data(args.appdata)
    except Exception as exc:
        _append_error_log(args.appdata, exc)
        print(f"desktop data migration failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(asdict(result), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
