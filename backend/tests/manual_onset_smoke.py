"""端到端验证:合成一段带角标闪白的视频,跑真实 ffmpeg 滤镜链,看能不能量回来。

不是单元测试(需要真实 ffmpeg 二进制),用来验证 build_diff_trace_command 这条链在真实
文件上确实成立。手动执行:
    .venv\\Scripts\\python.exe backend\\tests\\manual_onset_smoke.py
"""

import subprocess
import sys
import tempfile
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.recording.diagnostics.onset_probe import (
    build_diff_trace_command,
    calibration_marker_crop,
    find_flashes,
    match_flashes,
    parse_diff_trace,
    probe_motion_onset,
)

FPS = 120
DURATION = 10.0
FLASH_AT = [1.5, 4.0, 6.5, 9.0]
FLASH_MS = 0.100


def ffmpeg_exe() -> Path:
    """按 命令行参数 → 应用配置 → imageio-ffmpeg → PATH 的顺序找 ffmpeg。"""
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    try:
        from app.recording.diagnostics.latency_report import default_ffmpeg_bin

        return default_ffmpeg_bin()
    except Exception:  # noqa: BLE001 - 本机没配就往下找
        pass
    try:
        import imageio_ffmpeg

        return Path(imageio_ffmpeg.get_ffmpeg_exe())
    except ImportError:
        pass
    import shutil

    found = shutil.which("ffmpeg")
    if not found:
        raise SystemExit("找不到 ffmpeg：把路径作为第一个参数传进来")
    return Path(found)


def synth_clip(ffmpeg: Path, out: Path) -> None:
    """2K/120fps,左上角 160x160 是黑块并在指定时刻闪白 100ms,其余区域一直在动。

    背景刻意用 testsrc2(整幅都在变):能验证裁剪框真的把标记之外的干扰隔离掉了,
    这正是"在动态画面上量叠加层"必须成立的前提。
    """
    enable = "+".join(f"between(t,{t},{t + FLASH_MS})" for t in FLASH_AT)
    filters = (
        f"color=black:size=160x160:rate={FPS}[m];"
        f"color=white:size=160x160:rate={FPS}[w];"
        f"[m][w]overlay=enable='{enable}'[mark];"
        f"[0:v][mark]overlay=0:0[out]"
    )
    command = [
        str(ffmpeg), "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=2560x1440:rate={FPS}:duration={DURATION}",
        "-filter_complex", filters,
        "-map", "[out]", "-t", str(DURATION),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
        str(out),
    ]
    subprocess.run(command, check=True, timeout=600)


def main() -> int:
    ffmpeg = ffmpeg_exe()
    print(f"ffmpeg: {ffmpeg}")
    with tempfile.TemporaryDirectory(prefix="cs2ia-smoke-") as tmp:
        clip = Path(tmp) / "synthetic 2k.mp4"  # 路径带空格,一并验证
        print("合成样片...", flush=True)
        synth_clip(ffmpeg, clip)
        print(f"样片: {clip} ({clip.stat().st_size} bytes)")

        crop = calibration_marker_crop(base_width=2560, output_width=2560)
        print(f"裁剪框: {crop.to_filter()}")

        command = build_diff_trace_command(
            ffmpeg_bin=ffmpeg, source=clip, metadata_path=Path(tmp) / "diff.txt", crop=crop
        )
        print("命令:", " ".join(command))

        onset, trace = probe_motion_onset(ffmpeg_bin=ffmpeg, source=clip, crop=crop)
        print(f"帧数={len(trace)} 阈值={onset.threshold:.4f} 静止基线={onset.baseline_static}")
        if not trace:
            print("失败: 曲线为空")
            return 1

        flashes = find_flashes(trace)
        measured = [round(f.pts_sec, 4) for f in flashes]
        print(f"预期闪白: {FLASH_AT}")
        print(f"实测闪白: {measured}")

        pairs, unmatched = match_flashes(FLASH_AT, [f.pts_sec for f in flashes])
        for pair in pairs:
            print(f"  预期 {pair['expected_sec']:.4f} → 实测 {pair['measured_sec']:.4f}"
                  f" 偏差 {pair['offset_sec'] * 1000:+.1f}ms")
        if unmatched:
            print(f"未配上的预期时刻: {unmatched}")

        ok = len(pairs) == len(FLASH_AT) and not unmatched
        print("\n结论:", "滤镜链在真实文件上成立" if ok else "滤镜链有问题")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
