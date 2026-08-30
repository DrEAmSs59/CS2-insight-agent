from __future__ import annotations

import copy
import hashlib
import struct
import zlib
import zipfile
from pathlib import Path, PurePosixPath

import pytest

from app import chroma_skybox_child as child


_HEADER = struct.Struct("<7I")
_ENTRY = struct.Struct("<IHHIIH")
_MAGIC = 0x55AA1234
_VERSION = 2
_INLINE = 0x7FFF

_MAP = "de_test"
_SOURCE_RELATIVE = "maps/prefabs/de_test/de_test_skybox.vpk"
_TARGET_ENTRY = (
    "maps/prefabs/de_test/de_test_skybox/worldnodes/n0.vwnod_c"
)
_PRESERVED_ENTRY = (
    "maps/prefabs/de_test/de_test_skybox/entities/default_ents.vents_c"
)
_PAYLOAD_RELATIVE = "de_test/worldnodes/n0.vwnod_c"


def _path_parts(path: str) -> tuple[str, str, str]:
    normalized = path.replace("\\", "/").strip("/")
    directory, _, filename = normalized.rpartition("/")
    stem, dot, extension = filename.rpartition(".")
    if not dot:
        stem, extension = filename, " "
    return extension, directory or " ", stem


def _make_inline_vpk(
    entries: dict[str, tuple[bytes, bytes]],
) -> bytes:
    grouped: dict[str, dict[str, list[tuple[str, bytes, bytes]]]] = {}
    for path, (preload, body) in entries.items():
        extension, directory, stem = _path_parts(path)
        grouped.setdefault(extension, {}).setdefault(directory, []).append(
            (stem, preload, body)
        )

    tree = bytearray()
    data = bytearray()
    offset = 0
    for extension in sorted(grouped):
        tree += extension.encode("utf-8") + b"\0"
        for directory in sorted(grouped[extension]):
            tree += directory.encode("utf-8") + b"\0"
            for stem, preload, body in sorted(
                grouped[extension][directory], key=lambda item: item[0]
            ):
                tree += stem.encode("utf-8") + b"\0"
                tree += _ENTRY.pack(
                    zlib.crc32(preload + body) & 0xFFFFFFFF,
                    len(preload),
                    _INLINE,
                    offset,
                    len(body),
                    0xFFFF,
                )
                tree += preload
                data += body
                offset += len(body)
            tree += b"\0"
        tree += b"\0"
    tree += b"\0"

    header = _HEADER.pack(_MAGIC, _VERSION, len(tree), len(data), 0, 48, 0)
    tree_md5 = hashlib.md5(tree).digest()
    archive_md5 = hashlib.md5(b"").digest()
    whole_md5 = hashlib.md5(header + tree + data + tree_md5 + archive_md5).digest()
    return header + tree + data + tree_md5 + archive_md5 + whole_md5


def _write_relative(root: Path, relative_path: str, body: bytes) -> Path:
    path = root.joinpath(*PurePosixPath(relative_path).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def _refresh_payload_catalog(payload_root: Path, manifest: dict) -> None:
    members: list[str] = []
    for profile in manifest["maps"].values():
        for replacement in profile["replacements"]:
            members.append(replacement["payload_relative_path"])
    manifest["payload_catalog"] = {
        "format": "zip",
        "relative_path": "payloads.zip",
        "entry_count": len(members),
    }
    with zipfile.ZipFile(
        payload_root / "payloads.zip",
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as archive:
        for member in sorted(members):
            archive.write(
                payload_root.joinpath(*PurePosixPath(member).parts),
                arcname=member,
            )


def _fixture_data(
    tmp_path: Path,
    *,
    target_preload: bytes = b"",
) -> tuple[Path, Path, Path, bytes, bytes, dict]:
    csgo = tmp_path / "game" / "csgo"
    payload_root = tmp_path / "payloads"
    csgo.mkdir(parents=True)
    payload_root.mkdir()

    original_target = b"official-world-node"
    preserved = b"official-entity-lump"
    source_bytes = _make_inline_vpk(
        {
            _TARGET_ENTRY: (target_preload, original_target),
            _PRESERVED_ENTRY: (b"", preserved),
        }
    )
    source_path = _write_relative(csgo, _SOURCE_RELATIVE, source_bytes)
    payload = b"patched-color-agnostic-world-node"
    _write_relative(payload_root, _PAYLOAD_RELATIVE, payload)

    original_full = target_preload + original_target
    manifest = {
        "schema_version": 1,
        "maps": {
            _MAP: {
                "status": "validated",
                "source_relative_path": _SOURCE_RELATIVE,
                "source_size": len(source_bytes),
                "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                "output_logical_path": _SOURCE_RELATIVE,
                "replacements": [
                    {
                        "entry_path": _TARGET_ENTRY,
                        "original_size": len(original_full),
                        "original_sha256": hashlib.sha256(original_full).hexdigest(),
                        "payload_relative_path": _PAYLOAD_RELATIVE,
                        "payload_size": len(payload),
                        "payload_sha256": hashlib.sha256(payload).hexdigest(),
                    }
                ],
            }
        },
    }
    _refresh_payload_catalog(payload_root, manifest)
    return csgo, payload_root, source_path, preserved, payload, manifest


def _assert_other_md5(package: bytes) -> None:
    magic, version, tree_size, data_size, archive_size, other_size, signature_size = (
        _HEADER.unpack_from(package)
    )
    assert magic == _MAGIC
    assert version == _VERSION
    assert archive_size == 0
    assert other_size == 48
    assert signature_size == 0
    tree = package[_HEADER.size : _HEADER.size + tree_size]
    other_start = _HEADER.size + tree_size + data_size
    other = package[other_start : other_start + other_size]
    assert len(package) == other_start + 48
    assert other[:16] == hashlib.md5(tree).digest()
    assert other[16:32] == hashlib.md5(b"").digest()
    assert other[32:] == hashlib.md5(package[:other_start] + other[:32]).digest()


def test_build_is_deterministic_color_agnostic_and_preserves_source(tmp_path: Path):
    csgo, payload_root, source, preserved, payload, manifest = _fixture_data(tmp_path)
    source_before = source.read_bytes()

    green_hint = copy.deepcopy(manifest)
    green_hint["selected_color_hint"] = "green"
    blue_hint = copy.deepcopy(manifest)
    blue_hint["selected_color_hint"] = "blue"
    first = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=green_hint,
        map_name=_MAP,
    )
    second = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=blue_hint,
        map_name="test",
    )

    assert first.logical_path == _SOURCE_RELATIVE
    assert first.vpk_bytes == second.vpk_bytes
    assert first.metadata["output"]["sha256"] == hashlib.sha256(first.vpk_bytes).hexdigest()
    assert "color" not in first.metadata
    assert source.read_bytes() == source_before
    assert hashlib.sha256(source.read_bytes()).hexdigest() == manifest["maps"][_MAP][
        "source_sha256"
    ]

    source_header, _, source_entries = child._open_package(source)
    output_header, _, output_entries = child._open_package_bytes(first.vpk_bytes)
    assert set(output_entries) == set(source_entries)
    replacement = output_entries[_TARGET_ENTRY]
    assert replacement.offset == source_header.data_size
    assert replacement.length == len(payload)
    assert replacement.crc32 == zlib.crc32(payload) & 0xFFFFFFFF
    assert child._read_inline_entry_bytes(first.vpk_bytes, output_header, replacement) == payload
    assert (
        child._read_inline_entry_bytes(
            first.vpk_bytes,
            output_header,
            output_entries[_PRESERVED_ENTRY],
        )
        == preserved
    )
    assert first.metadata["source"]["size"] == len(source_before)
    assert first.metadata["source"]["entry_count"] == 2
    assert first.metadata["output"]["entry_count"] == 2
    assert first.metadata["output"]["signature_size"] == 0
    assert first.metadata["replacements"] == second.metadata["replacements"]
    assert first.metadata["replacements"][0]["payload_sha256"] == hashlib.sha256(
        payload
    ).hexdigest()
    _assert_other_md5(first.vpk_bytes)


def test_declared_validated_output_size_and_hash_are_enforced(tmp_path: Path):
    csgo, payload_root, _source, _preserved, _payload, manifest = _fixture_data(
        tmp_path
    )
    baseline = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=manifest,
        map_name=_MAP,
    )
    profile = manifest["maps"][_MAP]
    profile["validated_output_size"] = len(baseline.vpk_bytes)
    profile["validated_output_sha256"] = hashlib.sha256(
        baseline.vpk_bytes
    ).hexdigest()

    pinned = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=manifest,
        map_name=_MAP,
    )
    assert pinned.vpk_bytes == baseline.vpk_bytes
    assert pinned.metadata["output"]["validated_expected_size"] == len(
        baseline.vpk_bytes
    )

    wrong_size = copy.deepcopy(manifest)
    wrong_size["maps"][_MAP]["validated_output_size"] += 1
    with pytest.raises(child.ChromaSkyboxChildError, match="output size mismatch"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=wrong_size,
            map_name=_MAP,
        )

    wrong_hash = copy.deepcopy(manifest)
    wrong_hash["maps"][_MAP]["validated_output_sha256"] = "0" * 64
    with pytest.raises(child.ChromaSkyboxChildError, match="output SHA-256 mismatch"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=wrong_hash,
            map_name=_MAP,
        )


def test_validated_output_size_and_hash_must_be_declared_together(tmp_path: Path):
    csgo, payload_root, _source, _preserved, _payload, manifest = _fixture_data(
        tmp_path
    )
    manifest["maps"][_MAP]["validated_output_size"] = 123

    with pytest.raises(child.ChromaSkyboxChildError, match="declared together"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )


def test_multiple_replacements_are_appended_in_stable_entry_order(tmp_path: Path):
    csgo, payload_root, source, preserved, _payload, manifest = _fixture_data(tmp_path)
    entity_payload_relative = "de_test/entities/default_ents.vents_c"
    entity_payload = b"patched-color-agnostic-entity-lump"
    _write_relative(payload_root, entity_payload_relative, entity_payload)
    manifest["maps"][_MAP]["replacements"].append(
        {
            "entry_path": _PRESERVED_ENTRY,
            "original_size": len(preserved),
            "original_sha256": hashlib.sha256(preserved).hexdigest(),
            "payload_relative_path": entity_payload_relative,
            "payload_size": len(entity_payload),
            "payload_sha256": hashlib.sha256(entity_payload).hexdigest(),
        }
    )
    _refresh_payload_catalog(payload_root, manifest)

    result = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=manifest,
        map_name=_MAP,
    )

    source_header, _, _ = child._open_package(source)
    output_header, _, output_entries = child._open_package_bytes(result.vpk_bytes)
    sorted_paths = sorted((_TARGET_ENTRY, _PRESERVED_ENTRY))
    expected_offset = source_header.data_size
    expected_payloads = {
        _TARGET_ENTRY: b"patched-color-agnostic-world-node",
        _PRESERVED_ENTRY: entity_payload,
    }
    for entry_path in sorted_paths:
        entry = output_entries[entry_path]
        payload = expected_payloads[entry_path]
        assert entry.offset == expected_offset
        assert child._read_inline_entry_bytes(result.vpk_bytes, output_header, entry) == payload
        expected_offset += len(payload)
    assert [item["entry_path"] for item in result.metadata["replacements"]] == sorted_paths
    assert output_header.data_size == expected_offset


def test_hash_pinned_official_trailing_bytes_are_not_copied_to_output(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    retail_tail = b"retail-signature-extension-not-declared-by-v2-header"
    source.write_bytes(source.read_bytes() + retail_tail)
    source_bytes = source.read_bytes()
    manifest["maps"][_MAP]["source_size"] = len(source_bytes)
    manifest["maps"][_MAP]["source_sha256"] = hashlib.sha256(source_bytes).hexdigest()

    result = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=manifest,
        map_name=_MAP,
    )

    header, _, _ = child._open_package_bytes(result.vpk_bytes)
    assert header.total_size == len(result.vpk_bytes)
    assert not result.vpk_bytes.endswith(retail_tail)
    assert source.read_bytes() == source_bytes


def test_source_hash_mismatch_fails_without_touching_source(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["source_sha256"] = "0" * 64

    with pytest.raises(child.ChromaSkyboxChildError, match="official child VPK SHA-256 changed"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_source_size_mismatch_fails_closed(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["source_size"] += 1

    with pytest.raises(child.ChromaSkyboxChildError, match="official child VPK size changed"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_original_entry_hash_mismatch_fails_closed(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["replacements"][0]["original_sha256"] = "f" * 64

    with pytest.raises(child.ChromaSkyboxChildError, match="entry SHA-256 changed"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_replacement_requires_inline_zero_preload(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(
        tmp_path,
        target_preload=b"preload",
    )
    original = source.read_bytes()

    with pytest.raises(child.ChromaSkyboxChildError, match="zero preload"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_payload_hash_mismatch_fails_closed(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["replacements"][0]["payload_sha256"] = "1" * 64

    with pytest.raises(child.ChromaSkyboxChildError, match="payload SHA-256 mismatch"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_payload_catalog_rejects_extra_member(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    with zipfile.ZipFile(payload_root / "payloads.zip", "a") as archive:
        archive.writestr("unexpected.bin", b"unexpected")

    with pytest.raises(child.ChromaSkyboxChildError, match="entry count"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_payload_catalog_is_required(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest.pop("payload_catalog")

    with pytest.raises(child.ChromaSkyboxChildError, match="payload_catalog"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_relative_path", "../de_test_skybox.vpk"),
        ("source_relative_path", "C:/maps/de_test_skybox.vpk"),
        ("output_logical_path", "maps/prefabs/de_test/other.vpk"),
    ],
)
def test_source_and_output_paths_are_strictly_scoped(
    tmp_path: Path,
    field: str,
    value: str,
):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP][field] = value

    with pytest.raises(child.ChromaSkyboxChildError):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_payload_path_traversal_is_rejected(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["replacements"][0]["payload_relative_path"] = (
        "../outside.vwnod_c"
    )

    with pytest.raises(child.ChromaSkyboxChildError, match="invalid relative path"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_replacement_entry_must_stay_in_child_package_namespace(tmp_path: Path):
    csgo, payload_root, source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    manifest["maps"][_MAP]["replacements"][0]["entry_path"] = (
        "maps/prefabs/de_other/de_other_skybox/worldnodes/n0.vwnod_c"
    )

    with pytest.raises(child.ChromaSkyboxChildError, match="outside the child package namespace"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    assert source.read_bytes() == original


def test_manifest_accepts_safe_official_prefab_folder_aliases(tmp_path: Path):
    _csgo, _payload_root, _source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    alias_root = "maps/prefabs/official_alias"
    profile = manifest["maps"][_MAP]
    profile["source_relative_path"] = f"{alias_root}/test_skybox.vpk"
    profile["output_logical_path"] = profile["source_relative_path"]
    profile["replacements"][0]["entry_path"] = f"{alias_root}/worldnodes/n0.vwnod_c"

    parsed = child._parse_profile(
        manifest,
        _MAP,
        require_in_game_confirmed=True,
    )

    assert parsed.source_relative_path == f"{alias_root}/test_skybox.vpk"
    assert parsed.replacements[0].entry_path == f"{alias_root}/worldnodes/n0.vwnod_c"


def test_candidate_profile_requires_explicit_nonproduction_opt_in(tmp_path: Path):
    csgo, payload_root, _source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    manifest["maps"][_MAP]["status"] = "candidate"

    with pytest.raises(child.ChromaSkyboxChildError, match="is not validated"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name=_MAP,
        )

    result = child.build_chroma_child_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        manifest=manifest,
        map_name=_MAP,
        require_in_game_confirmed=False,
    )
    assert result.metadata["status"] == "candidate"


def test_schema_and_map_are_validated_before_source_access(tmp_path: Path):
    csgo, payload_root, _source, _preserved, _payload, manifest = _fixture_data(tmp_path)
    bad_schema = copy.deepcopy(manifest)
    bad_schema["schema_version"] = 2
    with pytest.raises(child.ChromaSkyboxChildError, match="manifest schema"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=bad_schema,
            map_name=_MAP,
        )

    with pytest.raises(child.ChromaSkyboxChildError, match="does not support map"):
        child.build_chroma_child_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            manifest=manifest,
            map_name="de_missing",
        )
