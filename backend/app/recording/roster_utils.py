"""Resolve player steamid64 / spec_slot from demo.all_players roster."""

from __future__ import annotations

from typing import Any, Optional

from .models import EventInfo, TargetPlayer


def lookup_roster_player(
    all_players: list,
    *,
    name: str = "",
    steamid64: str = "",
) -> Optional[dict[str, Any]]:
    """Find a roster row by steamid64 (preferred) or case-insensitive name."""
    if not all_players:
        return None
    sid = (steamid64 or "").strip()
    if sid:
        for p in all_players:
            if not isinstance(p, dict):
                continue
            if str(p.get("steamid64") or "").strip() == sid:
                return p
    raw = (name or "").strip()
    if not raw:
        return None
    low = raw.lower()
    for p in all_players:
        if not isinstance(p, dict):
            continue
        pn = str(p.get("name") or "").strip()
        if pn == raw or pn.lower() == low:
            return p
    return None


def _enrich_target_player(player: TargetPlayer, roster: list) -> tuple[TargetPlayer, bool]:
    if player is None:
        return player, False
    name = (player.name or "").strip()
    sid = (player.steamid64 or "").strip()
    slot = player.spec_slot
    if not name and not sid:
        return player, False
    found = lookup_roster_player(roster, name=name, steamid64=sid)
    if not found:
        return player, False
    updates: dict[str, Any] = {}
    if not sid and str(found.get("steamid64") or "").strip():
        updates["steamid64"] = str(found["steamid64"]).strip()
    if slot is None and found.get("spec_slot") is not None:
        try:
            updates["spec_slot"] = int(found["spec_slot"])
        except (TypeError, ValueError):
            pass
    if not name and str(found.get("name") or "").strip():
        updates["name"] = str(found["name"]).strip()
    if not updates:
        return player, False
    return player.model_copy(update=updates), True


def enrich_events_victims_from_roster(
    events: list[EventInfo],
    all_players: list,
) -> tuple[list[EventInfo], list[str]]:
    """Fill missing victim steamid64 / spec_slot from match roster."""
    notes: list[str] = []
    if not events or not all_players:
        return events, notes

    new_events: list[EventInfo] = []
    filled = 0
    for ev in events:
        victim = ev.victim
        if victim is None:
            new_events.append(ev)
            continue
        enriched, changed = _enrich_target_player(victim, all_players)
        if changed:
            filled += 1
            new_events.append(ev.model_copy(update={"victim": enriched}))
        else:
            new_events.append(ev)

    if filled:
        notes.append(
            f"roster: filled victim steamid/spec_slot for {filled}/{len(events)} kill events"
        )
    return new_events, notes
