"""Built-in weather modes that reuse resources from the installed CS2 game."""

from __future__ import annotations

from collections.abc import Iterable

from .map_material_vpk import map_material_console_commands


DEFAULT_WEATHER_EFFECT_ID = "default"
SNOW_WEATHER_EFFECT_ID = "snow"
RAIN_WEATHER_EFFECT_ID = "rain"
WEATHER_EFFECT_IDS = frozenset(
    {DEFAULT_WEATHER_EFFECT_ID, SNOW_WEATHER_EFFECT_ID, RAIN_WEATHER_EFFECT_ID}
)


class WeatherEffectError(ValueError):
    """A requested weather mode is unknown or unavailable."""


def normalize_weather_effect_id(value: object) -> str:
    effect_id = str(value or DEFAULT_WEATHER_EFFECT_ID).strip().lower()
    if effect_id not in WEATHER_EFFECT_IDS:
        raise WeatherEffectError(f"unsupported weather effect: {effect_id}")
    return effect_id


def weather_effect_console_commands(value: object) -> tuple[str, ...]:
    normalize_weather_effect_id(value)
    return ()


def merge_console_command_groups(*groups: Iterable[str]) -> tuple[str, ...]:
    merged: list[str] = []
    saw_cheats = False
    for group in groups:
        for command in group:
            if command == "sv_cheats 1":
                if saw_cheats:
                    continue
                saw_cheats = True
            merged.append(str(command))
    return tuple(merged)


def visual_layer_console_commands(
    *,
    map_material_id: object,
    weather_effect_id: object,
) -> tuple[str, ...]:
    return merge_console_command_groups(
        map_material_console_commands(map_material_id),
        weather_effect_console_commands(weather_effect_id),
    )
