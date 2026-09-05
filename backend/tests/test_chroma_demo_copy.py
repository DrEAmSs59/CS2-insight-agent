import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import chroma_demo_copy as chroma_copy


def test_prepares_only_destination_with_validated_manifest_and_handle(
    monkeypatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.dem"
    destination = tmp_path / "playback.dem"
    source.write_bytes(b"original-demo")
    manifest_calls = []
    handle_calls = []

    def fake_prepare(source_path, destination_path, **kwargs):
        manifest_calls.append((Path(source_path), Path(destination_path), kwargs))
        Path(destination_path).write_bytes(b"manifest-migrated")
        return SimpleNamespace(rewritten_chroma_sky_references=2)

    def fake_rewrite(path, **kwargs):
        handle_calls.append((Path(path), kwargs))
        Path(path).write_bytes(b"ready")
        return SimpleNamespace(fields_rewritten=12, output_sha256="a" * 64)

    monkeypatch.setattr(chroma_copy, "prepare_cs2_playback_demo", fake_prepare)
    monkeypatch.setattr(
        chroma_copy,
        "rewrite_demo_sky_material_handle_in_place",
        fake_rewrite,
    )

    report = chroma_copy.prepare_chroma_demo_copy(
        source,
        destination,
        map_name="de_dust2",
    )

    assert source.read_bytes() == b"original-demo"
    assert destination.read_bytes() == b"ready"
    assert report.map_name == "de_dust2"
    assert manifest_calls[0][0:2] == (source, destination)
    assert manifest_calls[0][2]["drop_legacy_type138"] is False
    assert manifest_calls[0][2]["chroma_skybox_spawn_group_world_name"] == (
        "maps/prefabs/de_dust2/de_dust2_skybox"
    )
    assert manifest_calls[0][2]["chroma_skybox_spawn_group_manifests"] == (
        report.profile.spawn_group_manifests
    )
    assert handle_calls == [
        (
            destination,
            {
                "expected_map": "de_dust2",
                "target_handle": 14038941216328320667,
                "expected_active_cubemap_fog_entities": 1,
                "disable_active_gradient_fog": False,
                "suppressed_func_brush_model_handles": (
                    14229486482546056262,
                ),
            },
        )
    ]


def test_removes_half_prepared_destination_when_handle_rewrite_fails(
    monkeypatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.dem"
    destination = tmp_path / "playback.dem"
    source.write_bytes(b"original-demo")

    def fake_prepare(_source, output, **_kwargs):
        Path(output).write_bytes(b"manifest-migrated")
        return SimpleNamespace(rewritten_chroma_sky_references=2)

    monkeypatch.setattr(chroma_copy, "prepare_cs2_playback_demo", fake_prepare)
    monkeypatch.setattr(
        chroma_copy,
        "rewrite_demo_sky_material_handle_in_place",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("bad handle")),
    )

    with pytest.raises(RuntimeError, match="bad handle"):
        chroma_copy.prepare_chroma_demo_copy(
            source,
            destination,
            map_name="de_ancient",
        )

    assert source.read_bytes() == b"original-demo"
    assert not destination.exists()


def test_rejects_unknown_map_without_creating_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.dem"
    destination = tmp_path / "playback.dem"
    source.write_bytes(b"original-demo")

    with pytest.raises(chroma_copy.ChromaDemoCopyError, match="no validated"):
        chroma_copy.prepare_chroma_demo_copy(
            source,
            destination,
            map_name="de_not_a_real_map",
        )

    assert not destination.exists()
