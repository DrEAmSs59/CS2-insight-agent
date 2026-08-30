from __future__ import annotations

import hashlib
import os
import struct
import zlib
from pathlib import Path

import pytest

from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app import inline_vpk_stream as streamed


_HEADER = struct.Struct("<7I")
_MAGIC = 0x55AA1234
_VERSION = 2


def _verified_source(path: Path, body: bytes | None = None) -> streamed.VerifiedFileSource:
    if body is not None:
        path.write_bytes(body)
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(97):
            digest.update(chunk)
            size += len(chunk)
    return streamed.VerifiedFileSource(path=path, size=size, sha256=digest.hexdigest())


def _fixture_entries(
    tmp_path: Path,
) -> tuple[dict[str, bytes], dict[str, streamed.VerifiedFileSource], Path, bytes]:
    nested_body = write_inline_vpk(
        {
            "maps/de_test/entities/default_ents.vents_c": b"entity-lump",
            "maps/de_test/worldnodes/n0.vwnod_c": b"world-node" * 211,
        }
    )
    nested = tmp_path / "staged-main.vpk"
    file_entries = {"maps/de_test.vpk": _verified_source(nested, nested_body)}
    byte_entries = {
        "panorama/layout/base.vxml_c": b"hud",
        "materials/cs2_insight/chroma/active_sky.vmat_c": b"sky-material",
        "materials/chroma_green.vtex_c": b"green-texture",
        "maps/prefabs/de_test/de_test_skybox.vpk": write_inline_vpk(
            {"nested/child.txt": b"child"}
        ),
    }
    return byte_entries, file_entries, nested, nested_body


def _assert_other_md5(path: Path) -> None:
    with path.open("rb") as stream:
        header_bytes = stream.read(_HEADER.size)
        (
            magic,
            version,
            tree_size,
            data_size,
            archive_size,
            other_size,
            signature_size,
        ) = _HEADER.unpack(header_bytes)
        tree = stream.read(tree_size)
        stream.seek(_HEADER.size + tree_size + data_size)
        other = stream.read(48)
        trailing = stream.read(1)
    assert magic == _MAGIC
    assert version == _VERSION
    assert archive_size == 0
    assert other_size == 48
    assert signature_size == 0
    assert not trailing
    assert other[:16] == hashlib.md5(tree).digest()
    assert other[16:32] == hashlib.md5(b"").digest()

    whole = hashlib.md5()
    remaining = _HEADER.size + tree_size + data_size + 32
    with path.open("rb") as stream:
        while remaining:
            chunk = stream.read(min(101, remaining))
            assert chunk
            whole.update(chunk)
            remaining -= len(chunk)
    assert other[32:] == whole.digest()


def test_streamed_outer_is_deterministic_and_read_inline_vpk_compatible(
    tmp_path: Path,
) -> None:
    byte_entries, file_entries, _nested, nested_body = _fixture_entries(tmp_path)
    first = tmp_path / "first.vpk"
    second = tmp_path / "second.vpk"

    first_build = streamed.write_inline_vpk_file(
        output_path=first,
        byte_entries=byte_entries,
        file_entries=file_entries,
    )
    second_build = streamed.write_inline_vpk_file(
        output_path=second,
        byte_entries=byte_entries,
        file_entries=file_entries,
    )

    assert first.read_bytes() == second.read_bytes()
    assert read_inline_vpk(first.read_bytes()) == {
        **byte_entries,
        "maps/de_test.vpk": nested_body,
    }
    assert first_build.output_path == first.resolve()
    assert first_build.metadata["output"]["sha256"] == hashlib.sha256(
        first.read_bytes()
    ).hexdigest()
    assert first_build.metadata["output"]["size"] == first.stat().st_size
    assert first_build.metadata["output"]["entry_count"] == 5
    assert first_build.metadata["output"]["other_md5_size"] == 48
    assert first_build.metadata == second_build.metadata | {
        "output": {
            **second_build.metadata["output"],
            "absolute_path": str(first.resolve()),
        }
    }
    _assert_other_md5(first)


def test_metadata_distinguishes_bytes_and_file_sources(tmp_path: Path) -> None:
    byte_entries, file_entries, nested, nested_body = _fixture_entries(tmp_path)
    output = tmp_path / "metadata.vpk"

    result = streamed.write_inline_vpk_file(
        output_path=output,
        byte_entries=byte_entries,
        file_entries=file_entries,
    )

    entries = {item["logical_path"]: item for item in result.metadata["entries"]}
    assert entries["panorama/layout/base.vxml_c"] == {
        "logical_path": "panorama/layout/base.vxml_c",
        "kind": "bytes",
        "size": 3,
        "sha256": hashlib.sha256(b"hud").hexdigest(),
        "crc32": f"{zlib.crc32(b'hud') & 0xFFFFFFFF:08x}",
    }
    assert entries["maps/de_test.vpk"] == {
        "logical_path": "maps/de_test.vpk",
        "kind": "file",
        "size": len(nested_body),
        "sha256": hashlib.sha256(nested_body).hexdigest(),
        "crc32": f"{zlib.crc32(nested_body) & 0xFFFFFFFF:08x}",
        "source_path": str(nested.resolve()),
    }


def test_file_source_is_never_loaded_with_path_read_bytes_and_reads_in_chunks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_entries, file_entries, nested, _nested_body = _fixture_entries(tmp_path)
    real_open = Path.open
    real_read_bytes = Path.read_bytes
    source_reads: list[int] = []
    monkeypatch.setattr(streamed, "_COPY_CHUNK_SIZE", 31)

    class ReadSpy:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def __enter__(self):
            self._wrapped.__enter__()
            return self

        def __exit__(self, *args):
            return self._wrapped.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self._wrapped, name)

        def read(self, size: int = -1):
            source_reads.append(size)
            assert 0 < size <= 31
            return self._wrapped.read(size)

    def guarded_open(self: Path, *args, **kwargs):
        opened = real_open(self, *args, **kwargs)
        mode = args[0] if args else kwargs.get("mode", "r")
        if self.resolve(strict=False) == nested.resolve() and mode == "rb":
            return ReadSpy(opened)
        return opened

    def guarded_read_bytes(self: Path) -> bytes:
        if self.resolve(strict=False) == nested.resolve():
            raise AssertionError("file-backed source must never use Path.read_bytes")
        return real_read_bytes(self)

    monkeypatch.setattr(Path, "open", guarded_open)
    monkeypatch.setattr(Path, "read_bytes", guarded_read_bytes)
    result = streamed.write_inline_vpk_file(
        output_path=tmp_path / "chunked.vpk",
        byte_entries=byte_entries,
        file_entries=file_entries,
    )

    assert result.metadata["output"]["entry_count"] == 5
    assert len(source_reads) > 10
    assert set(source_reads) == {31}


@pytest.mark.parametrize(
    "raw_path",
    (
        "../escape.txt",
        "/absolute.txt",
        "C:/absolute.txt",
        "materials//double.txt",
        "materials/./dot.txt",
        " materials/space.txt",
        "materials/no_extension",
        "materials/.hidden",
        "materials/trailing.",
    ),
)
def test_unsafe_byte_entry_paths_are_rejected(tmp_path: Path, raw_path: str) -> None:
    output = tmp_path / "blocked.vpk"
    with pytest.raises(streamed.InlineVpkStreamError, match="path|extension|leaf"):
        streamed.write_inline_vpk_file(
            output_path=output,
            byte_entries={raw_path: b"payload"},
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "logical_path",
    (
        "materials/de_test.vpk",
        "maps/test.vpk",
        "maps/prefabs/de_test/de_test_skybox.vpk",
        "maps/DE_TEST.vpk",
        "maps/de-test.vpk",
    ),
)
def test_file_entries_are_restricted_to_main_map_namespace(
    tmp_path: Path,
    logical_path: str,
) -> None:
    source = tmp_path / "source.vpk"
    declared = _verified_source(source, b"source")
    with pytest.raises(streamed.InlineVpkStreamError, match="restricted"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "blocked.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={logical_path: declared},
        )


def test_main_map_namespace_cannot_be_supplied_as_bytes(tmp_path: Path) -> None:
    with pytest.raises(streamed.InlineVpkStreamError, match="VerifiedFileSource"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "blocked.vpk",
            byte_entries={"maps/de_test.vpk": b"large-in-memory-map"},
        )


def test_normalized_and_casefolded_path_collisions_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(streamed.InlineVpkStreamError, match="collision"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "blocked-bytes.vpk",
            byte_entries={
                "materials/example.txt": b"first",
                "materials\\example.txt": b"second",
            },
        )

    source = tmp_path / "source.vpk"
    declared = _verified_source(source, b"source")
    with pytest.raises(streamed.InlineVpkStreamError, match="collision"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "blocked-files.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={
                "maps/de_test.vpk": declared,
                "maps\\DE_TEST.vpk": declared,
            },
        )


@pytest.mark.parametrize(
    ("declared_factory", "message"),
    (
        (
            lambda path, body: streamed.VerifiedFileSource(
                path=path, size=len(body) + 1, sha256=hashlib.sha256(body).hexdigest()
            ),
            "size changed",
        ),
        (
            lambda path, body: streamed.VerifiedFileSource(
                path=path, size=len(body), sha256="0" * 64
            ),
            "SHA-256 changed",
        ),
        (
            lambda path, body: streamed.VerifiedFileSource(
                path=path, size=True, sha256=hashlib.sha256(body).hexdigest()
            ),
            "invalid byte size",
        ),
        (
            lambda path, body: streamed.VerifiedFileSource(
                path=path, size=len(body), sha256="not-a-hash"
            ),
            "invalid SHA-256",
        ),
    ),
)
def test_declared_file_identity_is_strict(
    tmp_path: Path,
    declared_factory,
    message: str,
) -> None:
    body = b"pinned-source"
    source = tmp_path / "source.vpk"
    source.write_bytes(body)
    declared = declared_factory(source, body)
    output = tmp_path / "blocked.vpk"

    with pytest.raises(streamed.InlineVpkStreamError, match=message):
        streamed.write_inline_vpk_file(
            output_path=output,
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": declared},
        )
    assert not output.exists()


def test_missing_non_vpk_and_wrong_typed_file_sources_are_rejected(tmp_path: Path) -> None:
    missing = streamed.VerifiedFileSource(
        path=tmp_path / "missing.vpk",
        size=0,
        sha256=hashlib.sha256(b"").hexdigest(),
    )
    with pytest.raises(streamed.InlineVpkStreamError, match="does not exist"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "missing-output.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": missing},
        )

    wrong_suffix = tmp_path / "source.bin"
    wrong = _verified_source(wrong_suffix, b"source")
    with pytest.raises(streamed.InlineVpkStreamError, match=".vpk extension"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "suffix-output.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": wrong},
        )

    with pytest.raises(streamed.InlineVpkStreamError, match="VerifiedFileSource"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "typed-output.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": object()},  # type: ignore[dict-item]
        )


def test_output_cannot_overwrite_file_source(tmp_path: Path) -> None:
    source = tmp_path / "same.vpk"
    declared = _verified_source(source, b"source")
    with pytest.raises(streamed.InlineVpkStreamError, match="overwrite"):
        streamed.write_inline_vpk_file(
            output_path=source,
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": declared},
        )
    assert source.read_bytes() == b"source"


def test_output_validation_failure_preserves_existing_file_and_cleans_temp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_entries, file_entries, _nested, _body = _fixture_entries(tmp_path)
    output = tmp_path / "atomic.vpk"
    output.write_bytes(b"previous-good-output")

    def fail_verification(*_args, **_kwargs):
        raise streamed.InlineVpkStreamError("injected output verification failure")

    monkeypatch.setattr(streamed, "_verify_output", fail_verification)
    with pytest.raises(streamed.InlineVpkStreamError, match="injected"):
        streamed.write_inline_vpk_file(
            output_path=output,
            byte_entries=byte_entries,
            file_entries=file_entries,
        )
    assert output.read_bytes() == b"previous-good-output"
    assert not list(tmp_path.glob(".atomic.vpk.tmp-*"))


def test_source_change_before_copy_preserves_existing_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_entries, file_entries, nested, _body = _fixture_entries(tmp_path)
    output = tmp_path / "atomic.vpk"
    output.write_bytes(b"previous-good-output")
    real_resolve_output = streamed._resolve_output_path

    def mutate_after_preflight(*args, **kwargs):
        resolved = real_resolve_output(*args, **kwargs)
        with nested.open("ab") as target:
            target.write(b"changed")
        return resolved

    monkeypatch.setattr(streamed, "_resolve_output_path", mutate_after_preflight)
    with pytest.raises(streamed.InlineVpkStreamError, match="changed during copy"):
        streamed.write_inline_vpk_file(
            output_path=output,
            byte_entries=byte_entries,
            file_entries=file_entries,
        )
    assert output.read_bytes() == b"previous-good-output"
    assert not list(tmp_path.glob(".atomic.vpk.tmp-*"))


def test_source_change_after_copy_before_commit_is_detected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_entries, file_entries, nested, _body = _fixture_entries(tmp_path)
    output = tmp_path / "atomic.vpk"
    output.write_bytes(b"previous-good-output")
    real_verify = streamed._verify_output

    def mutate_after_output_verification(*args, **kwargs):
        result = real_verify(*args, **kwargs)
        with nested.open("ab") as target:
            target.write(b"changed-after-copy")
        return result

    monkeypatch.setattr(streamed, "_verify_output", mutate_after_output_verification)
    with pytest.raises(streamed.InlineVpkStreamError, match="changed before commit"):
        streamed.write_inline_vpk_file(
            output_path=output,
            byte_entries=byte_entries,
            file_entries=file_entries,
        )
    assert output.read_bytes() == b"previous-good-output"
    assert not list(tmp_path.glob(".atomic.vpk.tmp-*"))


def test_success_atomically_replaces_existing_output(tmp_path: Path) -> None:
    byte_entries, file_entries, _nested, nested_body = _fixture_entries(tmp_path)
    output = tmp_path / "atomic.vpk"
    output.write_bytes(b"previous-good-output")

    result = streamed.write_inline_vpk_file(
        output_path=output,
        byte_entries=byte_entries,
        file_entries=file_entries,
    )

    assert result.metadata["output"]["replaced_existing"] is True
    assert read_inline_vpk(output.read_bytes())["maps/de_test.vpk"] == nested_body
    assert not list(tmp_path.glob(".atomic.vpk.tmp-*"))


def test_empty_inputs_invalid_output_and_non_mapping_file_entries_fail_closed(
    tmp_path: Path,
) -> None:
    with pytest.raises(streamed.InlineVpkStreamError, match="at least one"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "empty.vpk",
            byte_entries={},
        )
    with pytest.raises(streamed.InlineVpkStreamError, match=".vpk file"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "wrong.bin",
            byte_entries={"panorama/base.txt": b"base"},
        )
    with pytest.raises(streamed.InlineVpkStreamError, match="file_entries must be a mapping"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "typed.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries=[],  # type: ignore[arg-type]
        )


@pytest.mark.skipif(os.name == "nt" and not hasattr(os, "symlink"), reason="no symlink API")
def test_symlink_file_source_is_rejected_when_supported(tmp_path: Path) -> None:
    target = tmp_path / "target.vpk"
    target.write_bytes(b"target")
    link = tmp_path / "link.vpk"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    declared = streamed.VerifiedFileSource(
        path=link,
        size=target.stat().st_size,
        sha256=hashlib.sha256(b"target").hexdigest(),
    )
    with pytest.raises(streamed.InlineVpkStreamError, match="symlink"):
        streamed.write_inline_vpk_file(
            output_path=tmp_path / "blocked.vpk",
            byte_entries={"panorama/base.txt": b"base"},
            file_entries={"maps/de_test.vpk": declared},
        )
