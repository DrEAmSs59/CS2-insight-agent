import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import video_composer as composer


def test_probe_budget_scales_with_size_and_stays_bounded(monkeypatch):
    path = Path('large.mp4')
    for size in [0, 1024**3, 20 * 1024**3, 1024**4]:
        monkeypatch.setattr(Path, 'stat', lambda self: SimpleNamespace(st_size=size))
        assert composer._probe_timeout_seconds(path) == min(21600, (120 + size/(5*1024**2))*1.3)
    monkeypatch.setattr(Path, 'stat', lambda self: (_ for _ in ()).throw(FileNotFoundError()))
    assert composer._probe_timeout_seconds(path) == composer._probe_timeout_seconds(None) == 156


def test_long_probe_uses_file_budget_and_propagates_cancellation(monkeypatch):
    monkeypatch.setattr(Path, 'stat', lambda self: SimpleNamespace(st_size=10*1024**3))
    cancelled = threading.Event()
    token = composer._MONTAGE_CANCEL_EVENT.set(cancelled)
    calls = []
    def probe(cmd, *, timeout, cancel_event):
        calls.append(timeout)
        assert timeout > 600  # A ten-minute scan must not inherit the old 120s deadline.
        assert cancel_event is cancelled
        if len(calls) > 1:
            raise InterruptedError('cancelled while probing')
        return subprocess.CompletedProcess(cmd, 0, stdout='{"streams":[]}', stderr='')
    monkeypatch.setattr(composer, 'run_process_capture', probe)
    try:
        assert composer.ffprobe_streams(Path('large.mp4'), Path('ffprobe.exe')) == {'streams':[]}
        with pytest.raises(composer.MontageComposerError) as error:
            composer.ffprobe_streams(Path('large.mp4'), Path('ffprobe.exe'))
        assert error.value.code == 'MONTAGE_EXPORT_CANCELLED'
    finally:
        composer._MONTAGE_CANCEL_EVENT.reset(token)


def test_probe_timeout_still_reports_the_failed_stage(monkeypatch):
    def timeout(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
    monkeypatch.setattr(composer, 'run_process_capture', timeout)
    with pytest.raises(composer.MontageComposerError) as error:
        composer.ffprobe_streams(Path('missing.mp4'), Path('ffprobe.exe'), probe_stage='output', file_role='final')
    assert error.value.code == 'MONTAGE_FFPROBE_FAILED'
