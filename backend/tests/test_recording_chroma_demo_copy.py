import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import obs_director


def test_recording_chroma_uses_shared_disposable_demo_pipeline(
    monkeypatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.dem"
    destination = tmp_path / "recording.dem"
    source.write_bytes(b"original")
    calls = []
    expected = SimpleNamespace(map_name="de_cache")

    def fake_prepare(source_path, destination_path, **kwargs):
        calls.append((Path(source_path), Path(destination_path), kwargs))
        Path(destination_path).write_bytes(b"chroma-ready")
        return expected

    monkeypatch.setattr(obs_director, "prepare_chroma_demo_copy", fake_prepare)
    def repair(path):
        assert path == destination and path.read_bytes() == b"chroma-ready"
        path.write_bytes(b"baseline-ready")
    monkeypatch.setattr(obs_director, "repair_recording_baseline", repair)

    result = obs_director._prepare_recording_playback_demo_copy(
        source,
        destination,
        chroma_demo_map_name="de_cache",
    )

    assert result is expected
    assert calls == [(source, destination, {"map_name": "de_cache"})]
    assert source.read_bytes() == b"original"
    assert destination.read_bytes() == b"baseline-ready"


def test_recording_non_chroma_repairs_only_copy(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.dem"
    destination = tmp_path / "recording.dem"
    source.write_bytes(b"original")
    def repair(path):
        assert path == destination and path.read_bytes() == b"original"
        path.write_bytes(b"baseline-ready")
    monkeypatch.setattr(obs_director, "repair_recording_baseline", repair)

    result = obs_director._prepare_recording_playback_demo_copy(source, destination)

    assert result is None
    assert source.read_bytes() == b"original"
    assert destination.read_bytes() == b"baseline-ready"


def test_recording_baseline_failure_removes_unusable_copy(tmp_path, monkeypatch):
    import pytest
    source, destination = tmp_path / "original.dem", tmp_path / "recording.dem"
    source.write_bytes(b"original")
    def fail(path):
        raise ValueError("baseline mismatch")
    monkeypatch.setattr(obs_director, "repair_recording_baseline", fail)
    with pytest.raises(ValueError, match="baseline mismatch"):
        obs_director._prepare_recording_playback_demo_copy(source, destination)
    assert source.read_bytes() == b"original"
    assert not destination.exists()
    with pytest.raises(ValueError, match="must differ"):
        obs_director._prepare_recording_playback_demo_copy(source, source)
    assert source.read_bytes() == b"original"
