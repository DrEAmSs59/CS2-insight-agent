"""实验档后处理：1000fps take → FrameMeld 60fps（blur 0.35）→ x265 10bit CRF18。"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

TARGET_FPS = 60
DEFAULT_BLUR_AMOUNT = 0.35
CRF = 18
PRESET = "slow"


class PostProcessError(RuntimeError):
    def __init__(self, step: str, message: str) -> None:
        super().__init__(message)
        self.step = step


def _run(command: list[str], step: str, timeout: int) -> float:
    started = time.monotonic()
    proc = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    elapsed = time.monotonic() - started
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[-800:]
        raise PostProcessError(step, f"{step} rc={proc.returncode}: {tail}")
    return elapsed


def run_postprocess(
    *,
    ffmpeg_bin: str,
    take_path: Path,
    output_path: Path,
    log=None,
    framemeld: bool = True,
    blur_amount: float = DEFAULT_BLUR_AMOUNT,
    timeout_sec: int = 7200,
    ref_take: Path | None = None,
    ref_clip: Path | None = None,
    luma_lock: bool = False,
    luma_tolerance: int = 5,
    luma_denoise: bool = True,
) -> dict[str, Any]:
    """把 1000fps take 处理成 60fps 视觉无损交付片。"""

    def emit(message: str) -> None:
        logger.info("[experimental-nr] %s", message)
        if log is not None:
            try:
                log.info(message)
            except Exception:  # pragma: no cover
                pass

    if not take_path.is_file():
        raise PostProcessError("input", f"take missing: {take_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    work = output_path.with_name(output_path.stem + "_framemeld.mp4")
    steps: list[dict[str, Any]] = []

    if framemeld:
        command = [
            ffmpeg_bin,
            "-framemeld",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(take_path),
            "--performance-mode",
            "balanced",
            "--blur-output-fps",
            str(TARGET_FPS),
            "--blur-amount",
            f"{blur_amount:.4f}",
            "-c:v",
            "h264_amf",
            "-cq",
            "0",
            "--host-managed-encoder-fallback",
            "-gpu",
            "0",
            "-c:a",
            "copy",
            str(work),
        ]
        emit(f"framemeld start blur={blur_amount} -> {work.name}")
        elapsed = _run(command, "framemeld", timeout_sec)
        steps.append({"step": "framemeld", "elapsed_sec": round(elapsed, 1), "output": str(work)})
        emit(f"framemeld done {elapsed:.1f}s")
        source = work
    else:
        source = take_path

    if luma_lock and (ref_take is not None or ref_clip is not None):
        from .experimental_nr_lumalock import LumaLockError, lock_luma

        if ref_clip is not None and Path(ref_clip).is_file():
            ref_clip = Path(ref_clip)
        else:
            ref_clip = output_path.with_name(output_path.stem + "_ref_framemeld.mp4")
        ref_command = [
            ffmpeg_bin,
            "-framemeld",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(ref_take),
            "--performance-mode",
            "balanced",
            "--blur-output-fps",
            str(TARGET_FPS),
            "--blur-amount",
            f"{blur_amount:.4f}",
            "-c:v",
            "h264_amf",
            "-cq",
            "0",
            "--host-managed-encoder-fallback",
            "-gpu",
            "0",
            "-c:a",
            "copy",
            str(ref_clip),
        ]
        if not ref_clip.is_file() or (ref_take is not None and ref_clip.name.endswith("_ref_framemeld.mp4")):
            emit(f"framemeld(reference) start -> {ref_clip.name}")
            elapsed = _run(ref_command, "framemeld-reference", timeout_sec)
            steps.append({"step": "framemeld-reference", "elapsed_sec": round(elapsed, 1), "output": str(ref_clip)})
            emit(f"framemeld(reference) done {elapsed:.1f}s")

        locked = output_path.with_name(output_path.stem + "_luma_locked.mp4")
        try:
            lock_result = lock_luma(
                ffmpeg_bin=ffmpeg_bin,
                nr_clip=source,
                ref_clip=ref_clip,
                out_clip=locked,
                tolerance=luma_tolerance,
                denoise=luma_denoise,
                timeout_sec=timeout_sec,
                emit=emit,
            )
        except LumaLockError as exc:
            raise PostProcessError("luma-lock", str(exc)) from exc
        steps.append(
            {
                "step": "luma-lock",
                "elapsed_sec": 0,
                "tolerance": lock_result["tolerance"],
                "denoise": lock_result["denoise"],
                "output": str(locked),
            }
        )
        emit("luma-lock done")
        source = locked
        if ref_clip.is_file():
            ref_clip.unlink(missing_ok=True)

    command = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-c:v",
        "libx265",
        "-preset",
        PRESET,
        "-crf",
        str(CRF),
        "-pix_fmt",
        "yuv420p10le",
        "-profile:v",
        "main10",
        "-tag:v",
        "hvc1",
        "-x265-params",
        "log-level=error",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    emit(f"x265 start crf={CRF} preset={PRESET}")
    elapsed = _run(command, "x265", timeout_sec)
    steps.append({"step": "x265", "elapsed_sec": round(elapsed, 1), "output": str(output_path)})
    emit(f"x265 done {elapsed:.1f}s")

    # decode self-check
    check = _run(
        [ffmpeg_bin, "-v", "error", "-i", str(output_path), "-f", "null", "-"],
        "decode-check",
        900,
    )
    steps.append({"step": "decode-check", "elapsed_sec": round(check, 1)})
    emit("decode-check ok")

    if work.is_file():
        work.unlink(missing_ok=True)

    size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)
    return {
        "ok": True,
        "output": str(output_path),
        "size_mb": size_mb,
        "fps": TARGET_FPS,
        "blur_amount": blur_amount,
        "crf": CRF,
        "steps": steps,
    }
