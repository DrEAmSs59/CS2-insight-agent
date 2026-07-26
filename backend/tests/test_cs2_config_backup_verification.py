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
