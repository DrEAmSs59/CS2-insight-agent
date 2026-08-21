from pathlib import Path

from app import cs2_config_backup, obs_director
from app.obs_director import OBSDirector, _empty_voice_ban_payload


KV3_HEADER = (
    "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} "
    "format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->"
)


def _modern_voice_ban(steam_id: int = 76561198386265483) -> bytes:
    return (
        f"{KV3_HEADER}\n"
        "{\n"
        "\tusers =\n"
        "\t[\n"
        "\t\t{\n"
        "\t\t\tflags = 3\n"
        f"\t\t\tsteamid = {steam_id}\n"
        "\t\t},\n"
        "\t]\n"
        "\tplayer_volume_map = null\n"
        "}\n"
    ).encode("utf-8")


def _bare_director() -> OBSDirector:
    director = OBSDirector.__new__(OBSDirector)
    director.cs2_path = ""
    director._user_config_snapshot = {}
    director._candidate_user_config_dirs = lambda: []
    return director


def test_empty_voice_ban_payload_preserves_modern_kv3_format():
    payload = _empty_voice_ban_payload(_modern_voice_ban())

    text = payload.decode("utf-8")
    assert text.startswith(KV3_HEADER)
    assert "users =\n\t[\n\t]" in text
    assert "player_volume_map = null" in text
    assert "steamid" not in text
    assert "flags" not in text


def test_empty_voice_ban_payload_keeps_legacy_binary_format():
    assert _empty_voice_ban_payload(b"legacy binary entries") == b"\0\0\0\0"


def test_voice_ban_paths_find_modern_remote_file(monkeypatch, tmp_path: Path):
    steam_root = tmp_path / "Steam"
    voice_ban = steam_root / "userdata" / "123" / "730" / "remote" / "voice_ban.dt"
    voice_ban.parent.mkdir(parents=True)
    voice_ban.write_bytes(_modern_voice_ban())
    monkeypatch.setattr(obs_director, "_candidate_steam_roots", lambda: [steam_root])
    director = _bare_director()

    assert director._voice_ban_paths() == [voice_ban]


def test_voice_ban_is_snapshotted_cleared_and_restored(monkeypatch, tmp_path: Path):
    voice_ban = tmp_path / "userdata" / "123" / "730" / "remote" / "voice_ban.dt"
    voice_ban.parent.mkdir(parents=True)
    original = _modern_voice_ban()
    voice_ban.write_bytes(original)
    director = _bare_director()
    director._voice_ban_paths = lambda: [voice_ban]
    captured = {}
    monkeypatch.setattr(
        obs_director,
        "write_persistent_backup_from_snap",
        lambda snap: captured.update(snap),
    )
    monkeypatch.setattr(cs2_config_backup, "is_restore_required", lambda: False)

    director._snapshot_user_configs()
    director._clear_voice_ban_files()

    assert captured[voice_ban] == original
    assert director._user_config_snapshot[voice_ban] == original
    assert voice_ban.read_bytes() == _empty_voice_ban_payload(original)

    result = director._restore_user_configs()

    assert result["ok"] is True
    assert result["verified"] is True
    assert voice_ban.read_bytes() == original
