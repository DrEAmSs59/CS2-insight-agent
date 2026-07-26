"""Canonical player-name normalization shared across API domains."""


def normalize_player_key(value: str) -> str:
    return "".join((value or "").split()).casefold()
