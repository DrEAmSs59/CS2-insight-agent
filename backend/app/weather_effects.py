"""Built-in weather modes that reuse resources from the installed CS2 game."""

from __future__ import annotations


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
