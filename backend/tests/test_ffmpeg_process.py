"""FFmpeg subprocess output decoding and diagnostic helpers."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.ffmpeg_process import decode_process_output, decoded_completed_process


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
