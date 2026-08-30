from pathlib import Path
from types import SimpleNamespace

import pytest

from app.pov_constants import POV_CORE_FORCED_COMMANDS
from app import pov_hud_manager
from app.pov_hud_manager import (
    PovHudError,
    PovHudManager,
    gameinfo_loads_pov_vpk,
    remove_pov_gameinfo_entries,
    resolve_pov_vpk_source_in_project_pov_dir,
    restore_pov_after_cs2_exit,
    try_restore_stale_pov_on_startup,
)


def test_all_maps_use_default_pov_asset(tmp_path: Path):
    default = tmp_path / "pov_default.vpk"
    default.write_bytes(b"default")
    (tmp_path / "pov_de_dust2.vpk").write_bytes(b"obsolete")

    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_dust2") == default
    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_mirage") == default


def test_pov_forces_rotating_round_scaled_radar():
    expected = {
        "cl_radar_always_centered 1",
        "cl_radar_square_always false",
        "cl_radar_square_when_spectating 0",
        "cl_radar_scale 0.4",
        "snd_disable_radar_visualize 0",
    }

    assert expected.issubset(POV_CORE_FORCED_COMMANDS)


def test_pov_forces_teammate_hud_color():
    assert "cl_hud_color 12" in POV_CORE_FORCED_COMMANDS


def test_pov_suppresses_demo_player_card_without_replacing_health_hud():
    assert "cl_spec_stats 0" in POV_CORE_FORCED_COMMANDS


def test_pov_forces_native_player_overhead_name_equipment_and_range():
    expected = {
        "mp_forcecamera 0",
        "cl_drawhud_force_teamid_overhead 1",
        "cl_teamid_overhead_mode 3",
        "cl_teamid_overhead_colors_show 1",
        "cl_teamid_overhead_fade_near_crosshair 0",
        "cl_teamid_overhead_maxdist 9999",
        "cl_teamid_overhead_maxdist_spec 9999",
    }

    assert expected.issubset(POV_CORE_FORCED_COMMANDS)


def test_semantic_cleanup_removes_only_active_pov_search_path():
    content = (
        "// Game csgo/pov.vpk\n"
        "Game custom/pov.vpk\n"
        "Game    csgo/pov.vpk    // installed by Agent\n"
        "Game csgo\n"
    )

    cleaned, removed = remove_pov_gameinfo_entries(content)

    assert removed == 1
    assert "// Game csgo/pov.vpk" in cleaned
    assert "Game custom/pov.vpk" in cleaned
    assert gameinfo_loads_pov_vpk(cleaned) is False


def test_pov_restore_removes_session_backup_and_next_install_uses_fresh_gameinfo(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    original = 'FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n'
    updated = original.replace("FileSystem", "FileSystem // updated")
    gameinfo.write_text(original, encoding="utf-8")
    pov_source = tmp_path / "pov_default.vpk"
    pov_source.write_bytes(b"pov")

    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_pov_vpk_source_path", lambda _map=None: pov_source)

    manager.install()
    assert "csgo/pov.vpk" in gameinfo.read_text(encoding="utf-8")
    assert manager._read_manifest()["state"] == "installed"
    verification = manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == original
    assert verification["verified"] is True
    assert verification["gameinfo_restored"] is True
    assert verification["pov_vpk_removed"] is True
    assert verification["verification_mode"] == "strict"
    assert verification["byte_verified"] is True
    assert verification["expected_gameinfo_sha256"] == verification["actual_gameinfo_sha256"]
    assert not manager.get_backup_dir().exists()

    repeated = manager.restore()
    assert repeated["verified"] is True
    assert repeated["not_needed"] is True
    assert repeated["verification_mode"] == "none"

    gameinfo.write_text(updated, encoding="utf-8")
    manager.install()
    manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == updated


def test_pov_install_rolls_back_when_target_vpk_cannot_be_written(
    monkeypatch,
    tmp_path: Path,
):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    original = 'FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n'
    gameinfo.write_text(original, encoding="utf-8")
    pov_source = tmp_path / "pov_default.vpk"
    pov_source.write_bytes(b"pov")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_pov_vpk_source_path", lambda _map=None: pov_source)
    original_atomic_copy = pov_hud_manager._atomic_copy

    def deny_target_vpk(source: Path, target: Path):
        if target.name == "pov.vpk":
            raise PermissionError("access denied")
        return original_atomic_copy(source, target)

    monkeypatch.setattr(pov_hud_manager, "_atomic_copy", deny_target_vpk)

    with pytest.raises(PovHudError, match="无法写入 POV HUD 文件"):
        manager.install()

    assert gameinfo.read_text(encoding="utf-8") == original
    assert not (csgo / "pov.vpk").exists()
    assert not manager.get_manifest_path().exists()
    assert not manager.get_backup_gameinfo_path().exists()


def test_pov_restore_falls_back_to_semantic_cleanup_for_tampered_backup(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text('FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n', encoding="utf-8")
    pov_source = tmp_path / "pov_default.vpk"
    pov_source.write_bytes(b"pov")

    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_pov_vpk_source_path", lambda _map=None: pov_source)
    manager.install()
    manager.get_backup_gameinfo_path().write_bytes(b"tampered backup")

    verification = manager.restore()

    assert verification["verified"] is True
    assert verification["verification_mode"] == "semantic"
    assert verification["byte_verified"] is False
    assert verification["strict_fallback_reason"] == "backup_hash_mismatch"
    assert verification["pov_vpk_exists"] is False
    assert verification["gameinfo_has_pov_entry"] is False
    assert not manager.get_backup_dir().exists()


def test_pov_restore_cleans_agent_residue_without_manifest(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text(
        'FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo/pov.vpk\n'
        '    Game    custom_addon\n    Game    csgo\n  }\n}\n',
        encoding="utf-8",
    )
    (csgo / "pov.vpk").write_bytes(b"agent generated")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))

    assert manager.status()["state"] == "orphaned"
    verification = manager.restore()

    assert verification["verified"] is True
    assert verification["verification_mode"] == "semantic"
    assert verification["removed_gameinfo_entries"] == 1
    assert "custom_addon" in gameinfo.read_text(encoding="utf-8")
    assert "csgo/pov.vpk" not in gameinfo.read_text(encoding="utf-8")
    assert not (csgo / "pov.vpk").exists()


def test_pov_restore_cleans_orphaned_backup_without_manifest(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text("Game csgo\n", encoding="utf-8")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    manager.get_backup_dir().mkdir()
    manager.get_backup_gameinfo_path().write_text("orphan", encoding="utf-8")

    assert manager.status()["state"] == "orphaned"
    verification = manager.restore()

    assert verification["verified"] is True
    assert verification["verification_mode"] == "semantic"
    assert not manager.get_backup_dir().exists()


def test_shared_restore_accepts_semantic_cleanup_without_original_hash(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    (csgo / "gameinfo.gi").write_text(
        'FileSystem\n{\n  SearchPaths\n  {\n    Game csgo/pov.vpk\n    Game csgo\n  }\n}\n',
        encoding="utf-8",
    )
    (csgo / "pov.vpk").write_bytes(b"residue")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))

    verification = restore_pov_after_cs2_exit(
        manager,
        None,
        is_running=lambda: False,
        sleep=lambda _seconds: None,
        max_attempts=1,
    )

    assert verification["verified"] is True
    assert verification["verification_mode"] == "semantic"


def test_startup_recovery_cleans_orphaned_pov_files(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text(
        'FileSystem\n{\n  SearchPaths\n  {\n    Game csgo/pov.vpk\n    Game csgo\n  }\n}\n',
        encoding="utf-8",
    )
    (csgo / "pov.vpk").write_bytes(b"residue")

    messages = try_restore_stale_pov_on_startup(SimpleNamespace(cs2_path=str(cs2)))

    assert messages == ["已自动清理上次遗留的 POV HUD 文件和 gameinfo.gi 加载项。"]
    assert "csgo/pov.vpk" not in gameinfo.read_text(encoding="utf-8")
    assert not (csgo / "pov.vpk").exists()


def test_shared_pov_restore_retries_until_strict_verification_passes():
    expected_sha = "a" * 64
    sleeps: list[float] = []

    class FakeManager:
        def __init__(self):
            self.restore_calls = 0
            self.restored = False

        def status(self):
            return {
                "needs_restore": not self.restored,
                "original_gameinfo_sha256": expected_sha.upper(),
            }

        def restore(self):
            self.restore_calls += 1
            if self.restore_calls == 1:
                raise PovHudError("files are still locked")
            self.restored = True
            return self.verify_restoration(expected_sha)

        def verify_restoration(self, expected_gameinfo_sha256=None):
            return {
                "verified": self.restored and expected_gameinfo_sha256 == expected_sha,
                "gameinfo_restored": self.restored,
                "pov_vpk_removed": self.restored,
                "expected_gameinfo_sha256": expected_gameinfo_sha256,
                "actual_gameinfo_sha256": expected_sha if self.restored else "b" * 64,
            }

    manager = FakeManager()
    verification = restore_pov_after_cs2_exit(
        manager,
        None,
        is_running=lambda: False,
        sleep=sleeps.append,
        max_attempts=3,
    )

    assert manager.restore_calls == 2
    assert sleeps == [0.5]
    assert verification["verified"] is True
    assert verification["expected_gameinfo_sha256"] == expected_sha


def test_shared_pov_restore_never_infers_success_without_original_hash():
    class FakeManager:
        @staticmethod
        def status():
            return {"needs_restore": False, "original_gameinfo_sha256": None}

        @staticmethod
        def verify_restoration(expected_gameinfo_sha256=None):
            return {
                "verified": True,
                "gameinfo_restored": True,
                "pov_vpk_removed": True,
                "expected_gameinfo_sha256": expected_gameinfo_sha256,
            }

    verification = restore_pov_after_cs2_exit(
        FakeManager(),
        None,
        is_running=lambda: False,
        sleep=lambda _seconds: None,
        max_attempts=1,
    )

    assert verification["verified"] is False
    assert "without the original gameinfo.gi hash" in verification["error"]
