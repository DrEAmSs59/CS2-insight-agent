"""Build the bundled runtime catalog for the waxed-reflection map material."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.demo_voice_hud import read_inline_vpk, write_inline_vpk  # noqa: E402


PROFILE_ID = "waxed_reflection"
SOURCE_ROOT = PROJECT_ROOT / "docs" / "dust2-floor-reflection-research.local"
OUTPUT_DIR = PROJECT_ROOT / "pov" / "map_materials" / PROFILE_ID
SOURCE_PACKS = (
    ("de_dust2", "v4-original-brightness", "dust2_verified_waxed_scene_v4_original_brightness.vpk"),
    ("de_ancient", "ancient-v1-waxed-scene", "ancient_verified_waxed_scene_v1.vpk"),
    ("de_mirage", "mirage-v1-waxed-scene", "mirage_verified_waxed_scene_v1.vpk"),
    ("de_nuke", "nuke-v1-waxed-scene", "nuke_verified_waxed_scene_v1.vpk"),
    ("de_anubis", "anubis-v1-waxed-scene", "anubis_verified_waxed_scene_v1.vpk"),
    ("de_inferno", "inferno-v1-waxed-scene", "inferno_verified_waxed_scene_v1.vpk"),
    ("de_overpass", "overpass-v1-waxed-scene", "overpass_verified_waxed_scene_v1.vpk"),
    ("de_cache", "cache-v1-waxed-scene", "cache_verified_waxed_scene_v1.vpk"),
)
LIGHTING_COMMANDS = (
    "sv_cheats 1",
    "mat_fullbright 0",
    "r_rendersun 0",
    "r_directlighting 0",
    "r_indirectlighting 1",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    catalog_entries: dict[str, bytes] = {}
    shared_payloads: dict[str, bytes] | None = None
    maps: dict[str, list[dict[str, str]]] = {}
    sources: list[dict[str, object]] = []

    for map_name, build_name, artifact_name in SOURCE_PACKS:
        manifest_path = SOURCE_ROOT / "builds" / build_name / "manifest.json"
        artifact_path = SOURCE_ROOT / "artifacts" / artifact_name
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        package = artifact_path.read_bytes()
        package_sha = sha256_bytes(package)
        if manifest.get("map") != map_name:
            raise RuntimeError(f"manifest map mismatch: {manifest_path}")
        if package_sha != manifest.get("vpk_sha256"):
            raise RuntimeError(f"artifact hash mismatch: {artifact_path}")
        if manifest.get("dark_postprocess_included") is not False:
            raise RuntimeError(f"postprocess must not be bundled: {artifact_path}")
        if manifest.get("sky_is_modified") is not False:
            raise RuntimeError(f"sky material must not be bundled: {artifact_path}")

        entries = read_inline_vpk(package)
        included = [str(path) for path in manifest.get("included") or []]
        if len(included) != int(manifest.get("included_count") or -1):
            raise RuntimeError(f"included count mismatch: {manifest_path}")
        missing = sorted(set(included) - set(entries))
        if missing:
            raise RuntimeError(f"artifact is missing material entries: {missing[:5]}")
        extras = {path: body for path, body in entries.items() if path not in included}
        if shared_payloads is None:
            shared_payloads = extras
        elif extras != shared_payloads:
            raise RuntimeError(f"shared donor resources differ for {map_name}")

        material_mappings: list[dict[str, str]] = []
        for index, target_path in enumerate(included):
            catalog_path = (
                f"_cs2_insight_catalog/map_materials/{PROFILE_ID}/"
                f"{map_name}/{index:04d}.vmat_c"
            )
            catalog_entries[catalog_path] = entries[target_path]
            material_mappings.append(
                {
                    "target": target_path,
                    "catalog": catalog_path,
                    "sha256": sha256_bytes(entries[target_path]),
                }
            )
        maps[map_name] = material_mappings
        sources.append(
            {
                "map": map_name,
                "artifact": artifact_name,
                "artifact_sha256": package_sha,
                "material_count": len(material_mappings),
            }
        )

    if shared_payloads is None:
        raise RuntimeError("no source packs were configured")
    shared_entries: list[dict[str, str]] = []
    for index, (target_path, body) in enumerate(sorted(shared_payloads.items())):
        suffix = Path(target_path).suffix or ".bin"
        catalog_path = (
            f"_cs2_insight_catalog/map_materials/{PROFILE_ID}/"
            f"shared/{index:02d}{suffix}"
        )
        catalog_entries[catalog_path] = body
        shared_entries.append(
            {
                "target": target_path,
                "catalog": catalog_path,
                "sha256": sha256_bytes(body),
            }
        )

    catalog = write_inline_vpk(catalog_entries)
    if read_inline_vpk(catalog) != catalog_entries:
        raise RuntimeError("catalog failed full VPK read-back verification")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    catalog_path = OUTPUT_DIR / "catalog.vpk"
    manifest_path = OUTPUT_DIR / "manifest.json"
    catalog_path.write_bytes(catalog)
    output_manifest = {
        "schema_version": 1,
        "id": PROFILE_ID,
        "display_name": {
            "zh": "打蜡反光倒影",
            "en": "Waxed reflections",
        },
        "lighting_commands": list(LIGHTING_COMMANDS),
        "maps": maps,
        "shared_entries": shared_entries,
        "source_packs": sources,
        "map_count": len(maps),
        "material_count": sum(len(items) for items in maps.values()),
        "entry_count": len(catalog_entries),
        "catalog_bytes": len(catalog),
        "catalog_sha256": sha256_bytes(catalog),
    }
    manifest_path.write_text(
        json.dumps(output_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"maps={output_manifest['map_count']}")
    print(f"materials={output_manifest['material_count']}")
    print(f"entries={output_manifest['entry_count']}")
    print(f"catalog_bytes={output_manifest['catalog_bytes']}")
    print(f"catalog_sha256={output_manifest['catalog_sha256']}")
    print(f"output={catalog_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
