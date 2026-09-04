from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import chroma_skybox_child as vpk
from app import pov_hud_manager
from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app.pov_hud_manager import PovHudManager
from app.weather_effects import (
    RAIN_WEATHER_EFFECT_ID,
    WEATHER_EFFECT_IDS,
    WeatherEffectError,
    normalize_weather_effect_id,
)
from app.weather_particle_vpk import (
    OFFICIAL_SNOW_PARTICLE_PATH,
    TRAIN_RAIN_PARTICLE_PATH,
    TRAIN_RAIN_PARTICLE_PATHS,
    WeatherParticleVpkError,
    build_train_snow_particle_override_vpk,
)
from tools import build_rain_weather_main_map as dust2_rain_builder
from tools.build_mirage_world_puddle_atlas import _puddle_texture_uv


def _write_external_particle_package(csgo: Path, payload: bytes) -> None:
    directory_bytes = bytearray(write_inline_vpk({OFFICIAL_SNOW_PARTICLE_PATH: payload}))
    _header, _tree, entries = vpk._open_package_bytes(directory_bytes)
    entry = entries[OFFICIAL_SNOW_PARTICLE_PATH]
    struct.pack_into("<H", directory_bytes, vpk._VPK_HEADER.size + entry.archive_field_offset, 0)
    (csgo / "pak01_dir.vpk").write_bytes(directory_bytes)
    (csgo / "pak01_000.vpk").write_bytes(payload)


def test_weather_ids_include_global_rain() -> None:
    assert WEATHER_EFFECT_IDS == frozenset({"default", "snow", "rain"})
    assert normalize_weather_effect_id(" RAIN ") == RAIN_WEATHER_EFFECT_ID
    with pytest.raises(WeatherEffectError, match="unsupported"):
        normalize_weather_effect_id("sandstorm")


def test_bundled_dust2_rain_profile_tracks_dynamic_object_contact_gate() -> None:
    project_root = Path(__file__).resolve().parents[2]
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    profile = manifest["maps"]["de_dust2"]
    assert profile["status"] == "validated"
    assert (
        profile["loose_outer_replacements"][0]["status"]
        == "validated"
    )
    replacement = profile["loose_outer_replacements"][0]
    assert replacement["payload_size"] == 64230
    assert replacement["payload_sha256"] == (
        "7ba8509c17914323a47bf04cc69dd2a7f8a6ddb9add04680a6ada73a9f40fe52"
    )
    assert profile["main_source"]["expected_output_size"] == 262532553
    assert profile["main_source"]["expected_output_sha256"] == (
        "da5cc054e760d0d29f20dd0d1c94ca3df98bea642553b7467aa7f8bfc4714fc5"
    )
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_dust2_rain_emitters_v2.json"
        ).read_text(encoding="utf-8")
    )
    assert profile["injection"]["profile"] == (
        "ancient_style_conservative_footprints"
    )
    assert profile["injection"]["particle_system_count"] == 385
    assert profile["injection"]["clientside_particle_system_count"] == 385
    assert profile["injection"]["networked_particle_system_count"] == 0
    assert profile["demo_particle_transport"]["particle_effect"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["demo_particle_transport"]["spawn_radius"] == 64.0
    assert profile["demo_particle_transport"]["emit_rate"] == 20.0
    assert profile["demo_particle_transport"]["particle_system_count"] == 385
    assert profile["demo_particle_transport"]["host_class"] == (
        "path_particle_rope_clientside"
    )
    assert profile["demo_particle_transport"]["max_simulation_time"] == 0.0
    assert profile["demo_particle_transport"]["network_snapshot_owned"] is False
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 117
    assert profile["demo_particle_transport"]["retail_clientside_rope_entities_modified"] == 0
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_maximum_trail_length"] == 30.0
    assert profile["injection"]["particle_emit_rate"] == 20.0
    assert profile["injection"]["source_particle_system_count"] == 385
    assert profile["injection"]["removed_particle_system_count"] == 0
    assert profile["injection"]["selected_emitter_ids"] == list(range(1, 386))
    assert profile["injection"]["selection_method"] == (
        "all prevalidated floor-aware emitters"
    )
    assert region["summary"]["rain_emitter_count"] == 385
    assert region["selection"]["clearance_radius"] == 72.0
    assert region["selection"]["require_full_outdoor_footprint"] is True
    assert region["selection"]["rejected_candidate_surface_count"] == 2111
    exclusions = region["selection"]["manual_exclusions"]
    assert exclusions == {
        "source_manifest": None,
        "clearance_radius": 72.0,
        "removed_emitter_count": 0,
        "removed_by_zone": {},
        "zones": [],
    }
    assert "manual_exclusion_manifest" not in profile["injection"]
    assert profile["injection"]["selected_preview"] == (
        "pov/weather_effects/regions/de_dust2_rain_precise_v2_preview.png"
    )
    assert "localized_ground_rain_suppression" not in profile["injection"]
    assert (project_root / profile["injection"]["selected_preview"]).is_file()
    assert profile["dynamic_object_rain_contact"]["original"] is False
    assert profile["dynamic_object_rain_contact"]["rain_profile"] is True
    assert profile["dynamic_object_rain_contact"]["original_env_rain_strength"] == 1.0
    assert profile["dynamic_object_rain_contact"]["rain_profile_env_rain_strength"] == 1.0
    assert "supersedes" not in profile


def test_bundled_rain_runtime_contains_only_final_declared_payloads() -> None:
    project_root = Path(__file__).resolve().parents[2]
    rain_root = project_root / "pov" / "weather_effects" / "rain"
    manifest = json.loads((rain_root / "manifest.json").read_text(encoding="utf-8"))
    expected_maps = {
        "de_dust2",
        "de_mirage",
        "de_cache",
        "de_inferno",
        "de_anubis",
        "de_ancient",
        "de_nuke",
    }
    assert set(manifest["maps"]) == expected_maps
    declared = {
        Path(item["payload_relative_path"]).as_posix()
        for profile in manifest["maps"].values()
        for item in profile["loose_outer_replacements"]
    }
    packaged = {
        path.relative_to(rain_root).as_posix()
        for path in rain_root.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    assert packaged == declared
    assert manifest["maps"]["de_nuke"]["spatial_puddles"] == {
        "status": "intentionally_disabled",
        "static_overlay_count": 0,
        "instance_count": 0,
        "mode": "rain_only_no_ground_wetness",
        "reason": (
            "the finalized Nuke treatment contains rain only; ground materials "
            "remain identical to the retail map"
        ),
        "global_ground_material_count": 0,
        "wet_model_count": 0,
        "puddle_model_count": 0,
        "puddle_count": 0,
        "lower_layer_modified": False,
    }


def test_dust2_builder_merges_without_dropping_other_maps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps({"maps": {"de_ancient": {"status": "preserve"}}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(dust2_rain_builder, "MANIFEST", manifest)

    merged = dust2_rain_builder._merge_manifest({"status": "dust2"})

    assert merged["maps"] == {
        "de_ancient": {"status": "preserve"},
        "de_dust2": {"status": "dust2"},
    }


def test_bundled_mirage_rain_profile_uses_continuous_clientside_hosts() -> None:
    project_root = Path(__file__).resolve().parents[2]
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    profile = manifest["maps"]["de_mirage"]
    atlas = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_mirage_world_puddle_atlas_v1.json"
        ).read_text(encoding="utf-8")
    )
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == (
        "maps/de_mirage.vpk"
    )
    replacements = profile["loose_outer_replacements"]
    entity_lumps = [
        item for item in replacements if item["kind"] == "main_entity_lump"
    ]
    static_models = [
        item for item in replacements if item["kind"] == "main_worldnode_static_model"
    ]
    assert len(entity_lumps) == 1
    assert len(static_models) == 17
    assert atlas["source_puddle_count"] == 19
    assert atlas["excluded_puddle_ids"] == ["puddle_05", "puddle_19"]
    assert {item["entry_path"] for item in static_models} == {
        item["compiled_model_target"] for item in atlas["models"]
    }
    assert {item["payload_relative_path"] for item in static_models} == {
        item["payload_root_relative_path"] for item in atlas["models"]
    }
    assert {
        "maps/de_mirage/worldnodes/n0_lr0_c254_s_mesh_overlay254.vmdl_c",
        "maps/de_mirage/worldnodes/n0_lr0_c194_s_mesh_overlay194.vmdl_c",
    }.isdisjoint({item["entry_path"] for item in static_models})
    assert profile["injection"]["particle_system_count"] == 832
    assert profile["injection"]["source_particle_system_count"] == 832
    assert profile["injection"]["puddle_instance_count"] == 0
    assert profile["injection"]["networked_puddle_instance_count"] == 0
    assert profile["injection"]["puddle_decal_count"] == 0
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_emit_rate"] == 20.0
    assert profile["injection"]["selection_method"] == (
        "all prevalidated floor-aware emitters"
    )
    assert profile["demo_particle_transport"]["host_class"] == (
        "path_particle_rope_clientside"
    )
    assert profile["demo_particle_transport"]["particle_effect"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert "user-authored red radar regions" in profile["demo_particle_transport"][
        "occlusion"
    ]
    assert "magenta highest-floor-only" in profile["demo_particle_transport"][
        "occlusion"
    ]
    assert profile["demo_particle_transport"]["max_simulation_time"] == 0.0
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 84
    assert profile["dynamic_object_rain_contact"]["original"] is False
    assert profile["dynamic_object_rain_contact"]["rain_profile"] is True
    puddles = profile["spatial_puddles"]
    assert puddles["status"] == "validated"
    assert puddles["instance_count"] == 0
    assert puddles["static_overlay_count"] == 17
    assert puddles["host_class"] == "worldnode_static_overlay_model_overrides"
    assert puddles["clientside_entity"] is None
    assert puddles["networked_entity"] is False
    assert puddles["resource_precache"] == {
        "block": "maps/de_mirage/worldnodes/n0.vwnod_c RERL",
        "models": [item["model"] for item in atlas["models"]],
        "added_reference_count": 0,
    }
    assert puddles["solid"] is False
    assert puddles["models"] == [item["model"] for item in atlas["models"]]
    assert puddles["materials"] == [
        "materials/models/effects/urban_puddle01a.vmat"
    ]
    assert puddles["geometry"]["puddle_count"] == 17
    assert puddles["geometry"]["vertex_count"] == 1653
    assert puddles["geometry"]["triangle_count"] == 2528
    assert puddles["geometry"]["irregular_boundary"] is True
    assert puddles["geometry"]["uv_mapping"] == (
        "center-radial-to-transparent-square-rim"
    )
    assert all(item["geometry"]["coverage"] >= 0.85 for item in atlas["models"])
    assert all(
        item["worldnode_slot_verification"]["match_count"] == 1
        for item in atlas["models"]
    )
    assert puddles["terrain_modified"] is False
    assert puddles["project_on_world"] is False
    assert puddles["project_on_characters"] is False
    assert puddles["project_on_water"] is False


def test_bundled_cache_rain_profile_follows_user_color_annotation() -> None:
    project_root = Path(__file__).resolve().parents[2]
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_cache_rain_annotated.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    profile = manifest["maps"]["de_cache"]
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == "maps/de_cache.vpk"
    assert len(profile["loose_outer_replacements"]) == 1
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_800.vpcf"
    )
    assert profile["injection"]["particle_system_count"] == 38
    assert profile["injection"]["source_particle_system_count"] == 222
    assert profile["injection"]["selected_yellow_upper_floor_emitter_count"] == 2
    assert profile["injection"]["maximum_original_emitter_distance"] <= 350.0
    assert profile["injection"]["annotation_status"] == "compiled"
    assert profile["demo_particle_transport"]["host_class"] == (
        "path_particle_rope_clientside"
    )
    assert profile["demo_particle_transport"]["max_simulation_time"] == 0.0
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 7
    assert profile["dynamic_object_rain_contact"]["original"] is False
    assert profile["dynamic_object_rain_contact"]["rain_profile"] is True
    assert profile["spatial_puddles"] == {
        "status": "validated",
        "static_overlay_count": 0,
        "entity_instance_count": 0,
        "mode": "native_material_wetness_only",
        "material_profile": "rain_puddles",
        "audited_ground_material_count": 3,
        "selection": "strict zero-indoor-use Cache material allowlist",
        "reason": (
            "the Dust2 first-pass route avoids static overlay puddles; shared "
            "Cache indoor/outdoor materials remain unchanged"
        ),
    }
    assert region["annotation"]["priority"] == [
        "yellow_upper_floor_only",
        "red_no_rain",
        "magenta_rain",
    ]
    assert region["selection"]["automatic_indoor_outdoor_classification_used"] is False
    assert region["selection"]["accepted_by_zone_source"] == {
        "magenta_rain": 204,
        "yellow_upper_floor_only": 18,
    }
    assert region["selection"]["yellow_multi_surface_emitter_count"] == 8
    assert all(
        emitter["layer_policy"] == "highest_nav_surface_only"
        for emitter in region["rain_emitters"]
        if emitter["zone_source"] == "yellow_upper_floor_only"
    )


def test_bundled_inferno_rain_profile_follows_user_color_annotation() -> None:
    project_root = Path(__file__).resolve().parents[2]
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_inferno_rain_annotated.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    atlas = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_inferno_world_puddle_atlas_v1.json"
        ).read_text(encoding="utf-8")
    )
    profile = manifest["maps"]["de_inferno"]
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == (
        "maps/de_inferno.vpk"
    )
    assert len(profile["loose_outer_replacements"]) == 12
    assert len(
        [
            item
            for item in profile["loose_outer_replacements"]
            if item["kind"] == "main_worldnode_static_model"
        ]
    ) == 11
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_system_count"] == 604
    assert profile["injection"]["source_particle_system_count"] == 604
    assert profile["injection"]["selected_yellow_upper_floor_emitter_count"] == 25
    assert profile["injection"]["maximum_original_emitter_distance"] == 0.0
    assert profile["injection"]["indoor_clearance_world"] == 72.0
    assert profile["injection"]["yellow_upper_floor_inset_world"] == 72.0
    assert profile["injection"]["annotation_status"] == "compiled"
    assert profile["demo_particle_transport"]["host_class"] == (
        "path_particle_rope_clientside"
    )
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 28
    assert profile["dynamic_object_rain_contact"]["original"] is False
    assert profile["dynamic_object_rain_contact"]["rain_profile"] is True
    assert profile["spatial_puddles"]["audited_ground_material_count"] == 2
    assert profile["spatial_puddles"]["static_overlay_count"] == 11
    assert profile["spatial_puddles"]["networked_entity"] is False
    assert profile["spatial_puddles"]["solid"] is False
    assert len(profile["spatial_puddles"]["coordinates"]) == 11
    assert profile["injection"]["static_puddle_overlay_count"] == 11
    assert atlas["puddle_count"] == 11
    assert atlas["collision"] is False
    assert atlas["entity_created"] is False
    assert all(item["geometry"]["coverage"] >= 0.85 for item in atlas["models"])
    assert all(
        item["worldnode_slot_verification"]["match_count"] == 1
        for item in atlas["models"]
    )
    assert [item["id"] for item in atlas["models"]] == [
        f"puddle_{index:02d}" for index in range(1, 12)
    ]
    large = atlas["models"][8:]
    assert [item["radius"] for item in large] == [
        [220.0, 120.0],
        [220.0, 120.0],
        [180.0, 100.0],
    ]
    assert all(item["geometry"]["coverage"] >= 0.9 for item in large)
    assert region["annotation"]["shared_boundary_classification"] is True
    assert region["annotation"]["priority"] == [
        "yellow_upper_floor_only",
        "red_no_rain",
        "magenta_rain",
    ]
    assert region["selection"]["automatic_indoor_outdoor_classification_used"] is False
    assert region["selection"]["accepted_by_zone_source"] == {
        "magenta_rain": 579,
        "yellow_upper_floor_only": 25,
    }
    assert region["selection"]["yellow_multi_surface_emitter_count"] == 2
    assert region["annotation"]["red_clearance_world"] == 72.0
    assert region["annotation"]["yellow_inset_world"] == 72.0
    manual_zones = region["annotation"]["manual_no_rain_zones"]
    assert [zone["id"] for zone in manual_zones] == [
        "ct_spawn_covered_gallery",
        "ct_spawn_arch_passage",
    ]
    for zone in manual_zones:
        center = tuple(map(float, zone["center"]))
        exclusion_radius = float(zone["radius"]) + float(
            zone["emitter_clearance_world"]
        )
        maximum_ground_z = float(zone["maximum_ground_z"])
        for emitter in region["rain_emitters"]:
            ground = tuple(map(float, emitter["ground_origin"]))
            if ground[2] <= maximum_ground_z:
                assert math.dist(center, ground[:2]) > exclusion_radius
    red_mask = Image.open(
        project_root
        / "pov"
        / "weather_effects"
        / "regions"
        / "de_inferno_rain_red_mask.png"
    ).convert("L")
    red_exclusion = red_mask.filter(
        ImageFilter.MaxFilter(region["annotation"]["red_clearance_pixels"] * 2 + 1)
    )
    for emitter in region["rain_emitters"]:
        pixel_x, pixel_y = (round(value) for value in emitter["radar_pixel"])
        if emitter["zone_source"] == "magenta_rain":
            assert red_exclusion.getpixel((pixel_x, pixel_y)) < 128
    assert all(
        emitter["layer_policy"] == "highest_nav_surface_only"
        for emitter in region["rain_emitters"]
        if emitter["zone_source"] == "yellow_upper_floor_only"
    )


def test_bundled_ancient_rain_profile_uses_conservative_geometry_plan() -> None:
    project_root = Path(__file__).resolve().parents[2]
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_ancient_rain_emitters.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    profile = manifest["maps"]["de_ancient"]
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == (
        "maps/de_ancient.vpk"
    )
    assert len(profile["loose_outer_replacements"]) == 1
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_system_count"] == 166
    assert profile["injection"]["source_particle_system_count"] == 166
    assert profile["injection"]["annotation_status"] == (
        "automatic_geometry_candidate"
    )
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 0
    assert "bundled Dust2" in profile["demo_particle_transport"]["schema_template"]
    assert profile["dynamic_object_rain_contact"]["map_parameter_count"] == 2
    assert profile["dynamic_object_rain_contact"]["original_values"] == [False, True]
    assert profile["dynamic_object_rain_contact"]["envrainstrength_rain_profile"] == 1.0
    assert profile["spatial_puddles"]["status"] == "retail_preserved"
    assert profile["spatial_puddles"]["static_overlay_count"] == 0
    assert profile["spatial_puddles"]["audited_ground_material_count"] == 0
    assert profile["spatial_puddles"]["mode"] == (
        "native_ancient_wetness_and_puddles_only"
    )
    assert region["selection"]["minimum_sky_exposure"] == 1.0
    assert region["selection"]["particle_radius"] == 64.0
    assert region["selection"]["clearance_radius"] == 72.0
    assert region["selection"]["require_full_outdoor_footprint"] is True
    assert region["summary"]["rain_emitter_count"] == 166


def test_bundled_nuke_rain_profile_excludes_the_underground_layer() -> None:
    project_root = Path(__file__).resolve().parents[2]
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_nuke_rain_emitters.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    profile = manifest["maps"]["de_nuke"]
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == "maps/de_nuke.vpk"
    assert len(profile["loose_outer_replacements"]) == 1
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_system_count"] == 221
    assert profile["injection"]["source_particle_system_count"] == 221
    assert profile["injection"]["manual_inclusion_emitter_count"] == 10
    assert profile["injection"]["lower_layer_max_z"] == -495.0
    assert profile["injection"]["lower_layer_emitter_count"] == 0
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 69
    assert profile["dynamic_object_rain_contact"]["map_parameter_count"] == 1
    assert profile["dynamic_object_rain_contact"]["original_values"] == [False]
    assert profile["dynamic_object_rain_contact"]["envrainstrength_original_values"] == [1.0]
    assert profile["spatial_puddles"]["status"] == "intentionally_disabled"
    assert profile["spatial_puddles"]["mode"] == (
        "rain_only_no_ground_wetness"
    )
    assert profile["spatial_puddles"]["wet_model_count"] == 0
    assert profile["spatial_puddles"]["puddle_model_count"] == 0
    assert profile["spatial_puddles"]["puddle_count"] == 0
    assert profile["spatial_puddles"]["lower_layer_modified"] is False
    assert "failed_experiment_metadata" not in profile["spatial_puddles"]
    assert len(
        [
            item
            for item in profile["loose_outer_replacements"]
            if item["kind"] == "main_worldnode_static_model"
        ]
    ) == 0
    assert region["selection"]["minimum_sky_exposure"] == 1.0
    assert region["selection"]["particle_radius"] == 64.0
    assert region["selection"]["clearance_radius"] == 72.0
    assert region["selection"]["require_full_outdoor_footprint"] is True
    assert region["summary"]["rain_emitter_count"] == 221
    assert region["selection"]["manual_inclusions"]["added_emitter_count"] == 10
    assert all(
        float(emitter["ground_origin"][2]) > -495.0
        for emitter in region["rain_emitters"]
    )
    assert len(region["rain_emitters"]) == 221


def test_bundled_anubis_rain_profile_enforces_roofs_and_highest_blue_layer() -> None:
    project_root = Path(__file__).resolve().parents[2]
    region = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_anubis_rain_world_puddle.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (project_root / "pov" / "weather_effects" / "rain" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    atlas = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_anubis_world_puddle_atlas_v1.json"
        ).read_text(encoding="utf-8")
    )
    profile = manifest["maps"]["de_anubis"]
    assert profile["status"] == "validated"
    assert profile["main_source"]["source_package_relative_path"] == (
        "maps/de_anubis.vpk"
    )
    assert len(profile["loose_outer_replacements"]) == 13
    assert len(
        [
            item
            for item in profile["loose_outer_replacements"]
            if item["kind"] == "main_worldnode_static_model"
        ]
    ) == 12
    assert profile["injection"]["particle"] == (
        "particles/rain_fx/rain_single_128.vpcf"
    )
    assert profile["injection"]["particle_spawn_radius"] == 64.0
    assert profile["injection"]["particle_system_count"] == 1004
    assert profile["injection"]["source_particle_system_count"] == 1004
    assert profile["injection"]["required_emitter_ids"] == [663]
    assert profile["injection"]["selected_blue_upper_floor_emitter_count"] == 3
    assert profile["injection"]["maximum_original_emitter_distance"] == 0.0
    assert profile["injection"]["yellow_clearance_world"] == 72.0
    assert profile["demo_particle_transport"]["retail_clientside_rope_entity_count"] == 10
    assert profile["dynamic_object_rain_contact"]["original"] is False
    assert profile["spatial_puddles"]["static_overlay_count"] == 12
    assert profile["spatial_puddles"]["mode"] == (
        "existing_waterways_plus_static_worldnode_puddles"
    )
    assert profile["spatial_puddles"]["audited_ground_material_count"] == 0
    assert profile["spatial_puddles"]["networked_entity"] is False
    assert profile["spatial_puddles"]["solid"] is False
    assert len(profile["spatial_puddles"]["coordinates"]) == 12
    assert profile["injection"]["static_puddle_overlay_count"] == 12
    assert atlas["source_puddle_count"] == 14
    assert atlas["excluded_puddle_ids"] == ["puddle_08", "puddle_10"]
    assert atlas["puddle_count"] == 12
    assert atlas["collision"] is False
    assert atlas["entity_created"] is False
    assert atlas["total_vertex_count"] == 1622
    assert atlas["total_triangle_count"] == 2603
    assert all(item["geometry"]["coverage"] >= 0.85 for item in atlas["models"])
    assert all(
        item["worldnode_slot_verification"]["match_count"] == 1
        for item in atlas["models"]
    )
    assert [item["id"] for item in atlas["models"]] == [
        "puddle_01",
        "puddle_02",
        "puddle_03",
        "puddle_04",
        "puddle_05",
        "puddle_06",
        "puddle_07",
        "puddle_09",
        "puddle_11",
        "puddle_12",
        "puddle_13",
        "puddle_14",
    ]
    assert region["annotation"]["priority"] == [
        "yellow_all_layers_no_rain",
        "blue_upper_floor_only",
        "magenta_rain",
    ]
    assert region["selection"]["automatic_indoor_outdoor_classification_used"] is False
    assert region["selection"]["accepted_by_zone_source"] == {
        "magenta_rain": 1001,
        "blue_upper_floor_only": 3,
    }
    assert region["selection"]["blue_upper_floor_min_z"] == -71.0
    assert region["selection"]["required_blue_emitter_id"] == "rain_0663"
    assert region["annotation"]["yellow_clearance_world"] == 72.0
    yellow_exclusion = Image.open(
        project_root
        / "pov"
        / "weather_effects"
        / "regions"
        / "de_anubis_rain_all_layers_no_rain_mask.png"
    ).convert("L")
    for emitter in region["rain_emitters"]:
        pixel_x, pixel_y = (round(value) for value in emitter["radar_pixel"])
        assert yellow_exclusion.getpixel((pixel_x, pixel_y)) < 128
    assert sum(
        area["annotation_zone"] == "blue_lower_floor_no_rain"
        for area in region["areas"]
    ) == 4
    assert all(
        float(emitter["ground_origin"][2])
        >= float(region["selection"]["blue_upper_floor_min_z"])
        for emitter in region["rain_emitters"]
        if emitter["zone_source"] == "blue_upper_floor_only"
    )


def test_mirage_puddle_uv_maps_every_authored_boundary_to_transparent_rim() -> None:
    project_root = Path(__file__).resolve().parents[2]
    annotation = json.loads(
        (
            project_root
            / "pov"
            / "weather_effects"
            / "regions"
            / "de_mirage_puddle_annotation_v1.json"
        ).read_text(encoding="utf-8")
    )
    assert len(annotation["puddles"]) == 19
    for puddle in annotation["puddles"]:
        polygon = puddle["world_polygon"]
        center = puddle["world_center"]
        assert _puddle_texture_uv(center, polygon, center) == (0.5, 0.5)
        for point in polygon:
            u, v = _puddle_texture_uv(point, polygon, center)
            assert 0.0 <= u <= 1.0
            assert 0.0 <= v <= 1.0
            assert min(u, v, 1.0 - u, 1.0 - v) == pytest.approx(0.0)


def test_builds_train_alias_from_verified_external_official_entry(tmp_path: Path) -> None:
    csgo = tmp_path / "csgo"
    csgo.mkdir()
    snow = b"compiled-official-snow-particle"
    _write_external_particle_package(csgo, snow)
    base = write_inline_vpk({"panorama/test.vjs_c": b"hud"})

    result = build_train_snow_particle_override_vpk(
        csgo_dir=csgo,
        map_name="de_train",
        base_vpk_bytes=base,
    )

    entries = read_inline_vpk(result.vpk_bytes)
    assert entries.pop("panorama/test.vjs_c") == b"hud"
    assert entries == {path: snow for path in TRAIN_RAIN_PARTICLE_PATHS}
    assert result.metadata["route"] == "native_precipitation_particle_alias"
    assert result.metadata["source_sha256"] == hashlib.sha256(snow).hexdigest()
    assert result.metadata["native_particle_entity_reused"] is True
    assert result.metadata["new_particle_entity_created"] is False
    assert result.metadata["target_particle_count"] == len(TRAIN_RAIN_PARTICLE_PATHS)


def test_rejects_non_train_map(tmp_path: Path) -> None:
    with pytest.raises(WeatherParticleVpkError, match="only supports de_train"):
        build_train_snow_particle_override_vpk(
            csgo_dir=tmp_path,
            map_name="de_dust2",
        )


def test_rejects_conflicting_existing_precipitation_override(tmp_path: Path) -> None:
    csgo = tmp_path / "csgo"
    csgo.mkdir()
    _write_external_particle_package(csgo, b"snow")
    base = write_inline_vpk({TRAIN_RAIN_PARTICLE_PATH: b"different"})

    with pytest.raises(WeatherParticleVpkError, match="already overrides"):
        build_train_snow_particle_override_vpk(
            csgo_dir=csgo,
            map_name="de_train",
            base_vpk_bytes=base,
        )


def test_manager_installs_and_restores_train_snow_probe(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    original_gameinfo = "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n"
    (csgo / "gameinfo.gi").write_text(original_gameinfo, encoding="utf-8")
    snow = b"compiled-official-snow-particle"
    _write_external_particle_package(csgo, snow)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))

    manager.install(map_name="de_train", weather_effect_id="snow")

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries == {path: snow for path in TRAIN_RAIN_PARTICLE_PATHS}
    manifest = manager._read_manifest()
    assert manifest["weather_effect_id"] == "snow"
    assert manifest["weather_main_map"] is None
    assert manifest["weather_particle_override"]["route"] == (
        "native_precipitation_particle_alias"
    )
    assert manifest["weather_particle_override"]["in_game_validation"] == "pending"

    restored = manager.restore()
    assert restored["verified"] is True
    assert not (csgo / "pov.vpk").exists()
    assert (csgo / "gameinfo.gi").read_text(encoding="utf-8") == original_gameinfo
