from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from ... import native_table as pd
from demoparser2 import DemoParser

from .parse_utils import (
    _to_pandas_df,
    _cell_str,
    _cell_team,
    PLAYER_TEAM_PARSE_FIELDS,
    coalesce_player_team_num,
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
from .player_identity import PlayerIdentityRegistry, player_key_for_values


_PLAYER_COLOR_NAMES = ("blue", "green", "yellow", "orange", "purple")


def _player_color_name(value: object) -> str | None:
    raw = _cell_str(value).lower()
    if raw in _PLAYER_COLOR_NAMES:
        return raw
    try:
        index = int(float(raw))
    except (TypeError, ValueError):
        return None
    return _PLAYER_COLOR_NAMES[index] if 0 <= index < len(_PLAYER_COLOR_NAMES) else None


def _is_real_steamid64(sid: object) -> bool:
    """是否为真实的 64 位 SteamID（剔除 GOTV/bot 等伪 id，如 "17"）。"""
    s = _norm_steam_id(sid)
    return bool(s) and s.isdigit() and len(s) >= 16 and s.startswith("7656")


def _player_info_team_col(pi: pd.DataFrame) -> Optional[str]:
    return next((c for c in ("team_number", "team_num", "team") if c in pi.columns), None)


def build_steam_to_team_from_player_info(
    parser: DemoParser,
    *,
    player_info_df: Optional[pd.DataFrame] = None,
) -> dict[str, int]:
    """steamid64(str) -> 末段（第二阶段）队伍号 2/3，来自 parse_player_info。

    parse_player_info 是最可靠的全员队伍来源：即便逐 tick 的 team_num 字段在某些
    国服 demo 上几乎全为空，它仍能给出完整 5v5。返回的队号为「比赛末段」所在阵营，
    用作稳定的「队伍身份」分组键（两支 5 人队整局不变，换边只改阵营号）。
    """
    try:
        pi = (
            player_info_df
            if player_info_df is not None
            else _to_pandas_df(parser.parse_player_info())
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if pi.empty or "steamid" not in pi.columns:
        return {}
    tcol = _player_info_team_col(pi)
    if tcol is None:
        return {}
    out: dict[str, int] = {}
    for _, r in pi.iterrows():
        if not _is_real_steamid64(r.get("steamid")):
            continue
        tm = _cell_team(r.get(tcol))
        if tm in (2, 3):
            out[_norm_steam_id(r.get("steamid"))] = tm
    return out


def build_name_to_team_from_player_info(
    parser: DemoParser,
    *,
    player_info_df: Optional[pd.DataFrame] = None,
) -> dict[str, int]:
    """玩家名(小写) -> 末段队伍号 2/3，来自 parse_player_info（剔除 bot/观察者）。"""
    try:
        pi = (
            player_info_df
            if player_info_df is not None
            else _to_pandas_df(parser.parse_player_info())
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return {}
    if pi.empty or "name" not in pi.columns:
        return {}
    tcol = _player_info_team_col(pi)
    if tcol is None:
        return {}
    has_sid = "steamid" in pi.columns
    out: dict[str, int] = {}
    for _, r in pi.iterrows():
        if has_sid and not _is_real_steamid64(r.get("steamid")):
            continue
        nm = _cell_str(r.get("name")).strip().lower()
        tm = _cell_team(r.get(tcol))
        if nm and tm in (2, 3):
            out[nm] = tm
    return out


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
        raw = parser.parse_ticks(PLAYER_TEAM_PARSE_FIELDS + ["name"], ticks=uniq)
        df = coalesce_player_team_num(_to_pandas_df(raw))
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


def _player_tick_snapshot_at(
    df: Optional[pd.DataFrame],
    desired_tick: int,
) -> pd.DataFrame:
    """Reuse a materialized player snapshot only when its tick is exact."""
    if df is None or df.empty:
        return pd.DataFrame()
    work = coalesce_player_team_num(df)
    if "tick" not in work.columns:
        return pd.DataFrame()
    numeric_ticks = pd.to_numeric(work["tick"], errors="coerce")
    exact = work.loc[numeric_ticks == int(desired_tick)]
    return exact.copy() if not exact.empty else pd.DataFrame()


def build_player_name_to_user_id(
    parser: DemoParser,
    match_start_tick: int,
    *,
    death_events: Optional[pd.DataFrame] = None,
) -> dict[str, int]:
    """从 player_death 的 user_id 扩展字段建立「昵称 -> 引擎 user id」。"""
    def _mapping(frame: pd.DataFrame) -> tuple[dict[str, int], set[str]]:
        if frame.empty:
            return {}, set()
        work = frame
        if match_start_tick > 0 and "tick" in work.columns:
            work = work.loc[
                pd.to_numeric(work["tick"], errors="coerce").fillna(0).astype(int)
                >= match_start_tick
            ]
        out: dict[str, int] = {}
        expected: set[str] = set()
        for _, row in work.iterrows():
            vn = _cell_str(row.get("user_name"))
            vu = _user_id_cell(row.get("user_user_id"))
            if vn:
                expected.add(vn.lower())
                if vu is not None:
                    out[vn] = vu
            an = _cell_str(row.get("attacker_name"))
            au = _user_id_cell(row.get("attacker_user_id"))
            if an:
                expected.add(an.lower())
                if au is not None:
                    out[an] = au
        return out, expected

    cached = death_events if death_events is not None else pd.DataFrame()
    cached_out, expected = _mapping(cached)
    if expected and expected.issubset({name.lower() for name in cached_out}):
        return cached_out
    try:
        fresh = _to_pandas_df(parser.parse_event("player_death", player=["user_id"]))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return cached_out
    fresh_out, _ = _mapping(fresh)
    return {**cached_out, **fresh_out}


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


def build_player_name_to_steam_id(
    parser: DemoParser,
    match_start_tick: int,
    *,
    death_events: Optional[pd.DataFrame] = None,
) -> dict[str, int]:
    """player_death 中 user_steamid / attacker_steamid 汇总为「昵称 -> Steam64」。"""
    def _mapping(frame: pd.DataFrame) -> tuple[dict[str, int], set[str]]:
        if frame.empty:
            return {}, set()
        work = frame
        if match_start_tick > 0 and "tick" in work.columns:
            work = work.loc[
                pd.to_numeric(work["tick"], errors="coerce").fillna(0).astype(int)
                >= match_start_tick
            ]
        out: dict[str, int] = {}
        expected: set[str] = set()
        for _, row in work.iterrows():
            vn = _cell_str(row.get("user_name"))
            vs = _steam_id_cell(row.get("user_steamid"))
            if vn:
                expected.add(vn.lower())
                if vs is not None:
                    out[vn] = vs
            an = _cell_str(row.get("attacker_name"))
            ast = _steam_id_cell(row.get("attacker_steamid"))
            if an:
                expected.add(an.lower())
                if ast is not None:
                    out[an] = ast
        return out, expected

    cached = death_events if death_events is not None else pd.DataFrame()
    cached_out, expected = _mapping(cached)
    if expected and expected.issubset({name.lower() for name in cached_out}):
        return cached_out
    try:
        fresh = _to_pandas_df(parser.parse_event("player_death"))
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return cached_out
    fresh_out, _ = _mapping(fresh)
    return {**cached_out, **fresh_out}


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
    *,
    name_to_team_pi: Optional[dict[str, int]] = None,
    player_ticks_df: Optional[pd.DataFrame] = None,
    expected_names: Optional[list[str] | tuple[str, ...] | set[str]] = None,
    require_player_color: bool = False,
) -> list[dict]:
    """全员名单：[{name, steamid64, spec_slot, team_num}, ...]。"""
    desired_tick = max(1, match_start_tick)
    cached_df = _player_tick_snapshot_at(player_ticks_df, desired_tick)
    expected_name_keys = {
        str(name).strip().lower()
        for name in (
            *name_to_sid.keys(),
            *spec_slots.keys(),
            *(name_to_team_pi or {}).keys(),
            *(expected_names or ()),
        )
        if str(name).strip()
    }
    cached_usable_names = (
        {
            name.strip().lower()
            for _, row in cached_df.iterrows()
            if (name := _cell_str(row.get("name")))
            and _cell_team(row.get("team_num")) in (2, 3)
        }
        if not cached_df.empty
        else set()
    )
    cache_complete = bool(cached_usable_names) and (
        not expected_name_keys or expected_name_keys.issubset(cached_usable_names)
    ) and (not require_player_color or "player_color" in cached_df.columns)
    df = cached_df
    if not cache_complete:
        try:
            fresh_df = coalesce_player_team_num(_to_pandas_df(parser.parse_ticks(
                ["name", "steamid", "player_color", *PLAYER_TEAM_PARSE_FIELDS],
                ticks=[desired_tick],
            )))
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            fresh_df = pd.DataFrame()
        if not fresh_df.empty:
            # Prefer the dedicated exact-tick read while retaining any names
            # that were present only in the shared cache.
            df = pd.concat([fresh_df, cached_df], ignore_index=True)
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
        sid_int = (
            name_to_sid.get(name)
            or name_to_sid.get(name.lower())
            or _steam_id_cell(row.get("steamid"))
        )
        players.append({
            "name": name,
            "steamid64": str(sid_int) if sid_int is not None else "",
            "spec_slot": spec_slots.get(name.lower()),
            "team_num": team_num,
            "player_color": _player_color_name(row.get("player_color")),
        })

    # 逐 tick team_num 在部分国服 demo 上几乎全为空，会导致名单残缺/单边。
    # 此时用 parse_player_info 的可靠队伍补全全员。
    distinct = {p["team_num"] for p in players}
    output_name_keys = {str(player["name"]).strip().lower() for player in players}
    missing_expected = expected_name_keys - output_name_keys
    if len(players) < 6 or len(distinct) < 2 or missing_expected:
        name_to_team_pi_resolved = (
            name_to_team_pi
            if name_to_team_pi is not None
            else build_name_to_team_from_player_info(parser)
        )
        if name_to_team_pi_resolved:
            candidate_names = [
                str(row.get("name", "")).strip()
                for _, row in df.iterrows()
            ]
            candidate_names.extend(str(name).strip() for name in expected_names or ())
            candidate_names.extend(str(name).strip() for name in name_to_sid)
            candidate_names.extend(str(name).strip() for name in spec_slots)
            existing = {str(player["name"]).strip().lower() for player in players}
            for name in candidate_names:
                name_key = name.lower()
                if not name or name_key in existing:
                    continue
                tm = name_to_team_pi_resolved.get(name_key)
                if tm not in (2, 3):
                    continue
                existing.add(name_key)
                sid_int = _lookup_steam_id_for_name(name_to_sid, name)
                players.append({
                    "name": name,
                    "steamid64": str(sid_int) if sid_int is not None else "",
                    "spec_slot": spec_slots.get(name.lower()),
                    "team_num": tm,
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
    *,
    player_ticks_df: Optional[pd.DataFrame] = None,
    expected_names: Optional[list[str] | tuple[str, ...] | set[str]] = None,
) -> dict[str, int]:
    """在某一 tick 快照上建立「玩家昵称(小写) -> spec_player 应传入的整数」。"""
    observed: list[int] = []
    t = max(1, int(tick_i)) if int(tick_i) <= 0 else int(tick_i)
    cached_df = _player_tick_snapshot_at(player_ticks_df, t)
    valid_cached_names: set[str] = set()
    if not cached_df.empty and "user_id" in cached_df.columns and "name" in cached_df.columns:
        valid_cached_names = {
            str(name).strip().lower()
            for _, row in cached_df.iterrows()
            if (name := _cell_str(row.get("name")))
            and _user_id_cell(row.get("user_id")) is not None
        }
    expected = {
        str(name).strip().lower()
        for name in expected_names or ()
        if str(name).strip()
    }
    cache_complete = bool(valid_cached_names) and (
        not expected or expected.issubset(valid_cached_names)
    )
    df = cached_df
    if not cache_complete:
        try:
            fresh_df = _to_pandas_df(parser.parse_ticks(["user_id", "name"], ticks=[t]))
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            fresh_df = pd.DataFrame()
        if not fresh_df.empty:
            # Fresh rows are appended so duplicate names overwrite cached IDs
            # when the mapping dict is built below.
            df = pd.concat([cached_df, fresh_df], ignore_index=True)
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
        df = coalesce_player_team_num(_to_pandas_df(
            parser.parse_ticks(
                ["name", "steamid", *PLAYER_TEAM_PARSE_FIELDS],
                ticks=[tick_i],
            ),
        ))
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
        pos = mask.tolist().index(True)
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
        df = coalesce_player_team_num(_to_pandas_df(
            parser.parse_ticks(
                ["user_id", "name", "steamid", *PLAYER_TEAM_PARSE_FIELDS],
                ticks=[tick_i],
            ),
        ))
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


def get_player_list(
    dem_path: str | Path,
    *,
    parser: Optional[DemoParser] = None,
    match_start_tick: Optional[int] = None,
    death_events: Optional[pd.DataFrame] = None,
    player_info_df: Optional[pd.DataFrame] = None,
) -> list[dict]:
    """Return one roster row per SteamID/XUID, never per nickname.

    Nicknames are display data. They are not unique in CS2 and can also change
    during a match, so every participant role is resolved by SteamID first,
    then engine user id, with the name used only as a last-resort fallback.
    """
    parser = parser or DemoParser(str(dem_path))
    if match_start_tick is None:
        match_start_tick = _get_match_start_tick(parser)
    try:
        events = (
            death_events
            if death_events is not None and not death_events.empty
            else _to_pandas_df(parser.parse_event("player_death", player=["user_id"]))
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        return []
    if events.empty:
        return []

    try:
        pi = (
            player_info_df
            if player_info_df is not None and not player_info_df.empty
            else _to_pandas_df(parser.parse_player_info())
        )
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
        pi = pd.DataFrame()

    registry = PlayerIdentityRegistry.from_frames(
        player_info=pi,
        death_events=events,
    )

    tick_for_roster = (
        match_start_tick
        if match_start_tick > 0
        else max(1, _int(events["tick"].min()) if "tick" in events.columns else 1)
    )
    spec_slots = build_player_name_to_spec_player_slot_dict(
        parser,
        tick_for_roster,
        dem_path,
    )

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

    stats: dict[str, dict[str, object]] = {}

    def _identity_values(row: dict, role: str) -> tuple[str, Optional[int], Optional[int]]:
        name = _cell_str(row.get(f"{role}_name"))
        if role == "user" and not name:
            name = _cell_str(row.get("player_name"))
        sid = _steam_id_cell(row.get(f"{role}_steamid"))
        uid = _user_id_cell(
            row.get(f"{role}_user_id")
            or (row.get("user_id") if role == "user" else None)
            or (row.get("attacker_id") if role == "attacker" else None)
        )
        return name, sid, uid

    def _touch(name: str, sid: object = None, uid: object = None) -> tuple[str, dict[str, object]]:
        identity = registry.identity_for_values(name, sid, uid)
        key = identity.player_key if identity is not None else player_key_for_values(name, sid, uid)
        if not key:
            return "", {}
        rec = stats.get(key)
        if rec is None:
            rec = {
                "player_key": key,
                "name": identity.display_name if identity is not None else name,
                "steam_id": identity.steamid if identity is not None else (_norm_steam_id(sid) or None),
                "event_user_id": (
                    _user_id_cell(identity.user_id) if identity is not None else _user_id_cell(uid)
                ),
                "kills": 0,
                "deaths": 0,
                "assists": 0,
                "team": None,
                "player_color": None,
            }
            stats[key] = rec
        return key, rec

    def _set_team_if_missing(rec: dict[str, object], team_val: Optional[int]) -> None:
        if rec and team_val in (2, 3) and rec.get("team") is None:
            rec["team"] = team_val

    # Seed the full playing roster so a 0/0 player is not lost merely because
    # they never appeared in player_death. Skip GOTV/bot/disconnect placeholders
    # whose "steamid" is a tiny fake id (e.g. "11"), or they inflate 5v5 to 11.
    pi_team_col = _player_info_team_col(pi) if not pi.empty else None
    if not pi.empty and "name" in pi.columns:
        for _, row in pi.iterrows():
            name = _cell_str(row.get("name"))
            sid = _steam_id_cell(row.get("steamid")) if "steamid" in pi.columns else None
            team = _cell_team(row.get(pi_team_col)) if pi_team_col else None
            if not name or team not in (2, 3):
                continue
            if "steamid" in pi.columns and not _is_real_steamid64(sid):
                continue
            _, rec = _touch(name, sid, row.get("user_id"))
            _set_team_if_missing(rec, team)

    for _, row in events.iterrows():
        attacker, attacker_sid, attacker_uid = _identity_values(row, "attacker")
        victim, victim_sid, victim_uid = _identity_values(row, "user")
        assister = _cell_str(row.get(assist_col)) if assist_col else ""
        assister_sid = _steam_id_cell(
            row.get("assister_steamid") or row.get("assistor_steamid")
        )
        assister_uid = _user_id_cell(
            row.get("assister_user_id") or row.get("assistor_user_id")
        )

        atk_team = _cell_team(row.get("attackerteam"))
        vic_team = _cell_team(row.get("userteam"))
        ast_team = _cell_team(row.get(assister_team_col)) if assister_team_col else None

        attacker_key, attacker_rec = _touch(attacker, attacker_sid, attacker_uid) if attacker else ("", {})
        victim_key, victim_rec = _touch(victim, victim_sid, victim_uid) if victim else ("", {})
        assister_key, assister_rec = _touch(assister, assister_sid, assister_uid) if assister else ("", {})
        _set_team_if_missing(attacker_rec, atk_team)
        _set_team_if_missing(victim_rec, vic_team)
        _set_team_if_missing(assister_rec, ast_team)

        if victim_rec:
            victim_rec["deaths"] = int(victim_rec["deaths"]) + 1
        if attacker_rec and attacker_key != victim_key:
            attacker_rec["kills"] = int(attacker_rec["kills"]) + 1
        if assister_rec and assister_key != victim_key:
            assister_rec["assists"] = int(assister_rec["assists"]) + 1

    if match_start_tick > 0 and stats:
        try:
            fix_df = coalesce_player_team_num(_to_pandas_df(
                parser.parse_ticks(
                    PLAYER_TEAM_PARSE_FIELDS + ["name", "steamid", "user_id", "player_color"],
                    ticks=[match_start_tick],
                ),
            ))
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            try:
                fix_df = coalesce_player_team_num(_to_pandas_df(
                    parser.parse_ticks(PLAYER_TEAM_PARSE_FIELDS + ["name"], ticks=[match_start_tick]),
                ))
            except BaseException as fallback_error:
                if isinstance(fallback_error, _DEMOPARSER_RE_RAISE):
                    raise
                fix_df = pd.DataFrame()
        if not fix_df.empty and "name" in fix_df.columns:
            for _, r in fix_df.iterrows():
                nm = _cell_str(r.get("name"))
                tm = _cell_team(r.get("team_num"))
                if not nm:
                    continue
                identity = registry.identity_for_values(
                    nm,
                    r.get("steamid"),
                    r.get("user_id"),
                )
                key = identity.player_key if identity is not None else player_key_for_values(
                    nm, r.get("steamid"), r.get("user_id")
                )
                rec = stats.get(key)
                if rec is not None:
                    # Team names and score slots are anchored to match_start_tick.
                    # parse_player_info reflects the final side after halftime, so
                    # an exact start snapshot must replace that fallback value.
                    if tm in (2, 3):
                        rec["team"] = tm
                    rec["player_color"] = _player_color_name(r.get("player_color"))

    rows: list[dict] = []
    observed_user_ids = [
        int(rec["event_user_id"])
        for rec in stats.values()
        if rec.get("event_user_id") is not None
    ]
    ordered = sorted(
        stats.values(),
        key=lambda rec: (-int(rec["kills"]), str(rec["name"]).casefold(), str(rec["player_key"])),
    )
    for rec in ordered:
        name = str(rec["name"])
        steam_id = str(rec.get("steam_id") or "") or None
        if steam_id and not _is_real_steamid64(steam_id):
            continue
        event_uid = _user_id_cell(rec.get("event_user_id"))
        rows.append(
            {
                "name": name,
                "player_key": str(rec["player_key"]),
                "team": rec["team"] if rec["team"] is not None else 0,
                "kills": int(rec["kills"]),
                "deaths": int(rec["deaths"]),
                "assists": int(rec["assists"]),
                "user_id": _spec_player_slot_from_event_user_id(
                    event_uid,
                    dem_path,
                    observed_user_ids,
                ) or lookup_spec_player_slot_for_name(spec_slots, name),
                "steam_id": steam_id,
                "steam_id64": steam_id,
                "xuid": steam_id,
                "player_color": rec.get("player_color"),
            },
        )
    return rows
