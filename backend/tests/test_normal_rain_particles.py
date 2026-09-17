from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import pov_hud_manager
from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app.pov_hud_manager import PovHudError, PovHudManager
from app.weather_particle_vpk import (
    RAIN_PARTICLE_MAP_PATHS,
    WeatherParticleVpkError,
    compose_rain_particle_override_vpk,
)

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "pov/weather_effects/rain_particles"
PARTICLE = "particles/rain_fx/rain_single_128.vpcf_c"
# These stand for the normal project's existing layers, including user sky selection.
BASE = {
    "panorama/test.vjs_c": b"normal-hud",
    "materials/skybox/sky_de_mirage.vmat_c": b"normal-sky",
    "lighting/postprocessing/de_mirage_prefab/de_mirage.vpost_c": b"normal-post",
    "materials/normal-ground.vmat_c": b"normal-ground",
    "particles/native-map-effect.vpcf_c": b"normal-particle",
}


@pytest.mark.parametrize("map_name", sorted(RAIN_PARTICLE_MAP_PATHS))
def test_rain_composition_changes_only_the_accepted_particle(map_name):
    result = compose_rain_particle_override_vpk(
        assets_dir=ASSETS, map_name=map_name, base_vpk_bytes=write_inline_vpk(BASE),
    )
    entries = read_inline_vpk(result.vpk_bytes)
    payload = entries.pop(PARTICLE)
    assert entries == BASE
    assert hashlib.sha256(payload).hexdigest() == "8886c3d877b41a27b14dcce350f1839dd14d2a7802783c24a2be99e466382191"
    assert result.metadata["target_particle"] == PARTICLE
    # Re-composition is idempotent; no additional resources can leak in.
    assert compose_rain_particle_override_vpk(
        assets_dir=ASSETS, map_name=map_name, base_vpk_bytes=result.vpk_bytes,
    ).vpk_bytes == result.vpk_bytes


@pytest.mark.parametrize("failure", ["missing", "tampered", "conflict", "unsupported"])
def test_rain_rejects_invalid_assets_or_conflicting_overrides(tmp_path, failure):
    assets = tmp_path / "particles"
    shutil.copytree(ASSETS, assets)
    particle = assets / Path(PARTICLE).name
    base = write_inline_vpk(BASE)
    map_name = "de_cache"
    if failure == "missing":
        particle.unlink()
    elif failure == "tampered":
        data = bytearray(particle.read_bytes())
        data[-1] ^= 1
        particle.write_bytes(data)
    elif failure == "conflict":
        base = write_inline_vpk({**BASE, PARTICLE: b"conflicting override"})
    else:
        map_name = "de_train"
    with pytest.raises(WeatherParticleVpkError):
        compose_rain_particle_override_vpk(assets_dir=assets, map_name=map_name, base_vpk_bytes=base)


def _manager(monkeypatch, tmp_path, map_name):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    cs2 = tmp_path / "game/bin/win64/cs2.exe"
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    csgo = tmp_path / "game/csgo"
    (csgo / "maps").mkdir(parents=True)
    original_info = b"FileSystem\n{\n SearchPaths\n {\n Game csgo\n }\n}\n"
    (csgo / "gameinfo.gi").write_bytes(original_info)
    original_map = b"normal-original-map"
    (csgo / f"maps/{map_name}.vpk").write_bytes(original_map)
    assets = tmp_path / "assets"
    (assets / "map_materials").mkdir(parents=True)
    (assets / "weather_effects/rain").mkdir(parents=True)
    (assets / "weather_effects/rain/manifest.json").write_text('{"maps": {}}', encoding="utf-8")
    (assets / "pov_default.vpk").write_bytes(write_inline_vpk(BASE))
    shutil.copytree(ASSETS, assets / "weather_effects/rain_particles")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: assets)
    monkeypatch.setattr(pov_hud_manager, "compose_recording_map_material_vpk", lambda **_: write_inline_vpk(BASE))

    def unchanged_layer(**kwargs):
        return SimpleNamespace(vpk_bytes=kwargs["base_vpk_bytes"], metadata={"normal_layer": True})

    monkeypatch.setattr(pov_hud_manager, "compose_map_sun_suppression_vpk", unchanged_layer)
    monkeypatch.setattr(pov_hud_manager, "compose_train_environment_postprocess_vpk", unchanged_layer)

    def build_map(**kwargs):
        target = kwargs["output_path"]
        payload = b"normal-map-with-refined-rain-hosts"
        target.write_bytes(payload)
        return SimpleNamespace(logical_path=f"maps/{map_name}.vpk", output_path=target, metadata={
            "source": {"size": len(original_map), "sha256": hashlib.sha256(original_map).hexdigest()},
            "output": {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
        })

    monkeypatch.setattr(pov_hud_manager, "build_chroma_main_map_vpk", build_map)
    return manager, csgo, assets, original_info, original_map


@pytest.mark.parametrize("map_name", sorted(RAIN_PARTICLE_MAP_PATHS))
def test_manager_installs_only_rain_delta_and_restores(monkeypatch, tmp_path, map_name):
    manager, csgo, _, original_info, original_map = _manager(monkeypatch, tmp_path, map_name)
    manager.install(map_name=map_name, weather_effect_id="rain")
    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries.pop(PARTICLE) == (ASSETS / Path(PARTICLE).name).read_bytes()
    assert entries == BASE
    manifest = manager._read_manifest()
    assert manifest["weather_particle_override"]["effect_id"] == "rain"
    assert (csgo / f"maps/{map_name}.vpk").read_bytes() == b"normal-map-with-refined-rain-hosts"
    assert manager.restore()["verified"]
    assert (csgo / f"maps/{map_name}.vpk").read_bytes() == original_map
    assert (csgo / "gameinfo.gi").read_bytes() == original_info
    assert not (csgo / "pov.vpk").exists()
    manager.install(map_name=map_name, weather_effect_id="default")
    assert read_inline_vpk((csgo / "pov.vpk").read_bytes()) == BASE
    assert manager._read_manifest()["weather_particle_override"] is None
    assert manager.restore()["verified"]


def test_manager_rejects_bad_particle_before_game_changes(monkeypatch, tmp_path):
    manager, csgo, assets, original_info, original_map = _manager(monkeypatch, tmp_path, "de_cache")
    (assets / "weather_effects/rain_particles/rain_single_128.vpcf_c").write_bytes(b"invalid")
    with pytest.raises(PovHudError, match="雨滴粒子"):
        manager.install(map_name="de_cache", weather_effect_id="rain")
    assert (csgo / "gameinfo.gi").read_bytes() == original_info
    assert (csgo / "maps/de_cache.vpk").read_bytes() == original_map
    assert not (csgo / "pov.vpk").exists()
