from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import (
    _to_pandas_df,
    _cell_str,
    _cell_team,
    _user_id_cell,
    _steam_id_cell,
    _pick_assister_column,
    _pick_assister_team_column,
    _int,
    _norm_steam_id,
    _DEMOPARSER_RE_RAISE,
    _get_match_start_tick,
)
from .tag_constants import TICK_RATE


def get_demo_spec_calibration_tick(dem_path: str | Path) -> int:
    """Return a tick after the real match has started, when the full player roster is present."""
    try:
        parser = DemoParser(str(dem_path))
        match_start = _get_match_start_tick(parser)
        first_death: Optional[int] = None
        try:
            de = _to_pandas_df(parser.parse_event("player_death"))
            if not de.empty and "tick" in de.columns:
                death_ticks = [
                    int(t)
                    for t in pd.to_numeric(de["tick"], errors="coerce").dropna().astype(int).tolist()
                    if int(t) >= max(0, match_start)
                ]
                if death_ticks:
                    first_death = min(death_ticks)
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
        try:
            fr = _to_pandas_df(parser.parse_event("round_freeze_end"))
            if not fr.empty and "tick" in fr.columns:
                ticks = sorted(
                    int(t)
                    for t in pd.to_numeric(fr["tick"], errors="coerce").dropna().astype(int).tolist()
                    if int(t) >= max(0, match_start)
                )
                if ticks:
                    tick = ticks[0] + int(0.5 * TICK_RATE)
                    if first_death is not None and tick >= first_death:
                        tick = max(ticks[0], first_death - int(0.5 * TICK_RATE))
                    return max(1, tick)
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
        if match_start > 0:
            return max(1, match_start + int(2 * TICK_RATE))
        if first_death is not None:
            return max(1, first_death - int(5 * TICK_RATE))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
    return 1


def _build_tick_team_lookup(parser: DemoParser, ticks: list[int]) -> dict[int, dict[str, int]]:
    """在若干 tick 上解析全场玩家 team_num + name。"""
    if not ticks:
        return {}
    uniq = sorted({int(t) for t in ticks})
    try:
        raw = parser.parse_ticks(["team_num", "name"], ticks=uniq)
        df = _to_pandas_df(raw)
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if df.empty or "tick" not in df.columns:
        return {}
    out: dict[int, dict[str, int]] = {}
    for tick, grp in df.groupby("tick"):
        name_to_team: dict[str, int] = {}
        for _, r in grp.iterrows():
            nm = _cell_str(r.get("name"))
            tm = _cell_team(r.get("team_num"))
            if nm and tm is not None:
                name_to_team[nm] = tm
        out[int(tick)] = name_to_team
    return out


def _lookup_team_at_tick(
    team_by_tick: dict[int, dict[str, int]],
    tick: int,
    player_name: str,
) -> Optional[int]:
    if not player_name:
        return None
    row = team_by_tick.get(int(tick))
    if not row:
        return None
    if player_name in row:
        return row[player_name]
    pl = player_name.lower()
    for k, v in row.items():
        if k.lower() == pl:
            return v
    return None


def build_player_name_to_user_id(parser: DemoParser, match_start_tick: int) -> dict[str, int]:
    """从 player_death 的 user_id 扩展字段建立「昵称 -> 引擎 user id」。"""
    try:
        de = _to_pandas_df(parser.parse_event("player_death", player=["user_id"]))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if de.empty:
        return {}
    if match_start_tick > 0 and "tick" in de.columns:
        de = de.loc[
            pd.to_numeric(de["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()
    out: dict[str, int] = {}
    for _, row in de.iterrows():
        vn = _cell_str(row.get("user_name"))
        vu = _user_id_cell(row.get("user_user_id"))
        if vn and vu is not None:
            out[vn] = vu
        an = _cell_str(row.get("attacker_name"))
        au = _user_id_cell(row.get("attacker_user_id"))
        if an and au is not None:
            out[an] = au
    return out


def _lookup_user_id_for_name(name_to_uid: dict[str, int], player_name: str) -> Optional[int]:
    if not player_name or not name_to_uid:
        return None
    raw = str(player_name).strip()
    if raw in name_to_uid:
        return int(name_to_uid[raw])
    low = raw.lower()
    for k, v in name_to_uid.items():
        if k.lower() == low:
            return int(v)
    return None


def build_player_name_to_steam_id(parser: DemoParser, match_start_tick: int) -> dict[str, int]:
    """player_death 中 user_steamid / attacker_steamid 汇总为「昵称 -> Steam64」。"""
    try:
        de = _to_pandas_df(parser.parse_event("player_death"))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if de.empty:
        return {}
    if match_start_tick > 0 and "tick" in de.columns:
        de = de.loc[
            pd.to_numeric(de["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()
    out: dict[str, int] = {}
    for _, row in de.iterrows():
        vn = _cell_str(row.get("user_name"))
        vs = _steam_id_cell(row.get("user_steamid"))
        if vn and vs is not None:
            out[vn] = vs
        an = _cell_str(row.get("attacker_name"))
        ast = _steam_id_cell(row.get("attacker_steamid"))
        if an and ast is not None:
            out[an] = ast
    return out


def _lookup_steam_id_for_name(name_to_sid: dict[str, int], player_name: str) -> Optional[int]:
    if not player_name or not name_to_sid:
        return None
    raw = str(player_name).strip()
    if raw in name_to_sid:
        return int(name_to_sid[raw])
    low = raw.lower()
    for k, v in name_to_sid.items():
        if k.lower() == low:
            return int(v)
    return None


def _build_all_players_roster(
    parser: DemoParser,
    match_start_tick: int,
    spec_slots: dict[str, int],
    name_to_sid: dict[str, int],
) -> list[dict]:
    """全员名单：[{name, steamid64, spec_slot, team_num}, ...]。"""
    try:
        df = _to_pandas_df(parser.parse_ticks(["name", "team_num"], ticks=[max(1, match_start_tick)]))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return []
    if df.empty:
        return []
    players: list[dict] = []
    seen: set[str] = set()
    for _, row in df.iterrows():
        name = str(row.get("name", "")).strip()
        if not name or name in seen:
            continue
        team_num = row.get("team_num")
        try:
            team_num = int(team_num)
        except (TypeError, ValueError):
            team_num = 0
        if team_num not in (2, 3):
            continue
        seen.add(name)
        sid_int = name_to_sid.get(name) or name_to_sid.get(name.lower())
        players.append({
            "name": name,
            "steamid64": str(sid_int) if sid_int is not None else "",
            "spec_slot": spec_slots.get(name.lower()),
            "team_num": team_num,
        })
    return players


def _spec_player_id_offset(
    dem_path: str | Path | None = None,
    observed_user_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> int:
    """parse_ticks 里每条玩家 user_id 与客户端 spec_player 编号之差。"""
    raw_env = os.environ.get("CS2_SPEC_PLAYER_SLOT_OFFSET")
    if raw_env is None and observed_user_ids:
        vals = [int(v) for v in observed_user_ids if int(v) >= 0]
        if vals and min(vals) == 0:
            return 1
        if vals and min(vals) >= 2 and max(vals) >= 11:
            return 1
    try:
        return max(0, int(float((raw_env or "0").strip())))
    except ValueError:
        return 0


def _spec_player_slot_from_event_user_id(
    uid: Optional[int],
    dem_path: str | Path | None = None,
    observed_user_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> Optional[int]:
    if uid is None or int(uid) < 0:
        return None
    return int(uid) + _spec_player_id_offset(dem_path, observed_user_ids)


def spec_player_extra_offset_for_gsi_failure(dem_path: str | Path, tick: int) -> int:
    """Extra fallback used only when GSI cannot expose a reliable current-player/spec mapping."""
    try:
        parser = DemoParser(str(dem_path))
        t = max(1, int(tick))
        df = _to_pandas_df(parser.parse_ticks(["user_id"], ticks=[t]))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return 0
    if df.empty or "user_id" not in df.columns:
        return 0
    vals = [
        u
        for u in (_user_id_cell(row.get("user_id")) for _, row in df.iterrows())
        if u is not None and int(u) >= 0
    ]
    if vals and min(vals) == 1 and max(vals) == 10:
        return 1
    return 0


def build_player_name_to_spec_player_slot_dict(
    parser: DemoParser,
    tick_i: int,
    dem_path: str | Path | None = None,
) -> dict[str, int]:
    """在某一 tick 快照上建立「玩家昵称(小写) -> spec_player 应传入的整数」。"""
    observed: list[int] = []
    t = max(1, int(tick_i)) if int(tick_i) <= 0 else int(tick_i)
    try:
        df = _to_pandas_df(parser.parse_ticks(["user_id", "name"], ticks=[t]))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if df.empty or "user_id" not in df.columns or "name" not in df.columns:
        return {}
    out: dict[str, int] = {}
    for _, row in df.iterrows():
        nm = _cell_str(row.get("name"))
        u = _user_id_cell(row.get("user_id"))
        if nm and u is not None:
            observed.append(u)
            out[nm.strip().lower()] = u
    off = _spec_player_id_offset(dem_path, observed)
    if off:
        out = {name: uid + off for name, uid in out.items()}
    return out


def lookup_spec_player_slot_for_name(slot_by_lower: dict[str, int], player_name: str) -> Optional[int]:
    raw = str(player_name or "").strip()
    if not raw:
        return None
    return slot_by_lower.get(raw.lower())


def _compute_spec_slot_legacy_team_steam_sort(
    dem_path: str | Path,
    tick_i: int,
    target_l: str,
) -> Optional[int]:
    """旧版启发式：(team_num, steamid) 排序；仅作无 user_id 时的回退。"""
    try:
        parser = DemoParser(str(dem_path))
        df = _to_pandas_df(
            parser.parse_ticks(["name", "steamid", "team_num"], ticks=[tick_i]),
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return None
    if df.empty or "name" not in df.columns:
        return None

    def _pick_slot_frame(frame: pd.DataFrame) -> Optional[int]:
        if frame.empty:
            return None
        work = frame.copy()
        if "steamid" in work.columns:
            work = work.drop_duplicates(subset=["steamid"], keep="first")
        sort_cols = [c for c in ("team_num", "steamid") if c in work.columns]
        if not sort_cols:
            return None
        work = work.sort_values(sort_cols, kind="mergesort").reset_index(drop=True)
        mask = work["name"].astype(str).str.strip().str.lower() == target_l
        if not mask.any():
            return None
        pos = int(mask.to_numpy().argmax())
        one_based = pos + 1
        if os.environ.get("CS2_SPEC_SLOT_ZERO_BASED", "").strip().lower() in ("1", "true", "yes"):
            return pos
        return one_based if one_based > 0 else None

    if "team_num" in df.columns:
        ct = df[df["team_num"].isin([2, 3])]
        slot = _pick_slot_frame(ct)
        if slot is not None:
            return slot
    return _pick_slot_frame(df)


def compute_spec_player_slot_one_based(
    dem_path: str | Path,
    tick: int,
    player_name: str,
) -> Optional[int]:
    """在当前 tick 快照上解析目标玩家的观战槽位，供控制台 spec_player 使用。"""
    raw = str(player_name or "").strip()
    if not raw:
        return None
    target_l = raw.lower()
    tick_i = max(0, int(tick))
    try:
        parser = DemoParser(str(dem_path))
        try:
            mst = _get_match_start_tick(parser)
            name_to_uid = build_player_name_to_user_id(parser, mst)
            event_uid = _lookup_user_id_for_name(name_to_uid, raw)
            event_slot = _spec_player_slot_from_event_user_id(event_uid, dem_path, tuple(name_to_uid.values()))
            if event_slot is not None:
                return event_slot
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
        df = _to_pandas_df(
            parser.parse_ticks(["user_id", "name", "steamid", "team_num"], ticks=[tick_i]),
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return None
    if df.empty or "name" not in df.columns:
        return None

    uid: Optional[int] = None
    if "user_id" in df.columns:
        for _, row in df.iterrows():
            nm = _cell_str(row.get("name"))
            if not nm or nm.strip().lower() != target_l:
                continue
            u = _user_id_cell(row.get("user_id"))
            if u is not None:
                uid = u
                break

    observed_tick_ids = [
        u
        for u in (_user_id_cell(row.get("user_id")) for _, row in df.iterrows())
        if u is not None
    ]
    off = _spec_player_id_offset(dem_path, observed_tick_ids)
    if uid is not None:
        return uid + off

    leg = _compute_spec_slot_legacy_team_steam_sort(dem_path, tick_i, target_l)
    return (leg + off) if leg is not None else None


def get_player_list(dem_path: str | Path) -> list[dict]:
    """扫描 Demo 所有在 player_death 出现过的玩家，汇总 K/D/A 与队伍。"""
    parser = DemoParser(str(dem_path))
    match_start_tick = _get_match_start_tick(parser)
    name_to_uid = build_player_name_to_user_id(parser, match_start_tick)
    name_to_sid = build_player_name_to_steam_id(parser, match_start_tick)
    events = pd.DataFrame()
    try:
        events = _to_pandas_df(parser.parse_event("player_death"))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return []

    if events.empty:
        return []

    tick_for_roster = (
        match_start_tick
        if match_start_tick > 0
        else max(1, _int(events["tick"].min()) if "tick" in events.columns else 1)
    )
    spec_slots = build_player_name_to_spec_player_slot_dict(parser, tick_for_roster, dem_path)

    if match_start_tick > 0 and "tick" in events.columns:
        events = events.loc[
            pd.to_numeric(events["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()
    if events.empty:
        return []

    assist_col = _pick_assister_column(events)
    assister_team_col = _pick_assister_team_column(events)

    if "tick" in events.columns:
        events = events.sort_values("tick", kind="mergesort")

    death_ticks = events["tick"].dropna().astype(int).unique().tolist()
    team_by_tick = _build_tick_team_lookup(parser, death_ticks)

    stats: dict[str, dict] = {}

    def _touch(name: str) -> dict:
        if name not in stats:
            stats[name] = {"kills": 0, "deaths": 0, "assists": 0, "team": None}
        return stats[name]

    def _set_team_if_missing(name: str, team_val: Optional[int]) -> None:
        if not name or team_val is None:
            return
        rec = _touch(name)
        if rec["team"] is None:
            rec["team"] = team_val

    for _, row in events.iterrows():
        attacker = _cell_str(row.get("attacker_name"))
        victim = _cell_str(row.get("user_name"))
        assister = _cell_str(row.get(assist_col)) if assist_col else ""
        tick = _int(row.get("tick"))

        atk_team = _cell_team(row.get("attackerteam"))
        vic_team = _cell_team(row.get("userteam"))
        ast_team = _cell_team(row.get(assister_team_col)) if assister_team_col else None

        if team_by_tick:
            if attacker:
                atk_team = _lookup_team_at_tick(team_by_tick, tick, attacker) or atk_team
            if victim:
                vic_team = _lookup_team_at_tick(team_by_tick, tick, victim) or vic_team
            if assister:
                ast_team = _lookup_team_at_tick(team_by_tick, tick, assister) or ast_team

        if attacker:
            _set_team_if_missing(attacker, atk_team)
        if victim:
            _set_team_if_missing(victim, vic_team)
        if assister:
            _set_team_if_missing(assister, ast_team)

        if victim:
            _touch(victim)["deaths"] += 1
        if attacker and attacker != victim:
            _touch(attacker)["kills"] += 1
        if assister and assister != victim:
            _touch(assister)["assists"] += 1

    names = sorted(
        stats.keys(),
        key=lambda n: (-stats[n]["kills"], n.lower()),
    )

    if match_start_tick > 0 and stats:
        try:
            fix_df = _to_pandas_df(
                parser.parse_ticks(["team_num", "name"], ticks=[match_start_tick]),
            )
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            fix_df = pd.DataFrame()
        if not fix_df.empty and "name" in fix_df.columns:
            for _, r in fix_df.iterrows():
                nm = _cell_str(r.get("name"))
                tm = _cell_team(r.get("team_num"))
                if not nm or tm is None:
                    continue
                nl = nm.lower()
                for key in stats:
                    if key.lower() == nl:
                        stats[key]["team"] = tm
                        break

    player_info_team_by_name: dict[str, int] = {}
    player_info_team_by_sid: dict[str, int] = {}
    try:
        pi = _to_pandas_df(parser.parse_player_info())
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        pi = pd.DataFrame()
    if not pi.empty and "name" in pi.columns:
        pi_team_col = next((c for c in ("team_number", "team_num", "team") if c in pi.columns), None)
        for _, r in pi.iterrows():
            nm = _cell_str(r.get("name"))
            sid = _steam_id_cell(r.get("steamid")) if "steamid" in pi.columns else None
            if nm and sid is not None:
                name_to_sid[nm] = sid
            tm = _cell_team(r.get(pi_team_col)) if pi_team_col else None
            if tm in (2, 3):
                if nm:
                    player_info_team_by_name[nm.lower()] = tm
                if sid is not None:
                    player_info_team_by_sid[str(sid)] = tm

    if stats and (player_info_team_by_name or player_info_team_by_sid):
        votes: dict[int, dict[int, int]] = {}
        for name, rec in stats.items():
            resolved_team = _cell_team(rec.get("team"))
            if resolved_team not in (2, 3):
                continue
            sid_i = _lookup_steam_id_for_name(name_to_sid, name)
            pi_team = player_info_team_by_sid.get(str(sid_i)) if sid_i is not None else None
            if pi_team is None:
                pi_team = player_info_team_by_name.get(str(name).strip().lower())
            if pi_team in (2, 3):
                bucket = votes.setdefault(pi_team, {})
                bucket[resolved_team] = bucket.get(resolved_team, 0) + 1

        player_info_to_tick_team: dict[int, int] = {}
        for pi_team, counts in votes.items():
            if counts:
                player_info_to_tick_team[pi_team] = max(counts.items(), key=lambda kv: kv[1])[0]

        for name, rec in stats.items():
            if rec.get("team") is not None:
                continue
            sid_i = _lookup_steam_id_for_name(name_to_sid, name)
            pi_team = player_info_team_by_sid.get(str(sid_i)) if sid_i is not None else None
            if pi_team is None:
                pi_team = player_info_team_by_name.get(str(name).strip().lower())
            if pi_team not in (2, 3):
                continue
            inferred_team = player_info_to_tick_team.get(pi_team, pi_team)
            if inferred_team in (2, 3):
                rec["team"] = inferred_team

    rows: list[dict] = []
    for n in names:
        sid_i = _lookup_steam_id_for_name(name_to_sid, n)
        event_uid = _lookup_user_id_for_name(name_to_uid, n)
        rows.append(
            {
                "name": n,
                "team": stats[n]["team"] if stats[n]["team"] is not None else 0,
                "kills": stats[n]["kills"],
                "deaths": stats[n]["deaths"],
                "assists": stats[n]["assists"],
                "user_id": _spec_player_slot_from_event_user_id(event_uid, dem_path, tuple(name_to_uid.values()))
                or lookup_spec_player_slot_for_name(spec_slots, n),
                "steam_id": str(sid_i) if sid_i is not None else None,
            },
        )
    return rows
