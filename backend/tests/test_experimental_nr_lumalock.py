"""实验档亮度锁源（ffmpeg filtergraph 拼装）的单元测试。"""

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.experimental_nr_lumalock import build_lock_command  # noqa: E402


def _graph(command: list[str]) -> str:
    return command[command.index("-filter_complex") + 1]


def _join(command: list[str]) -> str:
    return " ".join(command)


def test_build_lock_command_clamps_luma_only(tmp_path: Path) -> None:
    command = build_lock_command(
        "ffmpeg",
        tmp_path / "nr.mp4",
        tmp_path / "ref.mp4",
        tmp_path / "out.mp4",
        tolerance=5,
        denoise=False,
    )
    graph = _graph(command)
    assert "blend=c0_expr='clip(A,B-5,B+5)'" in graph
    # 只钳 Y，色度沿用 NR
    assert graph.count("[lock]") == 1
    assert "hqdn3d" not in graph
    assert "trim" not in graph


def test_build_lock_command_adds_denoise_when_requested(tmp_path: Path) -> None:
    command = build_lock_command(
        "ffmpeg",
        tmp_path / "nr.mp4",
        tmp_path / "ref.mp4",
        tmp_path / "out.mp4",
        tolerance=4,
        denoise=True,
    )
    graph = _graph(command)
    assert "hqdn3d=0:0:4:4" in graph
    assert "clip(A,B-4,B+4)" in graph


def test_build_lock_command_trims_offsets_for_alignment(tmp_path: Path) -> None:
    command = build_lock_command(
        "ffmpeg",
        tmp_path / "nr.mp4",
        tmp_path / "ref.mp4",
        tmp_path / "out.mp4",
        nr_offset=0,
        ref_offset=7,
        denoise=False,
    )
    graph = _graph(command)
    assert "[1:v]trim=start_frame=7,setpts=PTS-STARTPTS," in graph
    assert "[0:v]format=yuv420p" in graph

    command_nr = build_lock_command(
        "ffmpeg",
        tmp_path / "nr.mp4",
        tmp_path / "ref.mp4",
        tmp_path / "out.mp4",
        nr_offset=3,
        ref_offset=0,
        denoise=False,
    )
    graph_nr = _graph(command_nr)
    assert "[0:v]trim=start_frame=3,setpts=PTS-STARTPTS," in graph_nr
    assert "[1:v]format=yuv420p" in graph_nr


def test_build_lock_command_encodes_visual_lossless_output(tmp_path: Path) -> None:
    command = build_lock_command(
        "ffmpeg",
        tmp_path / "nr.mp4",
        tmp_path / "ref.mp4",
        tmp_path / "out.mp4",
        crf=14,
        preset="medium",
    )
    text = _join(command)
    assert "-c:v libx264" in text
    assert "-crf 14" in text
    assert "-preset medium" in text
    assert "-pix_fmt yuv420p" in text
