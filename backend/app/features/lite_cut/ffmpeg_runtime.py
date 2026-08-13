"""Cancelable FFmpeg process and progress helpers for LiteCut exports."""

from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from contextvars import copy_context
from typing import Any, Callable

from ...ffmpeg_process import command_for_log, decode_process_output, ensure_windows_command_length
from ...video_export_log import export_event, export_progress as log_video_export_progress
from ...video_composer import MontageComposerError

logger = logging.getLogger(__name__)

ProgressCallback = Callable[..., None]
_MAX_CAPTURE_BYTES = 4 * 1024 * 1024
_VSPIPE_PROGRESS_RE = re.compile(rb"Frame:\s*(\d+)\s*/\s*(\d+)")


def emit_progress(
    callback: ProgressCallback | None,
    progress: float,
    stage: str,
    detail: dict[str, Any] | None = None,
) -> None:
    log_video_export_progress(progress, stage, detail)
    if not callback:
        return
    try:
        safe_progress = max(0.0, min(1.0, float(progress)))
        if detail is None:
            callback(safe_progress, stage)
        else:
            try:
                callback(safe_progress, stage, detail)
            except TypeError:
                # Preserve compatibility with older two-argument callbacks.
                callback(safe_progress, stage)
    except Exception:
        logger.debug("lite_cut export progress callback failed", exc_info=True)


def cancel_requested(cancel_event: Any | None) -> bool:
    return bool(cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)())


def raise_if_cancelled(cancel_event: Any | None) -> None:
    if cancel_requested(cancel_event):
        raise MontageComposerError("MONTAGE_EXPORT_CANCELLED")


def _append_bounded(target: bytearray, chunk: bytes) -> None:
    target.extend(chunk)
    overflow = len(target) - _MAX_CAPTURE_BYTES
    if overflow > 0:
        del target[:overflow]


def run_ffmpeg_process(
    cmd: list[str],
    *,
    timeout: float = 3600,
    stall_timeout: float | None = None,
    cancel_event: Any | None = None,
    progress_callback: ProgressCallback | None = None,
    progress_start: float = 0.0,
    progress_end: float = 1.0,
    progress_stage: str = "encoding",
) -> subprocess.CompletedProcess:
    """Run a cancelable process while continuously draining both output pipes.

    Blur's VSPipe child writes carriage-return progress updates to stderr. If
    stderr is captured but not read until process exit, the Windows pipe fills
    and blocks the entire render. Reader threads prevent that deadlock and also
    translate ``Frame: current/total`` updates into the export progress range.
    """

    ensure_windows_command_length(cmd)
    started = time.monotonic()
    export_event(
        "stage_started",
        stage=progress_stage,
        hard_timeout_seconds=timeout,
        stall_timeout_seconds=stall_timeout,
    )
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False)
    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    progress_state = {"last_frame": -1, "last_progress_at": started, "rolling": b""}

    def drain(stream: Any, target: bytearray, *, parse_progress: bool = False) -> None:
        try:
            read_chunk = getattr(stream, "read1", stream.read)
            while True:
                # ``read1`` returns currently available pipe data instead of
                # waiting to fill the entire request, so UI progress remains
                # responsive even when updates are small.
                chunk = read_chunk(65536)
                if not chunk:
                    return
                _append_bounded(target, chunk)
                if not parse_progress:
                    continue
                rolling = (progress_state["rolling"] + chunk)[-8192:]
                progress_state["rolling"] = rolling[-256:]
                matches = list(_VSPIPE_PROGRESS_RE.finditer(rolling))
                if not matches:
                    continue
                current = int(matches[-1].group(1))
                total = int(matches[-1].group(2))
                if total <= 0 or current <= progress_state["last_frame"]:
                    continue
                progress_state["last_frame"] = current
                progress_state["last_progress_at"] = time.monotonic()
                stage_progress = max(0.0, min(1.0, current / total))
                mapped = progress_start + (progress_end - progress_start) * stage_progress
                emit_progress(
                    progress_callback,
                    mapped,
                    progress_stage,
                    {
                        "stage_progress": stage_progress,
                        "processed_frames": current,
                        "total_frames": total,
                    },
                )
        except (OSError, ValueError):
            logger.debug("LiteCut process output reader stopped", exc_info=True)

    assert process.stdout is not None and process.stderr is not None
    stdout_context = copy_context()
    stderr_context = copy_context()
    readers = [
        threading.Thread(
            target=stdout_context.run,
            args=(drain, process.stdout, stdout_buffer),
            daemon=True,
        ),
        threading.Thread(
            target=stderr_context.run,
            args=(drain, process.stderr, stderr_buffer),
            kwargs={"parse_progress": True},
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()

    def completed(returncode: int) -> subprocess.CompletedProcess:
        for reader in readers:
            reader.join(timeout=5.0)
        return subprocess.CompletedProcess(
            cmd,
            returncode,
            decode_process_output(bytes(stdout_buffer)),
            decode_process_output(bytes(stderr_buffer)),
        )

    while True:
        if cancel_requested(cancel_event):
            process.kill()
            process.wait(timeout=10)
            for reader in readers:
                reader.join(timeout=2.0)
            export_event(
                "stage_cancelled",
                level=logging.WARNING,
                stage=progress_stage,
                elapsed_ms=round((time.monotonic() - started) * 1000),
            )
            raise MontageComposerError("MONTAGE_EXPORT_CANCELLED")
        if process.poll() is not None:
            result = completed(int(process.returncode or 0))
            export_event(
                "stage_completed" if result.returncode == 0 else "stage_failed",
                level=logging.INFO if result.returncode == 0 else logging.ERROR,
                stage=progress_stage,
                returncode=result.returncode,
                elapsed_ms=round((time.monotonic() - started) * 1000),
                detail=(result.stderr or result.stdout or "").strip()[-2400:] if result.returncode else "",
            )
            if result.returncode != 0:
                logger.error(
                    "LiteCut FFmpeg failed returncode=%d command=%s stderr=%s",
                    result.returncode,
                    command_for_log(cmd),
                    (result.stderr or result.stdout or "").strip()[-1200:],
                )
            return result
        now = time.monotonic()
        hard_expired = now - started > timeout
        stalled = (
            stall_timeout is not None
            and now - float(progress_state["last_progress_at"]) > float(stall_timeout)
        )
        if hard_expired or stalled:
            process.kill()
            process.wait(timeout=10)
            reason = (
                f"hard timeout after {timeout:g} seconds"
                if hard_expired
                else (
                    f"no frame progress for {float(stall_timeout or 0):g} seconds "
                    f"after frame {int(progress_state['last_frame'])}"
                )
            )
            _append_bounded(stderr_buffer, ("\nFrameMeld " + reason).encode("utf-8"))
            export_event(
                "stage_failed",
                level=logging.ERROR,
                stage=progress_stage,
                returncode=124,
                elapsed_ms=round((time.monotonic() - started) * 1000),
                detail=reason,
            )
            logger.error("LiteCut FFmpeg timed out reason=%s command=%s", reason, command_for_log(cmd))
            return completed(124)
        time.sleep(0.25)
