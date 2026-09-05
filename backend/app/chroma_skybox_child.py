"""Fail-closed construction of nested chroma child-skybox VPKs.

The builder reads a trusted, manifest-selected official child-map package and
returns a fully verified unsigned VPK-v2 payload.  It never writes to the game
directory (or anywhere else): callers may merge the returned bytes into the
single managed ``pov.vpk`` only after this function succeeds.

Only explicitly listed inline entries are redirected.  The official data
section is streamed byte-for-byte into the output, replacement payloads are
appended, and a fresh 48-byte OtherMD5 section is emitted.
"""

from __future__ import annotations

import hashlib
import io
import re
import struct
import zlib
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO


CHROMA_CHILD_MANIFEST_SCHEMA_VERSION = 1
CHROMA_CHILD_VALIDATED_STATUS = "validated"
_ALLOWED_PROFILE_STATUSES = frozenset(
    {
        "candidate",
        "candidate_requires_in_game_gate",
        "in_game_confirmed",
        CHROMA_CHILD_VALIDATED_STATUS,
    }
)

_COPY_CHUNK_SIZE = 8 * 1024 * 1024
_VPK_MAGIC = 0x55AA1234
_VPK_VERSION = 2
_INLINE_ARCHIVE_INDEX = 0x7FFF
_VPK_HEADER = struct.Struct("<7I")
_VPK_ENTRY = struct.Struct("<IHHIIH")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAP_RE = re.compile(r"^de_[a-z0-9_]+$")
_CATALOG_FORMAT = "zip"
_MAX_CATALOG_ENTRIES = 256
_MAX_CATALOG_ENTRY_SIZE = 16 * 1024 * 1024
_MAX_CATALOG_TOTAL_SIZE = 128 * 1024 * 1024


class ChromaSkyboxChildError(RuntimeError):
    """The child-skybox manifest or official package failed strict validation."""


@dataclass(frozen=True)
class ChromaChildVpkBuild:
    """Verified nested VPK bytes and audit metadata for one map."""

    logical_path: str
    vpk_bytes: bytes
    metadata: dict[str, Any]


@dataclass(frozen=True)
class _ReplacementSpec:
    entry_path: str
    original_size: int
    original_sha256: str
    payload_relative_path: str
    payload_size: int
    payload_sha256: str


@dataclass(frozen=True)
class _Profile:
    map_name: str
    status: str
    source_relative_path: str
    source_size: int
    source_sha256: str
    output_logical_path: str
    validated_output_size: int | None
    validated_output_sha256: str | None
    replacements: tuple[_ReplacementSpec, ...]


@dataclass(frozen=True)
class _PayloadCatalogSpec:
    relative_path: str
    entry_count: int


@dataclass(frozen=True)
class _VpkHeaderValue:
    tree_size: int
    data_size: int
    archive_md5_size: int
    other_md5_size: int
    signature_size: int

    @property
    def data_start(self) -> int:
        return _VPK_HEADER.size + self.tree_size

    @property
    def total_size(self) -> int:
        return (
            self.data_start
            + self.data_size
            + self.archive_md5_size
            + self.other_md5_size
            + self.signature_size
        )


@dataclass(frozen=True)
class _VpkEntryValue:
    path: str
    crc32: int
    preload_size: int
    archive_index: int
    offset: int
    length: int
    preload: bytes
    crc_field_offset: int
    archive_field_offset: int
    data_offset_field_offset: int
    length_field_offset: int


def _normalize_map_name(value: object) -> str:
    raw = str(value or "").strip().lower().replace("\\", "/")
    if not raw or "/" in raw:
        raise ChromaSkyboxChildError("chroma child map name is invalid")
    if raw.endswith(".vpk"):
        raw = raw[:-4]
    if not raw.startswith("de_"):
        raw = f"de_{raw}"
    if not _MAP_RE.fullmatch(raw):
        raise ChromaSkyboxChildError("chroma child map name is invalid")
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
        raise ChromaSkyboxChildError(f"invalid relative path in {field}")
    parts = normalized.split("/")
    if any(not part or part in {".", ".."} or part != part.strip() for part in parts):
        raise ChromaSkyboxChildError(f"invalid relative path in {field}")
    path = PurePosixPath(*parts)
    if path.is_absolute() or ".." in path.parts:
        raise ChromaSkyboxChildError(f"invalid relative path in {field}")
    return path.as_posix()


def _sha256_value(value: object, *, field: str) -> str:
    digest = str(value or "").strip().lower()
    if not _SHA256_RE.fullmatch(digest):
        raise ChromaSkyboxChildError(f"invalid SHA-256 in {field}")
    return digest


def _size_value(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ChromaSkyboxChildError(f"invalid byte size in {field}")
    return value


def _parse_payload_catalog_spec(
    manifest: Mapping[str, Any],
) -> _PayloadCatalogSpec:
    raw_catalog = manifest.get("payload_catalog")
    if not isinstance(raw_catalog, Mapping):
        raise ChromaSkyboxChildError("chroma child payload_catalog is missing")
    if str(raw_catalog.get("format") or "").strip().lower() != _CATALOG_FORMAT:
        raise ChromaSkyboxChildError("chroma child payload catalog must use ZIP")
    relative_path = _safe_relative_path(
        raw_catalog.get("relative_path"),
        field="payload_catalog.relative_path",
    )
    if PurePosixPath(relative_path).suffix.lower() != ".zip":
        raise ChromaSkyboxChildError("chroma child payload catalog must be a .zip file")
    entry_count = _size_value(
        raw_catalog.get("entry_count"),
        field="payload_catalog.entry_count",
    )
    if entry_count <= 0 or entry_count > _MAX_CATALOG_ENTRIES:
        raise ChromaSkyboxChildError("chroma child payload catalog entry count is invalid")
    return _PayloadCatalogSpec(
        relative_path=relative_path,
        entry_count=entry_count,
    )


def _declared_catalog_entries(
    manifest: Mapping[str, Any],
) -> dict[str, tuple[int, str]]:
    raw_maps = manifest.get("maps")
    if not isinstance(raw_maps, Mapping) or not raw_maps:
        raise ChromaSkyboxChildError("chroma child manifest maps must be an object")
    declared: dict[str, tuple[int, str]] = {}
    for raw_map_name, raw_profile in raw_maps.items():
        map_name = _normalize_map_name(raw_map_name)
        if map_name != raw_map_name or not isinstance(raw_profile, Mapping):
            raise ChromaSkyboxChildError(
                f"invalid chroma child catalog profile: {raw_map_name!r}"
            )
        raw_replacements = raw_profile.get("replacements")
        if not isinstance(raw_replacements, list) or not raw_replacements:
            raise ChromaSkyboxChildError(
                f"maps.{map_name}.replacements must be a non-empty array"
            )
        for index, raw_replacement in enumerate(raw_replacements):
            field = f"maps.{map_name}.replacements[{index}]"
            if not isinstance(raw_replacement, Mapping):
                raise ChromaSkyboxChildError(f"{field} must be an object")
            relative_path = _safe_relative_path(
                raw_replacement.get("payload_relative_path"),
                field=f"{field}.payload_relative_path",
            )
            identity = (
                _size_value(
                    raw_replacement.get("payload_size"),
                    field=f"{field}.payload_size",
                ),
                _sha256_value(
                    raw_replacement.get("payload_sha256"),
                    field=f"{field}.payload_sha256",
                ),
            )
            if relative_path in declared:
                raise ChromaSkyboxChildError(
                    f"duplicate chroma child catalog path: {relative_path}"
                )
            declared[relative_path] = identity
    return declared


def _parse_profile(
    manifest: Mapping[str, Any],
    map_name: object,
    *,
    require_in_game_confirmed: bool,
) -> _Profile:
    if manifest.get("schema_version") != CHROMA_CHILD_MANIFEST_SCHEMA_VERSION:
        raise ChromaSkyboxChildError("unsupported chroma child manifest schema")
    maps = manifest.get("maps")
    if not isinstance(maps, Mapping):
        raise ChromaSkyboxChildError("chroma child manifest maps must be an object")

    normalized_map = _normalize_map_name(map_name)
    raw_profile = maps.get(normalized_map)
    if not isinstance(raw_profile, Mapping):
        raise ChromaSkyboxChildError(
            f"chroma child manifest does not support map {normalized_map}"
        )

    status = str(raw_profile.get("status") or "").strip().lower()
    if status not in _ALLOWED_PROFILE_STATUSES:
        raise ChromaSkyboxChildError(
            f"invalid chroma child validation status for {normalized_map}"
        )
    if require_in_game_confirmed and status != CHROMA_CHILD_VALIDATED_STATUS:
        raise ChromaSkyboxChildError(
            f"chroma child profile is not validated for {normalized_map}"
        )

    source_relative_path = _safe_relative_path(
        raw_profile.get("source_relative_path"),
        field=f"maps.{normalized_map}.source_relative_path",
    )
    source_parts = PurePosixPath(source_relative_path).parts
    if (
        len(source_parts) < 3
        or source_parts[:2] != ("maps", "prefabs")
        or not source_relative_path.endswith(".vpk")
    ):
        raise ChromaSkyboxChildError(
            f"chroma child source path is outside maps/prefabs for {normalized_map}"
        )

    output_logical_path = _safe_relative_path(
        raw_profile.get("output_logical_path") or source_relative_path,
        field=f"maps.{normalized_map}.output_logical_path",
    )
    if output_logical_path != source_relative_path:
        raise ChromaSkyboxChildError(
            "chroma child output must override the exact official logical path"
        )

    raw_replacements = raw_profile.get("replacements")
    if not isinstance(raw_replacements, list) or not raw_replacements:
        raise ChromaSkyboxChildError(
            f"chroma child replacements are empty for {normalized_map}"
        )

    replacements: list[_ReplacementSpec] = []
    seen_entries: set[str] = set()
    required_entry_prefix = f"{PurePosixPath(source_relative_path).parent.as_posix()}/"
    for index, raw_replacement in enumerate(raw_replacements):
        field = f"maps.{normalized_map}.replacements[{index}]"
        if not isinstance(raw_replacement, Mapping):
            raise ChromaSkyboxChildError(f"invalid replacement object in {field}")
        entry_path = _safe_relative_path(
            raw_replacement.get("entry_path"),
            field=f"{field}.entry_path",
        )
        if not entry_path.startswith(required_entry_prefix):
            raise ChromaSkyboxChildError(
                f"replacement entry is outside the child package namespace: {entry_path}"
            )
        if entry_path in seen_entries:
            raise ChromaSkyboxChildError(f"duplicate replacement entry: {entry_path}")
        seen_entries.add(entry_path)
        replacements.append(
            _ReplacementSpec(
                entry_path=entry_path,
                original_size=_size_value(
                    raw_replacement.get("original_size"),
                    field=f"{field}.original_size",
                ),
                original_sha256=_sha256_value(
                    raw_replacement.get("original_sha256"),
                    field=f"{field}.original_sha256",
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
            )
        )

    raw_validated_output_size = raw_profile.get("validated_output_size")
    raw_validated_output_sha256 = raw_profile.get("validated_output_sha256")
    if (raw_validated_output_size is None) != (
        raw_validated_output_sha256 is None
    ):
        raise ChromaSkyboxChildError(
            f"validated output size/hash must be declared together for {normalized_map}"
        )
    validated_output_size = (
        _size_value(
            raw_validated_output_size,
            field=f"maps.{normalized_map}.validated_output_size",
        )
        if raw_validated_output_size is not None
        else None
    )
    validated_output_sha256 = (
        _sha256_value(
            raw_validated_output_sha256,
            field=f"maps.{normalized_map}.validated_output_sha256",
        )
        if raw_validated_output_sha256 is not None
        else None
    )

    return _Profile(
        map_name=normalized_map,
        status=status,
        source_relative_path=source_relative_path,
        source_size=_size_value(
            raw_profile.get("source_size"),
            field=f"maps.{normalized_map}.source_size",
        ),
        source_sha256=_sha256_value(
            raw_profile.get("source_sha256"),
            field=f"maps.{normalized_map}.source_sha256",
        ),
        output_logical_path=output_logical_path,
        validated_output_size=validated_output_size,
        validated_output_sha256=validated_output_sha256,
        replacements=tuple(sorted(replacements, key=lambda item: item.entry_path)),
    )


def _resolve_root(value: Path, *, label: str) -> Path:
    try:
        root = Path(value).resolve(strict=True)
    except OSError as exc:
        raise ChromaSkyboxChildError(f"{label} does not exist: {value}") from exc
    if not root.is_dir():
        raise ChromaSkyboxChildError(f"{label} is not a directory: {root}")
    return root


def _resolve_file(root: Path, relative_path: str, *, field: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative_path).parts)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ChromaSkyboxChildError(f"file listed by {field} is missing") from exc
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ChromaSkyboxChildError(f"file listed by {field} escapes its asset root")
    return resolved


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_COPY_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _load_payload_catalog(
    payload_root: Path,
    manifest: Mapping[str, Any],
) -> tuple[_PayloadCatalogSpec, dict[str, bytes]]:
    spec = _parse_payload_catalog_spec(manifest)
    declared = _declared_catalog_entries(manifest)
    if len(declared) != spec.entry_count:
        raise ChromaSkyboxChildError(
            "chroma child payload catalog entry count does not match the manifest"
        )
    catalog_path = _resolve_file(
        payload_root,
        spec.relative_path,
        field="payload_catalog.relative_path",
    )
    try:
        with zipfile.ZipFile(catalog_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) != spec.entry_count:
                raise ChromaSkyboxChildError(
                    "chroma child payload ZIP entry count does not match the manifest"
                )
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ChromaSkyboxChildError(
                    "chroma child payload ZIP contains duplicate paths"
                )
            normalized_names: set[str] = set()
            total_size = 0
            for info in infos:
                normalized = _safe_relative_path(
                    info.filename,
                    field="payload_catalog ZIP entry",
                )
                if normalized != info.filename or info.is_dir():
                    raise ChromaSkyboxChildError(
                        f"invalid chroma child payload ZIP entry: {info.filename!r}"
                    )
                if info.flag_bits & 0x1:
                    raise ChromaSkyboxChildError(
                        "encrypted chroma child payload ZIP entries are not supported"
                    )
                if info.compress_type not in {
                    zipfile.ZIP_STORED,
                    zipfile.ZIP_DEFLATED,
                }:
                    raise ChromaSkyboxChildError(
                        "unsupported chroma child payload ZIP compression method"
                    )
                if info.file_size > _MAX_CATALOG_ENTRY_SIZE:
                    raise ChromaSkyboxChildError(
                        f"chroma child payload ZIP entry is too large: {info.filename}"
                    )
                total_size += info.file_size
                if total_size > _MAX_CATALOG_TOTAL_SIZE:
                    raise ChromaSkyboxChildError(
                        "chroma child payload ZIP expands beyond the size limit"
                    )
                normalized_names.add(normalized)
            if normalized_names != set(declared):
                missing = sorted(set(declared) - normalized_names)
                extra = sorted(normalized_names - set(declared))
                raise ChromaSkyboxChildError(
                    "chroma child payload ZIP paths do not match the manifest: "
                    f"missing={missing}, extra={extra}"
                )

            payloads: dict[str, bytes] = {}
            for relative_path, (expected_size, expected_sha256) in declared.items():
                info = archive.getinfo(relative_path)
                if info.file_size != expected_size:
                    raise ChromaSkyboxChildError(
                        f"chroma child payload size mismatch: {relative_path}"
                    )
                payload = archive.read(info)
                if len(payload) != expected_size:
                    raise ChromaSkyboxChildError(
                        f"chroma child payload is truncated: {relative_path}"
                    )
                if hashlib.sha256(payload).hexdigest() != expected_sha256:
                    raise ChromaSkyboxChildError(
                        f"chroma child payload SHA-256 mismatch: {relative_path}"
                    )
                payloads[relative_path] = payload
    except ChromaSkyboxChildError:
        raise
    except (
        OSError,
        RuntimeError,
        NotImplementedError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
    ) as exc:
        raise ChromaSkyboxChildError(
            f"unable to read chroma child payload ZIP: {exc}"
        ) from exc
    return spec, payloads


def _read_header(stream: BinaryIO, *, file_size: int) -> _VpkHeaderValue:
    raw = stream.read(_VPK_HEADER.size)
    if len(raw) != _VPK_HEADER.size:
        raise ChromaSkyboxChildError("truncated VPK header")
    magic, version, tree, data, archive_md5, other_md5, signature = _VPK_HEADER.unpack(raw)
    if magic != _VPK_MAGIC:
        raise ChromaSkyboxChildError(f"unexpected VPK magic 0x{magic:08x}")
    if version != _VPK_VERSION:
        raise ChromaSkyboxChildError(f"only VPK v2 is supported, got v{version}")
    header = _VpkHeaderValue(tree, data, archive_md5, other_md5, signature)
    if header.total_size > file_size:
        raise ChromaSkyboxChildError(
            f"VPK sections exceed the file size: {header.total_size} > {file_size}"
        )
    return header


def _read_cstring(buffer: bytes | bytearray, cursor: int) -> tuple[str, int]:
    if cursor < 0 or cursor > len(buffer):
        raise ChromaSkyboxChildError("invalid VPK tree cursor")
    end = buffer.find(b"\0", cursor)
    if end < 0:
        raise ChromaSkyboxChildError("unterminated VPK tree string")
    try:
        value = bytes(buffer[cursor:end]).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ChromaSkyboxChildError("invalid UTF-8 in VPK tree") from exc
    return value, end + 1


def _parse_tree(tree: bytes | bytearray) -> dict[str, _VpkEntryValue]:
    entries: dict[str, _VpkEntryValue] = {}
    cursor = 0
    while True:
        extension, cursor = _read_cstring(tree, cursor)
        if not extension:
            break
        while True:
            directory, cursor = _read_cstring(tree, cursor)
            if not directory:
                break
            while True:
                stem, cursor = _read_cstring(tree, cursor)
                if not stem:
                    break
                metadata = cursor
                if metadata + _VPK_ENTRY.size > len(tree):
                    raise ChromaSkyboxChildError("truncated VPK tree entry")
                crc, preload_size, archive, offset, length, terminator = _VPK_ENTRY.unpack_from(
                    tree, metadata
                )
                if terminator != 0xFFFF:
                    raise ChromaSkyboxChildError(
                        f"bad VPK entry terminator for {stem}: 0x{terminator:04x}"
                    )
                cursor += _VPK_ENTRY.size
                preload_end = cursor + preload_size
                if preload_end > len(tree):
                    raise ChromaSkyboxChildError("truncated VPK preload bytes")
                preload = bytes(tree[cursor:preload_end])
                cursor = preload_end
                filename = stem if extension == " " else f"{stem}.{extension}"
                path = filename if directory == " " else f"{directory}/{filename}"
                path = path.replace("\\", "/")
                if path in entries:
                    raise ChromaSkyboxChildError(f"duplicate VPK path: {path}")
                entries[path] = _VpkEntryValue(
                    path=path,
                    crc32=crc,
                    preload_size=preload_size,
                    archive_index=archive,
                    offset=offset,
                    length=length,
                    preload=preload,
                    crc_field_offset=metadata,
                    archive_field_offset=metadata + 6,
                    data_offset_field_offset=metadata + 8,
                    length_field_offset=metadata + 12,
                )
    if cursor != len(tree):
        raise ChromaSkyboxChildError(
            f"unexpected bytes after VPK tree: {len(tree) - cursor}"
        )
    return entries


def _open_package(path: Path) -> tuple[_VpkHeaderValue, bytearray, dict[str, _VpkEntryValue]]:
    file_size = path.stat().st_size
    with path.open("rb") as stream:
        header = _read_header(stream, file_size=file_size)
        tree = bytearray(stream.read(header.tree_size))
    if len(tree) != header.tree_size:
        raise ChromaSkyboxChildError("truncated VPK tree")
    entries = _parse_tree(tree)
    for entry in entries.values():
        if (
            entry.archive_index == _INLINE_ARCHIVE_INDEX
            and entry.offset + entry.length > header.data_size
        ):
            raise ChromaSkyboxChildError(f"inline VPK entry is out of bounds: {entry.path}")
    return header, tree, entries


def _open_package_bytes(
    package: bytes,
) -> tuple[_VpkHeaderValue, bytearray, dict[str, _VpkEntryValue]]:
    stream = io.BytesIO(package)
    header = _read_header(stream, file_size=len(package))
    if header.total_size != len(package):
        raise ChromaSkyboxChildError(
            f"output VPK has undeclared trailing bytes: {len(package) - header.total_size}"
        )
    tree = bytearray(stream.read(header.tree_size))
    if len(tree) != header.tree_size:
        raise ChromaSkyboxChildError("truncated output VPK tree")
    entries = _parse_tree(tree)
    for entry in entries.values():
        if (
            entry.archive_index == _INLINE_ARCHIVE_INDEX
            and entry.offset + entry.length > header.data_size
        ):
            raise ChromaSkyboxChildError(
                f"output inline VPK entry is out of bounds: {entry.path}"
            )
    return header, tree, entries


def _read_inline_entry(
    stream: BinaryIO,
    header: _VpkHeaderValue,
    entry: _VpkEntryValue,
) -> bytes:
    if entry.archive_index != _INLINE_ARCHIVE_INDEX:
        raise ChromaSkyboxChildError(f"VPK entry is not inline: {entry.path}")
    stream.seek(header.data_start + entry.offset)
    body = stream.read(entry.length)
    if len(body) != entry.length:
        raise ChromaSkyboxChildError(f"truncated VPK entry: {entry.path}")
    payload = entry.preload + body
    actual_crc = zlib.crc32(payload) & 0xFFFFFFFF
    if actual_crc != entry.crc32:
        raise ChromaSkyboxChildError(
            f"CRC mismatch for {entry.path}: {actual_crc:08x} != {entry.crc32:08x}"
        )
    return payload


def _read_inline_entry_bytes(
    package: bytes,
    header: _VpkHeaderValue,
    entry: _VpkEntryValue,
) -> bytes:
    return _read_inline_entry(io.BytesIO(package), header, entry)


def _entry_identity(entry: _VpkEntryValue) -> tuple[Any, ...]:
    return (
        entry.crc32,
        entry.preload_size,
        entry.archive_index,
        entry.offset,
        entry.length,
        entry.preload,
    )


def _verify_other_md5(package: bytes, header: _VpkHeaderValue, tree: bytes) -> None:
    if (
        header.archive_md5_size != 0
        or header.other_md5_size != 48
        or header.signature_size != 0
    ):
        raise ChromaSkyboxChildError("output VPK integrity sections are invalid")
    other_start = header.data_start + header.data_size
    other = package[other_start : other_start + 48]
    if len(other) != 48:
        raise ChromaSkyboxChildError("output VPK OtherMD5 section is truncated")
    expected_tree = hashlib.md5(tree).digest()
    expected_archive = hashlib.md5(b"").digest()
    whole = hashlib.md5()
    whole.update(memoryview(package)[:other_start])
    whole.update(other[:32])
    expected_whole = whole.digest()
    if other[:16] != expected_tree:
        raise ChromaSkyboxChildError("output VPK tree MD5 is invalid")
    if other[16:32] != expected_archive:
        raise ChromaSkyboxChildError("output VPK archive MD5 is invalid")
    if other[32:48] != expected_whole:
        raise ChromaSkyboxChildError("output VPK whole-file MD5 is invalid")


def _verify_output(
    package: bytes,
    *,
    source_header: _VpkHeaderValue,
    source_tree: bytes,
    source_entries: Mapping[str, _VpkEntryValue],
    source_data_sha256: str,
    payloads: Mapping[str, bytes],
    expected_offsets: Mapping[str, int],
) -> tuple[_VpkHeaderValue, Mapping[str, _VpkEntryValue]]:
    header, tree, entries = _open_package_bytes(package)
    if set(entries) != set(source_entries):
        raise ChromaSkyboxChildError("output VPK entry set changed")
    if header.tree_size != source_header.tree_size:
        raise ChromaSkyboxChildError("output VPK tree size changed")
    _verify_other_md5(package, header, bytes(tree))

    original_prefix = memoryview(package)[
        header.data_start : header.data_start + source_header.data_size
    ]
    if hashlib.sha256(original_prefix).hexdigest() != source_data_sha256:
        raise ChromaSkyboxChildError("official VPK data prefix changed in output")

    replacement_paths = set(payloads)
    for path, original in source_entries.items():
        if path not in replacement_paths and _entry_identity(entries[path]) != _entry_identity(original):
            raise ChromaSkyboxChildError(f"non-replacement VPK metadata changed: {path}")

    allowed_tree_offsets: set[int] = set()
    for path in replacement_paths:
        source_entry = source_entries[path]
        allowed_tree_offsets.update(range(source_entry.crc_field_offset, source_entry.crc_field_offset + 4))
        allowed_tree_offsets.update(
            range(source_entry.archive_field_offset, source_entry.archive_field_offset + 2)
        )
        allowed_tree_offsets.update(
            range(source_entry.data_offset_field_offset, source_entry.data_offset_field_offset + 4)
        )
        allowed_tree_offsets.update(
            range(source_entry.length_field_offset, source_entry.length_field_offset + 4)
        )
    for index, (before, after) in enumerate(zip(source_tree, tree, strict=True)):
        if before != after and index not in allowed_tree_offsets:
            raise ChromaSkyboxChildError("output VPK tree changed outside replacement metadata")

    for path, payload in payloads.items():
        entry = entries[path]
        expected_crc = zlib.crc32(payload) & 0xFFFFFFFF
        if (
            entry.preload_size != 0
            or entry.archive_index != _INLINE_ARCHIVE_INDEX
            or entry.offset != expected_offsets[path]
            or entry.length != len(payload)
            or entry.crc32 != expected_crc
        ):
            raise ChromaSkyboxChildError(f"replacement VPK metadata mismatch: {path}")
        if _read_inline_entry_bytes(package, header, entry) != payload:
            raise ChromaSkyboxChildError(f"replacement VPK payload mismatch: {path}")
    return header, entries


def _build_chroma_child_vpk(
    *,
    csgo_dir: Path,
    payload_root: Path,
    manifest: Mapping[str, Any],
    map_name: object,
    require_in_game_confirmed: bool,
) -> ChromaChildVpkBuild:
    profile = _parse_profile(
        manifest,
        map_name,
        require_in_game_confirmed=require_in_game_confirmed,
    )
    csgo_root = _resolve_root(csgo_dir, label="CS2 csgo directory")
    payloads_root = _resolve_root(payload_root, label="chroma child payload directory")
    payload_catalog_spec, catalog_payloads = _load_payload_catalog(
        payloads_root,
        manifest,
    )
    source = _resolve_file(
        csgo_root,
        profile.source_relative_path,
        field=f"maps.{profile.map_name}.source_relative_path",
    )

    source_stat = source.stat()
    if source_stat.st_size != profile.source_size:
        raise ChromaSkyboxChildError(
            f"official child VPK size changed for {profile.map_name}: "
            f"{source_stat.st_size} != {profile.source_size}"
        )
    source_sha256 = _sha256_file(source)
    if source_sha256 != profile.source_sha256:
        raise ChromaSkyboxChildError(
            f"official child VPK SHA-256 changed for {profile.map_name}: "
            f"{source_sha256} != {profile.source_sha256}"
        )

    source_header, source_tree_mutable, source_entries = _open_package(source)
    source_tree = bytes(source_tree_mutable)
    patched_tree = bytearray(source_tree)

    payloads: dict[str, bytes] = {}
    replacement_metadata: list[dict[str, Any]] = []
    appended_offset = source_header.data_size
    expected_offsets: dict[str, int] = {}
    with source.open("rb") as source_stream:
        for replacement in profile.replacements:
            entry = source_entries.get(replacement.entry_path)
            if entry is None:
                raise ChromaSkyboxChildError(
                    f"official child VPK is missing replacement entry: {replacement.entry_path}"
                )
            if entry.archive_index != _INLINE_ARCHIVE_INDEX or entry.preload_size != 0:
                raise ChromaSkyboxChildError(
                    "replacement requires an inline entry with zero preload bytes: "
                    f"{replacement.entry_path}"
                )
            original_payload = _read_inline_entry(source_stream, source_header, entry)
            if len(original_payload) != replacement.original_size:
                raise ChromaSkyboxChildError(
                    f"official child entry size changed: {replacement.entry_path}"
                )
            original_sha256 = hashlib.sha256(original_payload).hexdigest()
            if original_sha256 != replacement.original_sha256:
                raise ChromaSkyboxChildError(
                    f"official child entry SHA-256 changed: {replacement.entry_path}"
                )

            payload = catalog_payloads[replacement.payload_relative_path]
            if len(payload) != replacement.payload_size:
                raise ChromaSkyboxChildError(
                    f"chroma child payload size mismatch: {replacement.payload_relative_path}"
                )
            payload_sha256 = hashlib.sha256(payload).hexdigest()
            if payload_sha256 != replacement.payload_sha256:
                raise ChromaSkyboxChildError(
                    f"chroma child payload SHA-256 mismatch: {replacement.payload_relative_path}"
                )
            if len(payload) > 0xFFFFFFFF or appended_offset + len(payload) > 0xFFFFFFFF:
                raise ChromaSkyboxChildError("chroma child VPK data section exceeds VPK-v2 limits")

            payloads[replacement.entry_path] = payload
            expected_offsets[replacement.entry_path] = appended_offset
            crc32 = zlib.crc32(payload) & 0xFFFFFFFF
            struct.pack_into("<I", patched_tree, entry.crc_field_offset, crc32)
            struct.pack_into(
                "<H", patched_tree, entry.archive_field_offset, _INLINE_ARCHIVE_INDEX
            )
            struct.pack_into("<I", patched_tree, entry.data_offset_field_offset, appended_offset)
            struct.pack_into("<I", patched_tree, entry.length_field_offset, len(payload))
            replacement_metadata.append(
                {
                    "entry_path": replacement.entry_path,
                    "original_size": len(original_payload),
                    "original_sha256": original_sha256,
                    "original_crc32": f"{entry.crc32:08x}",
                    "payload_relative_path": replacement.payload_relative_path,
                    "payload_size": len(payload),
                    "payload_sha256": payload_sha256,
                    "output_offset": appended_offset,
                    "output_crc32": f"{crc32:08x}",
                }
            )
            appended_offset += len(payload)

    new_header_bytes = _VPK_HEADER.pack(
        _VPK_MAGIC,
        _VPK_VERSION,
        len(patched_tree),
        appended_offset,
        0,
        48,
        0,
    )
    tree_md5 = hashlib.md5(patched_tree).digest()
    empty_archive_md5 = hashlib.md5(b"").digest()
    whole_md5 = hashlib.md5()
    whole_md5.update(new_header_bytes)
    whole_md5.update(patched_tree)

    output = io.BytesIO()
    output.write(new_header_bytes)
    output.write(patched_tree)
    source_data_sha256 = hashlib.sha256()
    with source.open("rb") as source_stream:
        source_stream.seek(source_header.data_start)
        remaining = source_header.data_size
        while remaining:
            chunk = source_stream.read(min(_COPY_CHUNK_SIZE, remaining))
            if not chunk:
                raise ChromaSkyboxChildError("official child VPK data section is truncated")
            output.write(chunk)
            whole_md5.update(chunk)
            source_data_sha256.update(chunk)
            remaining -= len(chunk)
    for entry_path in sorted(payloads):
        payload = payloads[entry_path]
        output.write(payload)
        whole_md5.update(payload)
    output.write(tree_md5)
    whole_md5.update(tree_md5)
    output.write(empty_archive_md5)
    whole_md5.update(empty_archive_md5)
    output.write(whole_md5.digest())
    package = output.getvalue()

    # Re-hash the physical official source after construction.  A concurrent
    # Steam update must not yield bytes from a mixed or superseded source.
    if source.stat().st_size != profile.source_size or _sha256_file(source) != source_sha256:
        raise ChromaSkyboxChildError(
            f"official child VPK changed during construction for {profile.map_name}"
        )

    output_header, output_entries = _verify_output(
        package,
        source_header=source_header,
        source_tree=source_tree,
        source_entries=source_entries,
        source_data_sha256=source_data_sha256.hexdigest(),
        payloads=payloads,
        expected_offsets=expected_offsets,
    )
    output_sha256 = hashlib.sha256(package).hexdigest()
    if (
        profile.validated_output_size is not None
        and len(package) != profile.validated_output_size
    ):
        raise ChromaSkyboxChildError(
            f"validated child VPK output size mismatch for {profile.map_name}: "
            f"{len(package)} != {profile.validated_output_size}"
        )
    if (
        profile.validated_output_sha256 is not None
        and output_sha256 != profile.validated_output_sha256
    ):
        raise ChromaSkyboxChildError(
            f"validated child VPK output SHA-256 mismatch for {profile.map_name}: "
            f"{output_sha256} != {profile.validated_output_sha256}"
        )
    metadata: dict[str, Any] = {
        "schema_version": CHROMA_CHILD_MANIFEST_SCHEMA_VERSION,
        "map_name": profile.map_name,
        "status": profile.status,
        "logical_path": profile.output_logical_path,
        "payload_catalog": {
            "format": _CATALOG_FORMAT,
            "relative_path": payload_catalog_spec.relative_path,
            "entry_count": payload_catalog_spec.entry_count,
        },
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
            "size": len(package),
            "sha256": output_sha256,
            "validated_expected_size": profile.validated_output_size,
            "validated_expected_sha256": profile.validated_output_sha256,
            "declared_sections_size": output_header.total_size,
            "undeclared_trailing_size": len(package) - output_header.total_size,
            "data_size": output_header.data_size,
            "entry_count": len(output_entries),
            "archive_md5_size": output_header.archive_md5_size,
            "other_md5_size": output_header.other_md5_size,
            "signature_size": output_header.signature_size,
        },
        "replacements": replacement_metadata,
    }
    return ChromaChildVpkBuild(
        logical_path=profile.output_logical_path,
        vpk_bytes=package,
        metadata=metadata,
    )


def build_chroma_child_vpk(
    *,
    csgo_dir: Path,
    payload_root: Path,
    manifest: Mapping[str, Any],
    map_name: object,
    require_in_game_confirmed: bool = True,
) -> ChromaChildVpkBuild:
    """Build one verified, color-agnostic child package entirely in memory.

    ``status == "validated"`` is required by default.  Build/catalog tooling may
    opt into candidate profiles explicitly, but production callers should keep
    the default.  No game file is written by this function, so every validation
    failure occurs before the returned bytes can enter the managed ``pov.vpk``.
    """

    if not isinstance(manifest, Mapping):
        raise ChromaSkyboxChildError("chroma child manifest must be an object")
    try:
        return _build_chroma_child_vpk(
            csgo_dir=Path(csgo_dir),
            payload_root=Path(payload_root),
            manifest=manifest,
            map_name=map_name,
            require_in_game_confirmed=bool(require_in_game_confirmed),
        )
    except ChromaSkyboxChildError:
        raise
    except (OSError, ValueError, TypeError, struct.error) as exc:
        raise ChromaSkyboxChildError(f"unable to build chroma child VPK: {exc}") from exc
