"""Shared limits for event recording padding and saved pacing settings."""
import math
from typing import Any

MAX_EVENT_PREROLL_SECONDS = 10.0


def limit_event_preroll_seconds(value: Any) -> Any:
    """Cap legacy padding while leaving invalid inputs to model validation."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return value
    return min(number, MAX_EVENT_PREROLL_SECONDS) if math.isfinite(number) else value
