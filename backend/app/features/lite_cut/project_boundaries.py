"""Canonical project parameter boundaries applied before schema validation."""

from __future__ import annotations

from copy import deepcopy
import json
from functools import lru_cache
from typing import Any

from .contracts import contract_resource
from .effect_contract import load_effect_contract


@lru_cache(maxsize=1)
def _project_contract() -> dict[str, Any]:
    path = contract_resource("lite_cut_project_contract.json")
    return json.loads(path.read_text(encoding="utf-8"))


_PROJECT_CONTRACT = _project_contract()
_TIMELINE_LIMITS = _PROJECT_CONTRACT["timeline"]["limits"]
_TRACK_TYPE_ORDER = tuple(_PROJECT_CONTRACT["timeline"]["track_layout"]["ordered_types"])
_OUTPUT_DEFAULTS = _PROJECT_CONTRACT["output"]["defaults"]
_OUTPUT_LIMITS = _PROJECT_CONTRACT["output"]["limits"]
_EFFECT_CONTRACT = load_effect_contract()
_BLUR_LIMITS = _EFFECT_CONTRACT["canvas_rendering"]["blur_amount"]
CANVAS_FIT_VALUES = frozenset(str(value) for value in _EFFECT_CONTRACT["canvas_rendering"]["fit_values"])
_GAIN_LIMITS = _EFFECT_CONTRACT["audio_mix"]["gain_limits"]
_GAIN_DEFAULTS = _EFFECT_CONTRACT["audio_mix"]["gain_defaults"]
_DUCKING_GAIN = _EFFECT_CONTRACT["audio_mix"]["ducking"]["gain"]
_AUDIO_FADE_DURATION = _EFFECT_CONTRACT["audio_mix"]["fade_duration_sec"]

TIMELINE_TIME_DEFAULT = float(_TIMELINE_LIMITS["time_sec"]["default"])
TIMELINE_TIME_MIN = float(_TIMELINE_LIMITS["time_sec"]["min"])
TIMELINE_TIME_MAX = float(_TIMELINE_LIMITS["time_sec"]["max"])
TIMELINE_DURATION_DEFAULT = float(_TIMELINE_LIMITS["duration_sec"]["default"])
TIMELINE_DURATION_MIN_EXCLUSIVE = float(_TIMELINE_LIMITS["duration_sec"]["exclusive_min"])
TIMELINE_DURATION_MAX = float(_TIMELINE_LIMITS["duration_sec"]["max"])
OUTPUT_WIDTH_DEFAULT = int(_OUTPUT_DEFAULTS["width"])
OUTPUT_WIDTH_MIN = int(_OUTPUT_LIMITS["width"]["integer_min"])
OUTPUT_WIDTH_MAX = int(_OUTPUT_LIMITS["width"]["integer_max"])
OUTPUT_HEIGHT_DEFAULT = int(_OUTPUT_DEFAULTS["height"])
OUTPUT_HEIGHT_MIN = int(_OUTPUT_LIMITS["height"]["integer_min"])
OUTPUT_HEIGHT_MAX = int(_OUTPUT_LIMITS["height"]["integer_max"])
OUTPUT_FPS_DEFAULT = int(_OUTPUT_DEFAULTS["fps"])
OUTPUT_FPS_MIN = float(_OUTPUT_LIMITS["fps"]["min"])
OUTPUT_FPS_MAX = float(_OUTPUT_LIMITS["fps"]["max"])
CANVAS_BLUR_DEFAULT = int(_BLUR_LIMITS["default"])
CANVAS_BLUR_MIN = int(_BLUR_LIMITS["min"])
CANVAS_BLUR_MAX = int(_BLUR_LIMITS["max"])
AUDIO_CLIP_GAIN_MIN, AUDIO_CLIP_GAIN_MAX = (float(value) for value in _GAIN_LIMITS["clip"])
AUDIO_CLIP_GAIN_DEFAULT = float(_GAIN_DEFAULTS["clip"])
AUDIO_TRACK_GAIN_MIN, AUDIO_TRACK_GAIN_MAX = (float(value) for value in _GAIN_LIMITS["track"])
AUDIO_TRACK_GAIN_DEFAULT = float(_GAIN_DEFAULTS["track"])
AUDIO_MASTER_GAIN_MIN, AUDIO_MASTER_GAIN_MAX = (float(value) for value in _GAIN_LIMITS["master"])
AUDIO_MASTER_GAIN_DEFAULT = float(_GAIN_DEFAULTS["master"])
AUDIO_BGM_GAIN_MIN, AUDIO_BGM_GAIN_MAX = (float(value) for value in _GAIN_LIMITS["bgm"])
AUDIO_BGM_GAIN_DEFAULT = float(_GAIN_DEFAULTS["bgm"])
AUDIO_DUCKING_GAIN_MIN = float(_DUCKING_GAIN["min"])
AUDIO_DUCKING_GAIN_MAX = float(_DUCKING_GAIN["max"])
AUDIO_DUCKING_GAIN_DEFAULT = float(_DUCKING_GAIN["default"])
AUDIO_FADE_DURATION_MIN = float(_AUDIO_FADE_DURATION["min"])
AUDIO_FADE_DURATION_MAX = float(_AUDIO_FADE_DURATION["max"])
AUDIO_FADE_DURATION_DEFAULT = float(_AUDIO_FADE_DURATION["default"])


def _number(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(_number(value, fallback))))


def _hex_rgb(value: Any, fallback: str = "#000000") -> str:
    raw = str(value or "").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) == 3 and all(character in "0123456789abcdefABCDEF" for character in raw):
        raw = "".join(character * 2 for character in raw)
    if len(raw) == 6 and all(character in "0123456789abcdefABCDEF" for character in raw):
        return f"#{raw.lower()}"
    return fallback


def normalized_project_boundaries(raw_body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    body = deepcopy(raw_body)
    changed = False
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    if output is not body.get("output"):
        body["output"] = output
        changed = True
    defaults = {
        "width": _integer(output.get("width"), OUTPUT_WIDTH_DEFAULT, OUTPUT_WIDTH_MIN, OUTPUT_WIDTH_MAX),
        "height": _integer(output.get("height"), OUTPUT_HEIGHT_DEFAULT, OUTPUT_HEIGHT_MIN, OUTPUT_HEIGHT_MAX),
        "fps": _integer(output.get("fps"), OUTPUT_FPS_DEFAULT, int(OUTPUT_FPS_MIN), int(OUTPUT_FPS_MAX)),
        "blur_amount": _integer(output.get("blur_amount"), CANVAS_BLUR_DEFAULT, CANVAS_BLUR_MIN, CANVAS_BLUR_MAX),
        "background_color": _hex_rgb(output.get("background_color"), str(_OUTPUT_DEFAULTS["background_color"])),
    }
    fit = str(output.get("canvas_fit") or "contain").strip().lower()
    defaults["canvas_fit"] = fit if fit in CANVAS_FIT_VALUES else str(_OUTPUT_DEFAULTS["canvas_fit"])
    for key, value in defaults.items():
        if output.get(key) != value:
            output[key] = value
            changed = True
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    if audio is not body.get("audio"):
        body["audio"] = audio
        changed = True
    master = max(AUDIO_MASTER_GAIN_MIN, min(AUDIO_MASTER_GAIN_MAX, _number(audio.get("master_volume"), AUDIO_MASTER_GAIN_DEFAULT)))
    if audio.get("master_volume") != master:
        audio["master_volume"] = master
        changed = True
    tracks = body.get("tracks") or []
    if isinstance(tracks, list):
        rank = {track_type: index for index, track_type in enumerate(_TRACK_TYPE_ORDER)}
        ordered_tracks = [
            track
            for _, track in sorted(
                enumerate(tracks),
                key=lambda item: (rank.get(item[1].get("type") if isinstance(item[1], dict) else None, len(rank)), item[0]),
            )
        ]
        if ordered_tracks != tracks:
            body["tracks"] = tracks = ordered_tracks
            changed = True
        counters = {"video": 0, "audio": 0}
        prefixes = {"video": "V", "audio": "A"}
        for track in tracks:
            if not isinstance(track, dict) or track.get("type") not in counters:
                continue
            track_type = track["type"]
            counters[track_type] += 1
            label = f"{prefixes[track_type]}{counters[track_type]}"
            if track.get("label") != label:
                track["label"] = label
                changed = True
    for track in tracks:
        if not isinstance(track, dict):
            continue
        volume = max(AUDIO_TRACK_GAIN_MIN, min(AUDIO_TRACK_GAIN_MAX, _number(track.get("volume"), AUDIO_TRACK_GAIN_DEFAULT)))
        if track.get("volume") != volume:
            track["volume"] = volume
            changed = True
    return body, changed


__all__ = [
    "AUDIO_MASTER_GAIN_MAX",
    "AUDIO_MASTER_GAIN_DEFAULT",
    "AUDIO_MASTER_GAIN_MIN",
    "AUDIO_BGM_GAIN_MAX",
    "AUDIO_BGM_GAIN_DEFAULT",
    "AUDIO_BGM_GAIN_MIN",
    "AUDIO_CLIP_GAIN_MAX",
    "AUDIO_CLIP_GAIN_DEFAULT",
    "AUDIO_CLIP_GAIN_MIN",
    "AUDIO_DUCKING_GAIN_DEFAULT",
    "AUDIO_DUCKING_GAIN_MAX",
    "AUDIO_DUCKING_GAIN_MIN",
    "AUDIO_FADE_DURATION_DEFAULT",
    "AUDIO_FADE_DURATION_MAX",
    "AUDIO_FADE_DURATION_MIN",
    "AUDIO_TRACK_GAIN_MAX",
    "AUDIO_TRACK_GAIN_DEFAULT",
    "AUDIO_TRACK_GAIN_MIN",
    "CANVAS_BLUR_DEFAULT",
    "CANVAS_BLUR_MAX",
    "CANVAS_BLUR_MIN",
    "CANVAS_FIT_VALUES",
    "OUTPUT_FPS_DEFAULT",
    "OUTPUT_FPS_MAX",
    "OUTPUT_FPS_MIN",
    "OUTPUT_HEIGHT_DEFAULT",
    "OUTPUT_HEIGHT_MAX",
    "OUTPUT_HEIGHT_MIN",
    "OUTPUT_WIDTH_DEFAULT",
    "OUTPUT_WIDTH_MAX",
    "OUTPUT_WIDTH_MIN",
    "TIMELINE_DURATION_DEFAULT",
    "TIMELINE_DURATION_MAX",
    "TIMELINE_DURATION_MIN_EXCLUSIVE",
    "TIMELINE_TIME_DEFAULT",
    "TIMELINE_TIME_MAX",
    "TIMELINE_TIME_MIN",
    "normalized_project_boundaries",
]
