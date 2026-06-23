"""Regression coverage for event-clip pre-roll accounting."""

from app.recording.executor.recording_executor import _resolve_prepare_timing


def test_prepare_timing_counts_post_spec_console_work_before_recording_start():
    # 3.5 s spectate/verification plus 1.2 s command injection must leave only
    # 0.3 s of a five-second prepare window, rather than the old 1.5 s.
    overhead, remaining, resync = _resolve_prepare_timing(5.0, 4.7)

    assert overhead == 0.0
    assert round(remaining, 3) == 0.3
    assert resync is False


def test_prepare_timing_resyncs_when_all_prepare_work_passes_start_tick():
    overhead, remaining, resync = _resolve_prepare_timing(5.0, 5.3)

    assert round(overhead, 3) == 0.3
    assert remaining == 0.0
    assert resync is True
