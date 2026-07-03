from pathlib import Path

from app.pov_constants import POV_CORE_FORCED_COMMANDS, command_conflicts_with_pov
from app.pov_hud_manager import resolve_pov_vpk_source_in_project_pov_dir


def test_all_maps_use_default_pov_asset(tmp_path: Path):
    default = tmp_path / "pov_default.vpk"
    default.write_bytes(b"default")
    (tmp_path / "pov_de_dust2.vpk").write_bytes(b"obsolete")

    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_dust2") == default
    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_mirage") == default


def test_pov_forces_rotating_round_scaled_radar():
    expected = {
        "cl_radar_always_centered 1",
        "cl_radar_square_when_spectating 0",
        "cl_radar_scale 0.4",
    }

    assert expected.issubset(POV_CORE_FORCED_COMMANDS)
    assert all(command_conflicts_with_pov(command) for command in expected)
