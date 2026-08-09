"""Compact server-side waveform caches for LiteCut media."""

from __future__ import annotations

from array import array
import json
import logging
import os
from pathlib import Path
import subprocess
import threading
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_WAVEFORM_SAMPLE_RATE = 400
_WAVEFORM_CACHE_BUCKETS = 16384
_WAVEFORM_LOCKS = tuple(threading.Lock() for _ in range(64))


def waveform_cache_path(source: Path) -> Path:
    return source.with_name(f"{source.stem}.waveform-v1.json")


def _waveform_lock(path: Path) -> threading.Lock:
    return _WAVEFORM_LOCKS[hash(str(path.resolve()).casefold()) % len(_WAVEFORM_LOCKS)]


def waveform_command(*, ffmpeg_bin: Path, source: Path) -> list[str]:
    return [
        str(ffmpeg_bin),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(_WAVEFORM_SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
    ]


def _bucket_peaks(samples: array, bucket_count: int) -> list[float]:
    count = max(8, min(_WAVEFORM_CACHE_BUCKETS, int(bucket_count)))
    if not samples:
        return [0.0] * count
    peaks: list[float] = []
    for index in range(count):
        start = min(len(samples) - 1, int(index * len(samples) / count))
        end = min(len(samples), max(start + 1, int((index + 1) * len(samples) / count)))
        peak = 0.0
        for cursor in range(start, end):
            peak = max(peak, abs(float(samples[cursor])))
        peaks.append(round(peak, 6))
    return peaks


def _read_valid_cache(cache_path: Path, source: Path) -> dict[str, Any] | None:
    if not cache_path.is_file():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        stat = source.stat()
        if (
            int(payload.get("source_size") or -1) != int(stat.st_size)
            or int(payload.get("source_mtime_ns") or -1) != int(stat.st_mtime_ns)
            or not isinstance(payload.get("peaks"), list)
        ):
            return None
        return payload
    except (OSError, ValueError, TypeError):
        return None


def load_or_create_waveform_cache(
    source: Path,
    *,
    ffmpeg_bin: Path,
    duration_sec: float | None = None,
) -> tuple[dict[str, Any], bool]:
    source = source.resolve()
    cache_path = waveform_cache_path(source)
    with _waveform_lock(cache_path):
        cached = _read_valid_cache(cache_path, source)
        if cached is not None:
            return cached, True
        result = subprocess.run(
            waveform_command(ffmpeg_bin=ffmpeg_bin, source=source),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=3600,
        )
        if result.returncode != 0 or not result.stdout:
            tail = (result.stderr or b"").decode("utf-8", errors="replace").strip()[-500:]
            raise RuntimeError(tail or "素材没有可用于生成波形的音轨")
        usable_bytes = len(result.stdout) - (len(result.stdout) % 4)
        samples = array("f")
        samples.frombytes(result.stdout[:usable_bytes])
        if os.sys.byteorder != "little":
            samples.byteswap()
        measured_duration = len(samples) / _WAVEFORM_SAMPLE_RATE
        safe_duration = float(duration_sec or measured_duration or 0)
        stat = source.stat()
        payload = {
            "version": 1,
            "source_size": int(stat.st_size),
            "source_mtime_ns": int(stat.st_mtime_ns),
            "duration_sec": safe_duration,
            "peaks": _bucket_peaks(samples, _WAVEFORM_CACHE_BUCKETS),
        }
        temporary = cache_path.with_name(f"{cache_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            temporary.replace(cache_path)
        finally:
            temporary.unlink(missing_ok=True)
        return payload, False


def waveform_view(
    payload: dict[str, Any],
    *,
    start_sec: float = 0,
    end_sec: float | None = None,
    buckets: int = 72,
) -> dict[str, Any]:
    source = [max(0.0, float(value or 0)) for value in payload.get("peaks") or []]
    duration = max(0.001, float(payload.get("duration_sec") or 0.001))
    start = max(0.0, min(duration, float(start_sec or 0)))
    end = duration if end_sec is None else max(start, min(duration, float(end_sec)))
    if end <= start:
        end = min(duration, start + 0.001)
    left = max(0, min(len(source), int((start / duration) * len(source))))
    right = max(left + 1, min(len(source), int((end / duration) * len(source) + 0.999)))
    selected = array("f", source[left:right])
    values = _bucket_peaks(selected, max(8, min(512, int(buckets))))
    peak = max(max(values, default=0.0), 0.0001)
    normalized = [round(max(0.04, min(1.0, value / peak)), 4) for value in values]
    return {
        "peaks": normalized,
        "duration_sec": duration,
        "start_sec": start,
        "end_sec": end,
        "buckets": len(normalized),
    }
