import json
import sqlite3
from pathlib import Path

import pytest

from app.desktop_data_migration import (
    CANONICAL_CONTAINER_NAME,
    DesktopDataMigrationError,
    MIGRATION_MARKER_NAME,
    migrate_desktop_data,
)


def _write_config(data_root: Path, marker: str) -> None:
    data_root.mkdir(parents=True, exist_ok=True)
    (data_root / "cs2-insight.config.json").write_text(
        json.dumps({"demo_directory": marker}),
        encoding="utf-8",
    )


def _write_database(data_root: Path, marker: str) -> None:
    data_root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_root / "cs2-insight.db")
    try:
        connection.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
        connection.execute("INSERT INTO sentinel(value) VALUES (?)", (marker,))
        connection.commit()
    finally:
        connection.close()


def _read_database(data_root: Path) -> str:
    connection = sqlite3.connect(data_root / "cs2-insight.db")
    try:
        assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
        return connection.execute("SELECT value FROM sentinel").fetchone()[0]
    finally:
        connection.close()


def _canonical(appdata: Path) -> Path:
    return appdata / CANONICAL_CONTAINER_NAME / "data"


def test_migrates_full_electron_data_tree_and_keeps_source(tmp_path: Path):
    source = tmp_path / "cs2-insight-agent" / "data"
    _write_config(source, "electron-config")
    _write_database(source, "electron-db")
    (source / "lite_cut_assets" / "nested").mkdir(parents=True)
    (source / "lite_cut_assets" / "nested" / "clip.json").write_text("asset", encoding="utf-8")
    (source / ".cs2_config_backup").mkdir()
    (source / ".cs2_config_backup" / "restore.cfg").write_text("bind w +forward", encoding="utf-8")

    result = migrate_desktop_data(tmp_path)

    destination = _canonical(tmp_path)
    assert result.mode == "migrated"
    assert result.source == str(tmp_path / "cs2-insight-agent")
    assert json.loads((destination / "cs2-insight.config.json").read_text())["demo_directory"] == "electron-config"
    assert _read_database(destination) == "electron-db"
    assert (destination / "lite_cut_assets" / "nested" / "clip.json").read_text() == "asset"
    assert (destination / ".cs2_config_backup" / "restore.cfg").is_file()
    assert (source / "cs2-insight.config.json").is_file()
    assert (tmp_path / CANONICAL_CONTAINER_NAME / MIGRATION_MARKER_NAME).is_file()


def test_current_tauri_data_wins_when_multiple_legacy_sources_exist(tmp_path: Path):
    tauri = tmp_path / "com.cs2insightagent.app" / "data"
    electron = tmp_path / "cs2-insight-agent" / "data"
    _write_config(tauri, "tauri-newer")
    _write_config(electron, "electron-older")

    result = migrate_desktop_data(tmp_path)

    config = json.loads((_canonical(tmp_path) / "cs2-insight.config.json").read_text())
    assert config["demo_directory"] == "tauri-newer"
    assert result.ignored_sources == (str(tmp_path / "cs2-insight-agent"),)


def test_existing_canonical_data_is_authoritative_and_idempotent(tmp_path: Path):
    destination = _canonical(tmp_path)
    _write_config(destination, "canonical")
    _write_database(destination, "canonical-db")
    _write_config(tmp_path / "cs2-insight-agent" / "data", "legacy")

    first = migrate_desktop_data(tmp_path)
    second = migrate_desktop_data(tmp_path)

    assert first.mode == second.mode == "existing"
    assert json.loads((destination / "cs2-insight.config.json").read_text())["demo_directory"] == "canonical"
    assert _read_database(destination) == "canonical-db"


def test_completion_marker_skips_repeat_database_validation(tmp_path: Path, monkeypatch):
    destination = _canonical(tmp_path)
    _write_config(destination, "canonical")
    _write_database(destination, "canonical-db")
    migrate_desktop_data(tmp_path)

    def fail_if_called(_data_root: Path) -> None:
        raise AssertionError("completed migration must not rescan SQLite on every launch")

    monkeypatch.setattr("app.desktop_data_migration.validate_data_root", fail_if_called)
    result = migrate_desktop_data(tmp_path)

    assert result.mode == "existing"


def test_invalid_completion_marker_is_revalidated_and_rewritten(tmp_path: Path):
    destination = _canonical(tmp_path)
    _write_config(destination, "canonical")
    marker = tmp_path / CANONICAL_CONTAINER_NAME / MIGRATION_MARKER_NAME
    marker.write_text("{}", encoding="utf-8")

    result = migrate_desktop_data(tmp_path)

    assert result.mode == "existing"
    assert json.loads(marker.read_text(encoding="utf-8"))["version"] == 1


def test_empty_canonical_directories_do_not_mask_legacy_data(tmp_path: Path):
    (_canonical(tmp_path) / "logs").mkdir(parents=True)
    _write_config(tmp_path / "cs2-insight-agent" / "data", "legacy")

    result = migrate_desktop_data(tmp_path)

    assert result.mode == "migrated"
    config = json.loads((_canonical(tmp_path) / "cs2-insight.config.json").read_text())
    assert config["demo_directory"] == "legacy"


def test_migrates_legacy_product_name_root_layout(tmp_path: Path):
    container = tmp_path / CANONICAL_CONTAINER_NAME
    _write_config(container, "root-layout")
    _write_database(container, "root-db")
    (container / "logs").mkdir()
    (container / "logs" / "legacy.log").write_text("hello", encoding="utf-8")

    result = migrate_desktop_data(tmp_path)

    destination = _canonical(tmp_path)
    assert result.source_layout == "legacy-root"
    assert json.loads((destination / "cs2-insight.config.json").read_text())["demo_directory"] == "root-layout"
    assert _read_database(destination) == "root-db"
    assert (destination / "logs" / "legacy.log").read_text() == "hello"
    assert (container / "cs2-insight.config.json").is_file()


def test_sqlite_backup_includes_committed_wal_content(tmp_path: Path):
    source = tmp_path / "cs2-insight-agent" / "data"
    source.mkdir(parents=True)
    connection = sqlite3.connect(source / "cs2-insight.db")
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
        connection.execute("INSERT INTO sentinel(value) VALUES ('from-wal')")
        connection.commit()
        assert (source / "cs2-insight.db-wal").exists()

        migrate_desktop_data(tmp_path)
    finally:
        connection.close()

    assert _read_database(_canonical(tmp_path)) == "from-wal"
    assert not (_canonical(tmp_path) / "cs2-insight.db-wal").exists()
    assert not (_canonical(tmp_path) / "cs2-insight.db-shm").exists()


def test_invalid_config_aborts_without_replacing_source(tmp_path: Path):
    source = tmp_path / "cs2-insight-agent" / "data"
    source.mkdir(parents=True)
    (source / "cs2-insight.config.json").write_text("{not-json", encoding="utf-8")

    with pytest.raises(DesktopDataMigrationError, match="配置文件无法解析"):
        migrate_desktop_data(tmp_path)

    assert (source / "cs2-insight.config.json").read_text() == "{not-json"
    assert not _canonical(tmp_path).exists()


def test_corrupt_database_aborts_without_replacing_source(tmp_path: Path):
    source = tmp_path / "com.cs2insightagent.app" / "data"
    source.mkdir(parents=True)
    (source / "cs2-insight.db").write_bytes(b"not a sqlite database")

    with pytest.raises(DesktopDataMigrationError, match="SQLite"):
        migrate_desktop_data(tmp_path)

    assert (source / "cs2-insight.db").read_bytes() == b"not a sqlite database"
    assert not _canonical(tmp_path).exists()


def test_new_install_creates_canonical_data_root(tmp_path: Path):
    result = migrate_desktop_data(tmp_path)

    assert result.mode == "new-install"
    assert (_canonical(tmp_path) / "logs").is_dir()
    assert (tmp_path / CANONICAL_CONTAINER_NAME / MIGRATION_MARKER_NAME).is_file()
