"""Cancelable FFmpeg process and progress helpers for LiteCut exports."""

from __future__ import annotations

import logging
import subprocess
import time
from typing import Any, Callable

from ..video_composer import MontageComposerError

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[float, str], None]


def emit_progress(callback: ProgressCallback | None, progress: float, stage: str) -> None:
    if not callback:
        return
    try:
        callback(max(0.0, min(1.0, float(progress))), stage)
    except Exception:
        logger.debug("lite_cut export progress callback failed", exc_info=True)


def cancel_requested(cancel_event: Any | None) -> bool:
    return bool(cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)())


def raise_if_cancelled(cancel_event: Any | None) -> None:
    if cancel_requested(cancel_event):
        raise MontageComposerError("MONTAGE_EXPORT_CANCELLED")


def run_ffmpeg_process(cmd: list[str], *, timeout: float = 3600, cancel_event: Any | None = None) -> subprocess.CompletedProcess:
    started = time.monotonic()
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    while True:
        if cancel_requested(cancel_event):
            process.kill()
            process.communicate()
            raise MontageComposerError("MONTAGE_EXPORT_CANCELLED")
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
        if time.monotonic() - started > timeout:
            process.kill()
            stdout, stderr = process.communicate()
            return subprocess.CompletedProcess(cmd, 124, stdout, stderr)
        time.sleep(0.25)
