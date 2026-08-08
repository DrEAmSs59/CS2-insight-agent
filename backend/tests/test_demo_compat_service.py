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
    assert calls == [source.resolve()]
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


def test_terminal_tail_tolerance_is_default_but_can_be_strict(monkeypatch, tmp_path: Path):
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


def test_tolerated_terminal_tail_is_cached_without_changing_uploaded_bytes(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "unfinalized.dem"
    source_bytes = (
        b"PBDEMS2\x00"
        + b"\x00" * 8
        + _frame(1, 0, b"header")
        + _frame(7, 43, b"partial", declared_size=12)
    )
    source.write_bytes(source_bytes)
    original_stat = source.stat()
    monkeypatch.setattr(service, "_cache_path", lambda: tmp_path / "cache.json")

    first = service.ensure_demo_compatible(
        source,
        allow_truncated_packet_tail=True,
    )
    second = service.ensure_demo_compatible(source)

    assert first.cached is False
    assert first.report.outcome == "tolerated"
    assert first.report.tolerated_truncated_packet_tail is True
    assert second.cached is True
    assert second.report == first.report
    assert source.read_bytes() == source_bytes
    assert source.stat().st_mtime_ns == original_stat.st_mtime_ns
