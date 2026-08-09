"""Match configured player identities to inspected demo rosters."""

from __future__ import annotations

from typing import Optional

from ...env_utils import AppConfig
from ...player_names import normalize_player_key


def normalized_expected_parse_players(config: AppConfig) -> list[str]:
    raw = getattr(config, "expected_parse_players", None) or []
    seen: set[str] = set()
    players: list[str] = []
    for value in raw:
        if not isinstance(value, str):
            continue
        name = value.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        players.append(name)
        if len(players) >= 50:
            break
    return players


def _match_expected_to_roster_row(expected: str, roster: list[dict]) -> Optional[dict]:
    name = (expected or "").strip()
    if not name:
        return None
    normalized = normalize_player_key(name)
    lowered = name.lower()
    for row in roster:
        roster_name = (row.get("name") or "").strip()
        if not roster_name:
            continue
        if normalize_player_key(roster_name) == normalized or roster_name.lower() == lowered:
            return row
    if len(lowered) >= 3:
        for row in roster:
            roster_name = (row.get("name") or "").strip()
            if not roster_name:
                continue
            roster_lowered = roster_name.lower()
            if lowered in roster_lowered or roster_lowered in lowered:
                return row
    return None


def match_expected_players_in_roster(expected: list[str], roster: list[dict]) -> list[dict]:
    if not roster:
        return []
    matched: list[dict] = []
    seen_keys: set[str] = set()
    for expected_name in expected:
        text = str(expected_name or "").strip()
        exact = [
            row
            for row in roster
            if str(row.get("player_key") or "").strip() == text
            or str(row.get("name") or "").strip().casefold() == text.casefold()
        ]
        candidates = exact or [
            row for row in [_match_expected_to_roster_row(text, roster)] if row
        ]
        for row in candidates:
            key = str(row.get("player_key") or "").strip()
            if not key:
                steam_id = str(row.get("steam_id64") or row.get("steamid64") or "").strip()
                key = (
                    f"steamid:{steam_id}"
                    if steam_id
                    else normalize_player_key(str(row.get("name") or ""))
                )
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            matched.append(row)
    return matched
