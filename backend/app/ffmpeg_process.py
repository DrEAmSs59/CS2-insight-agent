"""Shared subprocess helpers for FFmpeg/FFprobe on Windows.

FFmpeg itself and GPU vendor runtimes do not always use the same encoding for
diagnostic output.  In particular, AMF can emit Windows-1252 bytes while the
Chinese Windows Python locale expects GBK.  Capturing pipes in ``text=True``
mode therefore risks losing the actual encoder error in a background reader
thread.  Always capture bytes and decode them here instead.
"""

from __future__ import annotations

import locale
import logging
import os
import re
import subprocess
import threading
import time
from collections.abc import Sequence
from contextvars import copy_context
from pathlib import Path
from typing import Any

from .montage_exceptions import MontageComposerError
from .video_export_log import export_event
from .video_export_log import export_progress as log_video_export_progress


_MAX_CAPTURE_BYTES = 4 * 1024 * 1024
_FRAME_PROGRESS_RE = re.compile(rb"Frame:\s*(\d+)\s*/\s*(\d+)")
WINDOWS_COMMAND_LINE_SAFE_LIMIT = 28_000

logger = logging.getLogger(__name__)


def windows_command_line_length(command: Sequence[str]) -> int:
    """Return the CreateProcess command-line length in UTF-16 code units."""

    rendered = subprocess.list2cmdline([str(part) for part in command])
    # CreateProcessW measures the command line in UTF-16 code units. Include
    # the terminating NUL so the diagnostic can be compared with its limit.
    return len(rendered.encode("utf-16-le")) // 2 + 1


def ensure_windows_command_length(
    command: Sequence[str],
    *,
    safe_limit: int = WINDOWS_COMMAND_LINE_SAFE_LIMIT,
    is_windows: bool | None = None,
) -> int:
    """Reject commands that are too close to CreateProcessW's hard limit.

    The command is not modified. A conservative margin below Windows' 32,767
    UTF-16-unit ceiling turns WinError 206 into a stable, actionable export
    error before FFmpeg starts.
    """

    command_length = windows_command_line_length(command)
    if (os.name == "nt" if is_windows is None else bool(is_windows)) and command_length > int(safe_limit):
        logger.warning(
            "FFmpeg command rejected before launch: command_line_chars=%d safe_limit=%d args=%d",
            command_length,
            safe_limit,
            len(command),
        )
        export_event(
            "command_line_rejected",
            level=logging.ERROR,
            command_line_chars=command_length,
            safe_limit=int(safe_limit),
            argument_count=len(command),
        )
        raise MontageComposerError(
            "MONTAGE_COMMAND_LINE_TOO_LONG",
            command_line_chars=command_length,
            safe_limit=int(safe_limit),
        )
    return command_length


def decode_process_output(value: bytes | str | None) -> str:
    """Decode mixed FFmpeg/vendor output without ever raising UnicodeError."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if not value:
        return ""

    encodings: list[str] = ["utf-8-sig"]
    preferred = locale.getpreferredencoding(False)
    if preferred:
        encodings.append(preferred)
    # AMF runtime messages may contain single-byte trademark/copyright
    # characters even when the surrounding FFmpeg output is ASCII.
    encodings.append("cp1252")

    seen: set[str] = set()
    for encoding in encodings:
        normalized = encoding.casefold()
        if normalized in seen:
            continue
        seen.add(normalized)
        try:
            return value.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return value.decode("utf-8", errors="replace")


def decoded_completed_process(
    result: subprocess.CompletedProcess[Any],
    *,
    args: Sequence[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Return a text CompletedProcess from a byte-capturing subprocess call."""
    return subprocess.CompletedProcess(
        list(args) if args is not None else result.args,
        int(result.returncode),
        decode_process_output(result.stdout),
        decode_process_output(result.stderr),
    )


def run_process_capture(
    command: Sequence[str],
    *,
    timeout: float,
    stall_timeout: float | None = None,
    cancel_event: Any | None = None,
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Run a process with byte pipes and return safely decoded text output."""
    ensure_windows_command_length(command)
    if stall_timeout is not None or cancel_event is not None:
        return _run_process_capture_with_stall_detection(
            command,
            timeout=timeout,
            stall_timeout=stall_timeout,
            cancel_event=cancel_event,
            **kwargs,
        )
    raw = subprocess.run(
        list(command),
        capture_output=True,
        text=False,
        timeout=timeout,
        check=False,
        **kwargs,
    )
    return decoded_completed_process(raw, args=command)


def _run_process_capture_with_stall_detection(
    command: Sequence[str],
    *,
    timeout: float,
    stall_timeout: float | None,
    cancel_event: Any | None = None,
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Capture a long process while supporting cancellation and stall detection."""

    if cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
        raise InterruptedError("process cancelled")

    started = time.monotonic()
    process = subprocess.Popen(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        **kwargs,
    )
    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    progress = {"last_frame": -1, "last_at": started, "rolling": b""}

    def append_bounded(target: bytearray, chunk: bytes) -> None:
        target.extend(chunk)
        overflow = len(target) - _MAX_CAPTURE_BYTES
        if overflow > 0:
            del target[:overflow]

    def drain(stream: Any, target: bytearray, *, parse_progress: bool = False) -> None:
        try:
            read_chunk = getattr(stream, "read1", stream.read)
            while True:
                chunk = read_chunk(65536)
                if not chunk:
                    return
                append_bounded(target, chunk)
                if not parse_progress:
                    continue
                rolling = (progress["rolling"] + chunk)[-8192:]
                progress["rolling"] = rolling[-256:]
                matches = list(_FRAME_PROGRESS_RE.finditer(rolling))
                if not matches:
                    continue
                current = int(matches[-1].group(1))
                total = int(matches[-1].group(2))
                if current <= int(progress["last_frame"]):
                    continue
                progress["last_frame"] = current
                progress["last_at"] = time.monotonic()
                if total > 0:
                    log_video_export_progress(
                        current / total,
                        "framemeld",
                        {
                            "stage_progress": current / total,
                            "processed_frames": current,
                            "total_frames": total,
                        },
                    )
        except (OSError, ValueError):
            return

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

    def finish(returncode: int) -> subprocess.CompletedProcess[str]:
        for reader in readers:
            reader.join(timeout=5.0)
        return subprocess.CompletedProcess(
            list(command),
            returncode,
            decode_process_output(bytes(stdout_buffer)),
            decode_process_output(bytes(stderr_buffer)),
        )

    hard_timeout = max(1.0, float(timeout))
    no_progress_timeout = (
        max(1.0, float(stall_timeout))
        if stall_timeout is not None
        else None
    )
    while True:
        if cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
            process.kill()
            process.wait(timeout=10)
            finish(int(process.returncode or -9))
            raise InterruptedError("process cancelled")
        returncode = process.poll()
        if returncode is not None:
            return finish(int(returncode))
        now = time.monotonic()
        hard_expired = now - started > hard_timeout
        stalled = (
            no_progress_timeout is not None
            and now - float(progress["last_at"]) > no_progress_timeout
        )
        if hard_expired or stalled:
            process.kill()
            process.wait(timeout=10)
            reason = (
                f"Process exceeded hard timeout of {hard_timeout:g} seconds"
                if hard_expired
                else (
                    f"Process made no frame progress for {float(no_progress_timeout or 0):g} seconds "
                    f"after frame {int(progress['last_frame'])}"
                )
            )
            append_bounded(stderr_buffer, ("\n" + reason).encode("utf-8"))
            completed = finish(124)
            raise subprocess.TimeoutExpired(
                list(command),
                hard_timeout if hard_expired else float(no_progress_timeout or 0),
                output=completed.stdout,
                stderr=completed.stderr,
            )
        time.sleep(0.25)


def command_for_log(command: Sequence[str]) -> str:
    """Render an argv list for support logs without invoking a shell."""
    return subprocess.list2cmdline([str(item) for item in command])


def process_error_tail(result: subprocess.CompletedProcess[str], limit: int = 1200) -> str:
    text = (result.stderr or result.stdout or "").strip()
    return text[-max(1, int(limit)) :]


def remove_partial_file(path: str | Path | None) -> None:
    if path is None:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass
