"""Boundary transition graph builder."""

from __future__ import annotations

from ...video_composer import _xfade_transition_name
from .transition_events import TRANSITION_DURATION_MAX


def _boundary_transition_filter_complex(
    *,
    transition_type: str,
    duration: float,
    previous_duration: float,
    next_duration: float,
    fps: float,
    previous_has_audio: bool,
    next_has_audio: bool,
) -> str:
    """Render one centered edit-point event without changing timeline length.

    The event occupies half of its duration on each clip. Where a source does
    not exist on the opposite side of the authored cut, its boundary frame is
    cloned. Preview uses the same boundary-frame rule.
    """
    frame = 1.0 / max(fps, 24.0)
    max_duration = max(frame, min(TRANSITION_DURATION_MAX, previous_duration * 2.0, next_duration * 2.0))
    td = max(frame, min(max(0.0, float(duration)), max_duration))
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    xname = "fade" if transition_type in {"cut", "fade"} else _xfade_transition_name(transition_type)
    half = td / 2.0
    phase_color = "black" if transition_type == "dip" else "white" if transition_type == "flash" else None
    phase_prefix = "dip" if transition_type == "dip" else "flash"
    parts = [
        "[0:v]split=3[pvsrc][ptailsrc][plastholdsrc]",
        "[1:v]split=3[nfirstholdsrc][nheadsrc][ntailsrc]",
        f"[pvsrc]trim=end={max(0.0, previous_duration - half):.6f},setpts=PTS-STARTPTS[pv]",
        f"[ptailsrc]trim=start={max(0.0, previous_duration - half):.6f}:end={previous_duration:.6f},setpts=PTS-STARTPTS[ptail]",
        f"[plastholdsrc]trim=start={max(0.0, previous_duration - max(0.25, frame * 4.0)):.6f}:end={previous_duration:.6f},setpts=PTS-STARTPTS,reverse,trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,setpts=N/{fps_s}/TB,trim=duration={half:.6f}[plasthold]",
        "[ptail][plasthold]concat=n=2:v=1:a=0[ptransition]",
        f"[nfirstholdsrc]trim=start=0:end={max(0.25, frame * 4.0):.6f},setpts=PTS-STARTPTS,trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,setpts=N/{fps_s}/TB,trim=duration={half:.6f}[nfirsthold]",
        f"[nheadsrc]trim=start=0:end={half:.6f},setpts=PTS-STARTPTS[nhead]",
        "[nfirsthold][nhead]concat=n=2:v=1:a=0[ntransition]",
    ]
    if phase_color:
        # FFmpeg's fadeblack/fadewhite variants do not reliably reach the
        # expected solid midpoint on every build. Split the transition into
        # two explicit halves so the boundary color and duration are stable.
        parts.extend([
            f"[ptransition]trim=start=0:end={half:.6f},setpts=PTS-STARTPTS,fade=t=out:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}out]",
            f"[ntransition]trim=start={half:.6f}:end={td:.6f},setpts=PTS-STARTPTS,fade=t=in:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}in]",
            f"[{phase_prefix}out][{phase_prefix}in]concat=n=2:v=1:a=0[xf]",
        ])
    else:
        parts.append(f"[ptransition][ntransition]xfade=transition={xname}:duration={td:.6f}:offset=0[xf]")
    parts.extend([
        f"[ntailsrc]trim=start={half:.6f},setpts=PTS-STARTPTS[ntail]",
        "[pv][xf][ntail]concat=n=3:v=1:a=0[vout]",
    ])
    if previous_has_audio:
        parts.append("[0:a]asetpts=PTS-STARTPTS[pa]")
    else:
        parts.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{previous_duration:.6f},asetpts=PTS-STARTPTS[pa]")
    if next_has_audio:
        parts.append("[1:a]asetpts=PTS-STARTPTS[na]")
    else:
        parts.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{next_duration:.6f},asetpts=PTS-STARTPTS[na]")
    parts.append("[pa][na]concat=n=2:v=0:a=1[aout]")
    return ";".join(parts)
