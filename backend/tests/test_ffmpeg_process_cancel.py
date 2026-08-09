from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.ffmpeg_process import run_process_capture


def test_run_process_capture_terminates_cancelled_process() -> None:
    cancel_event = threading.Event()
    timer = threading.Timer(0.2, cancel_event.set)
    started = time.monotonic()
    timer.start()
    try:
        with pytest.raises(InterruptedError, match="cancelled"):
            run_process_capture(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                timeout=60,
                cancel_event=cancel_event,
            )
    finally:
        timer.cancel()

    assert time.monotonic() - started < 5
