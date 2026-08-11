"""Boundary and canvas-background transition graph builders."""

from __future__ import annotations

from typing import Any

from ...video_composer import _xfade_transition_name
from .timeline import _map_transition_type


def _background_boundary_transition_parts(
    clip: dict[str, Any],
    *,
    scene_label: str,
    output_label: str,
    width: int,
    height: int,
    fps: float,
    duration: float,
    background_color: str,
    apply_in: bool,
    apply_out: bool,
) -> list[str]:
    """Transition a first/last clip against the project canvas background."""
    total = max(0.1, float(duration))
    incoming = clip.get("transition_in") if isinstance(clip.get("transition_in"), dict) else None
    outgoing = clip.get("transition_out") if isinstance(clip.get("transition_out"), dict) else None
    in_type = _map_transition_type(str((incoming or {}).get("type") or "cut"))
    out_type = _map_transition_type(str((outgoing or {}).get("type") or "cut"))
    in_d = max(0.0, float((incoming or {}).get("duration_sec") or 0)) if apply_in and in_type not in {"cut", "none"} else 0.0
    out_d = max(0.0, float((outgoing or {}).get("duration_sec") or 0)) if apply_out and out_type not in {"cut", "none"} else 0.0
    if in_d + out_d > total * 0.9:
        factor = total * 0.9 / max(in_d + out_d, 1e-6)
        in_d *= factor
        out_d *= factor
    if in_d <= 1e-6 and out_d <= 1e-6:
        return [f"{scene_label}null{output_label}"]
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    labels = []
    parts: list[str] = []
    split_count = (1 if in_d > 1e-6 else 0) + (1 if total - in_d - out_d > 1e-6 else 0) + (1 if out_d > 1e-6 else 0)
    split_labels = [f"[scene{i}]" for i in range(split_count)]
    parts.append(f"{scene_label}split={split_count}{''.join(split_labels)}")
    cursor = 0
    if in_d > 1e-6:
        source = split_labels[cursor]; cursor += 1
        parts.append(f"{source}trim=0:{in_d:.6f},setpts=PTS-STARTPTS,settb=AVTB[inclip]")
        parts.append(f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={in_d:.6f},settb=AVTB[bg_in]")
        parts.append(f"[bg_in][inclip]xfade=transition={_xfade_transition_name(in_type)}:duration={in_d:.6f}:offset=0[vin]")
        labels.append("[vin]")
    middle = total - in_d - out_d
    if middle > 1e-6:
        source = split_labels[cursor]; cursor += 1
        parts.append(f"{source}trim=start={in_d:.6f}:end={total - out_d:.6f},setpts=PTS-STARTPTS[mid]")
        labels.append("[mid]")
    if out_d > 1e-6:
        source = split_labels[cursor]
        parts.append(f"{source}trim=start={total - out_d:.6f}:end={total:.6f},setpts=PTS-STARTPTS,settb=AVTB[outclip]")
        parts.append(f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={out_d:.6f},settb=AVTB[bg_out]")
        parts.append(f"[outclip][bg_out]xfade=transition={_xfade_transition_name(out_type)}:duration={out_d:.6f}:offset=0[voutro]")
        labels.append("[voutro]")
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0,format=yuv420p{output_label}")
    return parts

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
    """Render a visual transition at a cut while preserving timeline duration.

    The outgoing image is held for the transition duration; the incoming clip keeps
    its full timeline allocation, so overlays and independent audio remain aligned.
    """
    frame = 1.0 / max(fps, 24.0)
    # This compositor keeps the full timeline allocation of both clips: the
    # outgoing last frame is extended underneath the incoming clip. Unlike a
    # conventional overlapping xfade, the previous duration does not limit
    # the transition. Only the incoming material needs one frame left for its
    # tail, so a requested 1.5s transition remains exactly 1.5s when possible.
    max_duration = max(frame, next_duration - frame)
    td = max(frame, min(max(0.0, float(duration)), 1.5, max_duration))
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    xname = "fade" if transition_type in {"cut", "fade"} else _xfade_transition_name(transition_type)
    half = td / 2.0
    phase_color = "black" if transition_type == "dip_black" else "white" if transition_type == "flash" else None
    phase_prefix = "dip" if transition_type == "dip_black" else "flash"
    if phase_color:
        hold_filter = (
            f"[holdsrc]trim=start={max(0.0, previous_duration - half):.6f}:end={previous_duration:.6f},"
            f"setpts=PTS-STARTPTS,fade=t=out:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}out]"
        )
    else:
        # Container duration is often determined by audio and can extend past
        # the final video frame. A one-frame trim at ``duration - frame`` can
        # therefore be empty, making xfade fall through to an apparent hard
        # cut. Search a small tail window and reverse it so trim selects the
        # last video frame that actually exists, then hold that frame.
        hold_window = max(0.25, frame * 4.0)
        hold_start = max(0.0, previous_duration - hold_window)
        hold_filter = (
            f"[holdsrc]trim=start={hold_start:.6f}:end={previous_duration:.6f},"
            f"setpts=PTS-STARTPTS,reverse,trim=end_frame=1,setpts=PTS-STARTPTS,"
            f"loop=loop=-1:size=1:start=0,setpts=N/{fps_s}/TB,trim=duration={td:.6f}[hold]"
        )
    parts = [
        "[0:v]split=2[pvsrc][holdsrc]",
        "[1:v]split=2[nintrosrc][ntailsrc]",
        "[pvsrc]setpts=PTS-STARTPTS[pv]",
        hold_filter,
        f"[nintrosrc]trim=start=0:end={td:.6f},setpts=PTS-STARTPTS[nintro]",
    ]
    if phase_color:
        # FFmpeg's fadeblack/fadewhite variants do not reliably reach the
        # expected solid midpoint on every build. Split the transition into
        # two explicit halves so the boundary color and duration are stable.
        parts.extend([
            f"[nintro]trim=start={half:.6f}:end={td:.6f},setpts=PTS-STARTPTS,fade=t=in:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}in]",
            f"[{phase_prefix}out][{phase_prefix}in]concat=n=2:v=1:a=0[xf]",
        ])
    else:
        parts.append(f"[hold][nintro]xfade=transition={xname}:duration={td:.6f}:offset=0[xf]")
    parts.extend([
        f"[ntailsrc]trim=start={td:.6f},setpts=PTS-STARTPTS[ntail]",
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

