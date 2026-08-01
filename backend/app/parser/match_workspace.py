from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable, Optional

import math

from .. import native_table as pd

from .parse_utils import _bool, _int, _round_end_winner_team_num, _to_pandas_df


_UTILITY_WEAPONS = {"hegrenade", "inferno", "molotov", "incgrenade", "incendiary"}
_TRADE_WINDOW_TICKS = 5 * 64
_ECONOMY_ORDER = ("pistol", "full", "force", "semi", "eco")
_GRENADE_PROJECTILES = {
    "CSmokeGrenadeProjectile": "烟雾弹",
    "CFlashbangProjectile": "闪光弹",
    "CHEGrenadeProjectile": "HE 手雷",
    "CMolotovProjectile": "燃烧弹",
    "CDecoyProjectile": "诱饵弹",
}
_GRENADE_WEAPON_KINDS = {
    "smokegrenade": _GRENADE_PROJECTILES["CSmokeGrenadeProjectile"],
    "flashbang": _GRENADE_PROJECTILES["CFlashbangProjectile"],
    "hegrenade": _GRENADE_PROJECTILES["CHEGrenadeProjectile"],
    "molotov": _GRENADE_PROJECTILES["CMolotovProjectile"],
    "incgrenade": _GRENADE_PROJECTILES["CMolotovProjectile"],
    "incendiary": _GRENADE_PROJECTILES["CMolotovProjectile"],
    "inferno": _GRENADE_PROJECTILES["CMolotovProjectile"],
    "decoy": _GRENADE_PROJECTILES["CDecoyProjectile"],
}
_NON_BULLET_WEAPONS = {
    "", "c4", "knife", "knife_t", "taser", "hegrenade", "flashbang",
    "smokegrenade", "molotov", "incgrenade", "incendiary", "decoy",
}


def _clean_name(value: object) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"nan", "nat", "none"} else text


def _float(value: object, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return default if pd.isna(result) else result


def _normalize_weapon(value: object) -> str:
    weapon = _clean_name(value).lower()
    for prefix in ("weapon_", "item_"):
        if weapon.startswith(prefix):
            weapon = weapon[len(prefix):]
    return weapon


def _round_number_for_active_event(row: pd.Series) -> int:
    return max(1, _int(row.get("total_rounds_played")) + 1)


def _round_number_for_tick(tick: int, windows: list[dict[str, Any]], row: Optional[pd.Series] = None) -> int:
    """Prefer formal round windows over unreliable per-event round counters."""
    for window in windows:
        if _int(window.get("start_tick")) <= int(tick) <= _int(window.get("end_tick")):
            return _int(window.get("round_number"))
    return _round_number_for_active_event(row) if row is not None and not windows else 0


def _time_text(tick: int, start_tick: int, tick_rate: float) -> str:
    seconds = max(0, int(round((int(tick) - int(start_tick)) / max(1.0, tick_rate))))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def _first_side_groups(group_side_by_round: dict[int, dict[int, int]]) -> tuple[Optional[int], Optional[int]]:
    if not group_side_by_round:
        return None, None
    first = group_side_by_round[min(group_side_by_round)]
    team_a_group = next((group for group, side in first.items() if int(side) == 2), None)
    team_b_group = next((group for group, side in first.items() if int(side) == 3), None)
    return team_a_group, team_b_group


def _team_key_for_group(group: object, team_a_group: Optional[int], team_b_group: Optional[int]) -> Optional[str]:
    try:
        group_i = int(float(group))
    except (TypeError, ValueError):
        return None
    if team_a_group is not None and group_i == team_a_group:
        return "a"
    if team_b_group is not None and group_i == team_b_group:
        return "b"
    if team_a_group is None and team_b_group is None:
        return "a" if group_i == 2 else "b" if group_i == 3 else None
    return None


def _detect_halftime_round(group_side_by_round: dict[int, dict[int, int]]) -> Optional[int]:
    if not group_side_by_round:
        return None
    rounds = sorted(group_side_by_round)
    baseline = group_side_by_round[rounds[0]]
    for round_number in rounds[1:]:
        if round_number > 24:
            break
        current = group_side_by_round[round_number]
        if any(current.get(group) != side for group, side in baseline.items()):
            return int(round_number)
    return None


def _economy_type(
    *,
    equipment_value: int,
    money_spent: int,
    start_money: int,
    round_number: int,
    halftime_round: Optional[int],
) -> str:
    if round_number == 1 or (halftime_round is not None and round_number == halftime_round):
        return "pistol"
    if equipment_value >= 4000:
        return "full"
    if money_spent < 1000 and equipment_value < 1000:
        return "eco"
    if start_money > 0 and money_spent / start_money >= 0.80:
        return "force"
    return "semi"


def _team_economy_vote(values: Iterable[str]) -> str:
    value_list = [value for value in values if value in _ECONOMY_ORDER]
    if not value_list:
        return "semi"
    counts = Counter(value_list)
    best = max(counts.values())
    return next(value for value in _ECONOMY_ORDER if counts[value] == best)


def _build_player_team_map(
    roster: list[dict[str, Any]],
    name_to_final_team: dict[str, int],
    team_a_group: Optional[int],
    team_b_group: Optional[int],
) -> dict[str, str]:
    out: dict[str, str] = {}
    for player in roster:
        name = _clean_name(player.get("name"))
        if not name:
            continue
        final_team = name_to_final_team.get(name.lower(), player.get("team_num"))
        key = _team_key_for_group(final_team, team_a_group, team_b_group)
        if key:
            out[name.lower()] = key
    for name, final_team in name_to_final_team.items():
        key = _team_key_for_group(final_team, team_a_group, team_b_group)
        if key:
            out.setdefault(name.lower(), key)
    return out


def _build_round_windows(
    *,
    round_freeze_end_ticks: dict[int, int],
    round_freeze_start_ticks: dict[int, int],
    round_end_tick_map: dict[int, int],
    re_df: pd.DataFrame,
    match_start_tick: int,
    tick_rate: float = 64.0,
    demo_end_tick: int = 0,
) -> list[dict[str, Any]]:
    winner_side_by_round: dict[int, int] = {}
    reason_by_round: dict[int, str] = {}
    end_tick_by_round = dict(round_end_tick_map)
    if re_df is not None and not re_df.empty:
        work = re_df
        if match_start_tick > 0 and "tick" in work.columns:
            work = work.loc[pd.to_numeric(work["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
        if "tick" in work.columns:
            work = work.sort_values("tick", kind="mergesort")
        sequence = 0
        best: dict[int, pd.Series] = {}
        for _, row in work.iterrows():
            raw_round = row.get("total_rounds_played")
            if raw_round is None or (isinstance(raw_round, float) and pd.isna(raw_round)):
                sequence += 1
                round_number = sequence
            else:
                round_number = _int(raw_round)
            tick = _int(row.get("tick"))
            if round_number <= 0 or tick <= 0:
                continue
            previous = best.get(round_number)
            if previous is None or tick >= _int(previous.get("tick")):
                best[round_number] = row
        for round_number, row in best.items():
            winner = _round_end_winner_team_num(row.get("winner"))
            if winner in (2, 3):
                winner_side_by_round[round_number] = int(winner)
            reason_by_round[round_number] = _clean_name(row.get("reason"))
            end_tick_by_round[round_number] = _int(row.get("tick"))

    numbers = sorted(set(round_freeze_end_ticks) | set(end_tick_by_round) | set(winner_side_by_round))
    out: list[dict[str, Any]] = []
    for round_number in numbers:
        freeze_tick = _int(round_freeze_end_ticks.get(round_number))
        end_tick = _int(end_tick_by_round.get(round_number))
        if freeze_tick <= 0 or end_tick <= freeze_tick:
            continue
        start_tick = _int(round_freeze_start_ticks.get(round_number), freeze_tick)
        out.append({
            "round_number": int(round_number),
            "start_tick": start_tick if start_tick > 0 else freeze_tick,
            "freeze_end_tick": freeze_tick,
            "round_end_tick": end_tick,
            "end_tick": end_tick,
            "winner_side": winner_side_by_round.get(round_number),
            "end_reason": reason_by_round.get(round_number) or None,
        })
    # `round_end` is the decision tick, not the end of the visible round.  Keep
    # the post-round sequence through the tick immediately before the next
    # freeze period so replay reaches the same final state as the Demo.
    for index in range(len(out) - 1):
        next_start_tick = _int(out[index + 1].get("start_tick"))
        if next_start_tick > _int(out[index].get("end_tick")):
            out[index]["end_tick"] = next_start_tick - 1
    if out:
        # The final round has no following freeze period from which to derive its
        # visible result phase. Keep up to three seconds after round_end so the
        # last kill/death feedback is actually present in the 2D replay.
        final = out[-1]
        raw_end = _int(final.get("round_end_tick") or final.get("end_tick"))
        tail_end = raw_end + max(1, int(round(float(tick_rate or 64.0) * 3.0)))
        eof_tick = _int(demo_end_tick)
        if eof_tick > raw_end:
            tail_end = min(tail_end, eof_tick)
            final["end_tick"] = max(_int(final.get("end_tick")), tail_end)
    for window in out:
        window["record_end_tick"] = _int(window.get("end_tick"))
    return out


def _events_by_round(
    events: pd.DataFrame,
    planted_df: pd.DataFrame,
    defused_df: pd.DataFrame,
    exploded_df: pd.DataFrame,
    dropped_df: pd.DataFrame,
    bomb_pickup_df: pd.DataFrame,
    windows: list[dict[str, Any]],
    nade_batch: Optional[dict[str, pd.DataFrame]] = None,
) -> dict[int, list[dict[str, Any]]]:
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    if events is not None and not events.empty:
        for _, row in events.iterrows():
            attacker = _clean_name(row.get("attacker_name"))
            victim = _clean_name(row.get("user_name") or row.get("player_name"))
            tick = _int(row.get("tick"))
            if not victim or tick <= 0:
                continue
            payload: dict[str, Any] = {
                "type": "kill",
                "tick": tick,
                "actor": attacker or "World",
                "target": victim,
                "weapon": _normalize_weapon(row.get("weapon")),
                "headshot": _bool(row.get("headshot")),
                "assister": _clean_name(row.get("assister_name")),
            }
            for role, prefixes in (
                ("actor", ("attacker_", "attacker")),
                ("target", ("user_", "player_", "victim_")),
            ):
                for prefix in prefixes:
                    x = _float(row.get(f"{prefix}X", row.get(f"{prefix}x")), float("nan"))
                    y = _float(row.get(f"{prefix}Y", row.get(f"{prefix}y")), float("nan"))
                    z = _float(row.get(f"{prefix}Z", row.get(f"{prefix}z")), float("nan"))
                    if not pd.isna(x) and not pd.isna(y):
                        payload[f"{role}_x"] = round(x, 2)
                        payload[f"{role}_y"] = round(y, 2)
                        if not pd.isna(z):
                            payload[f"{role}_z"] = round(z, 2)
                        break
            round_number = _round_number_for_tick(tick, windows, row)
            if round_number > 0:
                out[round_number].append(payload)

    # ``bomb_planted.site`` is a per-map entity id rather than an A/B enum.
    # The engine's place name is map-agnostic and reports BombsiteA/B.
    planted_site_by_round: dict[int, str] = {}
    for frame, event_type in (
        (planted_df, "plant"),
        (defused_df, "defuse"),
        (exploded_df, "explode"),
        (dropped_df, "bomb_drop"),
        (bomb_pickup_df, "bomb_pickup"),
    ):
        if frame is None or frame.empty:
            continue
        for _, row in frame.iterrows():
            tick = _int(row.get("tick"))
            if tick <= 0:
                continue
            round_number = _round_number_for_tick(tick, windows, row)
            if round_number <= 0:
                continue
            place = _clean_name(
                row.get("user_last_place_name")
                or row.get("player_last_place_name")
                or row.get("last_place_name")
            ).lower()
            site = "A" if place == "bombsitea" else "B" if place == "bombsiteb" else ""
            if not site:
                raw_site = _clean_name(row.get("site")).strip().upper()
                site = raw_site if raw_site in {"A", "B"} else ""
            if event_type == "plant" and site:
                planted_site_by_round[round_number] = site
            elif not site:
                site = planted_site_by_round.get(round_number, "")
            payload: dict[str, Any] = {
                "type": event_type,
                "tick": tick,
                "actor": _clean_name(row.get("user_name") or row.get("player_name") or row.get("defuser")),
                "site": site,
            }
            x = _float(row.get("user_X", row.get("player_X", row.get("X"))), float("nan"))
            y = _float(row.get("user_Y", row.get("player_Y", row.get("Y"))), float("nan"))
            z = _float(row.get("user_Z", row.get("player_Z", row.get("Z"))), float("nan"))
            if not pd.isna(x) and not pd.isna(y):
                payload["x"] = round(x, 2)
                payload["y"] = round(y, 2)
                if not pd.isna(z):
                    payload["z"] = round(z, 2)
            out[round_number].append(payload)

    grenade_labels = {
        "hegrenade_detonate": "HE 手雷",
        "inferno_startburn": "燃烧弹",
        "molotov_detonate": "燃烧弹",
        "smokegrenade_detonate": "烟雾弹",
        "flashbang_detonate": "闪光弹",
    }
    for event_name, frame in (nade_batch or {}).items():
        if frame is None or frame.empty:
            continue
        for _, row in frame.iterrows():
            tick = _int(row.get("tick"))
            if tick <= 0:
                continue
            x = _float(
                row.get("x", row.get("X", row.get("user_X", row.get("player_X")))),
                float("nan"),
            )
            y = _float(
                row.get("y", row.get("Y", row.get("user_Y", row.get("player_Y")))),
                float("nan"),
            )
            z = _float(
                row.get("z", row.get("Z", row.get("user_Z", row.get("player_Z")))),
                float("nan"),
            )
            payload: dict[str, Any] = {
                "type": "grenade",
                "kind": grenade_labels.get(event_name, event_name),
                "tick": tick,
                "actor": _clean_name(row.get("user_name") or row.get("player_name") or row.get("name")),
            }
            if not pd.isna(x) and not pd.isna(y):
                payload["x"] = round(x, 2)
                payload["y"] = round(y, 2)
                if not pd.isna(z):
                    payload["z"] = round(z, 2)
            round_number = _round_number_for_tick(tick, windows, row)
            if round_number > 0:
                out[round_number].append(payload)

    for round_number, rows in list(out.items()):
        rows.sort(key=lambda item: (int(item.get("tick") or 0), str(item.get("type") or "")))
        deduped: list[dict[str, Any]] = []
        seen: set[tuple[Any, ...]] = set()
        terminal_seen: set[str] = set()
        for event in rows:
            event_type = str(event.get("type") or "")
            if event_type in {"explode", "defuse"}:
                if event_type in terminal_seen:
                    continue
                terminal_seen.add(event_type)
            identity = (
                event_type,
                _int(event.get("tick")),
                _clean_name(event.get("actor")).lower(),
                _clean_name(event.get("target")).lower(),
                _clean_name(event.get("kind")),
            )
            if identity in seen:
                continue
            seen.add(identity)
            deduped.append(event)
        out[round_number] = deduped
    return out


def _shots_by_round(
    fire_df: pd.DataFrame,
    windows: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    """Build lightweight weapon-fire rays for the 2D replay."""
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    if fire_df is None or fire_df.empty:
        return out
    for _, row in fire_df.iterrows():
        tick = _int(row.get("tick"))
        round_number = _round_number_for_tick(tick, windows, row)
        actor = _clean_name(row.get("user_name") or row.get("player_name") or row.get("name"))
        weapon = _normalize_weapon(row.get("weapon"))
        if tick <= 0 or round_number <= 0 or not actor or weapon in _NON_BULLET_WEAPONS:
            continue
        shot: dict[str, Any] = {
            "tick": tick,
            "actor": actor,
            "weapon": weapon,
            "yaw": round(_float(row.get("user_yaw", row.get("player_yaw", row.get("yaw")))), 2),
            "pitch": round(_float(row.get("user_pitch", row.get("player_pitch", row.get("pitch")))), 2),
        }
        x = _float(row.get("user_X", row.get("player_X", row.get("X"))), float("nan"))
        y = _float(row.get("user_Y", row.get("player_Y", row.get("Y"))), float("nan"))
        z = _float(row.get("user_Z", row.get("player_Z", row.get("Z"))), float("nan"))
        if not pd.isna(x) and not pd.isna(y):
            shot["x"] = round(x, 2)
            shot["y"] = round(y, 2)
            if not pd.isna(z):
                shot["z"] = round(z, 2)
        out[round_number].append(shot)
    for shots in out.values():
        shots.sort(key=lambda item: _int(item.get("tick")))
    return out


def _grenade_throws_by_round(
    fire_df: Optional[pd.DataFrame],
    windows: list[dict[str, Any]],
) -> dict[tuple[int, str], list[dict[str, Any]]]:
    """Return the authoritative grenade release events from ``weapon_fire``.

    Projectile entities can first become visible several ticks after the throw
    event.  Keeping the release position here lets the replay draw that short
    initial part of the flight instead of making a moving player appear to
    throw from their later position.
    """
    out: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    if fire_df is None or fire_df.empty:
        return out
    for _, row in fire_df.iterrows():
        tick = _int(row.get("tick"))
        kind = _GRENADE_WEAPON_KINDS.get(_normalize_weapon(row.get("weapon")))
        round_number = _round_number_for_tick(tick, windows, row)
        actor = _clean_name(row.get("user_name") or row.get("player_name") or row.get("name"))
        if tick <= 0 or round_number <= 0 or not kind or not actor:
            continue
        release: dict[str, Any] = {
            "tick": tick,
            "actor": actor,
            "steamid64": _clean_name(
                row.get("user_steamid") or row.get("player_steamid") or row.get("steamid")
            ),
        }
        x = _float(row.get("user_X", row.get("player_X", row.get("X"))), float("nan"))
        y = _float(row.get("user_Y", row.get("player_Y", row.get("Y"))), float("nan"))
        z = _float(row.get("user_Z", row.get("player_Z", row.get("Z"))), float("nan"))
        if not pd.isna(x) and not pd.isna(y):
            release["x"] = round(x, 2)
            release["y"] = round(y, 2)
            if not pd.isna(z):
                release["z"] = round(z, 2)
        out[(round_number, kind)].append(release)
    for releases in out.values():
        releases.sort(key=lambda item: _int(item.get("tick")))
    return out


def _extract_grenade_trajectories(parser: Any, tick_rate: float) -> list[dict[str, Any]]:
    """Compact demoparser projectile rows into real per-throw flight paths."""
    if parser is None:
        return []
    try:
        frame = _to_pandas_df(parser.parse_grenades())
    except BaseException:
        return []
    required = {"grenade_type", "grenade_entity_id", "tick", "x", "y"}
    if frame is None or frame.empty or not required.issubset(frame.columns):
        return []
    try:
        work = frame.loc[frame["grenade_type"].isin(_GRENADE_PROJECTILES)].copy()
        for column in ("tick", "x", "y", "z"):
            if column not in work.columns:
                continue
            work[column] = pd.to_numeric(work[column], errors="coerce")
        work = work.dropna(subset=["tick", "x", "y"])
        if work.empty:
            return []
        work = work.sort_values(["grenade_entity_id", "tick"], kind="mergesort")
        gap = max(32, int(round(float(tick_rate) * 1.25)))
        segment = (
            work["grenade_entity_id"].ne(work["grenade_entity_id"].shift())
            | work["tick"].sub(work["tick"].shift()).gt(gap)
        ).cumsum()
        work["_segment"] = segment
    except (KeyError, TypeError, ValueError):
        return []

    trajectories: list[dict[str, Any]] = []
    for _, rows in work.groupby("_segment", sort=False):
        if rows.empty:
            continue
        first = rows.iloc[0]
        kind = _GRENADE_PROJECTILES.get(str(first.get("grenade_type") or ""))
        if not kind:
            continue
        # demoparser2 keeps smoke projectile entities alive at their landing
        # position while the cloud is active.  Keeping that stationary tail
        # makes a single throw appear to last for 18+ seconds and can cause it
        # to be matched to a later smoke detonation.  Retain one landing row,
        # but discard the repeated stationary samples before matching/events.
        if kind == "烟雾弹" and len(rows) > 2:
            movement = (
                rows[["x", "y"]]
                .diff()
                .pow(2)
                .sum(axis=1)
                .pow(0.5)
                .tolist()
            )
            moving_positions = [index for index, distance in enumerate(movement) if float(distance or 0) > 0.05]
            if moving_positions:
                landing_end = min(len(rows), moving_positions[-1] + 2)
                rows = rows.iloc[:landing_end]
        count = len(rows)
        stride = max(1, math.ceil(count / 56))
        sampled = rows.iloc[::stride]
        if sampled.index[-1] != rows.index[-1]:
            sampled = pd.concat([sampled, rows.iloc[[-1]]])
        points = []
        for _, row in sampled.iterrows():
            point = {
                "tick": int(row["tick"]),
                "x": round(float(row["x"]), 2),
                "y": round(float(row["y"]), 2),
            }
            z = row.get("z")
            if z is not None and not pd.isna(z):
                point["z"] = round(float(z), 2)
            points.append(point)
        trajectories.append({
            "kind": kind,
            "actor": _clean_name(first.get("name")),
            "steamid64": _clean_name(first.get("steamid")),
            "throw_tick": int(rows.iloc[0]["tick"]),
            "end_tick": int(rows.iloc[-1]["tick"]),
            "points": points,
        })
    return trajectories


def _enrich_grenade_events(
    events_by_round: dict[int, list[dict[str, Any]]],
    trajectories: list[dict[str, Any]],
    windows: list[dict[str, Any]],
    tick_rate: float,
    fire_df: Optional[pd.DataFrame] = None,
) -> None:
    if not trajectories:
        return
    by_round_kind: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for trajectory in trajectories:
        throw_tick = _int(trajectory.get("throw_tick"))
        window = next((row for row in windows if _int(row.get("start_tick")) <= throw_tick <= _int(row.get("end_tick"))), None)
        if window is not None:
            by_round_kind[(_int(window.get("round_number")), _clean_name(trajectory.get("kind")))].append(trajectory)

    releases_by_round_kind = _grenade_throws_by_round(fire_df, windows)
    used: set[int] = set()
    used_releases: set[int] = set()
    tolerance = max(32, int(round(float(tick_rate) * 2.0)))
    # Real demos observed so far expose the projectile 6-14 ticks after
    # weapon_fire. Keep this bounded so a grenade selected/primed during
    # freeze time cannot stretch into a fake multi-second flight path.
    release_tolerance = max(8, int(round(float(tick_rate) * 0.75)))
    for round_number, events in events_by_round.items():
        for event in events:
            if event.get("type") != "grenade":
                continue
            event_tick = _int(event.get("tick"))
            actor = _clean_name(event.get("actor")).lower()
            candidates = []
            for candidate in by_round_kind.get((round_number, _clean_name(event.get("kind"))), []):
                identity = id(candidate)
                if identity in used or _int(candidate.get("throw_tick")) > event_tick:
                    continue
                candidate_actor = _clean_name(candidate.get("actor")).lower()
                if actor and candidate_actor and candidate_actor != actor:
                    continue
                end_delta = abs(_int(candidate.get("end_tick")) - event_tick)
                if end_delta > tolerance:
                    continue
                candidates.append((end_delta, candidate))
            if not candidates:
                continue
            _, matched = min(candidates, key=lambda item: item[0])
            used.add(id(matched))
            trajectory = [dict(point) for point in (matched.get("points") or [])]
            trajectory.sort(key=lambda point: _int(point.get("tick")))
            throw_tick = _int(matched.get("throw_tick"))

            release_candidates = []
            trajectory_actor = _clean_name(matched.get("actor")).lower()
            trajectory_steamid = _clean_name(matched.get("steamid64"))
            for release in releases_by_round_kind.get(
                (round_number, _clean_name(event.get("kind"))),
                [],
            ):
                identity = id(release)
                release_tick = _int(release.get("tick"))
                if identity in used_releases or release_tick > throw_tick:
                    continue
                delta = throw_tick - release_tick
                if delta > release_tolerance:
                    continue
                release_actor = _clean_name(release.get("actor")).lower()
                if actor and release_actor and release_actor != actor:
                    continue
                if trajectory_actor and release_actor and release_actor != trajectory_actor:
                    continue
                release_steamid = _clean_name(release.get("steamid64"))
                if trajectory_steamid and release_steamid and release_steamid != trajectory_steamid:
                    continue
                release_x = _float(release.get("x"), float("nan"))
                release_y = _float(release.get("y"), float("nan"))
                if pd.isna(release_x) or pd.isna(release_y):
                    continue
                release_candidates.append((delta, release))

            if release_candidates and trajectory:
                _, release = min(release_candidates, key=lambda item: item[0])
                used_releases.add(id(release))
                first = trajectory[0]
                release_tick = _int(release.get("tick"))
                if release_tick < _int(first.get("tick")):
                    release_point = {
                        "tick": release_tick,
                        "x": round(_float(release.get("x")), 2),
                        "y": round(_float(release.get("y")), 2),
                    }
                    # Player event Z is feet height; the projectile's first Z
                    # preserves the correct radar floor while X/Y come from
                    # the actual release position.
                    first_z = _float(first.get("z"), float("nan"))
                    release_z = _float(release.get("z"), float("nan"))
                    if not pd.isna(first_z):
                        release_point["z"] = round(first_z, 2)
                    elif not pd.isna(release_z):
                        release_point["z"] = round(release_z, 2)
                    trajectory.insert(0, release_point)
                    throw_tick = release_tick

            event["throw_tick"] = throw_tick
            event["trajectory"] = trajectory


def _initial_bomb_carrier(events: list[dict[str, Any]]) -> str:
    for event in events:
        if event.get("type") in {"bomb_pickup", "bomb_drop", "plant"}:
            actor = _clean_name(event.get("actor"))
            if actor:
                return actor
    return ""


def _trade_pairs(kills: list[dict[str, Any]], player_team: dict[str, str]) -> tuple[set[int], set[int]]:
    trade_kill_indexes: set[int] = set()
    traded_death_indexes: set[int] = set()
    for index, kill in enumerate(kills):
        killer = _clean_name(kill.get("actor"))
        victim = _clean_name(kill.get("target"))
        if not killer or not victim or killer == victim:
            continue
        victim_team = player_team.get(victim.lower())
        for next_index in range(index + 1, len(kills)):
            reply = kills[next_index]
            delta = _int(reply.get("tick")) - _int(kill.get("tick"))
            if delta > _TRADE_WINDOW_TICKS:
                break
            reply_killer = _clean_name(reply.get("actor"))
            reply_victim = _clean_name(reply.get("target"))
            if reply_victim != killer:
                continue
            if victim_team and player_team.get(reply_killer.lower()) != victim_team:
                continue
            trade_kill_indexes.add(next_index)
            traded_death_indexes.add(index)
            break
    return trade_kill_indexes, traded_death_indexes


def _hurt_damage_value(row: pd.Series) -> int:
    for column in ("dmg_health", "health_damage", "damage"):
        if column in row.index and row.get(column) is not None and not (isinstance(row.get(column), float) and pd.isna(row.get(column))):
            return max(0, _int(row.get(column)))
    return 0


def _accumulate_capped_damage(
    hurt_df: pd.DataFrame,
    player_team: dict[str, str],
    windows: list[dict[str, Any]],
) -> tuple[dict[str, int], dict[str, int]]:
    """Sum enemy health damage with overkill capped to remaining HP.

    demoparser2 often reports weapon damage in ``dmg_health`` (e.g. 123 on a
    kill from 100 HP). HLTV-style ADR only counts the HP actually removed.
    """
    total: dict[str, int] = defaultdict(int)
    utility: dict[str, int] = defaultdict(int)
    if hurt_df is None or hurt_df.empty:
        return total, utility

    freeze_ticks = sorted(
        _int(window.get("freeze_end_tick"))
        for window in windows
        if _int(window.get("freeze_end_tick")) > 0
    )
    hp_by_victim: dict[str, int] = {}
    freeze_index = 0
    work = hurt_df
    if "tick" in work.columns:
        work = work.sort_values("tick", kind="mergesort")

    for _, row in work.iterrows():
        tick = _int(row.get("tick"))
        while freeze_index < len(freeze_ticks) and freeze_ticks[freeze_index] <= tick:
            hp_by_victim.clear()
            freeze_index += 1

        attacker = _clean_name(row.get("attacker_name"))
        victim = _clean_name(row.get("user_name"))
        victim_key = (
            _clean_name(row.get("user_steamid"))
            or victim.lower()
        )
        health_after = max(0, _int(row.get("health"))) if "health" in row.index else None

        if not attacker or not victim or attacker == victim:
            if victim_key and health_after is not None:
                hp_by_victim[victim_key] = health_after
            continue

        atk_key = attacker.lower()
        if player_team.get(atk_key) and player_team.get(atk_key) == player_team.get(victim.lower()):
            if victim_key and health_after is not None:
                hp_by_victim[victim_key] = health_after
            continue

        raw_damage = _hurt_damage_value(row)
        previous_hp = hp_by_victim.get(victim_key, 100)
        dealt = min(raw_damage, max(0, previous_hp))
        if victim_key:
            hp_by_victim[victim_key] = health_after if health_after is not None else max(0, previous_hp - dealt)
        if dealt <= 0:
            continue
        total[atk_key] += dealt
        if _normalize_weapon(row.get("weapon")) in _UTILITY_WEAPONS:
            utility[atk_key] += dealt
    return total, utility


def _note_clutch_solos(
    alive_by_team: dict[str, set[str]],
    clutch_attempted: set[str],
    clutch_opponents: dict[str, int] | None = None,
) -> None:
    for team_key, members in alive_by_team.items():
        if len(members) != 1:
            continue
        solo = next(iter(members))
        enemy_key = "b" if team_key == "a" else "a"
        enemy_count = len(alive_by_team.get(enemy_key, ()))
        if enemy_count >= 1:
            clutch_attempted.add(solo)
            if clutch_opponents is not None:
                prev = clutch_opponents.get(solo)
                if prev is None or enemy_count > prev:
                    clutch_opponents[solo] = enemy_count


def _player_stats(
    *,
    roster: list[dict[str, Any]],
    player_results: dict[str, Any],
    events_by_round: dict[int, list[dict[str, Any]]],
    hurt_df: pd.DataFrame,
    player_team: dict[str, str],
    round_numbers: list[int],
    economy_rows_by_player: dict[str, list[dict[str, Any]]],
    windows: list[dict[str, Any]] | None = None,
    round_winner_team: dict[int, Optional[str]] | None = None,
) -> tuple[list[dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    names: list[str] = []
    roster_by_name: dict[str, dict[str, Any]] = {}
    for row in roster:
        name = _clean_name(row.get("name"))
        if name and name.lower() not in roster_by_name:
            names.append(name)
            roster_by_name[name.lower()] = row
    for name in player_results:
        clean = _clean_name(name)
        if clean and clean.lower() not in roster_by_name:
            names.append(clean)
            roster_by_name[clean.lower()] = {}

    display_name_by_key = {name.lower(): name for name in names}

    rounds_with_kill: dict[str, set[int]] = defaultdict(set)
    rounds_with_death: dict[str, set[int]] = defaultdict(set)
    rounds_with_assist: dict[str, set[int]] = defaultdict(set)
    rounds_traded: dict[str, set[int]] = defaultdict(set)
    counters: dict[str, Counter] = defaultdict(Counter)
    multi_kills: dict[str, Counter] = defaultdict(Counter)
    winners = round_winner_team or {}
    special_events_by_round: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for round_number in round_numbers:
        kills = [event for event in events_by_round.get(round_number, []) if event.get("type") == "kill"]
        trade_kills, traded_deaths = _trade_pairs(kills, player_team)
        kills_this_round: Counter = Counter()
        valid_kill_indexes: list[int] = []
        alive_by_team: dict[str, set[str]] = {"a": set(), "b": set()}
        for player_key, team_key in player_team.items():
            if team_key in alive_by_team:
                alive_by_team[team_key].add(player_key)
        clutch_attempted: set[str] = set()
        clutch_opponents: dict[str, int] = {}
        _note_clutch_solos(alive_by_team, clutch_attempted, clutch_opponents)

        for index, kill in enumerate(kills):
            killer = _clean_name(kill.get("actor"))
            victim = _clean_name(kill.get("target"))
            assister = _clean_name(kill.get("assister"))
            if victim:
                counters[victim.lower()]["deaths"] += 1
                rounds_with_death[victim.lower()].add(round_number)
                victim_key = victim.lower()
                victim_team = player_team.get(victim_key)
                if victim_team in alive_by_team:
                    alive_by_team[victim_team].discard(victim_key)
                _note_clutch_solos(alive_by_team, clutch_attempted, clutch_opponents)
            if killer and victim and killer != victim and killer.lower() != "world":
                key = killer.lower()
                counters[key]["kills"] += 1
                rounds_with_kill[key].add(round_number)
                kills_this_round[key] += 1
                valid_kill_indexes.append(index)
                if kill.get("headshot"):
                    counters[key]["headshots"] += 1
                if _normalize_weapon(kill.get("weapon")) == "awp":
                    counters[key]["awp_kills"] += 1
                if index in trade_kills:
                    counters[key]["trade_kills"] += 1
            if assister and assister not in {killer, victim}:
                counters[assister.lower()]["assists"] += 1
                rounds_with_assist[assister.lower()].add(round_number)
            if index in traded_deaths and victim:
                counters[victim.lower()]["trade_deaths"] += 1
                rounds_traded[victim.lower()].add(round_number)

        winner_key = winners.get(round_number)
        for solo_key in clutch_attempted:
            counters[solo_key]["clutch_attempts"] += 1
            if winner_key and player_team.get(solo_key) == winner_key:
                counters[solo_key]["clutch_wins"] += 1
            opponents = clutch_opponents.get(solo_key)
            if opponents is not None:
                special_events_by_round[round_number].append({
                    "type": "clutch",
                    "player": display_name_by_key.get(solo_key, solo_key),
                    "team_key": player_team.get(solo_key),
                    "opponents": int(opponents),
                    "won": bool(winner_key and player_team.get(solo_key) == winner_key),
                })

        if valid_kill_indexes:
            first = kills[valid_kill_indexes[0]]
            killer = _clean_name(first.get("actor"))
            victim = _clean_name(first.get("target"))
            if killer:
                counters[killer.lower()]["first_kills"] += 1
            if victim:
                counters[victim.lower()]["first_deaths"] += 1
        for key, count in kills_this_round.items():
            multi_kills[key][min(5, count)] += 1
            if count >= 4:
                special_events_by_round[round_number].append({
                    "type": "multikill",
                    "player": display_name_by_key.get(key, key),
                    "team_key": player_team.get(key),
                    "kills": int(count),
                })

    damage_by_attacker, utility_by_attacker = _accumulate_capped_damage(
        hurt_df, player_team, windows or [],
    )
    for atk_key, damage in damage_by_attacker.items():
        counters[atk_key]["damage"] += int(damage)
    for atk_key, damage in utility_by_attacker.items():
        counters[atk_key]["utility_damage"] += int(damage)

    total_rounds = max(1, len(round_numbers))
    all_rounds = set(round_numbers)
    stats_out: list[dict[str, Any]] = []
    for name in names:
        key = name.lower()
        counter = counters[key]
        kills = int(counter["kills"])
        deaths = int(counter["deaths"])
        assists = int(counter["assists"])
        damage = int(counter["damage"])
        headshots = int(counter["headshots"])
        survived = all_rounds - rounds_with_death[key]
        kast_rounds = rounds_with_kill[key] | rounds_with_assist[key] | survived | rounds_traded[key]
        opening_duels = int(counter["first_kills"] + counter["first_deaths"])
        economy_rows = economy_rows_by_player.get(key, [])
        avg_equipment = (
            sum(int(row.get("equipment_value") or 0) for row in economy_rows) / len(economy_rows)
            if economy_rows else 0.0
        )
        roster_row = roster_by_name.get(key, {})
        stats_out.append({
            "name": name,
            "steam_id64": str(roster_row.get("steamid64") or roster_row.get("steam_id64") or "") or None,
            "team_key": player_team.get(key),
            "kills": kills,
            "deaths": deaths,
            "assists": assists,
            "kd": round(kills / max(1, deaths), 2),
            "kpr": round(kills / total_rounds, 2),
            "dpr": round(deaths / total_rounds, 2),
            "adr": round(damage / total_rounds, 1),
            "kast": round(len(kast_rounds & all_rounds) / total_rounds * 100, 1),
            "headshots": headshots,
            "hs_percent": round(headshots / max(1, kills) * 100, 1),
            "first_kills": int(counter["first_kills"]),
            "first_deaths": int(counter["first_deaths"]),
            "opening_duel_win_rate": round(counter["first_kills"] / max(1, opening_duels) * 100, 1),
            "trade_kills": int(counter["trade_kills"]),
            "trade_deaths": int(counter["trade_deaths"]),
            "trade_kill_rate": round(counter["trade_kills"] / total_rounds * 100, 1),
            "survival_rate": round(len(survived) / total_rounds * 100, 1),
            "one_kill_rounds": int(multi_kills[key][1]),
            "two_kill_rounds": int(multi_kills[key][2]),
            "three_kill_rounds": int(multi_kills[key][3]),
            "four_kill_rounds": int(multi_kills[key][4]),
            "five_kill_rounds": int(multi_kills[key][5]),
            "clutch_attempts": int(counter["clutch_attempts"]),
            "clutch_wins": int(counter["clutch_wins"]),
            "awp_kills": int(counter["awp_kills"]),
            "utility_damage": int(counter["utility_damage"]),
            "utility_damage_per_round": round(counter["utility_damage"] / total_rounds, 1),
            "average_equipment_value": round(avg_equipment),
        })
    stats_out.sort(key=lambda row: (-int(row["kills"]), -float(row["adr"]), str(row["name"]).lower()))
    return stats_out, dict(special_events_by_round)


def build_match_workspace(
    *,
    map_name: str,
    tick_rate: float,
    match_start_tick: int,
    shared_events: dict[str, Any],
    shared_facts: Any,
    player_results: dict[str, Any],
    parser: Any = None,
) -> dict[str, Any]:
    """Build the six analysis views from the analyzer's existing shared scan.

    The calculations follow the same principles as cs2-demo-analysis-kit: formal
    active-round windows, first-duel/trade/KAST aggregation, and player-voted
    economy types. No DAK package or exported bundle is required at runtime.
    """
    roster = shared_facts.roster_snapshot()
    group_side_by_round = shared_events.get("group_side_by_round_shared") or {}
    team_a_group, team_b_group = _first_side_groups(group_side_by_round)
    player_team = _build_player_team_map(
        roster,
        shared_events.get("name_to_final_team_shared") or {},
        team_a_group,
        team_b_group,
    )

    windows = _build_round_windows(
        round_freeze_end_ticks=shared_events.get("round_freeze_end_ticks_shared") or {},
        round_freeze_start_ticks=shared_events.get("round_freeze_start_ticks_shared") or {},
        round_end_tick_map=shared_facts.round_end_tick_map,
        re_df=shared_events.get("re_df_cached"),
        match_start_tick=match_start_tick,
        tick_rate=tick_rate,
        demo_end_tick=int(
            getattr(shared_facts, "demo_end_tick", getattr(shared_facts, "demo_max_tick", 0)) or 0
        ),
    )
    round_numbers = [int(row["round_number"]) for row in windows]
    halftime_round = _detect_halftime_round(group_side_by_round)
    team_a_score, team_b_score, match_date, duration_mins, team_a_name, team_b_name = shared_facts.match_summary
    team_a_label = _clean_name(team_a_name) or "A 队"
    team_b_label = _clean_name(team_b_name) or "B 队"

    economy_rows_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    economy_types_by_round_team: dict[tuple[int, str], list[str]] = defaultdict(list)
    economy_tick_to_round = shared_events.get("tick_to_round_shared") or {}
    economy_df = shared_events.get("economy_ticks_df")
    name_to_final_team = shared_events.get("name_to_final_team_shared") or {}
    if economy_df is not None and not economy_df.empty and "tick" in economy_df.columns:
        for _, row in economy_df.iterrows():
            round_number = economy_tick_to_round.get(_int(row.get("tick")))
            name = _clean_name(row.get("name"))
            if not round_number or not name:
                continue
            group = name_to_final_team.get(name.lower())
            team_key = _team_key_for_group(group, team_a_group, team_b_group) or player_team.get(name.lower())
            if not team_key:
                continue
            equipment = max(0, _int(row.get("current_equip_value")))
            spent = max(0, _int(row.get("cash_spent_this_round")))
            start_money = max(0, _int(row.get("start_balance")))
            eco_type = _economy_type(
                equipment_value=equipment,
                money_spent=spent,
                start_money=start_money,
                round_number=int(round_number),
                halftime_round=halftime_round,
            )
            payload = {
                "round_number": int(round_number),
                "equipment_value": equipment,
                "money_spent": spent,
                "start_money": start_money,
                "type": eco_type,
            }
            economy_rows_by_player[name.lower()].append(payload)
            economy_types_by_round_team[(int(round_number), team_key)].append(eco_type)

    raw_events_by_round = _events_by_round(
        shared_events.get("events"),
        shared_events.get("planted_df"),
        shared_events.get("defused_df"),
        shared_events.get("bomb_exploded_df"),
        shared_events.get("bomb_dropped_df"),
        shared_events.get("bomb_pickup_df"),
        windows,
        shared_events.get("nade_batch"),
    )
    shots_by_round = _shots_by_round(shared_events.get("fire_df"), windows)
    _enrich_grenade_events(
        raw_events_by_round,
        _extract_grenade_trajectories(parser, tick_rate),
        windows,
        tick_rate,
        shared_events.get("fire_df"),
    )

    round_winner_team: dict[int, Optional[str]] = {}
    for window in windows:
        round_number = int(window["round_number"])
        group_sides = group_side_by_round.get(round_number) or {}
        if group_sides:
            side_a = group_sides.get(team_a_group) if team_a_group is not None else 2
            side_b = group_sides.get(team_b_group) if team_b_group is not None else 3
        else:
            opening_half = round_number <= 12
            side_a = 2 if opening_half else 3
            side_b = 3 if opening_half else 2
        winner_side = window.get("winner_side")
        winner_group = next((group for group, side in group_sides.items() if side == winner_side), None)
        winner_key = _team_key_for_group(winner_group, team_a_group, team_b_group)
        if winner_key not in {"a", "b"}:
            winner_key = "a" if winner_side == side_a else "b" if winner_side == side_b else None
        round_winner_team[round_number] = winner_key

    stats, special_events_by_round = _player_stats(
        roster=roster,
        player_results=player_results,
        events_by_round=raw_events_by_round,
        hurt_df=shared_events.get("hurt_df"),
        player_team=player_team,
        round_numbers=round_numbers,
        economy_rows_by_player=economy_rows_by_player,
        windows=windows,
        round_winner_team=round_winner_team,
    )
    stats_by_name = {str(row["name"]).lower(): row for row in stats}

    economy_map = shared_events.get("economy_map_shared") or {}
    team_scores = {"a": 0, "b": 0}
    rounds_out: list[dict[str, Any]] = []
    for window in windows:
        round_number = int(window["round_number"])
        group_sides = group_side_by_round.get(round_number) or {}
        if group_sides:
            side_a = group_sides.get(team_a_group) if team_a_group is not None else 2
            side_b = group_sides.get(team_b_group) if team_b_group is not None else 3
        else:
            # Some demos do not expose a stable group-side map.  The workspace
            # still keeps team A as the opening T side, then swaps at halftime.
            opening_half = round_number <= 12
            side_a = 2 if opening_half else 3
            side_b = 3 if opening_half else 2
        winner_side = window.get("winner_side")
        winner_group = next((group for group, side in group_sides.items() if side == winner_side), None)
        winner_key = _team_key_for_group(winner_group, team_a_group, team_b_group)
        if winner_key not in {"a", "b"}:
            winner_key = "a" if winner_side == side_a else "b" if winner_side == side_b else None
        score_before = dict(team_scores)
        if winner_key in team_scores:
            team_scores[winner_key] += 1

        values_by_side = economy_map.get(round_number) or {}
        equipment_a = max(0, _int(values_by_side.get(side_a)))
        equipment_b = max(0, _int(values_by_side.get(side_b)))
        economy_a = _team_economy_vote(economy_types_by_round_team[(round_number, "a")])
        economy_b = _team_economy_vote(economy_types_by_round_team[(round_number, "b")])

        events = [dict(event) for event in raw_events_by_round.get(round_number, [])]
        for event in events:
            event["time_text"] = _time_text(event.get("tick") or 0, window["freeze_end_tick"], tick_rate)
        kills = [event for event in events if event.get("type") == "kill" and event.get("actor") not in {"", "World"}]
        kill_counts = Counter(_clean_name(event.get("actor")) for event in kills)
        top_player, top_kills = (kill_counts.most_common(1)[0] if kill_counts else ("", 0))
        plant = next((event for event in events if event.get("type") == "plant"), None)
        site = _clean_name((plant or {}).get("site"))
        winner_label = (
            team_a_label if winner_key == "a"
            else team_b_label if winner_key == "b"
            else "本回合胜方"
        )
        if top_kills >= 2:
            numeral = {2: "双", 3: "三", 4: "四", 5: "五"}.get(min(5, top_kills), str(top_kills))
            headline = f"{top_player} {numeral}杀帮助 {winner_label} 拿下回合"
        elif plant and site:
            headline = f"{winner_label} 在 {site} 区下包后赢下回合"
        else:
            headline = f"{winner_label} 赢下第 {round_number} 回合"
        tags: list[str] = []
        if kills:
            tags.append("首杀")
        if top_kills >= 2:
            tags.append(f"{top_kills}K")
        if any(event.get("headshot") for event in kills):
            tags.append("爆头")
        if plant:
            tags.append("下包")

        rounds_out.append({
            **window,
            "winner_team_key": winner_key,
            "team_a_side": "T" if side_a == 2 else "CT" if side_a == 3 else None,
            "team_b_side": "T" if side_b == 2 else "CT" if side_b == 3 else None,
            "team_a_score_before": score_before["a"],
            "team_b_score_before": score_before["b"],
            "team_a_score_after": team_scores["a"],
            "team_b_score_after": team_scores["b"],
            "team_a_equipment_value": equipment_a,
            "team_b_equipment_value": equipment_b,
            "team_a_economy": economy_a,
            "team_b_economy": economy_b,
            "site": site or None,
            "headline": headline,
            "tags": tags,
            "duration_seconds": max(0, round((window["end_tick"] - window["freeze_end_tick"]) / max(1.0, tick_rate))),
            "events": events,
            "special_events": special_events_by_round.get(round_number, []),
            "shots": [dict(shot) for shot in shots_by_round.get(round_number, [])],
            "bomb_initial_carrier": _initial_bomb_carrier(events),
        })

    try:
        from ..radar.radar_map_assets import lookup_map_data
        map_transform = lookup_map_data(map_name)
    except (KeyError, OSError):
        map_transform = None

    # Smoke/inferno area tracks are intentionally NOT stored in the workspace.
    # The whole-match replay cache extracts them once and embeds the requested
    # round's tracks in the binary replay packet.
    cosmetic_sample_ticks = {
        _int(tick)
        for window in windows
        for tick in (window.get("freeze_end_tick"), window.get("end_tick"))
        if _int(tick) > 0
    }
    for events in raw_events_by_round.values():
        cosmetic_sample_ticks.update(
            _int(event.get("tick"))
            for event in events
            if _int(event.get("tick")) > 0
        )
    try:
        from .cs2_item_catalog import build_player_cosmetic_inventory

        player_cosmetics = build_player_cosmetic_inventory(
            parser,
            sample_ticks=sorted(cosmetic_sample_ticks),
        ) if parser is not None else {}
    except Exception:  # noqa: BLE001 - optional catalog enrichment never blocks analysis
        logger.exception("build_player_cosmetic_inventory failed")
        player_cosmetics = {}

    return {
        "version": 1,
        "algorithm_version": "match-workspace-2026.08.4",
        "data_source": "demo_parser_with_derived_metrics",
        "team_assignment_source": (
            "round_side_groups" if group_side_by_round else "roster_order_fallback"
        ),
        "derived_fields": [
            "kast",
            "trade_kills",
            "trade_deaths",
            "economy_type",
            "clutch_attempts",
            "clutch_wins",
            "special_events",
            "phase_meta",
        ],
        "map_name": map_name,
        "tick_rate": float(tick_rate),
        "match_start_tick": int(match_start_tick),
        "demo_end_tick": int(
            getattr(shared_facts, "demo_end_tick", shared_facts.demo_max_tick)
        ),
        "duration_mins": int(duration_mins),
        "match_date": match_date,
        "team_a_name": team_a_name,
        "team_b_name": team_b_name,
        "team_a_score": int(team_a_score),
        "team_b_score": int(team_b_score),
        "team_a_group": team_a_group,
        "team_b_group": team_b_group,
        "map_transform": map_transform,
        "phase_meta": {
            "halftime_round": halftime_round,
            "regulation_end_round": (
                (halftime_round - 1) * 2
                if halftime_round and halftime_round > 1
                else None
            ),
        },
        "players": stats,
        "rounds": rounds_out,
        "cosmetics": {
            "version": 5,
            "ownership_source": "demo_economy_entities",
            "players": player_cosmetics,
        },
        "effect_tracks_version": 1,
        "effect_capabilities": {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
            "source": "replay_effects_api",
        },
        "effect_tracks": [],
        "effect_warnings": [],
        "summary": {
            "total_rounds": len(rounds_out),
        },
    }
