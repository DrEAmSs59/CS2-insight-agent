import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_compat_service as service
from app.demo_playback_compat import PATCH_ID, PATCH_REVISION, PlaybackDemoReport


def _clean_report() -> PlaybackDemoReport:
    return PlaybackDemoReport(
        schema_version=1,
        outcome="clean",
        patch_id=PATCH_ID,
        patch_revision=PATCH_REVISION,
        removed_messages=0,
        changed_frames=0,
        first_tick=None,
        last_tick=None,
        max_per_frame=0,
        remaining_selected_messages=0,
    )


def test_ensure_demo_compatible_persists_and_reuses_fingerprint(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"demo-bytes")
    cache = tmp_path / "compat-cache.json"
    calls: list[Path] = []

    def fake_repair(path):
        calls.append(Path(path))
        return _clean_report()

    monkeypatch.setattr(service, "_cache_path", lambda: cache)
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    first = service.ensure_demo_compatible(source)
    second = service.ensure_demo_compatible(source)

    assert first.cached is False
    assert second.cached is True
    assert calls == [source.resolve()]
    assert cache.is_file()


def test_ensure_demo_compatible_invalidates_when_file_changes(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"first")
    calls = 0

    def fake_repair(_path):
        nonlocal calls
        calls += 1
        return _clean_report()

    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "cache.json")
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    service.ensure_demo_compatible(source)
    source.write_bytes(b"second-version")
    result = service.ensure_demo_compatible(source)

    assert result.cached is False
    assert calls == 2
