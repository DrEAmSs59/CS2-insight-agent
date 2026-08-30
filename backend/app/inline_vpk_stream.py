"""Streaming writer for the single managed inline ``pov.vpk``.

The ordinary HUD, map-material, chroma material, and child-skybox layers are
small enough to remain byte entries.  Reconstructed main-map VPKs are not: a
single package can be several hundred MiB.  This module combines both kinds
without materialising file-backed entries in memory.

Every file-backed source is pinned by size and SHA-256, restricted to the
``maps/de_<name>.vpk`` namespace, checked before, during, and after copying,
and committed only after the complete output passes a second streaming
verification.  The destination is replaced atomically through a sibling
temporary file and a valid VPK-v2 OtherMD5 section is always emitted.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
import uuid
import zlib
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from . import chroma_skybox_child as _vpk


_COPY_CHUNK_SIZE = 8 * 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAIN_MAP_LOGICAL_PATH_RE = re.compile(r"^maps/de_[a-z0-9_]+\.vpk$")
_UINT32_MAX = 0xFFFFFFFF


class InlineVpkStreamError(RuntimeError):
    """An entry, source artifact, or generated outer VPK failed validation."""


@dataclass(frozen=True)
class VerifiedFileSource:
    """Declared identity of one already-verified file-backed outer entry.

    The writer does not trust the declaration on its own.  It re-hashes the
    physical file before constructing the tree, while copying it, and once
    more before committing the output.
    """

    path: Path
    size: int
    sha256: str


@dataclass(frozen=True)
class InlineVpkFileBuild:
    """Verified atomic output and audit metadata."""

    output_path: Path
    metadata: dict[str, Any]


@dataclass(frozen=True)
class _PreparedEntry:
    logical_path: str
    kind: str
    size: int
    sha256: str
    crc32: int
    body: bytes | None = None
    source_path: Path | None = None


@dataclass(frozen=True)
class _PlacedEntry:
    prepared: _PreparedEntry
    offset: int


def _safe_logical_path(value: object, *, field: str) -> str:
    if not isinstance(value, str):
        raise InlineVpkStreamError(f"{field} must be a string")
    raw = value.replace("\\", "/")
    if (
        not raw
        or raw != raw.strip()
        or "\x00" in raw
        or raw.startswith("/")
        or ":" in raw
    ):
        raise InlineVpkStreamError(f"unsafe VPK entry path in {field}: {value!r}")
    parts = raw.split("/")
    if any(not part or part in {".", ".."} or part != part.strip() for part in parts):
        raise InlineVpkStreamError(f"unsafe VPK entry path in {field}: {value!r}")
    path = PurePosixPath(*parts)
    if path.is_absolute() or ".." in path.parts:
        raise InlineVpkStreamError(f"unsafe VPK entry path in {field}: {value!r}")
    normalized = path.as_posix()
    leaf = path.name
    if not leaf or "." not in leaf:
        raise InlineVpkStreamError(f"VPK entry path has no extension in {field}: {value!r}")
    stem, extension = leaf.rsplit(".", 1)
    if not stem or not extension:
        raise InlineVpkStreamError(f"invalid VPK entry leaf in {field}: {value!r}")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise InlineVpkStreamError(
            f"VPK entry path is not valid UTF-8 in {field}: {value!r}"
        ) from exc
    return normalized


def _sha256_value(value: object, *, field: str) -> str:
    digest = str(value or "").strip().lower()
    if not _SHA256_RE.fullmatch(digest):
        raise InlineVpkStreamError(f"invalid SHA-256 in {field}")
    return digest


def _size_value(value: object, *, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _UINT32_MAX
    ):
        raise InlineVpkStreamError(f"invalid byte size in {field}")
    return value


def _path_parts(path: str) -> tuple[str, str, str]:
    directory, _, leaf = path.rpartition("/")
    stem, extension = leaf.rsplit(".", 1)
    return extension, directory or " ", stem


def _hash_file_with_crc(path: Path) -> tuple[int, str, int]:
    size = 0
    sha256 = hashlib.sha256()
    crc32 = 0
    with path.open("rb") as stream:
        while chunk := stream.read(_COPY_CHUNK_SIZE):
            size += len(chunk)
            sha256.update(chunk)
            crc32 = zlib.crc32(chunk, crc32)
    return size, sha256.hexdigest(), crc32 & _UINT32_MAX


def _hash_range_with_crc(
    stream: BinaryIO,
    *,
    offset: int,
    length: int,
) -> tuple[str, int]:
    stream.seek(offset)
    remaining = length
    sha256 = hashlib.sha256()
    crc32 = 0
    while remaining:
        chunk = stream.read(min(_COPY_CHUNK_SIZE, remaining))
        if not chunk:
            raise InlineVpkStreamError("generated VPK entry range is truncated")
        sha256.update(chunk)
        crc32 = zlib.crc32(chunk, crc32)
        remaining -= len(chunk)
    return sha256.hexdigest(), crc32 & _UINT32_MAX


def _resolve_file_source(
    declared: VerifiedFileSource,
    *,
    field: str,
) -> tuple[Path, int, str, int]:
    if not isinstance(declared, VerifiedFileSource):
        raise InlineVpkStreamError(f"{field} must be a VerifiedFileSource")
    expected_size = _size_value(declared.size, field=f"{field}.size")
    expected_sha256 = _sha256_value(declared.sha256, field=f"{field}.sha256")
    source = Path(declared.path)
    if source.is_symlink():
        raise InlineVpkStreamError(f"file-backed VPK source must not be a symlink: {source}")
    try:
        source = source.resolve(strict=True)
    except OSError as exc:
        raise InlineVpkStreamError(f"file-backed VPK source does not exist: {source}") from exc
    if not source.is_file():
        raise InlineVpkStreamError(f"file-backed VPK source is not a file: {source}")
    if source.suffix.lower() != ".vpk":
        raise InlineVpkStreamError(
            f"file-backed VPK source must use the .vpk extension: {source}"
        )
    actual_size, actual_sha256, actual_crc32 = _hash_file_with_crc(source)
    if actual_size != expected_size:
        raise InlineVpkStreamError(
            f"file-backed VPK source size changed: {actual_size} != {expected_size}"
        )
    if actual_sha256 != expected_sha256:
        raise InlineVpkStreamError("file-backed VPK source SHA-256 changed")
    return source, actual_size, actual_sha256, actual_crc32


def _prepare_entries(
    *,
    byte_entries: Mapping[str, bytes],
    file_entries: Mapping[str, VerifiedFileSource],
) -> tuple[dict[str, _PreparedEntry], list[_PlacedEntry], bytes, int]:
    if not isinstance(byte_entries, Mapping):
        raise InlineVpkStreamError("byte_entries must be a mapping")
    if not isinstance(file_entries, Mapping):
        raise InlineVpkStreamError("file_entries must be a mapping")
    if not byte_entries and not file_entries:
        raise InlineVpkStreamError("the streamed VPK must contain at least one entry")

    prepared: dict[str, _PreparedEntry] = {}
    casefolded_paths: dict[str, str] = {}

    def reserve_path(raw_path: object, *, field: str) -> str:
        logical_path = _safe_logical_path(raw_path, field=field)
        folded = logical_path.casefold()
        previous = casefolded_paths.get(folded)
        if previous is not None:
            raise InlineVpkStreamError(
                f"VPK entry path collision: {previous!r} and {logical_path!r}"
            )
        casefolded_paths[folded] = logical_path
        return logical_path

    for raw_path, raw_body in byte_entries.items():
        logical_path = reserve_path(raw_path, field="byte_entries")
        if _MAIN_MAP_LOGICAL_PATH_RE.fullmatch(logical_path.casefold()):
            raise InlineVpkStreamError(
                "main-map VPK entries must use a VerifiedFileSource: "
                f"{logical_path}"
            )
        if not isinstance(raw_body, (bytes, bytearray, memoryview)):
            raise InlineVpkStreamError(
                f"byte entry payload must be bytes-like: {logical_path}"
            )
        body = bytes(raw_body)
        if len(body) > _UINT32_MAX:
            raise InlineVpkStreamError(f"byte entry is too large for VPK v2: {logical_path}")
        prepared[logical_path] = _PreparedEntry(
            logical_path=logical_path,
            kind="bytes",
            size=len(body),
            sha256=hashlib.sha256(body).hexdigest(),
            crc32=zlib.crc32(body) & _UINT32_MAX,
            body=body,
        )

    for raw_path, declared in file_entries.items():
        logical_path = reserve_path(raw_path, field="file_entries")
        if (
            logical_path != logical_path.casefold()
            or not _MAIN_MAP_LOGICAL_PATH_RE.fullmatch(logical_path)
        ):
            raise InlineVpkStreamError(
                "file-backed entries are restricted to maps/de_<map>.vpk: "
                f"{logical_path}"
            )
        source, size, sha256, crc32 = _resolve_file_source(
            declared,
            field=f"file_entries[{logical_path!r}]",
        )
        prepared[logical_path] = _PreparedEntry(
            logical_path=logical_path,
            kind="file",
            size=size,
            sha256=sha256,
            crc32=crc32,
            source_path=source,
        )

    grouped: dict[str, dict[str, dict[str, _PreparedEntry]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for logical_path, entry in prepared.items():
        extension, directory, stem = _path_parts(logical_path)
        if stem in grouped[extension][directory]:
            raise InlineVpkStreamError(f"duplicate VPK tree key: {logical_path}")
        grouped[extension][directory][stem] = entry

    tree = bytearray()
    placed: list[_PlacedEntry] = []
    data_size = 0
    for extension in sorted(grouped):
        tree.extend(extension.encode("utf-8") + b"\0")
        for directory in sorted(grouped[extension]):
            tree.extend(directory.encode("utf-8") + b"\0")
            for stem in sorted(grouped[extension][directory]):
                entry = grouped[extension][directory][stem]
                if data_size + entry.size > _UINT32_MAX:
                    raise InlineVpkStreamError("streamed VPK data exceeds the VPK-v2 limit")
                tree.extend(stem.encode("utf-8") + b"\0")
                tree.extend(
                    _vpk._VPK_ENTRY.pack(
                        entry.crc32,
                        0,
                        _vpk._INLINE_ARCHIVE_INDEX,
                        data_size,
                        entry.size,
                        0xFFFF,
                    )
                )
                placed.append(_PlacedEntry(prepared=entry, offset=data_size))
                data_size += entry.size
            tree.extend(b"\0")
        tree.extend(b"\0")
    tree.extend(b"\0")
    if len(tree) > _UINT32_MAX:
        raise InlineVpkStreamError("streamed VPK tree exceeds the VPK-v2 limit")
    return prepared, placed, bytes(tree), data_size


def _resolve_output_path(
    value: Path,
    *,
    file_sources: Mapping[str, _PreparedEntry],
) -> Path:
    output = Path(value)
    if output.name in {"", ".", ".."} or output.suffix.lower() != ".vpk":
        raise InlineVpkStreamError("streamed VPK output must be a .vpk file")
    try:
        parent = output.parent.resolve(strict=True)
    except OSError as exc:
        raise InlineVpkStreamError("streamed VPK output directory does not exist") from exc
    if not parent.is_dir():
        raise InlineVpkStreamError("streamed VPK output parent is not a directory")
    target = parent / output.name
    if target.is_symlink():
        raise InlineVpkStreamError("streamed VPK output must not be a symlink")
    if target.exists() and not target.is_file():
        raise InlineVpkStreamError("streamed VPK output exists but is not a file")
    target_resolved = target.resolve(strict=False)
    for entry in file_sources.values():
        if entry.source_path is not None and target_resolved == entry.source_path:
            raise InlineVpkStreamError("refusing to overwrite a file-backed VPK source")
    return target


def _copy_file_entry(
    entry: _PreparedEntry,
    output: BinaryIO,
    *,
    whole_md5: Any,
) -> None:
    if entry.source_path is None:
        raise InlineVpkStreamError(f"file entry has no source: {entry.logical_path}")
    copied_size = 0
    copied_sha256 = hashlib.sha256()
    copied_crc32 = 0
    with entry.source_path.open("rb") as source:
        while chunk := source.read(_COPY_CHUNK_SIZE):
            output.write(chunk)
            whole_md5.update(chunk)
            copied_size += len(chunk)
            copied_sha256.update(chunk)
            copied_crc32 = zlib.crc32(chunk, copied_crc32)
    if copied_size != entry.size:
        raise InlineVpkStreamError(
            f"file-backed VPK source size changed during copy: {entry.logical_path}"
        )
    if copied_sha256.hexdigest() != entry.sha256:
        raise InlineVpkStreamError(
            f"file-backed VPK source SHA-256 changed during copy: {entry.logical_path}"
        )
    if copied_crc32 & _UINT32_MAX != entry.crc32:
        raise InlineVpkStreamError(
            f"file-backed VPK source CRC32 changed during copy: {entry.logical_path}"
        )


def _verify_other_md5(path: Path, header: _vpk._VpkHeaderValue, tree: bytes) -> None:
    if (
        header.archive_md5_size != 0
        or header.other_md5_size != 48
        or header.signature_size != 0
    ):
        raise InlineVpkStreamError("streamed VPK integrity sections are invalid")
    other_start = header.data_start + header.data_size
    with path.open("rb") as stream:
        stream.seek(other_start)
        other = stream.read(48)
        trailing = stream.read(1)
    if len(other) != 48 or trailing:
        raise InlineVpkStreamError("streamed VPK OtherMD5 or physical size is invalid")
    if other[:16] != hashlib.md5(tree).digest():
        raise InlineVpkStreamError("streamed VPK tree MD5 is invalid")
    if other[16:32] != hashlib.md5(b"").digest():
        raise InlineVpkStreamError("streamed VPK archive MD5 is invalid")

    whole_md5 = hashlib.md5()
    remaining = other_start + 32
    with path.open("rb") as stream:
        while remaining:
            chunk = stream.read(min(_COPY_CHUNK_SIZE, remaining))
            if not chunk:
                raise InlineVpkStreamError("streamed VPK is truncated during MD5 verification")
            whole_md5.update(chunk)
            remaining -= len(chunk)
    if other[32:48] != whole_md5.digest():
        raise InlineVpkStreamError("streamed VPK whole-file MD5 is invalid")


def _verify_output(
    path: Path,
    *,
    prepared: Mapping[str, _PreparedEntry],
    placed: list[_PlacedEntry],
    expected_tree: bytes,
    expected_data_size: int,
) -> tuple[int, str, Mapping[str, _vpk._VpkEntryValue]]:
    try:
        header, tree_mutable, entries = _vpk._open_package(path)
    except _vpk.ChromaSkyboxChildError as exc:
        raise InlineVpkStreamError(f"unable to parse streamed VPK: {exc}") from exc
    tree = bytes(tree_mutable)
    if header.total_size != path.stat().st_size:
        raise InlineVpkStreamError("streamed VPK has undeclared trailing bytes")
    if tree != expected_tree or header.tree_size != len(expected_tree):
        raise InlineVpkStreamError("streamed VPK tree changed after construction")
    if header.data_size != expected_data_size:
        raise InlineVpkStreamError("streamed VPK data size changed after construction")
    if set(entries) != set(prepared):
        raise InlineVpkStreamError("streamed VPK entry set changed")
    _verify_other_md5(path, header, tree)

    expected_offsets = {item.prepared.logical_path: item.offset for item in placed}
    with path.open("rb") as stream:
        for logical_path, expected in prepared.items():
            actual = entries[logical_path]
            if (
                actual.preload_size != 0
                or actual.archive_index != _vpk._INLINE_ARCHIVE_INDEX
                or actual.offset != expected_offsets[logical_path]
                or actual.length != expected.size
                or actual.crc32 != expected.crc32
            ):
                raise InlineVpkStreamError(
                    f"streamed VPK entry metadata mismatch: {logical_path}"
                )
            sha256, crc32 = _hash_range_with_crc(
                stream,
                offset=header.data_start + actual.offset,
                length=actual.length,
            )
            if sha256 != expected.sha256 or crc32 != expected.crc32:
                raise InlineVpkStreamError(
                    f"streamed VPK entry payload mismatch: {logical_path}"
                )
    output_size, output_sha256, _output_crc32 = _hash_file_with_crc(path)
    return output_size, output_sha256, entries


def write_inline_vpk_file(
    *,
    output_path: Path,
    byte_entries: Mapping[str, bytes],
    file_entries: Mapping[str, VerifiedFileSource] | None = None,
) -> InlineVpkFileBuild:
    """Atomically write and verify one inline VPK from bytes and pinned files.

    ``byte_entries`` follows the same logical-path-to-bytes convention as
    :func:`app.demo_voice_hud.write_inline_vpk`.  Large reconstructed main maps
    must instead be supplied through ``file_entries`` and are streamed in
    bounded chunks.  The output path is not changed unless the complete sibling
    temporary archive passes structural, payload, hash, and OtherMD5 checks.
    """

    try:
        prepared, placed, tree, data_size = _prepare_entries(
            byte_entries=byte_entries,
            file_entries={} if file_entries is None else file_entries,
        )
        output = _resolve_output_path(output_path, file_sources=prepared)
        header = _vpk._VPK_HEADER.pack(
            _vpk._VPK_MAGIC,
            _vpk._VPK_VERSION,
            len(tree),
            data_size,
            0,
            48,
            0,
        )
        tree_md5 = hashlib.md5(tree).digest()
        empty_archive_md5 = hashlib.md5(b"").digest()
        whole_md5 = hashlib.md5()
        whole_md5.update(header)
        whole_md5.update(tree)

        temp = output.with_name(f".{output.name}.tmp-{uuid.uuid4().hex}")
        try:
            with temp.open("xb") as stream:
                stream.write(header)
                stream.write(tree)
                for item in placed:
                    entry = item.prepared
                    if entry.kind == "bytes":
                        if entry.body is None:
                            raise InlineVpkStreamError(
                                f"byte entry has no payload: {entry.logical_path}"
                            )
                        stream.write(entry.body)
                        whole_md5.update(entry.body)
                    elif entry.kind == "file":
                        _copy_file_entry(entry, stream, whole_md5=whole_md5)
                    else:
                        raise InlineVpkStreamError(
                            f"unknown streamed VPK entry kind: {entry.kind}"
                        )
                stream.write(tree_md5)
                whole_md5.update(tree_md5)
                stream.write(empty_archive_md5)
                whole_md5.update(empty_archive_md5)
                stream.write(whole_md5.digest())
                stream.flush()
                os.fsync(stream.fileno())

            output_size, output_sha256, output_entries = _verify_output(
                temp,
                prepared=prepared,
                placed=placed,
                expected_tree=tree,
                expected_data_size=data_size,
            )

            # A source may be replaced after its bytes were copied.  Re-hash it
            # immediately before committing so the audit metadata cannot refer
            # to a superseded staging artifact.
            for logical_path, entry in prepared.items():
                if entry.kind != "file" or entry.source_path is None:
                    continue
                size, sha256, crc32 = _hash_file_with_crc(entry.source_path)
                if (
                    size != entry.size
                    or sha256 != entry.sha256
                    or crc32 != entry.crc32
                ):
                    raise InlineVpkStreamError(
                        f"file-backed VPK source changed before commit: {logical_path}"
                    )

            replaced_existing = output.exists()
            os.replace(temp, output)
        finally:
            if temp.exists():
                temp.unlink()

        metadata: dict[str, Any] = {
            "schema_version": 1,
            "output": {
                "absolute_path": str(output),
                "size": output_size,
                "sha256": output_sha256,
                "tree_size": len(tree),
                "data_size": data_size,
                "entry_count": len(output_entries),
                "archive_md5_size": 0,
                "other_md5_size": 48,
                "signature_size": 0,
                "atomic_replace": True,
                "replaced_existing": replaced_existing,
            },
            "entries": [
                {
                    "logical_path": logical_path,
                    "kind": entry.kind,
                    "size": entry.size,
                    "sha256": entry.sha256,
                    "crc32": f"{entry.crc32:08x}",
                    **(
                        {"source_path": str(entry.source_path)}
                        if entry.source_path is not None
                        else {}
                    ),
                }
                for logical_path, entry in sorted(prepared.items())
            ],
        }
        return InlineVpkFileBuild(output_path=output, metadata=metadata)
    except InlineVpkStreamError:
        raise
    except _vpk.ChromaSkyboxChildError as exc:
        raise InlineVpkStreamError(f"unable to write streamed VPK: {exc}") from exc
    except (OSError, ValueError, TypeError, struct.error) as exc:
        raise InlineVpkStreamError(f"unable to write streamed VPK: {exc}") from exc
