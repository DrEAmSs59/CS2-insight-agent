"""实验档后处理：逐帧亮度锁源（v7 口径，纯 ffmpeg 实现）。

把 NR 画面的亮度(Y) 钳制到参考画面（同一 demo/tick、未开 NR 的 take）附近，
保留 NR 自己的色度/纹理，从而压掉「每一帧明暗漂移」。

实现：两路 yuv420p 输入做 blend，只钳制 Y 平面：
    clip(A, B - tol, B + tol)   # A = NR 的 Y，B = 参考的 Y
色度平面（U/V）默认沿用 A（NR），因此颜色仍是 NR 的。
可选再叠一层 hqdn3d 纯时域降噪（0:0:4:4）。

注意：两次独立抓帧的帧数/起点不完全一致（实测 5910 vs 5900 帧），
所以默认先用 `estimate_offset()` 做内容对齐，再按偏移裁掉多余帧。
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

TOLERANCE = 5  # /255
TEMPORAL_DENOISE = "hqdn3d=0:0:4:4"


class LumaLockError(RuntimeError):
    """亮度锁源失败。"""


def _run(command: list[str], step: str, timeout: int) -> None:
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise LumaLockError(f"{step} timeout after {timeout}s") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-6:]
        raise LumaLockError(f"{step} failed rc={proc.returncode}: " + " | ".join(tail))


def _trim_prefix(offset: int) -> str:
    if offset <= 0:
        return ""
    return f"trim=start_frame={offset},setpts=PTS-STARTPTS,"


def build_lock_command(
    ffmpeg_bin: str,
    nr_clip: Path,
    ref_clip: Path,
    out_clip: Path,
    *,
    tolerance: int = TOLERANCE,
    denoise: bool = True,
    crf: int = 14,
    preset: str = "medium",
    nr_offset: int = 0,
    ref_offset: int = 0,
) -> list[str]:
    tol = max(0, int(tolerance))
    graph = (
        f"[0:v]{_trim_prefix(nr_offset)}format=yuv420p[nr];"
        f"[1:v]{_trim_prefix(ref_offset)}format=yuv420p[rf];"
        f"[nr][rf]blend=c0_expr='clip(A,B-{tol},B+{tol})'[lock];"
    )
    tail = "[lock]"
    if denoise:
        graph += f"[lock]{TEMPORAL_DENOISE}[lockdn];"
        tail = "[lockdn]"
    return [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(nr_clip),
        "-i",
        str(ref_clip),
        "-filter_complex",
        graph,
        "-map",
        tail,
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(out_clip),
    ]


def _gray_frames(ffmpeg_bin: str, path: Path, width: int = 160, height: int = 90) -> list[bytes]:
    """解码成小尺寸灰度帧（每帧一段 bytes）。不依赖 numpy。"""
    command = [
        ffmpeg_bin,
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(path),
        "-vf",
        f"scale={width}:{height},format=gray",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.run(command, capture_output=True, timeout=1200)
    if proc.returncode != 0:
        raise LumaLockError("probe frames failed: " + (proc.stderr or b"").decode("utf-8", "replace")[-300:])
    size = width * height
    buf = proc.stdout
    count = len(buf) // size
    if count == 0:
        raise LumaLockError(f"no frames decoded from {path}")
    return [buf[i * size : (i + 1) * size] for i in range(count)]


def _mad(a: bytes, b: bytes, stride: int = 8) -> float:
    total = 0
    hits = 0
    for i in range(0, min(len(a), len(b)), stride):
        total += abs(a[i] - b[i])
        hits += 1
    return total / max(1, hits)


def estimate_offset(
    *,
    ffmpeg_bin: str,
    nr_clip: Path,
    ref_clip: Path,
    max_shift: int = 24,
) -> int:
    """估 NR 与参考片的内容偏移：返回值 o 表示 nr[t] ≈ ref[t + o]。"""
    nr = _gray_frames(ffmpeg_bin, nr_clip)
    ref = _gray_frames(ffmpeg_bin, ref_clip)
    limit = min(len(nr), len(ref), 90)
    nr = nr[:limit]
    ref = ref[:limit]
    best_shift, best_score = 0, float("inf")
    for shift in range(-max_shift, max_shift + 1):
        if shift >= 0:
            pairs = zip(nr[: limit - shift], ref[shift:])
        else:
            pairs = zip(nr[-shift:], ref[: limit + shift])
        score = 0.0
        count = 0
        for a, b in pairs:
            score += _mad(a, b)
            count += 1
        if count == 0:
            continue
        score /= count
        if score < best_score:
            best_shift, best_score = shift, score
    return int(best_shift)


def lock_luma(
    *,
    ffmpeg_bin: str,
    nr_clip: Path,
    ref_clip: Path,
    out_clip: Path,
    tolerance: int = TOLERANCE,
    denoise: bool = True,
    timeout_sec: int = 3600,
    align: bool = True,
    max_shift: int = 24,
    emit: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """把 nr_clip 的亮度钳制到 ref_clip，输出中间片（x264 CRF14，供后续 x265 封装）。"""
    if not Path(nr_clip).is_file():
        raise LumaLockError(f"nr clip missing: {nr_clip}")
    if not Path(ref_clip).is_file():
        raise LumaLockError(f"reference clip missing: {ref_clip}")
    nr_offset = 0
    ref_offset = 0
    if align:
        offset = estimate_offset(ffmpeg_bin=ffmpeg_bin, nr_clip=Path(nr_clip), ref_clip=Path(ref_clip), max_shift=max_shift)
        if offset > 0:
            ref_offset = offset
        elif offset < 0:
            nr_offset = -offset
        if emit:
            emit(f"luma lock: alignment offset={offset}")
    command = build_lock_command(
        ffmpeg_bin,
        Path(nr_clip),
        Path(ref_clip),
        Path(out_clip),
        tolerance=tolerance,
        denoise=denoise,
        nr_offset=nr_offset,
        ref_offset=ref_offset,
    )
    if emit:
        emit(f"luma lock: tolerance={tolerance}/255 denoise={denoise}")
    _run(command, "luma lock", timeout_sec)
    if not Path(out_clip).is_file() or Path(out_clip).stat().st_size == 0:
        raise LumaLockError("luma lock produced empty output")
    return {
        "ok": True,
        "output": str(out_clip),
        "size_mb": round(Path(out_clip).stat().st_size / (1024 * 1024), 2),
        "tolerance": tolerance,
        "denoise": denoise,
        "nr_offset": nr_offset,
        "ref_offset": ref_offset,
    }
