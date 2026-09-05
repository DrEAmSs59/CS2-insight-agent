import hashlib
import json
from pathlib import Path

import pytest

from app.entity_lump_kv3 import (
    EntityLumpKv3Error,
    inspect_light_environment,
    scale_light_environment_direct_brightness,
)


RAIN_ROOT = (
    Path(__file__).resolve().parents[2] / "pov" / "weather_effects" / "rain"
)
RAIN_DUST2_VENTS = RAIN_ROOT / "de_dust2" / "default_ents.vents_c"
RAIN_INFERNO_VENTS = RAIN_ROOT / "de_inferno" / "default_ents.vents_c"

HALVED_BRIGHTNESS = {
    "de_dust2": 1.25,
    "de_mirage": 1.5,
    "de_cache": 0.949999988079071,
    "de_inferno": 1.5,
    "de_anubis": 3.174999952316284,
    "de_ancient": 1.899999976158142,
    "de_nuke": 1.2000000476837158,
}


@pytest.mark.skipif(not RAIN_DUST2_VENTS.is_file(), reason="rain Dust II entity lump is not bundled")
def test_rain_dust2_light_environment_brightness_is_halved() -> None:
    bundled = RAIN_DUST2_VENTS.read_bytes()
    before = inspect_light_environment(bundled)

    assert before.classname == "light_environment"
    assert before.brightness == pytest.approx(1.25)
    assert before.brightnessscale == pytest.approx(1.0)

    restored = scale_light_environment_direct_brightness(bundled, factor=2.0)
    assert inspect_light_environment(restored).brightness == pytest.approx(2.5)
    assert inspect_light_environment(
        scale_light_environment_direct_brightness(restored, factor=0.5)
    ).brightness == pytest.approx(1.25)


@pytest.mark.skipif(
    not RAIN_INFERNO_VENTS.is_file(), reason="rain Inferno entity lump is not bundled"
)
def test_rain_inferno_zstd_entity_lump_brightness_is_halved() -> None:
    bundled = RAIN_INFERNO_VENTS.read_bytes()
    before = inspect_light_environment(bundled)
    assert before.brightness == pytest.approx(1.5)
    restored = scale_light_environment_direct_brightness(bundled, factor=2.0)
    assert inspect_light_environment(restored).brightness == pytest.approx(3.0)


def test_bundled_rain_maps_keep_half_direct_sun() -> None:
    missing = [
        name
        for name in HALVED_BRIGHTNESS
        if not (RAIN_ROOT / name / "default_ents.vents_c").is_file()
    ]
    if missing:
        pytest.skip(f"rain entity lumps not bundled: {', '.join(missing)}")
    for map_name, expected in HALVED_BRIGHTNESS.items():
        info = inspect_light_environment(
            (RAIN_ROOT / map_name / "default_ents.vents_c").read_bytes()
        )
        assert info.classname == "light_environment"
        assert info.brightness == pytest.approx(expected)
        assert info.brightnessscale == pytest.approx(1.0)


def test_rain_entity_lump_hashes_match_manifest() -> None:
    manifest_path = RAIN_ROOT / "manifest.json"
    if not manifest_path.is_file():
        pytest.skip("rain manifest is not bundled")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for profile in manifest["maps"].values():
        for item in profile["loose_outer_replacements"]:
            relative = str(item["payload_relative_path"])
            if not relative.endswith("default_ents.vents_c"):
                continue
            path = RAIN_ROOT / relative
            if not path.is_file():
                pytest.skip(f"rain entity lump is not bundled: {relative}")
            payload = path.read_bytes()
            assert len(payload) == item["payload_size"]
            assert hashlib.sha256(payload).hexdigest() == item["payload_sha256"]


def test_scale_rejects_missing_light_environment() -> None:
    with pytest.raises(EntityLumpKv3Error):
        scale_light_environment_direct_brightness(b"not-a-vents-file", factor=0.5)
