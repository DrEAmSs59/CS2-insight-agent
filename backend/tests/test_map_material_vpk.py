import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.chroma_skybox_child import ChromaChildVpkBuild
from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app import pov_hud_manager
from app.map_material_vpk import (
    DEFAULT_MAP_MATERIAL_ID,
    MAP_MATERIAL_IDS,
    RAIN_PUDDLES_MAP_MATERIAL_ID,
    SNOW_GROUND_MAP_MATERIAL_ID,
    WAXED_REFLECTION_LIGHTING_COMMANDS,
    WAXED_REFLECTION_MAP_MATERIAL_ID,
    MapMaterialVpkError,
    compose_recording_map_material_vpk,
    map_material_console_commands,
    normalize_map_material_id,
)
from app.map_sun_vpk import MAP_SUN_VISUAL_MATERIAL_PATHS
from app.pov_hud_manager import PovHudManager
from app.skybox_vpk import (
    CHROMA_ACTIVE_SKY_MATERIAL_PATH,
    MAP_SKY_MATERIAL_PATHS,
    SKYBOX_ASSETS,
    compose_recording_skybox_vpk,
)


def _write_profile(root: Path) -> Path:
    profile = root / WAXED_REFLECTION_MAP_MATERIAL_ID
    profile.mkdir(parents=True)
    catalog_entries = {
        "catalog/shared/normal.vtex_c": b"normal",
        "catalog/dust2/floor.vmat_c": b"dust-floor",
        "catalog/mirage/wall.vmat_c": b"mirage-wall",
    }
    catalog = write_inline_vpk(catalog_entries)
    manifest = {
        "schema_version": 1,
        "id": WAXED_REFLECTION_MAP_MATERIAL_ID,
        "lighting_commands": list(WAXED_REFLECTION_LIGHTING_COMMANDS),
        "catalog_sha256": hashlib.sha256(catalog).hexdigest(),
        "shared_entries": [
            {
                "target": "materials/cs2_insight/flat_normal.vtex_c",
                "catalog": "catalog/shared/normal.vtex_c",
                "sha256": hashlib.sha256(b"normal").hexdigest(),
            }
        ],
        "maps": {
            "de_dust2": [
                {
                    "target": "materials/ground/floor.vmat_c",
                    "catalog": "catalog/dust2/floor.vmat_c",
                    "sha256": hashlib.sha256(b"dust-floor").hexdigest(),
                }
            ],
            "de_mirage": [
                {
                    "target": "materials/walls/wall.vmat_c",
                    "catalog": "catalog/mirage/wall.vmat_c",
                    "sha256": hashlib.sha256(b"mirage-wall").hexdigest(),
                }
            ],
        },
    }
    (profile / "catalog.vpk").write_bytes(catalog)
    (profile / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def _manager_for_tmp_game(monkeypatch, tmp_path: Path) -> tuple[PovHudManager, Path, Path]:
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    core_dir = game_root / "core"
    core_dir.mkdir()
    (core_dir / "pak01_dir.vpk").write_bytes(
        write_inline_vpk(
            {
                "materials/models/editor/editor_transparent.vmat_c": (
                    b"transparent-sun"
                )
            }
        )
    )
    (csgo / "gameinfo.gi").write_text(
        "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n",
        encoding="utf-8",
    )
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)
    return manager, pov_dir, csgo


def test_map_material_ids_and_lighting_commands() -> None:
    assert MAP_MATERIAL_IDS == (
        "default",
        "waxed_reflection",
        "snow_ground",
        "rain_puddles",
    )
    assert normalize_map_material_id(" WAXED_REFLECTION ") == "waxed_reflection"
    assert normalize_map_material_id(" SNOW_GROUND ") == SNOW_GROUND_MAP_MATERIAL_ID
    assert normalize_map_material_id(" RAIN_PUDDLES ") == RAIN_PUDDLES_MAP_MATERIAL_ID
    assert map_material_console_commands("default") == ()
    assert map_material_console_commands("waxed_reflection") == WAXED_REFLECTION_LIGHTING_COMMANDS
    assert map_material_console_commands(SNOW_GROUND_MAP_MATERIAL_ID) == ()
    assert map_material_console_commands(RAIN_PUDDLES_MAP_MATERIAL_ID) == ()
    assert "r_rendersun 0" in WAXED_REFLECTION_LIGHTING_COMMANDS
    assert "r_directlighting 0" in WAXED_REFLECTION_LIGHTING_COMMANDS
    assert "r_indirectlighting 1" in WAXED_REFLECTION_LIGHTING_COMMANDS
    with pytest.raises(MapMaterialVpkError, match="unsupported"):
        normalize_map_material_id("mirror_everything")


def test_compose_selects_only_the_requested_map_and_preserves_base(tmp_path: Path) -> None:
    assets = _write_profile(tmp_path / "map_materials")
    base = write_inline_vpk({"panorama/layout/base.vxml_c": b"hud"})
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id="waxed_reflection",
        map_name="maps/de_dust2.vpk",
        base_vpk_bytes=base,
    )
    entries = read_inline_vpk(package)
    assert entries == {
        "panorama/layout/base.vxml_c": b"hud",
        "materials/cs2_insight/flat_normal.vtex_c": b"normal",
        "materials/ground/floor.vmat_c": b"dust-floor",
    }
    assert "materials/walls/wall.vmat_c" not in entries
    assert not any(path.startswith("catalog/") for path in entries)


def test_default_requires_no_material_only_vpk(tmp_path: Path) -> None:
    base = write_inline_vpk({"panorama/base.txt": b"hud"})
    assert compose_recording_map_material_vpk(
        assets_dir=tmp_path,
        material_id=DEFAULT_MAP_MATERIAL_ID,
        map_name="de_dust2",
        base_vpk_bytes=base,
    ) == base
    with pytest.raises(MapMaterialVpkError, match="does not require"):
        compose_recording_map_material_vpk(
            assets_dir=tmp_path,
            material_id=DEFAULT_MAP_MATERIAL_ID,
            map_name="de_dust2",
        )


def test_unsupported_map_and_tampered_catalog_fail_closed(tmp_path: Path) -> None:
    assets = _write_profile(tmp_path / "map_materials")
    with pytest.raises(MapMaterialVpkError, match="does not support map"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id="waxed_reflection",
            map_name="de_train",
        )

    catalog = assets / "waxed_reflection" / "catalog.vpk"
    catalog.write_bytes(catalog.read_bytes() + b"tampered")
    with pytest.raises(MapMaterialVpkError, match="catalog hash"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id="waxed_reflection",
            map_name="de_dust2",
        )


def test_manager_installs_material_only_without_pov_panorama(monkeypatch, tmp_path: Path) -> None:
    manager, pov_dir, csgo = _manager_for_tmp_game(monkeypatch, tmp_path)
    _write_profile(pov_dir / "map_materials")

    manager.install(map_name="de_dust2", map_material_id="waxed_reflection")

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries == {
        "materials/cs2_insight/flat_normal.vtex_c": b"normal",
        "materials/ground/floor.vmat_c": b"dust-floor",
    }
    assert not any(path.startswith("panorama/") for path in entries)
    manifest = manager._read_manifest()
    assert manifest["feature"] == "recording_map_material"
    assert manifest["recording_map_material_id"] == "waxed_reflection"

    restored = manager.restore()
    assert restored["verified"] is True
    assert not (csgo / "pov.vpk").exists()
    assert "csgo/pov.vpk" not in (csgo / "gameinfo.gi").read_text(encoding="utf-8")


def test_manager_merges_material_and_skybox_into_one_runtime_vpk(
    monkeypatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo = _manager_for_tmp_game(monkeypatch, tmp_path)
    _write_profile(pov_dir / "map_materials")
    material_path, texture_path = SKYBOX_ASSETS["cartoon3"]
    skybox_dir = pov_dir / "skyboxes" / "cartoon3"
    skybox_dir.mkdir(parents=True)
    (skybox_dir / Path(material_path).name).write_bytes(b"sky-material")
    (skybox_dir / Path(texture_path).name).write_bytes(b"sky-texture")

    manager.install(
        map_name="de_dust2",
        map_material_id="waxed_reflection",
        skybox_id="cartoon3",
    )

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries["materials/ground/floor.vmat_c"] == b"dust-floor"
    assert entries[material_path] == b"sky-material"
    assert entries[texture_path] == b"sky-texture"
    assert entries[MAP_SKY_MATERIAL_PATHS["de_dust2"][0]] == b"sky-material"
    for target in MAP_SUN_VISUAL_MATERIAL_PATHS["de_dust2"]:
        assert entries[target] == b"transparent-sun"
    manifest = manager._read_manifest()
    assert manifest["feature"] == "recording_map_material_with_skybox"
    assert manifest["map_sun_suppression"]["light_environment_modified"] is False


def test_rain_uses_train_overcast_for_default_but_allows_a_skybox_override(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    rain_package = compose_recording_map_material_vpk(
        assets_dir=project_root / "pov" / "map_materials",
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_anubis",
    )
    target_sky = MAP_SKY_MATERIAL_PATHS["de_anubis"][0]
    rain_entries = read_inline_vpk(rain_package)
    assert hashlib.sha256(rain_entries[target_sky]).hexdigest() == (
        "afbb3798fc64181b63a97e1e99f18a8fab0f273865802892c3bef1e232e18d8f"
    )

    material_path, texture_path = SKYBOX_ASSETS["cartoon3"]
    skybox_dir = tmp_path / "skyboxes" / "cartoon3"
    skybox_dir.mkdir(parents=True)
    (skybox_dir / Path(material_path).name).write_bytes(b"custom-rain-sky")
    (skybox_dir / Path(texture_path).name).write_bytes(b"custom-rain-texture")
    overridden = compose_recording_skybox_vpk(
        builtin_assets_dir=tmp_path / "skyboxes",
        base_vpk_bytes=rain_package,
        skybox_id="cartoon3",
        map_name="de_anubis",
    )
    overridden_entries = read_inline_vpk(overridden)
    assert overridden_entries[target_sky] == b"custom-rain-sky"
    assert overridden_entries[texture_path] == b"custom-rain-texture"


def test_manager_merges_waxed_material_chroma_and_verified_child_into_one_vpk(
    monkeypatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo = _manager_for_tmp_game(monkeypatch, tmp_path)
    _write_profile(pov_dir / "map_materials")
    original_material_path, texture_path = SKYBOX_ASSETS["chroma_blue"]
    skybox_dir = pov_dir / "skyboxes" / "chroma_blue"
    skybox_dir.mkdir(parents=True)
    (skybox_dir / Path(original_material_path).name).write_bytes(b"blue-material")
    (skybox_dir / Path(texture_path).name).write_bytes(b"blue-texture")
    child_assets = pov_dir / "chroma_skybox_children"
    child_assets.mkdir()
    (child_assets / "payloads").mkdir()
    (child_assets / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "maps": {
                    "de_dust2": {"main_map_patch_required": False},
                },
            }
        ),
        encoding="utf-8",
    )
    main_assets = pov_dir / "chroma_main_maps"
    main_assets.mkdir()
    (main_assets / "payloads").mkdir()
    (main_assets / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "no_main_patch_required": ["de_dust2"],
                "maps": {},
            }
        ),
        encoding="utf-8",
    )

    logical_path = "maps/prefabs/de_dust2/de_dust2_skybox.vpk"
    official_bytes = b"official-child"
    official_child = csgo / Path(logical_path)
    official_child.parent.mkdir(parents=True)
    official_child.write_bytes(official_bytes)
    child_vpk = write_inline_vpk({"nested/verified.txt": b"child"})
    child_metadata = {
        "map_name": "de_dust2",
        "status": "validated",
        "logical_path": logical_path,
        "source": {
            "sha256": hashlib.sha256(official_bytes).hexdigest(),
            "size": len(official_bytes),
        },
        "output": {
            "sha256": hashlib.sha256(child_vpk).hexdigest(),
            "size": len(child_vpk),
        },
    }
    monkeypatch.setattr(
        pov_hud_manager,
        "build_chroma_child_vpk",
        lambda **_kwargs: ChromaChildVpkBuild(
            logical_path,
            child_vpk,
            child_metadata,
        ),
    )

    manager.install(
        map_name="de_dust2",
        map_material_id="waxed_reflection",
        skybox_id="chroma_blue",
    )

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries["materials/cs2_insight/flat_normal.vtex_c"] == b"normal"
    assert entries["materials/ground/floor.vmat_c"] == b"dust-floor"
    assert entries[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"blue-material"
    assert entries[texture_path] == b"blue-texture"
    assert logical_path not in entries
    assert official_child.read_bytes() == child_vpk
    assert not (csgo / "cs2_insight_chroma_runtime").exists()
    assert original_material_path not in entries
    assert not set(MAP_SKY_MATERIAL_PATHS["de_dust2"]).intersection(entries)
    manifest = manager._read_manifest()
    assert manifest["feature"] == "recording_map_material_with_skybox"
    assert manifest["recording_map_material_id"] == "waxed_reflection"
    assert manifest["recording_skybox_id"] == "chroma_blue"
    assert manifest["chroma_child_skybox"] == child_metadata
    assert manifest["chroma_official_swaps"]["route"] == (
        "transactional_official_child_vpk_swap"
    )
    assert manager.restore()["verified"] is True
    assert official_child.read_bytes() == official_bytes


@pytest.mark.parametrize(
    "map_name",
    (
        "de_dust2",
        "de_ancient",
        "de_mirage",
        "de_nuke",
        "de_anubis",
        "de_inferno",
        "de_overpass",
        "de_cache",
    ),
)
def test_bundled_waxed_catalog_composes_each_supported_map(map_name: str) -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / "waxed_reflection" / "manifest.json").read_text(encoding="utf-8")
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id="waxed_reflection",
        map_name=map_name,
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"][map_name]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == len(manifest["maps"][map_name]) + len(manifest["shared_entries"])
    assert not any(path.startswith("materials/skybox/") for path in entries)
    assert not any(path.startswith("panorama/") for path in entries)


def test_bundled_snow_ground_catalog_is_dust2_only_and_excludes_indoor_surfaces() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / SNOW_GROUND_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=SNOW_GROUND_MAP_MATERIAL_ID,
        map_name="de_dust2",
    )
    entries = read_inline_vpk(package)
    expected_targets = {item["target"] for item in manifest["maps"]["de_dust2"]}
    assert set(entries) == expected_targets
    assert len(entries) == 4
    assert all(item["classified_indoor_area"] == 0 for item in manifest["selection"]["targets"])
    assert all(path.endswith(".vmat_c") for path in entries)
    assert not any(token in path for path in entries for token in ("wall", "door", "crate", "tile"))
    with pytest.raises(MapMaterialVpkError, match="does not support map"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id=SNOW_GROUND_MAP_MATERIAL_ID,
            map_name="de_train",
        )


def test_bundled_rain_puddles_catalog_preserves_18_native_dust2_ground_materials() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_dust2",
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"]["de_dust2"]),
    }
    assert set(entries) == expected_targets
    ground_entries = {
        path: payload
        for path, payload in entries.items()
        if path.startswith("materials/de_dust/hr_dust/")
    }
    assert len(entries) == 20
    assert len(ground_entries) == 18
    assert all(path.endswith(".vmat_c") for path in ground_entries)
    assert len({hashlib.sha256(payload).hexdigest() for payload in ground_entries.values()}) == 18
    assert all(b"de_ancient" not in payload for payload in ground_entries.values())
    assert "materials/skybox/sky_de_dust2.vmat_c" in entries
    assert "particles/rain_fx/rain.vpcf_c" in entries
    assert not any(
        path.startswith("materials/cs2_insight/weather/de_dust2/no_ripple/")
        for path in entries
    )
    assert not any(path.startswith("maps/de_dust2/worldnodes/") for path in entries)
    assert manifest["source"]["overcast_sky_donor"].endswith("sky_overcast_01.vmat_c")
    assert manifest["source"]["rain_particle_donor"].endswith(
        "rain_single_800.vpcf_c"
    )
    assert manifest["source"]["rain_particle_tuning"] == {
        "profile": "ancient_style_conservative_footprints",
        "official_particle": "rain_single_128",
        "map_emitter_count": 385,
        "spawn_radius": 64.0,
        "clearance_radius": 72.0,
        "parent_emit_rate": 20.0,
        "parent_trail_length": [3.0, 30.0],
        "child_particle": "rain_impact_single",
        "rain_streak_layers": 1,
        "particle_internals_modified": False,
        "region_manifest": (
            "pov/weather_effects/regions/de_dust2_rain_emitters_v2.json"
        ),
        "placement": (
            "automatic physical-geometry plan; every retained 72-unit safety "
            "footprint stays on same-floor fully outdoor NAV"
        ),
    }
    assert manifest["source"]["ground_mode"] == "dust2_native_textures_with_wetness"
    assert manifest["source"]["ground_shader"] == "csgo_environment_blend.vfx"
    assert manifest["source"]["ground_transform"]["material_count"] == 18
    assert manifest["source"]["ground_transform"]["parameters"] == {
        "F_WETNESS": 1,
        "g_bPuddlesOnVerticalSurfaces": 0,
            "g_bWetnessUseHeightmapAdjustments": 0,
            "g_fPuddleBlendSoftness": 0.08,
            "g_fPuddleRoughness": 0.02,
            "g_fPuddleStrength": 1.0,
            "g_fPuddleSedimentHeight": 0.9,
            "g_fWetnessStrength": 1.0,
            "g_fRainStrength": 1.0,
            "g_fRippleStrength": 1.0,
            "g_fPuddleSedimentOpacity": 0.25,
            "g_fWetEdgeSpread": 0.2,
            "g_fWetEdgeStrength": 0.5,
    }
    assert "local_rain_suppression" not in manifest["map_sources"]["de_dust2"]
    assert all(
        item["shader"] == "csgo_environment_blend.vfx"
        for item in manifest["source"]["ground_transform"]["items"]
    )
    assert manifest["source"]["research_phase"] == (
        "documented_phase_3_native_texture_preserving_wetness"
    )
    with pytest.raises(MapMaterialVpkError, match="does not support map"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
            map_name="de_train",
        )


def test_bundled_rain_puddles_catalog_includes_mirage_outdoor_adapter() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_mirage",
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"]["de_mirage"]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == 14
    assert "materials/skybox/sky_de_mirage.vmat_c" in entries
    assert "particles/rain_fx/rain.vpcf_c" in entries
    assert "particles/cs2_insight/rain_mirage_800_blocked.vpcf_c" not in entries
    assert not any(path.endswith(".vmdl_c") for path in entries)
    puddle_source = manifest["map_sources"]["de_mirage"]["world_puddle_atlas"]
    assert puddle_source["render_host"] == "worldnode_static_overlay_model_overrides"
    assert puddle_source["worldnode"] == "maps/de_mirage/worldnodes/n0.vwnod_c"
    assert puddle_source["puddle_count"] == 17
    assert puddle_source["uv_mapping"] == "center-radial-to-transparent-square-rim"
    assert len(puddle_source["models"]) == 17
    assert len({item["model"] for item in puddle_source["models"]}) == 17
    assert puddle_source["collision"] is False
    ground_entries = {
        path: payload
        for path, payload in entries.items()
        if path.endswith(".vmat_c") and not path.startswith("materials/skybox/")
    }
    assert len(ground_entries) == 12
    assert all(b"de_ancient" not in payload for payload in ground_entries.values())
    mirage_source = manifest["map_sources"]["de_mirage"]
    assert mirage_source["ground_transform"]["material_count"] == 12
    assert mirage_source["ground_transform"]["parameters"] == {
        "F_WETNESS": 1,
        "g_bPuddlesOnVerticalSurfaces": 0,
        "g_bWetnessUseHeightmapAdjustments": 0,
        "g_fPuddleBlendSoftness": 0.08,
        "g_fPuddleRoughness": 0.005,
        "g_fPuddleStrength": 1.0,
        "g_fPuddleSedimentHeight": 0.9,
        "g_fPuddleSedimentOpacity": 0.12,
        "g_fWetnessStrength": 1.0,
        "g_fRainStrength": 1.0,
        "g_fRippleStrength": 1.0,
        "g_fWetEdgeSpread": 0.25,
        "g_fWetEdgeStrength": 0.9,
    }
    assert mirage_source["rain_particle_tuning"] == {
        "official_particle": "rain_single_128",
        "map_emitter_count": 832,
        "source_map_emitter_count": 832,
        "removed_map_emitter_count": 0,
        "emitter_reduction_percent": 0.0,
        "spawn_radius": 64.0,
        "parent_emit_rate": 20.0,
        "parent_trail_length": [3.0, 30.0],
        "child_particle": "rain_impact_single",
        "rain_streak_layers": 1,
        "particle_internals_modified": False,
        "placement": (
            "green radar whitelist minus expanded red exclusion, plus cyan "
            "supplements and a magenta highest-floor-only override"
        ),
    }
    assert {
        item["source_layer_mode"]
        for item in mirage_source["ground_transform"]["items"]
    } == {"single_layer_duplicated", "two_layer"}
    assert manifest["map_selections"]["de_mirage"]["region_manifest"].endswith(
        "de_mirage.json"
    )
    assert mirage_source["world_puddle_atlas"]["collision"] is False
    assert mirage_source["world_puddle_atlas"]["vertex_count"] == 1653
    assert mirage_source["world_puddle_atlas"]["triangle_count"] == 2528


def test_bundled_rain_puddles_catalog_includes_strict_cache_outdoor_materials() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_cache",
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"]["de_cache"]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == 5
    assert "materials/cartoon.vmat_c" not in entries
    assert "materials/cartoon_exr_b1862b2d.vtex_c" not in entries
    assert "materials/cartoon5.vmat_c" not in entries
    assert "materials/cartoon5_exr_dc4f746d.vtex_c" not in entries
    assert "materials/skybox/sky_overcast_01.vmat_c" not in entries
    assert "materials/skybox/sky_overcast_01_exr_da4019b1.vtex_c" not in entries
    assert (
        hashlib.sha256(
            entries["materials/de_cache/sky/de_cache_sky_001.vmat_c"]
        ).hexdigest()
        == manifest["source"]["overcast_sky_donor_sha256"]
    )
    assert not any(key.startswith("cache_overcast") for key in manifest["source"])
    assert not any(
        key.startswith("cache_private_overcast") for key in manifest["source"]
    )
    ground_entries = {
        path: payload
        for path, payload in entries.items()
        if path.startswith("materials/de_cache/floor/")
    }
    assert set(ground_entries) == {
        "materials/de_cache/floor/ch2_floor_busstation_01_b.vmat_c",
        "materials/de_cache/floor/ch2_floor_busstation_01.vmat_c",
        "materials/de_cache/floor/ch2_floor_vinyl_01.vmat_c",
    }
    assert "materials/de_cache/sky/de_cache_sky_001.vmat_c" in entries
    assert "particles/rain_fx/rain.vpcf_c" in entries
    cache_source = manifest["map_sources"]["de_cache"]
    assert cache_source["ground_mode"] == "cache_native_environment_blend_with_wetness"
    assert cache_source["ground_transform"]["material_count"] == 3
    assert {
        item["source_layer_mode"]
        for item in cache_source["ground_transform"]["items"]
    } == {"native_environment_blend_preserved"}
    assert cache_source["rain_particle_tuning"]["map_emitter_count"] == 38
    assert cache_source["rain_particle_tuning"]["source_map_emitter_count"] == 222
    assert manifest["map_selections"]["de_cache"]["region_manifest"].endswith(
        "de_cache_rain_annotated.json"
    )


def test_bundled_rain_puddles_catalog_includes_strict_inferno_outdoor_materials() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_inferno",
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"]["de_inferno"]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == 4
    ground_entries = {
        path: payload
        for path, payload in entries.items()
        if path.startswith("materials/de_inferno/ground/")
    }
    assert set(ground_entries) == {
        "materials/de_inferno/ground/inferno_stonefloor07_dirt_blend.vmat_c",
        "materials/de_inferno/ground/inferno_sewer_ground_01.vmat_c",
    }
    assert "materials/skybox/test/s2_de_inferno_sky01.vmat_c" in entries
    assert "particles/rain_fx/rain.vpcf_c" in entries
    inferno_source = manifest["map_sources"]["de_inferno"]
    assert inferno_source["ground_mode"] == (
        "inferno_native_environment_blend_with_wetness"
    )
    assert inferno_source["ground_transform"]["material_count"] == 2
    assert {
        item["source_layer_mode"]
        for item in inferno_source["ground_transform"]["items"]
    } == {"native_environment_blend_preserved"}
    assert inferno_source["rain_particle_tuning"]["official_particle"] == (
        "rain_single_128"
    )
    assert inferno_source["rain_particle_tuning"]["spawn_radius"] == 64.0
    assert inferno_source["rain_particle_tuning"]["map_emitter_count"] == 604
    assert inferno_source["rain_particle_tuning"]["source_map_emitter_count"] == 604
    assert manifest["map_selections"]["de_inferno"]["region_manifest"].endswith(
        "de_inferno_rain_annotated.json"
    )


def test_bundled_rain_puddles_catalog_preserves_ancient_native_wetness() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_ancient",
    )
    entries = read_inline_vpk(package)
    assert set(entries) == {
        "materials/skybox/sky_hr_aztec_02_lighting.vmat_c",
        "materials/skybox/sky_hr_aztec_02_v1.vmat_c",
        "particles/rain_fx/rain.vpcf_c",
    }
    ancient_source = manifest["map_sources"]["de_ancient"]
    assert ancient_source["ground_mode"] == (
        "ancient_retail_wetness_and_puddles_preserved"
    )
    assert ancient_source["ground_transform"] == {
        "material_count": 0,
        "items": [],
        "parameters": {
            "WetnessUseHeightmapAdjustments": 0,
            "PuddleBlendSoftness": 0.08,
            "PuddleRoughness": 0.02,
            "PuddleSedimentHeight": 0.9,
            "PuddleSedimentOpacity": 0.25,
            "WetEdgeSpread": 0.2,
            "WetEdgeStrength": 0.5,
        },
        "mode": "disabled_to_preserve_retail_wetness_and_puddles",
    }
    assert ancient_source["rain_particle_tuning"]["official_particle"] == (
        "rain_single_128"
    )
    assert ancient_source["rain_particle_tuning"]["map_emitter_count"] == 166
    selection = manifest["map_selections"]["de_ancient"]
    assert selection["targets"] == []
    assert selection["region_manifest"].endswith(
        "de_ancient_rain_emitters.json"
    )


def test_bundled_rain_puddles_catalog_keeps_nuke_rain_only() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_nuke",
    )
    entries = read_inline_vpk(package)
    assert set(entries) == {
        "materials/skybox/sky_de_nuke.vmat_c",
        "particles/rain_fx/rain.vpcf_c",
    }
    nuke_source = manifest["map_sources"]["de_nuke"]
    assert nuke_source["ground_mode"] == "nuke_rain_only_no_ground_wetness"
    assert nuke_source["ground_transform"] == {
        "material_count": 0,
        "items": [],
        "parameters": {},
        "mode": "rain_only_no_ground_override",
    }
    assert nuke_source["rain_particle_tuning"]["official_particle"] == (
        "rain_single_128"
    )
    assert nuke_source["rain_particle_tuning"]["map_emitter_count"] == 221
    selection = manifest["map_selections"]["de_nuke"]
    assert selection["targets"] == []
    assert selection["region_manifest"].endswith("de_nuke_rain_emitters.json")


def test_bundled_rain_puddles_catalog_includes_strict_anubis_ground_materials() -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / RAIN_PUDDLES_MAP_MATERIAL_ID / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id=RAIN_PUDDLES_MAP_MATERIAL_ID,
        map_name="de_anubis",
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"]["de_anubis"]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == 2
    ground_entries = {
        path: payload
        for path, payload in entries.items()
        if path.startswith("materials/anubis/")
    }
    assert ground_entries == {}
    assert "materials/skybox/sky_de_annubis.vmat_c" in entries
    assert "particles/rain_fx/rain.vpcf_c" in entries
    anubis_source = manifest["map_sources"]["de_anubis"]
    assert anubis_source["ground_mode"] == (
        "anubis_native_environment_blend_with_wetness"
    )
    assert anubis_source["ground_transform"]["material_count"] == 0
    assert anubis_source["ground_transform"]["items"] == []
    assert anubis_source["world_puddle_atlas"]["puddle_count"] == 12
    assert anubis_source["world_puddle_atlas"]["vertex_count"] == 1622
    assert anubis_source["world_puddle_atlas"]["triangle_count"] == 2603
    assert anubis_source["world_puddle_atlas"]["collision"] is False
    assert anubis_source["rain_particle_tuning"]["map_emitter_count"] == 1004
    assert anubis_source["rain_particle_tuning"]["source_map_emitter_count"] == 1004
    selection = manifest["map_selections"]["de_anubis"]
    assert selection["region_manifest"].endswith("de_anubis_rain_world_puddle.json")
    assert selection["material_audit"]["safe_outdoor_wet_candidate_count"] == 0
    assert selection["material_audit"]["safe_candidate_pool_count"] == 4
