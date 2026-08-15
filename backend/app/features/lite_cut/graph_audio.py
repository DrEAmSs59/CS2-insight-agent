"""Audio filter and mix graph builders for LiteCut exports."""

from __future__ import annotations

from typing import Any

from .timeline import _clip_audio_fade, _clip_volume, _clip_volume_filter
from .timeline_math import (
    clip_duration_sec as _clip_duration_sec,
    clip_has_speed_ramp as _clip_has_speed_ramp,
    clip_preserve_pitch as _clip_preserve_pitch,
    clip_reverse as _clip_reverse,
    clip_speed as _clip_speed,
    clip_speed_segments as _clip_speed_segments,
    clip_timeline_duration_sec as _clip_timeline_duration_sec,
)
from .project_boundaries import (
    AUDIO_BGM_GAIN_DEFAULT,
    AUDIO_CLIP_GAIN_DEFAULT,
    AUDIO_DUCKING_GAIN_DEFAULT,
    AUDIO_DUCKING_GAIN_MAX,
    AUDIO_DUCKING_GAIN_MIN,
    AUDIO_MASTER_GAIN_DEFAULT,
    AUDIO_MASTER_GAIN_MAX,
    AUDIO_MASTER_GAIN_MIN,
)
from .visual_material import (
    VISUAL_FREEZE_DEFAULT_SEC,
    VISUAL_FREEZE_MAX_SEC,
    VISUAL_FREEZE_MIN_SEC,
    VISUAL_SPEED_DEFAULT,
    VISUAL_SPEED_MAX,
    VISUAL_SPEED_MIN,
)


def _atempo_chain(speed: float) -> list[str]:
    remaining = max(VISUAL_SPEED_MIN, min(VISUAL_SPEED_MAX, float(speed or VISUAL_SPEED_DEFAULT)))
    parts: list[str] = []
    while remaining > 2.0 + 1e-6:
        parts.append("atempo=2.000000")
        remaining /= 2.0
    while remaining < 0.5 - 1e-6:
        parts.append("atempo=0.500000")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return parts

def _pitch_shift_speed_chain(speed: float) -> list[str]:
    bounded = max(VISUAL_SPEED_MIN, min(VISUAL_SPEED_MAX, float(speed or VISUAL_SPEED_DEFAULT)))
    return [
        "aresample=48000",
        f"asetrate={48000 * bounded:.6f}",
        "aresample=48000",
    ]

def _audio_filter_chain(speed: float, volume: float, reverse: bool = False, preserve_pitch: bool = True, volume_filter: str | None = None, freeze_frame_sec: float = VISUAL_FREEZE_DEFAULT_SEC) -> str:
    parts: list[str] = []
    if reverse:
        parts.append("areverse")
    if abs(speed - VISUAL_SPEED_DEFAULT) > 1e-6:
        parts.extend(_atempo_chain(speed) if preserve_pitch else _pitch_shift_speed_chain(speed))
    if volume_filter:
        parts.append(volume_filter)
    elif abs(volume - AUDIO_CLIP_GAIN_DEFAULT) > 1e-6:
        parts.append(f"volume={volume:.6f}")
    if freeze_frame_sec > 1e-6:
        parts.append(f"apad=pad_dur={max(VISUAL_FREEZE_MIN_SEC, min(VISUAL_FREEZE_MAX_SEC, freeze_frame_sec)):.6f}")
    return ",".join(parts)

def _audio_mix_filter_complex(
    *,
    has_base_audio: bool,
    audio_clips: list[dict[str, Any]],
    master_volume: float = AUDIO_MASTER_GAIN_DEFAULT,
) -> str:
    parts: list[str] = []
    foreground_labels: list[str] = []
    bgm_label: str | None = None
    bgm_duck_enabled = False
    bgm_duck_volume = AUDIO_DUCKING_GAIN_DEFAULT
    foreground_windows: list[tuple[float, float]] = []

    def mix_labels(labels: list[str], output_label: str) -> None:
        if len(labels) == 1:
            parts.append(f"{labels[0]}anull{output_label}")
        else:
            parts.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:dropout_transition=0:normalize=0{output_label}")

    if has_base_audio:
        parts.append("[0:a]asetpts=PTS-STARTPTS[basea]")
        foreground_labels.append("[basea]")
    for idx, clip in enumerate(audio_clips, start=1):
        delay_ms = max(0, int(round(float(clip.get("timeline_start") or 0) * 1000)))
        duration = _clip_timeline_duration_sec(clip)
        speed = _clip_speed(clip)
        preserve_pitch = _clip_preserve_pitch(clip)
        volume = _clip_volume(clip)
        fade_in = min(duration, _clip_audio_fade(clip, "fade_in_sec"))
        fade_out = min(duration, _clip_audio_fade(clip, "fade_out_sec"))
        label = f"[a{idx}]"
        chain: list[str]
        if _clip_has_speed_ramp(clip):
            segment_labels: list[str] = []
            for segment_index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
                segment_label = f"[ars{idx}_{segment_index}]"
                segment_labels.append(segment_label)
                segment_chain = [
                    f"atrim=start={start:.6f}:end={end:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *(_atempo_chain(segment_speed) if preserve_pitch else _pitch_shift_speed_chain(segment_speed)),
                ]
                parts.append(f"[{idx}:a]{','.join(segment_chain)}{segment_label}")
            ramp_label = f"[arr{idx}]"
            parts.append("".join(segment_labels) + f"concat=n={len(segment_labels)}:v=0:a=1{ramp_label}")
            chain = ["areverse"] if _clip_reverse(clip) else ["anull"]
            parts.append(f"{ramp_label}{','.join(chain)}[arp{idx}]")
            input_label = f"[arp{idx}]"
            chain = []
        else:
            input_label = f"[{idx}:a]"
            trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
            trim_out = trim_in + _clip_duration_sec(clip)
            chain = [f"atrim=start={trim_in:.6f}:end={trim_out:.6f}", "asetpts=PTS-STARTPTS"]
            if _clip_reverse(clip):
                chain.append("areverse")
            if abs(speed - 1.0) > 1e-6:
                chain.extend(_atempo_chain(speed) if preserve_pitch else _pitch_shift_speed_chain(speed))
        chain.append(_clip_volume_filter(clip))
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={fade_in:.6f}")
        if fade_out > 0:
            start = max(0.0, duration - fade_out)
            chain.append(f"afade=t=out:st={start:.6f}:d={fade_out:.6f}")
        chain.append(f"adelay={delay_ms}:all=1")
        parts.append(f"{input_label}{','.join(chain)}{label}")
        meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
        if meta.get("project_bgm"):
            bgm_label = label
            bgm_duck_enabled = bool(meta.get("ducking_enabled"))
            try:
                bgm_duck_volume = max(AUDIO_DUCKING_GAIN_MIN, min(AUDIO_DUCKING_GAIN_MAX, float(meta.get("ducking_volume", AUDIO_DUCKING_GAIN_DEFAULT))))
            except (TypeError, ValueError):
                bgm_duck_volume = AUDIO_DUCKING_GAIN_DEFAULT
        else:
            foreground_labels.append(label)
            if not clip.get("muted") and _clip_volume(clip) > 0.0 and duration > 0.0:
                start_sec = max(0.0, float(clip.get("timeline_start") or 0.0))
                foreground_windows.append((start_sec, start_sec + duration))
    labels: list[str]
    if bgm_label and bgm_duck_enabled and foreground_labels:
        activity = "+".join(f"between(t\\,{start:.6f}\\,{end:.6f})" for start, end in foreground_windows) or "0"
        parts.append(f"{bgm_label}volume='if(gt({activity}\\,0)\\,{bgm_duck_volume:.6f}\\,{AUDIO_BGM_GAIN_DEFAULT:g})':eval=frame[bgmduck]")
        labels = [*foreground_labels, "[bgmduck]"]
    else:
        labels = [*foreground_labels, *([bgm_label] if bgm_label else [])]
    if not labels:
        return ""
    mix_label = "[premaster]"
    mix_labels(labels, mix_label)
    master = max(AUDIO_MASTER_GAIN_MIN, min(AUDIO_MASTER_GAIN_MAX, float(master_volume)))
    if abs(master - 1.0) > 1e-6:
        parts.append(f"{mix_label}volume={master:.6f}[mixa]")
    else:
        parts.append(f"{mix_label}anull[mixa]")
    return ";".join(parts)
    AUDIO_MASTER_GAIN_DEFAULT,
    VISUAL_SPEED_DEFAULT,
