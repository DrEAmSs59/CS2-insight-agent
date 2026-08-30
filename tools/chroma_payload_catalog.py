"""Maintain the editable ZIP catalog used by chroma child-skybox patches.

The archive is only a source-resource container.  Runtime output remains a
verified VPK, and every member is still pinned by the map manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "pov" / "chroma_skybox_children" / "manifest.json"
_FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


class CatalogError(RuntimeError):
    pass


def _safe_member(value: object) -> str:
    raw = str(value or "").strip()
    normalized = raw.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if (
        not normalized
        or normalized != raw
        or normalized.startswith("/")
        or ":" in normalized
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise CatalogError(f"unsafe catalog member path: {value!r}")
    return normalized


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CatalogError(f"unable to read manifest {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise CatalogError("unsupported chroma child manifest")
    if not isinstance(value.get("maps"), dict) or not value["maps"]:
        raise CatalogError("manifest maps must be a non-empty object")
    return value


def _catalog_path(manifest_path: Path, manifest: Mapping[str, Any]) -> Path:
    raw = manifest.get("payload_catalog")
    if not isinstance(raw, Mapping) or raw.get("format") != "zip":
        raise CatalogError("manifest payload_catalog must use ZIP")
    relative = _safe_member(raw.get("relative_path"))
    if PurePosixPath(relative).suffix.lower() != ".zip":
        raise CatalogError("payload catalog must be a .zip file")
    root = manifest_path.resolve().parent
    target = root.joinpath(*PurePosixPath(relative).parts).resolve()
    if not target.is_relative_to(root):
        raise CatalogError("payload catalog escapes the manifest directory")
    return target


def _replacement_rows(
    manifest: Mapping[str, Any],
) -> list[tuple[str, str, dict[str, Any]]]:
    rows: list[tuple[str, str, dict[str, Any]]] = []
    seen: set[str] = set()
    for map_name, raw_profile in sorted(manifest["maps"].items()):
        if not isinstance(raw_profile, dict):
            raise CatalogError(f"invalid map profile: {map_name}")
        replacements = raw_profile.get("replacements")
        if not isinstance(replacements, list) or not replacements:
            raise CatalogError(f"map has no replacements: {map_name}")
        for raw_replacement in replacements:
            if not isinstance(raw_replacement, dict):
                raise CatalogError(f"invalid replacement in {map_name}")
            member = _safe_member(raw_replacement.get("payload_relative_path"))
            if member in seen:
                raise CatalogError(f"duplicate payload member: {member}")
            seen.add(member)
            rows.append((map_name, member, raw_replacement))
    return rows


def _verify(
    manifest_path: Path,
    manifest: Mapping[str, Any],
) -> dict[str, bytes]:
    rows = _replacement_rows(manifest)
    declared = {member: replacement for _, member, replacement in rows}
    catalog = _catalog_path(manifest_path, manifest)
    try:
        with zipfile.ZipFile(catalog, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise CatalogError("payload ZIP contains duplicate members")
            if set(names) != set(declared):
                raise CatalogError("payload ZIP members do not match the manifest")
            payloads: dict[str, bytes] = {}
            for info in infos:
                member = _safe_member(info.filename)
                if member != info.filename or info.is_dir() or info.flag_bits & 0x1:
                    raise CatalogError(f"invalid payload ZIP member: {info.filename!r}")
                body = archive.read(info)
                replacement = declared[member]
                expected_size = replacement.get("payload_size")
                expected_sha = str(replacement.get("payload_sha256") or "").lower()
                if len(body) != expected_size:
                    raise CatalogError(f"payload size mismatch: {member}")
                if hashlib.sha256(body).hexdigest() != expected_sha:
                    raise CatalogError(f"payload SHA-256 mismatch: {member}")
                payloads[member] = body
    except CatalogError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise CatalogError(f"unable to read payload ZIP {catalog}: {exc}") from exc
    expected_count = manifest["payload_catalog"].get("entry_count")
    if expected_count != len(payloads):
        raise CatalogError("payload_catalog.entry_count is stale")
    return payloads


def _write_deterministic_zip(path: Path, payloads: Mapping[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for member in sorted(payloads):
                info = zipfile.ZipInfo(member, date_time=_FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, payloads[member], compresslevel=9)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_manifest(path: Path, manifest: Mapping[str, Any]) -> None:
    body = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(body, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sanitize_manifest(manifest: dict[str, Any]) -> None:
    allowed_root = {"schema_version", "purpose", "payload_catalog", "maps"}
    for key in tuple(manifest):
        if key not in allowed_root:
            manifest.pop(key, None)
    allowed_profile = {
        "status",
        "main_map_patch_required",
        "source_relative_path",
        "source_size",
        "source_sha256",
        "output_logical_path",
        "validated_output_size",
        "validated_output_sha256",
        "replacements",
    }
    allowed_replacement = {
        "kind",
        "entry_path",
        "original_size",
        "original_sha256",
        "payload_relative_path",
        "payload_size",
        "payload_sha256",
    }
    for profile in manifest["maps"].values():
        for key in tuple(profile):
            if key not in allowed_profile:
                profile.pop(key, None)
        for replacement in profile["replacements"]:
            for key in tuple(replacement):
                if key not in allowed_replacement:
                    replacement.pop(key, None)


def _command_list(manifest_path: Path) -> None:
    manifest = _load_manifest(manifest_path)
    payloads = _verify(manifest_path, manifest)
    print("map\tkind\tbytes\tmember")
    for map_name, member, replacement in _replacement_rows(manifest):
        print(
            f"{map_name}\t{replacement.get('kind', '')}\t"
            f"{len(payloads[member])}\t{member}"
        )


def _command_verify(manifest_path: Path) -> None:
    manifest = _load_manifest(manifest_path)
    payloads = _verify(manifest_path, manifest)
    print(
        f"verified {len(payloads)} payloads in "
        f"{_catalog_path(manifest_path, manifest)}"
    )


def _command_extract(manifest_path: Path, output: Path) -> None:
    manifest = _load_manifest(manifest_path)
    payloads = _verify(manifest_path, manifest)
    root = output.resolve()
    if root.exists() and any(root.iterdir()):
        raise CatalogError(f"extract output is not empty: {root}")
    root.mkdir(parents=True, exist_ok=True)
    for member, body in payloads.items():
        target = root.joinpath(*PurePosixPath(member).parts).resolve()
        if not target.is_relative_to(root):
            raise CatalogError(f"payload escapes extract output: {member}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    print(f"extracted {len(payloads)} payloads to {root}")


def _command_build(manifest_path: Path, source: Path) -> None:
    manifest = _load_manifest(manifest_path)
    root = source.resolve(strict=True)
    if not root.is_dir():
        raise CatalogError(f"build source is not a directory: {root}")
    payloads: dict[str, bytes] = {}
    changed_maps: set[str] = set()
    for map_name, member, replacement in _replacement_rows(manifest):
        path = root.joinpath(*PurePosixPath(member).parts).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise CatalogError(f"payload source escapes the source root: {member}")
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if (
            replacement.get("payload_size") != len(body)
            or replacement.get("payload_sha256") != digest
        ):
            changed_maps.add(map_name)
        replacement["payload_size"] = len(body)
        replacement["payload_sha256"] = digest
        payloads[member] = body

    manifest["payload_catalog"]["entry_count"] = len(payloads)
    for map_name in sorted(changed_maps):
        profile = manifest["maps"][map_name]
        profile["status"] = "candidate_requires_in_game_gate"
        profile.pop("validated_output_size", None)
        profile.pop("validated_output_sha256", None)

    _sanitize_manifest(manifest)
    _write_deterministic_zip(_catalog_path(manifest_path, manifest), payloads)
    _write_manifest(manifest_path, manifest)
    _verify(manifest_path, manifest)
    if changed_maps:
        print(
            "rebuilt catalog; manual in-game validation required for: "
            + ", ".join(sorted(changed_maps))
        )
    else:
        print(f"rebuilt catalog with {len(payloads)} unchanged payloads")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="List, verify, extract, or rebuild the chroma payload ZIP catalog."
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    commands.add_parser("verify")
    extract = commands.add_parser("extract")
    extract.add_argument("--output", type=Path, required=True)
    build = commands.add_parser("build")
    build.add_argument("--source", type=Path, required=True)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    manifest_path = args.manifest.resolve()
    try:
        if args.command == "list":
            _command_list(manifest_path)
        elif args.command == "verify":
            _command_verify(manifest_path)
        elif args.command == "extract":
            _command_extract(manifest_path, args.output)
        else:
            _command_build(manifest_path, args.source)
    except (CatalogError, OSError) as exc:
        print(f"error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
