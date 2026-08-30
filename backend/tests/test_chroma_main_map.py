from __future__ import annotations

import copy
import hashlib
import struct
import zlib
from pathlib import Path, PurePosixPath

import pytest

from app import chroma_main_map as main_map
from app import chroma_skybox_child as child


_HEADER = struct.Struct("<7I")
_ENTRY = struct.Struct("<IHHIIH")
_MAGIC = 0x55AA1234
_VERSION = 2
_INLINE = 0x7FFF

_MAP = "de_test"
_SOURCE_RELATIVE = "maps/de_test.vpk"
_WORLD_ENTRY = "maps/de_test/worldnodes/n0.vwnod_c"
_ENTITY_ENTRY = "maps/de_test/entities/default_ents.vents_c"
_PRESERVED_ENTRY = "maps/de_test/other/preserved.bin"
_WORLD_PAYLOAD_RELATIVE = "maps/de_test/worldnodes/n0.vwnod_c"
_ENTITY_PAYLOAD_RELATIVE = "maps/de_test/entities/default_ents.vents_c"


def _path_parts(path: str) -> tuple[str, str, str]:
    normalized = path.replace("\\", "/").strip("/")
    directory, _, filename = normalized.rpartition("/")
    stem, dot, extension = filename.rpartition(".")
    if not dot:
        stem, extension = filename, " "
    return extension, directory or " ", stem


def _make_inline_vpk(entries: dict[str, tuple[bytes, bytes]]) -> bytes:
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


def _reference_patch_inline_vpk(
    source: Path, replacements: dict[str, bytes]
) -> bytes:
    source_header, source_tree, source_entries = child._open_package(source)
    patched_tree = bytearray(source_tree)
    appended_offset = source_header.data_size
    for entry_path in sorted(replacements):
        payload = replacements[entry_path]
        entry = source_entries[entry_path]
        struct.pack_into(
            "<I", patched_tree, entry.crc_field_offset, zlib.crc32(payload) & 0xFFFFFFFF
        )
        struct.pack_into("<H", patched_tree, entry.archive_field_offset, _INLINE)
        struct.pack_into(
            "<I", patched_tree, entry.data_offset_field_offset, appended_offset
        )
        struct.pack_into("<I", patched_tree, entry.length_field_offset, len(payload))
        appended_offset += len(payload)

    header = _HEADER.pack(
        _MAGIC, _VERSION, len(patched_tree), appended_offset, 0, 48, 0
    )
    with source.open("rb") as stream:
        stream.seek(source_header.data_start)
        official_data = stream.read(source_header.data_size)
    appended = b"".join(replacements[path] for path in sorted(replacements))
    tree_md5 = hashlib.md5(patched_tree).digest()
    archive_md5 = hashlib.md5(b"").digest()
    whole_md5 = hashlib.md5(
        header + patched_tree + official_data + appended + tree_md5 + archive_md5
    ).digest()
    return (
        header
        + patched_tree
        + official_data
        + appended
        + tree_md5
        + archive_md5
        + whole_md5
    )


def _fixture_data(
    tmp_path: Path,
    *,
    world_preload: bytes = b"",
    trailing: bytes = b"",
) -> tuple[Path, Path, Path, Path, bytes, bytes, bytes, dict]:
    csgo = tmp_path / "game" / "csgo"
    payload_root = tmp_path / "payloads"
    staging = tmp_path / "staging"
    csgo.mkdir(parents=True)
    payload_root.mkdir()
    staging.mkdir()

    official_world = b"official-main-world-node"
    official_entity = b"official-main-entity-lump"
    preserved = b"official-non-target-data"
    source_bytes = _make_inline_vpk(
        {
            _WORLD_ENTRY: (world_preload, official_world),
            _ENTITY_ENTRY: (b"", official_entity),
            _PRESERVED_ENTRY: (b"", preserved),
        }
    ) + trailing
    source = _write_relative(csgo, _SOURCE_RELATIVE, source_bytes)

    world_payload = b"patched-main-world-node-without-lightshafts"
    entity_payload = b"patched-main-entity-lump-with-fog-disabled"
    _write_relative(payload_root, _WORLD_PAYLOAD_RELATIVE, world_payload)
    _write_relative(payload_root, _ENTITY_PAYLOAD_RELATIVE, entity_payload)

    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    source_size = len(source_bytes)
    expected_output = _reference_patch_inline_vpk(
        source,
        {
            _WORLD_ENTRY: world_payload,
            _ENTITY_ENTRY: entity_payload,
        },
    )

    def replacement(
        *,
        kind: str,
        entry_path: str,
        original: bytes,
        payload_relative_path: str,
        payload: bytes,
    ) -> dict:
        return {
            "kind": kind,
            "status": "validated",
            "entry_path": entry_path,
            "source_package_relative_path": _SOURCE_RELATIVE,
            "source_package_size": source_size,
            "source_package_sha256": source_sha256,
            "original_size": len(original),
            "original_sha256": hashlib.sha256(original).hexdigest(),
            "original_crc32": f"{zlib.crc32(original) & 0xFFFFFFFF:08x}",
            "payload_relative_path": payload_relative_path,
            "payload_size": len(payload),
            "payload_sha256": hashlib.sha256(payload).hexdigest(),
            "payload_crc32": f"{zlib.crc32(payload) & 0xFFFFFFFF:08x}",
        }

    manifest = {
        "schema_version": 2,
        "maps": {
            _MAP: {
                "status": "validated",
                "main_source": {
                    "source_package_relative_path": _SOURCE_RELATIVE,
                    "source_package_size": source_size,
                    "source_package_sha256": source_sha256,
                    "expected_output_size": len(expected_output),
                    "expected_output_sha256": hashlib.sha256(
                        expected_output
                    ).hexdigest(),
                    "expected_output_entry_count": 3,
                },
                "loose_outer_replacements": [
                    replacement(
                        kind="main_worldnode_scene_filter",
                        entry_path=_WORLD_ENTRY,
                        original=world_preload + official_world,
                        payload_relative_path=_WORLD_PAYLOAD_RELATIVE,
                        payload=world_payload,
                    ),
                    replacement(
                        kind="main_entity_lump",
                        entry_path=_ENTITY_ENTRY,
                        original=official_entity,
                        payload_relative_path=_ENTITY_PAYLOAD_RELATIVE,
                        payload=entity_payload,
                    ),
                ],
            }
        },
    }
    return (
        csgo,
        payload_root,
        staging,
        source,
        preserved,
        world_payload,
        entity_payload,
        manifest,
    )


def _read_entry(path: Path, entry_path: str) -> bytes:
    header, _, entries = child._open_package(path)
    with path.open("rb") as stream:
        return child._read_inline_entry(stream, header, entries[entry_path])


def _assert_other_md5(path: Path) -> None:
    body = path.read_bytes()
    magic, version, tree_size, data_size, archive_size, other_size, signature_size = (
        _HEADER.unpack_from(body)
    )
    assert magic == _MAGIC
    assert version == _VERSION
    assert archive_size == 0
    assert other_size == 48
    assert signature_size == 0
    tree = body[_HEADER.size : _HEADER.size + tree_size]
    other_start = _HEADER.size + tree_size + data_size
    other = body[other_start : other_start + 48]
    assert len(body) == other_start + 48
    assert other[:16] == hashlib.md5(tree).digest()
    assert other[16:32] == hashlib.md5(b"").digest()
    assert other[32:] == hashlib.md5(body[:other_start] + other[:32]).digest()


def test_stream_build_is_deterministic_verified_and_preserves_source(tmp_path: Path):
    (
        csgo,
        payload_root,
        staging,
        source,
        preserved,
        world_payload,
        entity_payload,
        manifest,
    ) = _fixture_data(tmp_path)
    source_before = source.read_bytes()
    first_path = staging / "first.vpk"
    second_path = staging / "second.vpk"

    first = main_map.build_chroma_main_map_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        output_path=first_path,
        manifest=manifest,
        map_name="test",
    )
    second = main_map.build_chroma_main_map_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        output_path=second_path,
        manifest=copy.deepcopy(manifest),
        map_name=_MAP,
    )

    assert first.logical_path == _SOURCE_RELATIVE
    assert first.output_path == first_path.resolve()
    assert first_path.read_bytes() == second_path.read_bytes()
    assert source.read_bytes() == source_before
    assert _read_entry(first_path, _WORLD_ENTRY) == world_payload
    assert _read_entry(first_path, _ENTITY_ENTRY) == entity_payload
    assert _read_entry(first_path, _PRESERVED_ENTRY) == preserved

    source_header, _, source_entries = child._open_package(source)
    output_header, _, output_entries = child._open_package(first_path)
    assert set(output_entries) == set(source_entries)
    for entry_path in source_entries:
        if entry_path not in {_WORLD_ENTRY, _ENTITY_ENTRY}:
            assert child._entry_identity(output_entries[entry_path]) == child._entry_identity(
                source_entries[entry_path]
            )
    expected_offset = source_header.data_size
    expected_payloads = {
        _ENTITY_ENTRY: entity_payload,
        _WORLD_ENTRY: world_payload,
    }
    for entry_path in sorted(expected_payloads):
        assert output_entries[entry_path].offset == expected_offset
        expected_offset += len(expected_payloads[entry_path])
    assert output_header.data_size == expected_offset

    assert first.metadata["status"] == "validated"
    assert first.metadata["source"]["sha256"] == hashlib.sha256(source_before).hexdigest()
    assert first.metadata["source"]["entry_count"] == 3
    assert first.metadata["output"]["sha256"] == hashlib.sha256(
        first_path.read_bytes()
    ).hexdigest()
    assert first.metadata["output"]["entry_count"] == 3
    assert first.metadata["output"]["atomic_replace"] is True
    assert first.metadata["output"]["replaced_existing"] is False
    assert [item["entry_path"] for item in first.metadata["replacements"]] == sorted(
        (_WORLD_ENTRY, _ENTITY_ENTRY)
    )
    _assert_other_md5(first_path)


def test_builder_never_calls_path_read_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)

    def forbidden_read_bytes(_self: Path) -> bytes:
        raise AssertionError("stream builder must not call Path.read_bytes")

    monkeypatch.setattr(Path, "read_bytes", forbidden_read_bytes)
    result = main_map.build_chroma_main_map_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        output_path=staging / "streamed.vpk",
        manifest=manifest,
        map_name=_MAP,
    )
    assert result.output_path.stat().st_size == result.metadata["output"]["size"]


def test_hash_pinned_official_trailing_bytes_are_not_copied(tmp_path: Path):
    retail_tail = b"retail-signature-extension-not-declared-by-v2-header"
    csgo, payload_root, staging, source, *_rest, manifest = _fixture_data(
        tmp_path, trailing=retail_tail
    )
    output = staging / "without-retail-tail.vpk"

    result = main_map.build_chroma_main_map_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        output_path=output,
        manifest=manifest,
        map_name=_MAP,
    )

    assert source.read_bytes().endswith(retail_tail)
    assert not output.read_bytes().endswith(retail_tail)
    assert result.metadata["source"]["undeclared_trailing_size"] == len(retail_tail)
    assert result.metadata["output"]["undeclared_trailing_size"] == 0


@pytest.mark.parametrize(
    ("field_path", "value", "message"),
    [
        (("main_source", "source_package_size"), 1, "official main-map VPK size changed"),
        (
            ("main_source", "source_package_sha256"),
            "0" * 64,
            "official main-map VPK SHA-256 changed",
        ),
        (
            ("main_source", "expected_output_size"),
            1,
            "manifest expected output size is inconsistent",
        ),
        (
            ("main_source", "expected_output_sha256"),
            "4" * 64,
            "reconstructed main-map VPK SHA-256 differs from manifest",
        ),
        (
            ("main_source", "expected_output_entry_count"),
            99,
            "official main-map VPK entry count changed",
        ),
        (("replacement", "original_size"), 1, "entry size changed"),
        (("replacement", "original_sha256"), "1" * 64, "entry SHA-256 changed"),
        (("replacement", "original_crc32"), "00000000", "entry CRC32 changed"),
        (("replacement", "payload_size"), 1, "payload size mismatch"),
        (("replacement", "payload_sha256"), "2" * 64, "payload SHA-256 mismatch"),
        (("replacement", "payload_crc32"), "00000000", "payload CRC32 mismatch"),
    ],
)
def test_size_and_hash_guards_fail_closed(
    tmp_path: Path,
    field_path: tuple[str, str],
    value: object,
    message: str,
):
    csgo, payload_root, staging, source, *_rest, manifest = _fixture_data(tmp_path)
    original = source.read_bytes()
    existing = staging / "existing.vpk"
    existing.write_bytes(b"previous-good-output")
    profile = manifest["maps"][_MAP]
    if field_path[0] == "main_source":
        profile["main_source"][field_path[1]] = value
        for replacement in profile["loose_outer_replacements"]:
            mirrored = {
                "source_package_size": "source_package_size",
                "source_package_sha256": "source_package_sha256",
            }.get(field_path[1])
            if mirrored:
                replacement[mirrored] = value
    else:
        profile["loose_outer_replacements"][0][field_path[1]] = value

    with pytest.raises(main_map.ChromaMainMapError, match=message):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=existing,
            manifest=manifest,
            map_name=_MAP,
        )
    assert source.read_bytes() == original
    assert existing.read_bytes() == b"previous-good-output"


def test_candidate_requires_explicit_nonproduction_opt_in(tmp_path: Path):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)
    manifest["maps"][_MAP]["status"] = "candidate_requires_in_game_gate"

    with pytest.raises(main_map.ChromaMainMapError, match="profile is not validated"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "production.vpk",
            manifest=manifest,
            map_name=_MAP,
        )

    result = main_map.build_chroma_main_map_vpk(
        csgo_dir=csgo,
        payload_root=payload_root,
        output_path=staging / "research.vpk",
        manifest=manifest,
        map_name=_MAP,
        require_in_game_confirmed=False,
    )
    assert result.metadata["status"] == "candidate_requires_in_game_gate"


def test_unvalidated_replacement_is_rejected_in_production(tmp_path: Path):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)
    manifest["maps"][_MAP]["loose_outer_replacements"][0]["status"] = "candidate"

    with pytest.raises(main_map.ChromaMainMapError, match="replacement is not validated"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "production.vpk",
            manifest=manifest,
            map_name=_MAP,
        )


@pytest.mark.parametrize(
    ("mutator", "message"),
    [
        (
            lambda profile: profile["main_source"].__setitem__(
                "source_package_relative_path", "maps/de_other.vpk"
            ),
            "exact official path",
        ),
        (
            lambda profile: profile["main_source"].__setitem__(
                "output_logical_path", "maps/de_other.vpk"
            ),
            "exact official logical path",
        ),
        (
            lambda profile: profile["loose_outer_replacements"][0].__setitem__(
                "entry_path", "maps/de_other/worldnodes/n0.vwnod_c"
            ),
            "outside the main-map namespace",
        ),
        (
            lambda profile: profile["loose_outer_replacements"][0].__setitem__(
                "kind", "main_entity_lump"
            ),
            "not an EntityLump",
        ),
        (
            lambda profile: profile["loose_outer_replacements"][0].__setitem__(
                "payload_relative_path", "../outside.vwnod_c"
            ),
            "invalid relative path",
        ),
        (
            lambda profile: profile["loose_outer_replacements"][0].__setitem__(
                "source_package_sha256", "3" * 64
            ),
            "differs from main_source",
        ),
    ],
)
def test_manifest_paths_kinds_and_source_identity_are_strict(
    tmp_path: Path,
    mutator,
    message: str,
):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)
    mutator(manifest["maps"][_MAP])

    with pytest.raises(main_map.ChromaMainMapError, match=message):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "blocked.vpk",
            manifest=manifest,
            map_name=_MAP,
        )


def test_replacement_requires_inline_zero_preload(tmp_path: Path):
    csgo, payload_root, staging, source, *_rest, manifest = _fixture_data(
        tmp_path, world_preload=b"preload"
    )
    original = source.read_bytes()

    with pytest.raises(main_map.ChromaMainMapError, match="zero preload"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "blocked.vpk",
            manifest=manifest,
            map_name=_MAP,
        )
    assert source.read_bytes() == original


def test_output_must_be_outside_game_and_parent_must_exist(tmp_path: Path):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)

    with pytest.raises(main_map.ChromaMainMapError, match="game tree"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=csgo / "maps" / "runtime.vpk",
            manifest=manifest,
            map_name=_MAP,
        )
    with pytest.raises(main_map.ChromaMainMapError, match="directory does not exist"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "missing" / "runtime.vpk",
            manifest=manifest,
            map_name=_MAP,
        )


def test_post_write_verification_failure_preserves_existing_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)
    output = staging / "atomic.vpk"
    output.write_bytes(b"previous-good-output")

    def fail_verification(*_args, **_kwargs):
        raise main_map.ChromaMainMapError("injected verification failure")

    monkeypatch.setattr(main_map, "_verify_output_file", fail_verification)
    with pytest.raises(main_map.ChromaMainMapError, match="injected verification failure"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=output,
            manifest=manifest,
            map_name=_MAP,
        )
    assert output.read_bytes() == b"previous-good-output"
    assert not list(staging.glob(".atomic.vpk.tmp-*"))


def test_source_change_during_build_preserves_existing_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    csgo, payload_root, staging, source, *_rest, manifest = _fixture_data(tmp_path)
    output = staging / "atomic.vpk"
    output.write_bytes(b"previous-good-output")
    real_sha256_file = main_map._sha256_file
    source_calls = 0

    def changing_source_hash(path: Path) -> str:
        nonlocal source_calls
        if path == source.resolve():
            source_calls += 1
            if source_calls == 2:
                return "f" * 64
        return real_sha256_file(path)

    monkeypatch.setattr(main_map, "_sha256_file", changing_source_hash)
    with pytest.raises(main_map.ChromaMainMapError, match="changed during construction"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=output,
            manifest=manifest,
            map_name=_MAP,
        )
    assert output.read_bytes() == b"previous-good-output"
    assert not list(staging.glob(".atomic.vpk.tmp-*"))


def test_schema_and_map_are_validated_before_source_access(tmp_path: Path):
    csgo, payload_root, staging, _source, *_rest, manifest = _fixture_data(tmp_path)
    bad_schema = copy.deepcopy(manifest)
    bad_schema["schema_version"] = 1

    with pytest.raises(main_map.ChromaMainMapError, match="manifest schema"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "blocked.vpk",
            manifest=bad_schema,
            map_name=_MAP,
        )
    with pytest.raises(main_map.ChromaMainMapError, match="does not support map"):
        main_map.build_chroma_main_map_vpk(
            csgo_dir=csgo,
            payload_root=payload_root,
            output_path=staging / "blocked.vpk",
            manifest=manifest,
            map_name="de_missing",
        )
