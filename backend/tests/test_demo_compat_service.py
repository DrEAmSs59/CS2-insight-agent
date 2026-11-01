import sys
from dataclasses import replace

import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_compat_service as service
from app.demo_playback_compat import PATCH_ID, PATCH_REVISION, PlaybackDemoReport
from app.demo_terminal_phase import TerminalPhaseResult


@pytest.fixture(autouse=True)
def stub_entity_parser(monkeypatch):
    # Synthetic packet fixtures do not contain real entity serializers.
    monkeypatch.setattr(service, "repair_terminal_phase_in_place", lambda _path: TerminalPhaseResult(0, None, None))


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


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _frame(command: int, tick: int, payload: bytes, *, declared_size=None) -> bytes:
    size = len(payload) if declared_size is None else declared_size
    return _varint(command) + _varint(tick) + _varint(size) + payload


def test_ensure_demo_compatible_persists_and_reuses_fingerprint(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"demo-bytes")
    cache = tmp_path / "compat-cache.json"
    calls: list[Path] = []

    def fake_repair(path, **_kwargs):
        calls.append(Path(path))
        return _clean_report()

    monkeypatch.setattr(service, "_cache_path", lambda: cache)
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    first = service.ensure_demo_compatible(source)
    second = service.ensure_demo_compatible(source)

    assert first.cached is False
    assert second.cached is True
    assert len(calls) == 1
    assert calls[0] != source.resolve()
    assert source.read_bytes() == b"demo-bytes"
    assert cache.is_file()


def test_ensure_demo_compatible_invalidates_when_file_changes(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"first")
    calls = 0

    def fake_repair(_path, **_kwargs):
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


def test_terminal_recovery_is_default_but_can_be_strict(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"demo-bytes")
    ensure_options: list[bool] = []

    def fake_repair(_path, *, allow_truncated_packet_tail=False):
        ensure_options.append(allow_truncated_packet_tail)
        return _clean_report()

    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "cache.json")
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    service.ensure_demo_compatible(source)

    source.write_bytes(b"changed-demo-bytes")
    service.ensure_demo_compatible(source, allow_truncated_packet_tail=False)

    assert ensure_options == [True, False]


def test_recovered_terminal_tail_is_cached_after_atomic_finalization(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "unfinalized.dem"
    recovery_message = b"\x12\x05spawn"
    recovery_handle = b"\x0a\x04\x08\x01\x10\x01"
    source_bytes = (
        b"PBDEMS2\x00"
        + b"\x00" * 8
        + _frame(1, (1 << 32) - 1, b"header")
        + _frame(18, (1 << 32) - 1, recovery_message)
        + _frame(18, (1 << 32) - 1, recovery_handle)
        + _frame(7, 42, b"")
        + _frame(7, 43, b"partial", declared_size=12)
    )
    source.write_bytes(source_bytes)
    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "cache.json")

    first = service.ensure_demo_compatible(
        source,
        allow_truncated_packet_tail=True,
    )
    second = service.ensure_demo_compatible(source)

    assert first.cached is False
    assert first.report.outcome == "repaired"
    assert first.report.recovered_unfinalized_demo is True
    assert second.cached is True
    assert second.report == first.report
    assert source.read_bytes() != source_bytes


def test_compatible_baseline_repairs_once_and_never_mutates_original(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "library" / "match.dem"
    source.parent.mkdir()
    source_bytes = b"ORIGINAL-DEMO"
    source.write_bytes(source_bytes)
    cache_dir = tmp_path / "cache"
    calls: list[Path] = []

    def fake_repair(path, **_kwargs):
        candidate = Path(path)
        calls.append(candidate)
        candidate.write_bytes(candidate.read_bytes() + b"-COMPAT")
        return replace(_clean_report(), outcome="repaired")

    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "compat-cache.json")
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    first = service.ensure_compatible_baseline(source, cache_dir)
    second = service.ensure_compatible_baseline(source, cache_dir)

    assert first == second
    assert first.parent == cache_dir.resolve()
    assert first.read_bytes() == source_bytes + b"-COMPAT"
    assert source.read_bytes() == source_bytes
    assert len(calls) == 1
    assert first.with_suffix(".json").is_file()


def test_compatible_baseline_invalidates_when_original_changes(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"FIRST")
    cache_dir = tmp_path / "cache"
    calls = 0

    def fake_repair(path, **_kwargs):
        nonlocal calls
        calls += 1
        candidate = Path(path)
        candidate.write_bytes(candidate.read_bytes() + b"-COMPAT")
        return replace(_clean_report(), outcome="repaired")

    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "compat-cache.json")
    monkeypatch.setattr(service, "repair_demo_in_place", fake_repair)

    first = service.ensure_compatible_baseline(source, cache_dir)
    source.write_bytes(b"SECOND-VERSION")
    second = service.ensure_compatible_baseline(source, cache_dir)

    assert first != second
    assert first.read_bytes() == b"FIRST-COMPAT"
    assert second.read_bytes() == b"SECOND-VERSION-COMPAT"
    assert calls == 2


def test_compatible_baseline_failure_publishes_nothing(monkeypatch, tmp_path: Path):
    source = tmp_path / "match.dem"
    source_bytes = b"ORIGINAL"
    source.write_bytes(source_bytes)
    cache_dir = tmp_path / "cache"

    def broken_repair(_path, **_kwargs):
        raise RuntimeError("repair failed")

    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "compat-cache.json")
    monkeypatch.setattr(service, "repair_demo_in_place", broken_repair)

    try:
        service.ensure_compatible_baseline(source, cache_dir)
    except RuntimeError as exc:
        assert str(exc) == "repair failed"
    else:
        raise AssertionError("baseline construction must fail closed")

    assert source.read_bytes() == source_bytes
    assert not list(cache_dir.glob(".skin-compat-v*.dem"))
    assert not list(cache_dir.glob(".skin-compat-build-*.dem"))


def test_phase_failure_rolls_back_event_patch_and_is_not_cached(monkeypatch, tmp_path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"ORIGINAL")
    cache = tmp_path / "compat-cache.json"
    monkeypatch.setattr(service, "_cache_path", lambda: cache)

    def patch_events(path, **_options):
        path.write_bytes(b"EVENTS-REMOVED")
        return replace(_clean_report(), outcome="repaired", removed_win_panel_events=1)

    def reject_phase(_path):
        raise ValueError("unsupported serializer")

    monkeypatch.setattr(service, "repair_demo_in_place", patch_events)
    monkeypatch.setattr(service, "repair_terminal_phase_in_place", reject_phase)
    with pytest.raises(ValueError, match="unsupported serializer"):
        service.ensure_demo_compatible(source)
    assert source.read_bytes() == b"ORIGINAL"
    assert not cache.exists()
    assert list(tmp_path.iterdir()) == [source]


def test_phase_only_repair_is_persisted_and_cached(monkeypatch, tmp_path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"EVENT-ALREADY-REMOVED")
    cache = tmp_path / "compat-cache.json"
    monkeypatch.setattr(service, "_cache_path", lambda: cache)
    monkeypatch.setattr(service, "repair_demo_in_place", lambda *_args, **_kwargs: _clean_report())
    calls = []

    def patch_phase(path):
        calls.append(path)
        path.write_bytes(b"PHASE-REPAIRED")
        return TerminalPhaseResult(2, 141862, 142081)

    monkeypatch.setattr(service, "repair_terminal_phase_in_place", patch_phase)
    first = service.ensure_demo_compatible(source)
    second = service.ensure_demo_compatible(source)
    assert source.read_bytes() == b"PHASE-REPAIRED"
    assert first.report.outcome == "repaired"
    assert first.report.terminal_phase_checked
    assert first.report.rewritten_terminal_phase_fields == 2
    assert (first.report.first_tick, first.report.last_tick) == (141862, 142081)
    assert second.cached and second.report == first.report
    assert len(calls) == 1


def test_legacy_cache_and_baseline_revision_are_invalidated(monkeypatch, tmp_path):
    import json
    from dataclasses import asdict

    source = tmp_path / "match.dem"
    source.write_bytes(b"OLD-COMPATIBLE-DEMO")
    cache = tmp_path / "compat-cache.json"
    monkeypatch.setattr(service, "_cache_path", lambda: cache)
    fingerprint = service._fingerprint(source)
    cache.write_text(json.dumps({"schema": 1, "records": {service._path_key(source): {
        "patch_revision": PATCH_REVISION - 1, "fingerprint": fingerprint,
        "report": asdict(_clean_report()),
    }}}), encoding="utf-8")
    calls = []
    monkeypatch.setattr(service, "repair_demo_in_place", lambda *_a, **_k: calls.append(1) or _clean_report())
    result = service.ensure_demo_compatible(source)
    assert not result.cached and result.report.terminal_phase_checked
    assert calls == [1]

    new_path, _, _ = service._baseline_paths(source, tmp_path, fingerprint, allow_truncated_packet_tail=True)
    monkeypatch.setattr(service, "PATCH_REVISION", PATCH_REVISION - 1)
    old_path, _, _ = service._baseline_paths(source, tmp_path, fingerprint, allow_truncated_packet_tail=True)
    assert old_path != new_path


def test_same_revision_without_entity_audit_cannot_be_cached(tmp_path):
    from dataclasses import asdict
    cache = {"records": {"key": {"patch_revision": PATCH_REVISION,
        "fingerprint": {}, "report": asdict(_clean_report())}}}
    assert service._cached_result(cache, "key", {}) is None
