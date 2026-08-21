import json
from pathlib import Path

from app import cs2_config_backup as backup


def _prepare_manifest(monkeypatch, tmp_path: Path, *, original: Path, backup_bytes: bytes) -> Path:
    root = tmp_path / "backup"
    stored = root / "account" / "config.cfg"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(backup_bytes)
    monkeypatch.setattr(backup, "get_backup_root", lambda: root)
    (root / backup.MANIFEST_FILENAME).write_text(
        json.dumps({
            "version": backup.MANIFEST_VERSION,
            "entries": [{
                "original": str(original),
                "existed": True,
                "backup_relpath": "account/config.cfg",
            }],
        }),
        encoding="utf-8",
    )
    backup.write_recording_state("recording")
    return root


def test_restore_reports_success_only_after_byte_verification(monkeypatch, tmp_path: Path):
    original = tmp_path / "userdata" / "config.cfg"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"modified during recording")
    _prepare_manifest(monkeypatch, tmp_path, original=original, backup_bytes=b"before recording")

    result = backup.restore_latest_user_config_backup(skip_cs2_running_check=True)

    assert original.read_bytes() == b"before recording"
    assert result == {
        "ok": True,
        "verified": True,
        "checked": 1,
        "restored": 1,
        "failed": [],
        "source": "manifest",
    }
    assert backup.read_recording_state()["status"] == "recorded"


def test_restore_keeps_recovery_required_when_post_write_verification_fails(
    monkeypatch,
    tmp_path: Path,
):
    original = tmp_path / "userdata" / "config.cfg"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"modified during recording")
    _prepare_manifest(monkeypatch, tmp_path, original=original, backup_bytes=b"before recording")
    monkeypatch.setattr(backup, "_atomic_write_bytes", lambda _target, _data: None)

    result = backup.restore_latest_user_config_backup(skip_cs2_running_check=True)

    assert result["ok"] is False
    assert result["verified"] is False
    assert result["checked"] == 0
    assert result["failed"]
    assert backup.read_recording_state()["status"] == "recording"


def test_config_discovery_and_snapshot_include_steam_remote_files(monkeypatch, tmp_path: Path):
    steam_root = tmp_path / "Steam"
    cs2 = (
        steam_root
        / "steamapps"
        / "common"
        / "Counter-Strike Global Offensive"
        / "game"
        / "bin"
        / "win64"
        / "cs2.exe"
    )
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")

    account = steam_root / "userdata" / "123" / "730"
    local_cfg = account / "local" / "cfg"
    remote = account / "remote"
    local_cfg.mkdir(parents=True)
    remote.mkdir(parents=True)
    local_keys = local_cfg / "cs2_user_keys_0_slot0.vcfg"
    remote_keys = remote / "cs2_user_keys.vcfg"
    remote_convars = remote / "cs2_user_convars.vcfg"
    local_keys.write_bytes(b'local: "ALT" "toggleradarscale"')
    remote_keys.write_bytes(b'remote: "ALT" "toggleradarscale"')
    remote_convars.write_bytes(b'"cl_hud_color" "8"')
    monkeypatch.setattr(backup, "_candidate_steam_roots", lambda: [])

    directories = backup.candidate_user_config_dirs(cs2)
    snapshot = backup.snapshot_user_configs(cs2)

    assert local_cfg in directories
    assert remote in directories
    assert snapshot[local_keys] == b'local: "ALT" "toggleradarscale"'
    assert snapshot[remote_keys] == b'remote: "ALT" "toggleradarscale"'
    assert snapshot[remote_convars] == b'"cl_hud_color" "8"'


def test_memory_snapshot_restores_local_and_remote_player_settings(monkeypatch, tmp_path: Path):
    local_keys = tmp_path / "local" / "cfg" / "cs2_user_keys_0_slot0.vcfg"
    remote_keys = tmp_path / "remote" / "cs2_user_keys.vcfg"
    machine_convars = tmp_path / "local" / "cfg" / "cs2_machine_convars.vcfg"
    for path in (local_keys, remote_keys, machine_convars):
        path.parent.mkdir(parents=True, exist_ok=True)

    snapshot = {
        local_keys: b'"ALT" "toggleradarscale"',
        remote_keys: b'"ALT" "toggleradarscale"',
        machine_convars: b'"cl_hud_color" "8"',
    }
    local_keys.write_bytes(b"")
    remote_keys.write_bytes(b"")
    machine_convars.write_bytes(b'"cl_hud_color" "12"')
    monkeypatch.setattr(backup, "is_restore_required", lambda: False)
    monkeypatch.setattr(backup, "is_cs2_running", lambda: False)

    result = backup.restore_user_config_snapshot(snapshot)

    assert result["ok"] is True
    assert result["verified"] is True
    assert result["restored"] == 3
    assert local_keys.read_bytes() == snapshot[local_keys]
    assert remote_keys.read_bytes() == snapshot[remote_keys]
    assert machine_convars.read_bytes() == snapshot[machine_convars]
