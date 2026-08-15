"""FFmpeg subprocess output decoding and diagnostic helpers."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import pytest

from app.ffmpeg_process import (
    decode_process_output,
    decoded_completed_process,
    ensure_windows_command_length,
    windows_command_line_length,
)
from app.montage_exceptions import MontageComposerError


def test_decode_process_output_accepts_utf8() -> None:
    assert decode_process_output("编码失败".encode("utf-8")) == "编码失败"


def test_decode_process_output_accepts_amf_windows_1252_byte() -> None:
    raw = b"AMD\xae AMF CreateComponent failed with error 10"
    decoded = decode_process_output(raw)
    assert "AMD® AMF" in decoded
    assert "CreateComponent failed with error 10" in decoded


def test_decoded_completed_process_never_uses_text_pipe_decoder() -> None:
    raw = subprocess.CompletedProcess(["ffmpeg"], 1, b"", b"AMF \xae failed")
    decoded = decoded_completed_process(raw)
    assert decoded.returncode == 1
    assert decoded.stdout == ""
    assert decoded.stderr == "AMF ® failed"


def test_windows_command_length_uses_list2cmdline_quoting() -> None:
    command = [r"C:\Program Files\ffmpeg.exe", "-i", r"C:\My Videos\clip.mp4"]
    rendered = subprocess.list2cmdline(command)
    assert windows_command_line_length(command) == len(rendered.encode("utf-16-le")) // 2 + 1


def test_oversized_windows_command_is_rejected_without_mutation() -> None:
    command = ["ffmpeg.exe", "-filter_complex", "x" * 500]
    original = list(command)
    with pytest.raises(MontageComposerError) as caught:
        ensure_windows_command_length(command, safe_limit=100, is_windows=True)
    assert caught.value.code == "MONTAGE_COMMAND_LINE_TOO_LONG"
    assert caught.value.params["command_line_chars"] > 100
    assert command == original


def test_non_windows_command_is_not_rejected() -> None:
    command = ["ffmpeg", "-filter_complex", "x" * 500]
    assert ensure_windows_command_length(command, safe_limit=100, is_windows=False) > 100
