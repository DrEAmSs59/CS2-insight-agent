"""Fail-closed streaming reconstruction of chroma-patched main-map VPKs.

Main map WorldNodes are loaded from the map's CurrentPackage and cannot be
reliably shadowed as loose entries in the outer POV package.  This builder
therefore creates a verified, unsigned VPK-v2 copy of the official main map,
redirecting only manifest-declared inline entries to appended payloads.

The official package is never modified.  Source data and replacement payloads
are copied in bounded chunks to a sibling temporary file, verified on disk, and
atomically committed to a caller-selected staging path outside the game tree.
No full main-map package or replacement payload is held in memory.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
import uuid
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from . import chroma_skybox_child as _vpk


CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION = 2
CHROMA_MAIN_MAP_VALIDATED_STATUS = "validated"
_ALLOWED_PROFILE_STATUSES = frozenset(
    {
        "candidate",
        "candidate_requires_in_game_gate",
        "in_game_confirmed",
        CHROMA_MAIN_MAP_VALIDATED_STATUS,
    }
)
_ALLOWED_REPLACEMENT_KINDS = frozenset(
    {
        "main_entity_lump",
        "main_worldnode_scene_filter",
        "main_worldnode_static_model",
    }
)
_COPY_CHUNK_SIZE = 8 * 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CRC32_RE = re.compile(r"^[0-9a-f]{8}$")
_MAP_RE = re.compile(r"^de_[a-z0-9_]+$")


class ChromaMainMapError(RuntimeError):
    """A main-map manifest, source, payload, or output failed validation."""


@dataclass(frozen=True)
class ChromaMainMapVpkBuild:
    """Verified staging artifact and audit metadata for one main map."""

    logical_path: str
    output_path: Path
    metadata: dict[str, Any]


@dataclass(frozen=True)
class _ReplacementSpec:
    kind: str
    status: str
    entry_path: str
    original_size: int
    original_sha256: str
    original_crc32: int
    payload_relative_path: str
    payload_size: int
    payload_sha256: str
    payload_crc32: int


@dataclass(frozen=True)
class _Profile:
    map_name: str
    status: str
    source_relative_path: str
    source_size: int
    source_sha256: str
    expected_output_size: int
    expected_output_sha256: str
    expected_output_entry_count: int
    output_logical_path: str
    replacements: tuple[_ReplacementSpec, ...]


@dataclass(frozen=True)
class _PayloadValue:
    spec: _ReplacementSpec
    path: Path
    crc32: int


def _normalize_map_name(value: object) -> str:
    raw = str(value or "").strip().lower().replace("\\", "/")
    if not raw or "/" in raw:
        raise ChromaMainMapError("chroma main-map name is invalid")
    if raw.endswith(".vpk"):
        raw = raw[:-4]
    if not raw.startswith("de_"):
        raw = f"de_{raw}"
    if not _MAP_RE.fullmatch(raw):
        raise ChromaMainMapError("chroma main-map name is invalid")
    return raw


def _safe_relative_path(value: object, *, field: str) -> str:
    raw = str(value or "").strip()
    normalized = raw.replace("\\", "/")
    if (
        not normalized
        or "\x00" in normalized
        or normalized.startswith("/")
        or ":" in normalized
    ):
        raise ChromaMainMapError(f"invalid relative path in {field}")
    parts = normalized.split("/")
    if any(not part or part in {".", ".."} or part != part.strip() for part in parts):
        raise ChromaMainMapError(f"invalid relative path in {field}")
    path = PurePosixPath(*parts)
    if path.is_absolute() or ".." in path.parts:
        raise ChromaMainMapError(f"invalid relative path in {field}")
    return path.as_posix()


def _sha256_value(value: object, *, field: str) -> str:
    digest = str(value or "").strip().lower()
    if not _SHA256_RE.fullmatch(digest):
        raise ChromaMainMapError(f"invalid SHA-256 in {field}")
    return digest


def _size_value(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ChromaMainMapError(f"invalid byte size in {field}")
    return value


def _crc32_value(value: object, *, field: str) -> int:
    digest = str(value or "").strip().lower()
    if not _CRC32_RE.fullmatch(digest):
        raise ChromaMainMapError(f"invalid CRC32 in {field}")
    return int(digest, 16)


def _parse_profile(
    manifest: Mapping[str, Any],
    map_name: object,
    *,
    require_in_game_confirmed: bool,
) -> _Profile:
    if manifest.get("schema_version") != CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION:
        raise ChromaMainMapError("unsupported chroma main-map manifest schema")
    maps = manifest.get("maps")
    if not isinstance(maps, Mapping):
        raise ChromaMainMapError("chroma main-map manifest maps must be an object")

    normalized_map = _normalize_map_name(map_name)
    raw_profile = maps.get(normalized_map)
    if not isinstance(raw_profile, Mapping):
        raise ChromaMainMapError(
            f"chroma main-map manifest does not support map {normalized_map}"
        )

    status = str(raw_profile.get("status") or "").strip().lower()
    if status not in _ALLOWED_PROFILE_STATUSES:
        raise ChromaMainMapError(
            f"invalid chroma main-map validation status for {normalized_map}"
        )
    if require_in_game_confirmed and status != CHROMA_MAIN_MAP_VALIDATED_STATUS:
        raise ChromaMainMapError(
            f"chroma main-map profile is not validated for {normalized_map}"
        )

    raw_source = raw_profile.get("main_source")
    if not isinstance(raw_source, Mapping):
        raise ChromaMainMapError(f"main_source is missing for {normalized_map}")
    source_relative_path = _safe_relative_path(
        raw_source.get("source_package_relative_path"),
        field=f"maps.{normalized_map}.main_source.source_package_relative_path",
    )
    expected_source_path = f"maps/{normalized_map}.vpk"
    if source_relative_path != expected_source_path:
        raise ChromaMainMapError(
            f"main-map source must be the exact official path {expected_source_path}"
        )
    output_logical_path = _safe_relative_path(
        raw_source.get("output_logical_path") or source_relative_path,
        field=f"maps.{normalized_map}.main_source.output_logical_path",
    )
    if output_logical_path != source_relative_path:
        raise ChromaMainMapError(
            "chroma main-map output must override the exact official logical path"
        )
    source_size = _size_value(
        raw_source.get("source_package_size"),
        field=f"maps.{normalized_map}.main_source.source_package_size",
    )
    source_sha256 = _sha256_value(
        raw_source.get("source_package_sha256"),
        field=f"maps.{normalized_map}.main_source.source_package_sha256",
    )
    expected_output_size = _size_value(
        raw_source.get("expected_output_size"),
        field=f"maps.{normalized_map}.main_source.expected_output_size",
    )
    expected_output_sha256 = _sha256_value(
        raw_source.get("expected_output_sha256"),
        field=f"maps.{normalized_map}.main_source.expected_output_sha256",
    )
    expected_output_entry_count = _size_value(
        raw_source.get("expected_output_entry_count"),
        field=f"maps.{normalized_map}.main_source.expected_output_entry_count",
    )
    if expected_output_entry_count == 0:
        raise ChromaMainMapError(
            f"expected output entry count is empty for {normalized_map}"
        )

    raw_replacements = raw_profile.get("loose_outer_replacements")
    if not isinstance(raw_replacements, list) or not raw_replacements:
        raise ChromaMainMapError(
            f"main-map replacements are empty for {normalized_map}"
        )

    replacements: list[_ReplacementSpec] = []
    seen_entries: set[str] = set()
    required_entry_prefix = f"maps/{normalized_map}/"
    for index, raw_replacement in enumerate(raw_replacements):
        field = f"maps.{normalized_map}.loose_outer_replacements[{index}]"
        if not isinstance(raw_replacement, Mapping):
            raise ChromaMainMapError(f"invalid replacement object in {field}")
        kind = str(raw_replacement.get("kind") or "").strip().lower()
        if kind not in _ALLOWED_REPLACEMENT_KINDS:
            raise ChromaMainMapError(f"unsupported replacement kind in {field}")
        replacement_status = str(raw_replacement.get("status") or "").strip().lower()
        if replacement_status not in _ALLOWED_PROFILE_STATUSES:
            raise ChromaMainMapError(f"invalid replacement status in {field}")
        if (
            require_in_game_confirmed
            and replacement_status != CHROMA_MAIN_MAP_VALIDATED_STATUS
        ):
            raise ChromaMainMapError(
                f"main-map replacement is not validated in {field}"
            )

        repeated_source = _safe_relative_path(
            raw_replacement.get("source_package_relative_path"),
            field=f"{field}.source_package_relative_path",
        )
        repeated_size = _size_value(
            raw_replacement.get("source_package_size"),
            field=f"{field}.source_package_size",
        )
        repeated_sha256 = _sha256_value(
            raw_replacement.get("source_package_sha256"),
            field=f"{field}.source_package_sha256",
        )
        if (
            repeated_source != source_relative_path
            or repeated_size != source_size
            or repeated_sha256 != source_sha256
        ):
            raise ChromaMainMapError(
                f"replacement source identity differs from main_source in {field}"
            )

        entry_path = _safe_relative_path(
            raw_replacement.get("entry_path"), field=f"{field}.entry_path"
        )
        if not entry_path.startswith(required_entry_prefix):
            raise ChromaMainMapError(
                f"replacement entry is outside the main-map namespace: {entry_path}"
            )
        if kind == "main_entity_lump" and not (
            entry_path.startswith(f"{required_entry_prefix}entities/")
            and entry_path.endswith(".vents_c")
        ):
            raise ChromaMainMapError(
                f"main_entity_lump path is not an EntityLump: {entry_path}"
            )
        if kind == "main_worldnode_scene_filter" and not (
            entry_path.startswith(f"{required_entry_prefix}worldnodes/")
            and entry_path.endswith(".vwnod_c")
        ):
            raise ChromaMainMapError(
                f"main_worldnode_scene_filter path is not a WorldNode: {entry_path}"
            )
        if kind == "main_worldnode_static_model" and not (
            entry_path.startswith(f"{required_entry_prefix}worldnodes/")
            and entry_path.endswith(".vmdl_c")
        ):
            raise ChromaMainMapError(
                f"main_worldnode_static_model path is not a WorldNode model: {entry_path}"
            )
        if entry_path in seen_entries:
            raise ChromaMainMapError(f"duplicate replacement entry: {entry_path}")
        seen_entries.add(entry_path)
        replacements.append(
            _ReplacementSpec(
                kind=kind,
                status=replacement_status,
                entry_path=entry_path,
                original_size=_size_value(
                    raw_replacement.get("original_size"),
                    field=f"{field}.original_size",
                ),
                original_sha256=_sha256_value(
                    raw_replacement.get("original_sha256"),
                    field=f"{field}.original_sha256",
                ),
                original_crc32=_crc32_value(
                    raw_replacement.get("original_crc32"),
                    field=f"{field}.original_crc32",
                ),
                payload_relative_path=_safe_relative_path(
                    raw_replacement.get("payload_relative_path"),
                    field=f"{field}.payload_relative_path",
                ),
                payload_size=_size_value(
                    raw_replacement.get("payload_size"),
                    field=f"{field}.payload_size",
                ),
                payload_sha256=_sha256_value(
                    raw_replacement.get("payload_sha256"),
                    field=f"{field}.payload_sha256",
                ),
                payload_crc32=_crc32_value(
                    raw_replacement.get("payload_crc32"),
                    field=f"{field}.payload_crc32",
                ),
            )
        )

    return _Profile(
        map_name=normalized_map,
        status=status,
        source_relative_path=source_relative_path,
        source_size=source_size,
        source_sha256=source_sha256,
        expected_output_size=expected_output_size,
        expected_output_sha256=expected_output_sha256,
        expected_output_entry_count=expected_output_entry_count,
        output_logical_path=output_logical_path,
        replacements=tuple(sorted(replacements, key=lambda item: item.entry_path)),
    )


def _resolve_root(value: Path, *, label: str) -> Path:
    try:
        root = Path(value).resolve(strict=True)
    except OSError as exc:
        raise ChromaMainMapError(f"{label} does not exist: {value}") from exc
    if not root.is_dir():
        raise ChromaMainMapError(f"{label} is not a directory: {root}")
    return root


def _resolve_file(root: Path, relative_path: str, *, field: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative_path).parts)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ChromaMainMapError(f"file listed by {field} is missing") from exc
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ChromaMainMapError(f"file listed by {field} escapes its asset root")
    return resolved


def _resolve_output_path(value: Path, *, csgo_root: Path, source: Path) -> Path:
    output = Path(value)
    if output.name in {"", ".", ".."} or output.suffix.lower() != ".vpk":
        raise ChromaMainMapError("main-map staging output must be a .vpk file")
    try:
        parent = output.parent.resolve(strict=True)
    except OSError as exc:
        raise ChromaMainMapError("main-map staging output directory does not exist") from exc
    if not parent.is_dir():
        raise ChromaMainMapError("main-map staging output parent is not a directory")
    candidate = parent / output.name
    if parent.is_relative_to(csgo_root):
        raise ChromaMainMapError("refusing to write a reconstructed VPK in the game tree")
    if candidate.resolve(strict=False) == source:
        raise ChromaMainMapError("refusing to overwrite the official main-map VPK")
    if candidate.is_symlink():
        raise ChromaMainMapError("main-map staging output must not be a symlink")
    if candidate.exists() and not candidate.is_file():
        raise ChromaMainMapError("main-map staging output exists but is not a file")
    return candidate


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_COPY_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_file_with_crc(path: Path) -> tuple[int, str, int]:
    crc32 = 0
    digest = hashlib.sha256()
    length = 0
    with path.open("rb") as stream:
        while chunk := stream.read(_COPY_CHUNK_SIZE):
            crc32 = zlib.crc32(chunk, crc32)
            digest.update(chunk)
            length += len(chunk)
    return length, digest.hexdigest(), crc32 & 0xFFFFFFFF


def _hash_range_with_crc(
    stream: BinaryIO, *, offset: int, length: int
) -> tuple[str, int]:
    stream.seek(offset)
    remaining = length
    digest = hashlib.sha256()
    crc32 = 0
    while remaining:
        chunk = stream.read(min(_COPY_CHUNK_SIZE, remaining))
        if not chunk:
            raise ChromaMainMapError("VPK range is truncated")
        digest.update(chunk)
        crc32 = zlib.crc32(chunk, crc32)
        remaining -= len(chunk)
    return digest.hexdigest(), crc32 & 0xFFFFFFFF


def _copy_exact(
    source: BinaryIO,
    output: BinaryIO,
    *,
    length: int,
    whole_md5: Any,
    sha256: Any | None = None,
) -> None:
    remaining = length
    while remaining:
        chunk = source.read(min(_COPY_CHUNK_SIZE, remaining))
        if not chunk:
            raise ChromaMainMapError("input changed or was truncated during streaming copy")
        output.write(chunk)
        whole_md5.update(chunk)
        if sha256 is not None:
            sha256.update(chunk)
        remaining -= len(chunk)


def _hash_range(path: Path, *, offset: int, length: int, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        stream.seek(offset)
        remaining = length
        while remaining:
            chunk = stream.read(min(_COPY_CHUNK_SIZE, remaining))
            if not chunk:
                raise ChromaMainMapError(f"output range is truncated: {path}")
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def _verify_other_md5_file(
    path: Path, header: _vpk._VpkHeaderValue, tree: bytes
) -> None:
    if (
        header.archive_md5_size != 0
        or header.other_md5_size != 48
        or header.signature_size != 0
    ):
        raise ChromaMainMapError("output VPK integrity sections are invalid")
    other_start = header.data_start + header.data_size
    with path.open("rb") as stream:
        stream.seek(other_start)
        other = stream.read(48)
        trailing = stream.read(1)
    if len(other) != 48 or trailing:
        raise ChromaMainMapError("output VPK OtherMD5 or physical size is invalid")
    if other[:16] != hashlib.md5(tree).digest():
        raise ChromaMainMapError("output VPK tree MD5 is invalid")
    if other[16:32] != hashlib.md5(b"").digest():
        raise ChromaMainMapError("output VPK archive MD5 is invalid")

    whole = hashlib.md5()
    remaining = other_start + 32
    with path.open("rb") as stream:
        while remaining:
            chunk = stream.read(min(_COPY_CHUNK_SIZE, remaining))
            if not chunk:
                raise ChromaMainMapError("output VPK is truncated during MD5 verification")
            whole.update(chunk)
            remaining -= len(chunk)
    if other[32:48] != whole.digest():
        raise ChromaMainMapError("output VPK whole-file MD5 is invalid")


def _verify_output_file(
    path: Path,
    *,
    source_header: _vpk._VpkHeaderValue,
    source_tree: bytes,
    source_entries: Mapping[str, _vpk._VpkEntryValue],
    source_data_sha256: str,
    payloads: Mapping[str, _PayloadValue],
    expected_offsets: Mapping[str, int],
) -> tuple[_vpk._VpkHeaderValue, Mapping[str, _vpk._VpkEntryValue], str]:
    try:
        header, tree_mutable, entries = _vpk._open_package(path)
    except _vpk.ChromaSkyboxChildError as exc:
        raise ChromaMainMapError(f"unable to parse reconstructed main-map VPK: {exc}") from exc
    tree = bytes(tree_mutable)
    if header.total_size != path.stat().st_size:
        raise ChromaMainMapError("output VPK has undeclared trailing bytes")
    if set(entries) != set(source_entries):
        raise ChromaMainMapError("output VPK entry set changed")
    if header.tree_size != source_header.tree_size:
        raise ChromaMainMapError("output VPK tree size changed")
    _verify_other_md5_file(path, header, tree)

    output_prefix_sha256 = _hash_range(
        path,
        offset=header.data_start,
        length=source_header.data_size,
        algorithm="sha256",
    )
    if output_prefix_sha256 != source_data_sha256:
        raise ChromaMainMapError("official VPK data prefix changed in output")

    replacement_paths = set(payloads)
    for entry_path, original in source_entries.items():
        if (
            entry_path not in replacement_paths
            and _vpk._entry_identity(entries[entry_path]) != _vpk._entry_identity(original)
        ):
            raise ChromaMainMapError(
                f"non-replacement VPK metadata changed: {entry_path}"
            )

    allowed_tree_offsets: set[int] = set()
    for entry_path in replacement_paths:
        source_entry = source_entries[entry_path]
        allowed_tree_offsets.update(
            range(source_entry.crc_field_offset, source_entry.crc_field_offset + 4)
        )
        allowed_tree_offsets.update(
            range(source_entry.archive_field_offset, source_entry.archive_field_offset + 2)
        )
        allowed_tree_offsets.update(
            range(
                source_entry.data_offset_field_offset,
                source_entry.data_offset_field_offset + 4,
            )
        )
        allowed_tree_offsets.update(
            range(source_entry.length_field_offset, source_entry.length_field_offset + 4)
        )
    for index, (before, after) in enumerate(zip(source_tree, tree, strict=True)):
        if before != after and index not in allowed_tree_offsets:
            raise ChromaMainMapError(
                "output VPK tree changed outside replacement metadata"
            )

    with path.open("rb") as stream:
        for entry_path, payload in payloads.items():
            entry = entries[entry_path]
            if (
                entry.preload_size != 0
                or entry.archive_index != _vpk._INLINE_ARCHIVE_INDEX
                or entry.offset != expected_offsets[entry_path]
                or entry.length != payload.spec.payload_size
                or entry.crc32 != payload.crc32
            ):
                raise ChromaMainMapError(
                    f"replacement VPK metadata mismatch: {entry_path}"
                )
            payload_sha256, payload_crc32 = _hash_range_with_crc(
                stream,
                offset=header.data_start + entry.offset,
                length=entry.length,
            )
            if (
                payload_sha256 != payload.spec.payload_sha256
                or payload_crc32 != payload.crc32
            ):
                raise ChromaMainMapError(
                    f"replacement VPK payload mismatch: {entry_path}"
                )

    return header, entries, _sha256_file(path)


def _build_chroma_main_map_vpk(
    *,
    csgo_dir: Path,
    payload_root: Path,
    output_path: Path,
    manifest: Mapping[str, Any],
    map_name: object,
    require_in_game_confirmed: bool,
) -> ChromaMainMapVpkBuild:
    profile = _parse_profile(
        manifest,
        map_name,
        require_in_game_confirmed=require_in_game_confirmed,
    )
    csgo_root = _resolve_root(csgo_dir, label="CS2 csgo directory")
    payloads_root = _resolve_root(
        payload_root, label="chroma main-map payload directory"
    )
    source = _resolve_file(
        csgo_root,
        profile.source_relative_path,
        field=f"maps.{profile.map_name}.main_source.source_package_relative_path",
    )
    output = _resolve_output_path(output_path, csgo_root=csgo_root, source=source)

    source_stat = source.stat()
    if source_stat.st_size != profile.source_size:
        raise ChromaMainMapError(
            f"official main-map VPK size changed for {profile.map_name}: "
            f"{source_stat.st_size} != {profile.source_size}"
        )
    source_sha256 = _sha256_file(source)
    if source_sha256 != profile.source_sha256:
        raise ChromaMainMapError(
            f"official main-map VPK SHA-256 changed for {profile.map_name}: "
            f"{source_sha256} != {profile.source_sha256}"
        )

    try:
        source_header, source_tree_mutable, source_entries = _vpk._open_package(source)
    except _vpk.ChromaSkyboxChildError as exc:
        raise ChromaMainMapError(f"unable to parse official main-map VPK: {exc}") from exc
    source_tree = bytes(source_tree_mutable)
    patched_tree = bytearray(source_tree)
    if len(source_entries) != profile.expected_output_entry_count:
        raise ChromaMainMapError(
            f"official main-map VPK entry count changed for {profile.map_name}: "
            f"{len(source_entries)} != {profile.expected_output_entry_count}"
        )

    payloads: dict[str, _PayloadValue] = {}
    replacement_metadata: list[dict[str, Any]] = []
    expected_offsets: dict[str, int] = {}
    appended_offset = source_header.data_size
    with source.open("rb") as source_stream:
        for replacement in profile.replacements:
            entry = source_entries.get(replacement.entry_path)
            if entry is None:
                raise ChromaMainMapError(
                    f"official main-map VPK is missing replacement entry: "
                    f"{replacement.entry_path}"
                )
            if entry.archive_index != _vpk._INLINE_ARCHIVE_INDEX or entry.preload_size != 0:
                raise ChromaMainMapError(
                    "replacement requires an inline entry with zero preload bytes: "
                    f"{replacement.entry_path}"
                )
            if entry.length != replacement.original_size:
                raise ChromaMainMapError(
                    f"official main-map entry size changed: {replacement.entry_path}"
                )
            if entry.crc32 != replacement.original_crc32:
                raise ChromaMainMapError(
                    f"official main-map entry CRC32 changed: {replacement.entry_path}"
                )
            original_sha256, original_crc32 = _hash_range_with_crc(
                source_stream,
                offset=source_header.data_start + entry.offset,
                length=entry.length,
            )
            if original_crc32 != entry.crc32:
                raise ChromaMainMapError(
                    f"official main-map entry CRC32 is invalid: {replacement.entry_path}"
                )
            if original_sha256 != replacement.original_sha256:
                raise ChromaMainMapError(
                    f"official main-map entry SHA-256 changed: {replacement.entry_path}"
                )

            payload_path = _resolve_file(
                payloads_root,
                replacement.payload_relative_path,
                field=f"payload for {replacement.entry_path}",
            )
            payload_size, payload_sha256, payload_crc32 = _hash_file_with_crc(payload_path)
            if payload_size != replacement.payload_size:
                raise ChromaMainMapError(
                    f"chroma main-map payload size mismatch: "
                    f"{replacement.payload_relative_path}"
                )
            if payload_sha256 != replacement.payload_sha256:
                raise ChromaMainMapError(
                    f"chroma main-map payload SHA-256 mismatch: "
                    f"{replacement.payload_relative_path}"
                )
            if payload_crc32 != replacement.payload_crc32:
                raise ChromaMainMapError(
                    f"chroma main-map payload CRC32 mismatch: "
                    f"{replacement.payload_relative_path}"
                )
            if payload_size > 0xFFFFFFFF or appended_offset + payload_size > 0xFFFFFFFF:
                raise ChromaMainMapError(
                    "reconstructed main-map VPK data section exceeds VPK-v2 limits"
                )

            payloads[replacement.entry_path] = _PayloadValue(
                spec=replacement, path=payload_path, crc32=payload_crc32
            )
            expected_offsets[replacement.entry_path] = appended_offset
            struct.pack_into(
                "<I", patched_tree, entry.crc_field_offset, payload_crc32
            )
            struct.pack_into(
                "<H",
                patched_tree,
                entry.archive_field_offset,
                _vpk._INLINE_ARCHIVE_INDEX,
            )
            struct.pack_into(
                "<I", patched_tree, entry.data_offset_field_offset, appended_offset
            )
            struct.pack_into(
                "<I", patched_tree, entry.length_field_offset, payload_size
            )
            replacement_metadata.append(
                {
                    "kind": replacement.kind,
                    "status": replacement.status,
                    "entry_path": replacement.entry_path,
                    "original_size": replacement.original_size,
                    "original_sha256": original_sha256,
                    "original_crc32": f"{entry.crc32:08x}",
                    "payload_relative_path": replacement.payload_relative_path,
                    "payload_size": payload_size,
                    "payload_sha256": payload_sha256,
                    "output_offset": appended_offset,
                    "output_crc32": f"{payload_crc32:08x}",
                }
            )
            appended_offset += payload_size

    computed_output_size = (
        _vpk._VPK_HEADER.size + len(patched_tree) + appended_offset + 48
    )
    if computed_output_size != profile.expected_output_size:
        raise ChromaMainMapError(
            f"manifest expected output size is inconsistent for {profile.map_name}: "
            f"{computed_output_size} != {profile.expected_output_size}"
        )

    header_bytes = _vpk._VPK_HEADER.pack(
        _vpk._VPK_MAGIC,
        _vpk._VPK_VERSION,
        len(patched_tree),
        appended_offset,
        0,
        48,
        0,
    )
    tree_md5 = hashlib.md5(patched_tree).digest()
    empty_archive_md5 = hashlib.md5(b"").digest()
    whole_md5 = hashlib.md5()
    whole_md5.update(header_bytes)
    whole_md5.update(patched_tree)
    source_data_sha256 = hashlib.sha256()

    temp = output.with_name(f".{output.name}.tmp-{uuid.uuid4().hex}")
    try:
        with temp.open("xb") as output_stream:
            output_stream.write(header_bytes)
            output_stream.write(patched_tree)
            with source.open("rb") as source_stream:
                source_stream.seek(source_header.data_start)
                _copy_exact(
                    source_stream,
                    output_stream,
                    length=source_header.data_size,
                    whole_md5=whole_md5,
                    sha256=source_data_sha256,
                )
            for entry_path in sorted(payloads):
                payload = payloads[entry_path]
                copied_sha256 = hashlib.sha256()
                with payload.path.open("rb") as payload_stream:
                    _copy_exact(
                        payload_stream,
                        output_stream,
                        length=payload.spec.payload_size,
                        whole_md5=whole_md5,
                        sha256=copied_sha256,
                    )
                    if payload_stream.read(1):
                        raise ChromaMainMapError(
                            "payload grew during construction: "
                            f"{payload.spec.payload_relative_path}"
                        )
                if copied_sha256.hexdigest() != payload.spec.payload_sha256:
                    raise ChromaMainMapError(
                        f"payload changed during construction: "
                        f"{payload.spec.payload_relative_path}"
                    )
            output_stream.write(tree_md5)
            whole_md5.update(tree_md5)
            output_stream.write(empty_archive_md5)
            whole_md5.update(empty_archive_md5)
            output_stream.write(whole_md5.digest())
            output_stream.flush()
            os.fsync(output_stream.fileno())

        if source.stat().st_size != profile.source_size or _sha256_file(source) != source_sha256:
            raise ChromaMainMapError(
                f"official main-map VPK changed during construction for {profile.map_name}"
            )

        output_header, output_entries, output_sha256 = _verify_output_file(
            temp,
            source_header=source_header,
            source_tree=source_tree,
            source_entries=source_entries,
            source_data_sha256=source_data_sha256.hexdigest(),
            payloads=payloads,
            expected_offsets=expected_offsets,
        )
        output_size = temp.stat().st_size
        if output_size != profile.expected_output_size:
            raise ChromaMainMapError(
                f"reconstructed main-map VPK size differs from manifest: "
                f"{output_size} != {profile.expected_output_size}"
            )
        if output_sha256 != profile.expected_output_sha256:
            raise ChromaMainMapError(
                f"reconstructed main-map VPK SHA-256 differs from manifest: "
                f"{output_sha256} != {profile.expected_output_sha256}"
            )
        if len(output_entries) != profile.expected_output_entry_count:
            raise ChromaMainMapError(
                f"reconstructed main-map VPK entry count differs from manifest: "
                f"{len(output_entries)} != {profile.expected_output_entry_count}"
            )
        replaced_existing = output.exists()
        os.replace(temp, output)
    finally:
        if temp.exists():
            temp.unlink()

    metadata: dict[str, Any] = {
        "schema_version": CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION,
        "map_name": profile.map_name,
        "status": profile.status,
        "logical_path": profile.output_logical_path,
        "source": {
            "relative_path": profile.source_relative_path,
            "absolute_path": str(source),
            "size": profile.source_size,
            "sha256": source_sha256,
            "declared_sections_size": source_header.total_size,
            "undeclared_trailing_size": profile.source_size - source_header.total_size,
            "data_size": source_header.data_size,
            "data_sha256": source_data_sha256.hexdigest(),
            "entry_count": len(source_entries),
        },
        "output": {
            "absolute_path": str(output),
            "size": output_size,
            "sha256": output_sha256,
            "declared_sections_size": output_header.total_size,
            "undeclared_trailing_size": output_size - output_header.total_size,
            "data_size": output_header.data_size,
            "entry_count": len(output_entries),
            "manifest_expected_size": profile.expected_output_size,
            "manifest_expected_sha256": profile.expected_output_sha256,
            "manifest_expected_entry_count": profile.expected_output_entry_count,
            "archive_md5_size": output_header.archive_md5_size,
            "other_md5_size": output_header.other_md5_size,
            "signature_size": output_header.signature_size,
            "atomic_replace": True,
            "replaced_existing": replaced_existing,
        },
        "replacements": replacement_metadata,
    }
    return ChromaMainMapVpkBuild(
        logical_path=profile.output_logical_path,
        output_path=output,
        metadata=metadata,
    )


def build_chroma_main_map_vpk(
    *,
    csgo_dir: Path,
    payload_root: Path,
    output_path: Path,
    manifest: Mapping[str, Any],
    map_name: object,
    require_in_game_confirmed: bool = True,
) -> ChromaMainMapVpkBuild:
    """Stream-build one verified main-map VPK into a non-game staging path.

    Production callers must keep ``require_in_game_confirmed=True`` so only a
    map profile and replacement entries whose status is exactly ``validated``
    can build.  Research/catalog tooling may explicitly opt into candidate
    profiles.  The destination is changed only after the temporary output has
    passed full structural, hash, metadata, payload, and OtherMD5 verification.
    """

    if not isinstance(manifest, Mapping):
        raise ChromaMainMapError("chroma main-map manifest must be an object")
    try:
        return _build_chroma_main_map_vpk(
            csgo_dir=Path(csgo_dir),
            payload_root=Path(payload_root),
            output_path=Path(output_path),
            manifest=manifest,
            map_name=map_name,
            require_in_game_confirmed=bool(require_in_game_confirmed),
        )
    except ChromaMainMapError:
        raise
    except _vpk.ChromaSkyboxChildError as exc:
        raise ChromaMainMapError(f"unable to build chroma main-map VPK: {exc}") from exc
    except (OSError, ValueError, TypeError, struct.error) as exc:
        raise ChromaMainMapError(f"unable to build chroma main-map VPK: {exc}") from exc
