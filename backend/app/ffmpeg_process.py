"""Shared subprocess helpers for FFmpeg/FFprobe on Windows.

FFmpeg itself and GPU vendor runtimes do not always use the same encoding for
diagnostic output.  In particular, AMF can emit Windows-1252 bytes while the
Chinese Windows Python locale expects GBK.  Capturing pipes in ``text=True``
mode therefore risks losing the actual encoder error in a background reader
thread.  Always capture bytes and decode them here instead.
"""

from __future__ import annotations

import locale
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any


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
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Run a process with byte pipes and return safely decoded text output."""
    raw = subprocess.run(
        list(command),
        capture_output=True,
        text=False,
        timeout=timeout,
        check=False,
        **kwargs,
    )
    return decoded_completed_process(raw, args=command)


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
