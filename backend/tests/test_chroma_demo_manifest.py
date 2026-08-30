from app.chroma_demo_manifest import (
    chroma_demo_redirect_material_path,
    get_chroma_demo_manifest_profile,
    supported_chroma_demo_manifest_maps,
)


EXPECTED_MAPS = {
    "de_ancient",
    "de_anubis",
    "de_cache",
    "de_dust2",
    "de_inferno",
    "de_mirage",
    "de_nuke",
    "de_overpass",
    "de_train",
    "de_vertigo",
}


def test_bundled_reference_catalog_covers_all_validated_maps():
    assert set(supported_chroma_demo_manifest_maps()) == EXPECTED_MAPS


def test_reference_profiles_share_the_registered_private_sky_handle():
    for map_name in EXPECTED_MAPS:
        profile = get_chroma_demo_manifest_profile(map_name)
        assert profile is not None
        assert profile.map_name == map_name
        assert profile.world_name.startswith("maps/prefabs/")
        assert profile.spawn_group_manifest
        assert profile.spawn_group_manifests == {
            15: profile.spawn_group_manifest,
            18: profile.spawn_group_manifest,
        }
        assert profile.target_material_path == (
            "materials/cs2_insight/chroma/active_sky.vmat_c"
        )
        assert profile.target_sky_material_handle == 14038941216328320667


def test_reference_profiles_do_not_use_legacy_equal_length_redirects():
    assert all(
        chroma_demo_redirect_material_path(map_name) is None
        for map_name in EXPECTED_MAPS
    )


def test_map_specific_demo_environment_overrides_are_explicit():
    dust2 = get_chroma_demo_manifest_profile("de_dust2")
    assert dust2 is not None
    assert dust2.active_cubemap_fog_entities_to_disable == 1
    assert dust2.suppressed_func_brush_model_handles == (
        14229486482546056262,
    )
    assert dust2.disable_active_gradient_fog is False

    ancient = get_chroma_demo_manifest_profile("de_ancient")
    assert ancient is not None
    assert ancient.active_cubemap_fog_entities_to_disable == 1
    assert ancient.disable_active_gradient_fog is True
    assert ancient.suppressed_func_brush_model_handles == ()

    anubis = get_chroma_demo_manifest_profile("de_anubis")
    assert anubis is not None
    assert anubis.active_cubemap_fog_entities_to_disable == 2
    assert anubis.disable_active_gradient_fog is False
    assert anubis.suppressed_func_brush_model_handles == (
        2989301448668638875,
    )

    inferno = get_chroma_demo_manifest_profile("de_inferno")
    assert inferno is not None
    assert inferno.active_cubemap_fog_entities_to_disable == 1
    assert inferno.disable_active_gradient_fog is True
    assert inferno.suppressed_func_brush_model_handles == ()

    mirage = get_chroma_demo_manifest_profile("de_mirage")
    assert mirage is not None
    assert mirage.active_cubemap_fog_entities_to_disable == 1
    assert mirage.disable_active_gradient_fog is False
    assert mirage.suppressed_func_brush_model_handles == ()

    cache = get_chroma_demo_manifest_profile("de_cache")
    assert cache is not None
    assert cache.active_cubemap_fog_entities_to_disable == 1
    assert cache.disable_active_gradient_fog is True
    assert cache.suppressed_func_brush_model_handles == ()

    for map_name in EXPECTED_MAPS - {
        "de_dust2",
        "de_ancient",
        "de_anubis",
        "de_cache",
        "de_inferno",
        "de_mirage",
    }:
        profile = get_chroma_demo_manifest_profile(map_name)
        assert profile is not None
        assert profile.active_cubemap_fog_entities_to_disable == 0
        assert profile.disable_active_gradient_fog is False
        assert profile.suppressed_func_brush_model_handles == ()


def test_normalizes_lookup_without_trusting_demo_filename():
    assert get_chroma_demo_manifest_profile("maps/de_dust2.vpk").map_name == "de_dust2"
    assert get_chroma_demo_manifest_profile("ANUBIS").map_name == "de_anubis"
    assert get_chroma_demo_manifest_profile("de_unknown") is None
