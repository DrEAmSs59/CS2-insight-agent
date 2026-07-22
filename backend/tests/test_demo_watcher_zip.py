import io
import struct
import zipfile
import zlib
from pathlib import Path

import pytest

from app.demo_watcher import (
    _extract_dems_from_zip_sync,
    _iter_local_header_zip_dems,
    iter_candidate_files,
    normalize_scan_depth,
)


def _build_local_header_only_zip(name: str, payload: bytes) -> bytes:
    """Build a single-entry deflate zip without central directory (5E-style)."""
    name_bytes = name.encode("utf-8")
    compressor = zlib.compressobj(level=1, wbits=-zlib.MAX_WBITS)
    compressed = compressor.compress(payload) + compressor.flush()
    header = struct.pack(
        "<IHHHHHIIIHH",
        0x04034B50,
        20,
        0,
        8,
        0,
        0,
        0,
        len(compressed),
        len(payload),
        len(name_bytes),
        0,
    )
    return header + name_bytes + compressed


def test_iter_local_header_zip_dems_reads_payload_without_eocd():
    payload = b"HL2DEMO" + b"\x00" * 16
    raw = _build_local_header_only_zip("match.dem", payload)
    with pytest.raises(zipfile.BadZipFile):
        zipfile.ZipFile(io.BytesIO(raw), "r")

    members = _iter_local_header_zip_dems_from_bytes(raw)
    assert members == [("match.dem", payload)]


def _iter_local_header_zip_dems_from_bytes(raw: bytes) -> list[tuple[str, bytes]]:
    path = Path("local-header.zip")
    path.write_bytes(raw)
    try:
        return _iter_local_header_zip_dems(path)
    finally:
        path.unlink(missing_ok=True)


def test_extract_dems_from_zip_sync_falls_back_to_local_header(tmp_path: Path):
    payload = b"HL2DEMO" + b"\x00" * 32
    zip_path = tmp_path / "replay.zip"
    zip_path.write_bytes(_build_local_header_only_zip("replay.dem", payload))

    extracted = _extract_dems_from_zip_sync(zip_path)
    assert len(extracted) == 1
    assert extracted[0].read_bytes() == payload


def test_iter_candidate_files_respects_configured_depth(tmp_path: Path):
    root_demo = tmp_path / "root.dem"
    level_one = tmp_path / "season" / "match.dem"
    level_two = tmp_path / "season" / "day" / "deep.dem"
    ignored = tmp_path / "season" / "notes.txt"
    level_one.parent.mkdir()
    level_two.parent.mkdir()
    for path in (root_demo, level_one, level_two, ignored):
        path.write_bytes(b"demo")

    depth_zero = {path.name for path in iter_candidate_files(tmp_path, (".dem",), max_depth=0)}
    depth_one = {path.name for path in iter_candidate_files(tmp_path, (".dem",), max_depth=1)}
    depth_two = {path.name for path in iter_candidate_files(tmp_path, (".dem",), max_depth=2)}

    assert depth_zero == {"root.dem"}
    assert depth_one == {"root.dem", "match.dem"}
    assert depth_two == {"root.dem", "match.dem", "deep.dem"}


def test_normalize_scan_depth_clamps_invalid_values():
    assert normalize_scan_depth("bad") == 2
    assert normalize_scan_depth(-5) == 0
    assert normalize_scan_depth(100) == 32
