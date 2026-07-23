import json
from pathlib import Path

import pytest

from app.electron_ui_state_migration import (
    ElectronUiStateMigrationError,
    UI_STATE_BACKUP_DIR_NAME,
    UI_STATE_FILE_NAME,
    migrate_electron_ui_state,
)


def _legacy_profile(appdata: Path) -> Path:
    profile = appdata / "cs2-insight-agent"
    leveldb = profile / "Local Storage" / "leveldb"
    leveldb.mkdir(parents=True)
    (leveldb / "000003.log").write_bytes(b"leveldb-state")
    session = profile / "Session Storage"
    session.mkdir()
    (session / "000003.log").write_bytes(b"session-state")
    (profile / "Preferences").write_text("{}", encoding="utf-8")
    return profile


def test_exports_allowlisted_state_and_archives_raw_browser_profile(tmp_path: Path):
    profile = _legacy_profile(tmp_path)
    data_root = tmp_path / "CS2 Insight Agent" / "data"
    executable = tmp_path / "CS2 Insight Agent.exe"
    executable.write_bytes(b"fake")

    result = migrate_electron_ui_state(
        tmp_path,
        data_root,
        require_export=True,
        electron_executable=executable,
        exporter=lambda _exe: {
            "cs2-insight-theme": "light",
            "liteCut:recovery:v1:9": "draft",
            "private-unrelated-key": "must-not-cross-shells",
        },
    )

    state = json.loads((data_root / UI_STATE_FILE_NAME).read_text(encoding="utf-8"))
    assert result.mode == "exported"
    assert state["local_storage"] == {
        "cs2-insight-theme": "light",
        "liteCut:recovery:v1:9": "draft",
    }
    backup = data_root / UI_STATE_BACKUP_DIR_NAME / profile.name
    assert (backup / "Local Storage" / "leveldb" / "000003.log").read_bytes() == b"leveldb-state"
    assert (backup / "Session Storage" / "000003.log").read_bytes() == b"session-state"
    assert (profile / "Local Storage" / "leveldb" / "000003.log").is_file()


def test_existing_export_is_idempotent_and_does_not_launch_electron(tmp_path: Path):
    _legacy_profile(tmp_path)
    data_root = tmp_path / "CS2 Insight Agent" / "data"
    data_root.mkdir(parents=True)
    (data_root / UI_STATE_FILE_NAME).write_text(
        json.dumps({"version": 1, "local_storage": {"cs2-insight-theme": "dark"}}),
        encoding="utf-8",
    )

    result = migrate_electron_ui_state(
        tmp_path,
        data_root,
        require_export=True,
        exporter=lambda _exe: pytest.fail("existing export must not relaunch Electron"),
    )

    assert result.mode == "existing"
    assert result.exported_keys == ("cs2-insight-theme",)


def test_missing_electron_keeps_raw_recovery_copy_without_blocking_tauri_upgrade(
    tmp_path: Path, monkeypatch
):
    profile = _legacy_profile(tmp_path)
    data_root = tmp_path / "CS2 Insight Agent" / "data"
    monkeypatch.setattr(
        "app.electron_ui_state_migration.find_legacy_electron_executable",
        lambda: None,
    )

    result = migrate_electron_ui_state(tmp_path, data_root, require_export=True)

    assert result.mode == "archived"
    backup = data_root / UI_STATE_BACKUP_DIR_NAME / profile.name
    assert (backup / "Local Storage" / "leveldb" / "000003.log").is_file()
    assert (profile / "Local Storage" / "leveldb" / "000003.log").is_file()


def test_required_live_export_failure_aborts_and_keeps_recovery_copy(tmp_path: Path):
    profile = _legacy_profile(tmp_path)
    data_root = tmp_path / "CS2 Insight Agent" / "data"
    executable = tmp_path / "CS2 Insight Agent.exe"
    executable.write_bytes(b"fake")

    with pytest.raises(ElectronUiStateMigrationError, match="could not export"):
        migrate_electron_ui_state(
            tmp_path,
            data_root,
            require_export=True,
            electron_executable=executable,
            exporter=lambda _exe: (_ for _ in ()).throw(RuntimeError("CDP unavailable")),
        )

    backup = data_root / UI_STATE_BACKUP_DIR_NAME / profile.name
    assert (backup / "Local Storage" / "leveldb" / "000003.log").is_file()
    assert (profile / "Local Storage" / "leveldb" / "000003.log").is_file()


def test_clean_install_has_no_ui_migration_work(tmp_path: Path):
    data_root = tmp_path / "CS2 Insight Agent" / "data"

    result = migrate_electron_ui_state(tmp_path, data_root, require_export=True)

    assert result.mode == "none"
    assert not (data_root / UI_STATE_FILE_NAME).exists()
