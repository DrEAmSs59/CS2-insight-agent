from __future__ import annotations

from typing import Optional

import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import (
    _safe_parse_event,
    _to_pandas_df,
    _int,
    _round_end_winner_team_num,
    _norm_steam_id,
    _cell_team,
    _cell_str,
    _winner_side_engine_num,
    PLAYER_TEAM_PARSE_FIELDS,
    coalesce_player_team_num,
)
from .tag_constants import TICK_RATE, _EXTRA_EVENT_FIELDS


def _round_end_frame_usable(
    frame: Optional[pd.DataFrame],
    match_start_tick: int = 0,
) -> bool:
    """Whether a cached round_end frame can safely replace a dedicated parse."""
    if frame is None or frame.empty or "winner" not in frame.columns:
        return False
    work = frame
    if match_start_tick > 0 and "tick" not in work.columns:
        return False
    if match_start_tick > 0:
        work = work.loc[
            pd.to_numeric(work["tick"], errors="coerce").fillna(0).astype(int)
            >= match_start_tick
        ]
    winners = [_round_end_winner_team_num(value) for value in work["winner"].tolist()]
    return bool(winners) and all(winner in (2, 3) for winner in winners)


def build_round_economy_shared(
    parser: DemoParser,
    match_start_tick: int = 0,
    *,
    freeze_end_df: "Optional[pd.DataFrame]" = None,
    round_start_df: "Optional[pd.DataFrame]" = None,
) -> tuple[dict[int, dict[int, int]], dict[int, int], dict[int, int], dict[int, int], pd.DataFrame]:
    """
    Player-independent part of round economy — call once per demo.

    Returns (economy_map, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, economy_ticks_df).
    Pass economy_ticks_df + tick_to_round to extract_target_team_map() per player.

    freeze_end_df / round_start_df: pre-parsed DataFrames from a batch call; when provided and
    non-empty the function skips the corresponding parse_event() calls.
    """
    _empty: tuple = ({}, {}, {}, {}, pd.DataFrame())
    fr = (
        freeze_end_df
        if (freeze_end_df is not None and not freeze_end_df.empty)
        else _safe_parse_event(parser, "round_freeze_end", other=list(_EXTRA_EVENT_FIELDS))
    )
    if fr.shape[0] == 0 or "tick" not in fr.columns:
        return _empty
    if match_start_tick > 0:
        fr = fr.loc[pd.to_numeric(fr["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
    if fr.shape[0] == 0:
        return _empty
    trc = "total_rounds_played" if "total_rounds_played" in fr.columns else None

    round_freeze_end_ticks: dict[int, int] = {}
    tick_to_round: dict[int, int] = {}
    if trc is not None:
        for _, row in fr.sort_values("tick", kind="mergesort").iterrows():
            tick = _int(row.get("tick"))
            if tick <= 0:
                continue
            rn_here = _int(row.get(trc)) + 1
            tick_to_round[tick] = rn_here
            if rn_here not in round_freeze_end_ticks or tick < round_freeze_end_ticks[rn_here]:
                round_freeze_end_ticks[rn_here] = tick
    else:
        # 部分国服 demo 的 round_freeze_end 不带 total_rounds_played（甚至没有 round 列），
        # 此时按 tick 先后顺序顺序编号回合（已按 match_start_tick 过滤掉热身/拼刀）。
        seq = 0
        seen_ticks: set[int] = set()
        for _, row in fr.sort_values("tick", kind="mergesort").iterrows():
            tick = _int(row.get("tick"))
            if tick <= 0 or tick in seen_ticks:
                continue
            seen_ticks.add(tick)
            seq += 1
            tick_to_round[tick] = seq
            round_freeze_end_ticks[seq] = tick

    round_freeze_start_ticks: dict[int, int] = {}
    try:
        rs_df = (
            round_start_df
            if (round_start_df is not None and not round_start_df.empty)
            else _safe_parse_event(parser, "round_start")
        )
        if not rs_df.empty and "tick" in rs_df.columns:
            rs_ticks = sorted(
                pd.to_numeric(rs_df["tick"], errors="coerce").dropna().astype(int).tolist()
            )
            if match_start_tick > 0:
                rs_ticks = [t for t in rs_ticks if t >= match_start_tick]
            for rnd in sorted(round_freeze_end_ticks.keys()):
                fe = round_freeze_end_ticks[rnd]
                prev_fe = round_freeze_end_ticks.get(
                    rnd - 1,
                    match_start_tick if match_start_tick > 0 else 0,
                )
                candidates = [t for t in rs_ticks if prev_fe < t < fe]
                if candidates:
                    round_freeze_start_ticks[rnd] = min(candidates)
    except Exception:
        pass

    ticks = sorted(tick_to_round.keys())
    if not ticks:
        return {}, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, pd.DataFrame()

    economy_fields = PLAYER_TEAM_PARSE_FIELDS + [
        "current_equip_value", "is_alive", "name", "steamid", "user_id",
    ]
    try:
        raw = parser.parse_ticks(economy_fields, ticks=ticks)
        economy_ticks_df = coalesce_player_team_num(_to_pandas_df(raw))
    except Exception:
        return {}, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, pd.DataFrame()

    if economy_ticks_df.empty or "tick" not in economy_ticks_df.columns:
        return {}, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, pd.DataFrame()

    observed_ticks = set(
        pd.to_numeric(economy_ticks_df["tick"], errors="coerce").dropna().astype(int)
    )
    missing_ticks = sorted(set(ticks) - observed_ticks)
    if missing_ticks:
        try:
            retry_df = coalesce_player_team_num(
                _to_pandas_df(parser.parse_ticks(economy_fields, ticks=missing_ticks))
            )
        except Exception:
            retry_df = pd.DataFrame()
        if not retry_df.empty:
            economy_ticks_df = pd.concat(
                [economy_ticks_df, retry_df],
                ignore_index=True,
            )

    economy_map: dict[int, dict[int, int]] = {}
    for tick, grp in economy_ticks_df.groupby("tick", sort=False):
        tick_i = int(tick)
        rn = tick_to_round.get(tick_i)
        if rn is None:
            continue
        if "is_alive" in grp.columns:
            alive = grp[grp["is_alive"].astype(bool)]
        else:
            alive = grp
        sums: dict[int, int] = {2: 0, 3: 0}
        if "team_num" in alive.columns and "current_equip_value" in alive.columns:
            for _, r in alive.iterrows():
                try:
                    tm = int(float(r["team_num"]))
                except (TypeError, ValueError):
                    continue
                if tm not in sums:
                    continue
                try:
                    v = int(float(r["current_equip_value"]))
                except (TypeError, ValueError):
                    continue
                sums[tm] += v
        economy_map[rn] = sums

    return economy_map, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, economy_ticks_df


def extract_target_team_map(
    economy_ticks_df: pd.DataFrame,
    tick_to_round: dict[int, int],
    target_player: str,
) -> dict[int, int]:
    """Per-player: which team the player was on each round, derived from the shared economy_ticks_df."""
    target_team_map: dict[int, int] = {}
    if economy_ticks_df.empty or "tick" not in economy_ticks_df.columns:
        return target_team_map
    tp = str(target_player or "").strip().lower()
    if not tp:
        return target_team_map
    name_col = "name" if "name" in economy_ticks_df.columns else None
    if name_col is None:
        return target_team_map

    for tick, grp in economy_ticks_df.groupby("tick", sort=False):
        tick_i = int(tick)
        rn = tick_to_round.get(tick_i)
        if rn is None or rn in target_team_map:
            continue
        if "is_alive" in grp.columns:
            alive = grp[grp["is_alive"].astype(bool)]
        else:
            alive = grp
        search_groups = [alive, grp] if (
            "is_alive" in grp.columns and len(alive) < len(grp)
        ) else [alive]
        for sg in search_groups:
            if rn in target_team_map:
                break
            for _, r in sg.iterrows():
                nm = str(r.get(name_col) or "").strip().lower()
                if nm != tp:
                    continue
                try:
                    target_team_map[rn] = int(float(r["team_num"]))
                except (TypeError, ValueError):
                    pass
                break

    return target_team_map


def build_round_economy(
    parser: DemoParser,
    target_player: str,
    match_start_tick: int = 0,
) -> tuple[dict[int, dict[int, int]], dict[int, int], dict[int, int], dict[int, int]]:
    """Kept for callers outside analyze_multi_players. Delegates to the two shared helpers."""
    economy_map, round_freeze_end_ticks, round_freeze_start_ticks, tick_to_round, economy_ticks_df = (
        build_round_economy_shared(parser, match_start_tick)
    )
    target_team_map = extract_target_team_map(economy_ticks_df, tick_to_round, target_player)
    return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks


def build_round_scores(
    parser: DemoParser,
    match_start_tick: int = 0,
    *,
    re_df: Optional[pd.DataFrame] = None,
) -> dict[int, dict[int, int]]:
    """解析 round_end，返回每回合**开始前**的双方比分 {round: {2: T胜场, 3: CT胜场}}。"""
    re = (
        re_df
        if _round_end_frame_usable(re_df, match_start_tick)
        else _safe_parse_event(parser, "round_end", other=list(_EXTRA_EVENT_FIELDS))
    )
    if match_start_tick > 0 and not re.empty and "tick" in re.columns:
        re = re.loc[pd.to_numeric(re["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
    if re.empty:
        return {1: {2: 0, 3: 0}}
    if "tick" in re.columns:
        re = re.sort_values("tick", kind="mergesort")
    winner_col = "winner" if "winner" in re.columns else None
    if not winner_col:
        return {1: {2: 0, 3: 0}}
    trc = "total_rounds_played" if "total_rounds_played" in re.columns else None

    scores: dict[int, int] = {2: 0, 3: 0}
    out: dict[int, dict[int, int]] = {1: {2: scores[2], 3: scores[3]}}
    seq = 0

    for _, row in re.iterrows():
        w = _round_end_winner_team_num(row.get(winner_col))
        if w is None:
            continue
        if trc is not None:
            ended_round = _int(row.get(trc))
        else:
            seq += 1
            ended_round = seq
        if ended_round <= 0:
            continue
        out[ended_round] = {2: scores[2], 3: scores[3]}
        scores[w] = scores.get(w, 0) + 1
        out[ended_round + 1] = {2: scores[2], 3: scores[3]}

    return out


def build_round_scores_team_based(
    parser: DemoParser,
    round_target_team_map: dict[int, int],
    match_start_tick: int = 0,
    *,
    re_df: Optional[pd.DataFrame] = None,
) -> dict[int, tuple[int, int]]:
    """
    按**队伍身份**（而非 T/CT 阵营角色）累计胜场。
    返回 {round_num: (own_wins_before_round, opp_wins_before_round)}

    re_df: 已过滤 warmup 的 round_end DataFrame，有则直接用，省一次 parse_event。
    """
    if _round_end_frame_usable(re_df, match_start_tick):
        re = re_df
    else:
        re = _safe_parse_event(parser, "round_end", other=list(_EXTRA_EVENT_FIELDS))
        if match_start_tick > 0 and not re.empty and "tick" in re.columns:
            re = re.loc[
                pd.to_numeric(re["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
            ]
    if re.empty or "winner" not in re.columns:
        return {}
    if "tick" in re.columns:
        re = re.sort_values("tick", kind="mergesort")
    trc = "total_rounds_played" if "total_rounds_played" in re.columns else None

    def get_player_team(rnd: int) -> Optional[int]:
        if rnd in round_target_team_map:
            return round_target_team_map[rnd]
        best: Optional[int] = None
        for r in sorted(round_target_team_map.keys()):
            if r <= rnd:
                best = round_target_team_map[r]
            else:
                break
        return best

    out: dict[int, tuple[int, int]] = {1: (0, 0)}
    own_wins = 0
    opp_wins = 0
    seq = 0

    for _, row in re.iterrows():
        winner_team = _round_end_winner_team_num(row.get("winner"))
        if winner_team is None:
            continue
        if trc is not None:
            ended_round = _int(row.get(trc))
        else:
            seq += 1
            ended_round = seq

        if ended_round <= 0:
            continue

        player_team = get_player_team(ended_round)
        out[ended_round] = (own_wins, opp_wins)

        if player_team is not None:
            if winner_team == player_team:
                own_wins += 1
            else:
                opp_wins += 1
        out[ended_round + 1] = (own_wins, opp_wins)

    return out


def build_group_side_by_round(
    parser: DemoParser,
    round_freeze_end_ticks: dict[int, int],
    steam_to_final_team: dict[str, int],
    *,
    player_ticks_df: Optional[pd.DataFrame] = None,
) -> dict[int, dict[int, int]]:
    """每回合两支「队伍身份」各自所处阵营。

    队伍身份用 parse_player_info 的末段队号（2/3）表示，整局不变；阵营 (engine team_num,
    2=T / 3=CT) 会在中场/加时换边。返回 {round: {final_team: side}}。

    原理：在每个回合的冻结时刻观察任意一名「已知队伍身份」玩家的 team_num，即可推断其
    队伍当回合的阵营，另一支队伍取相反阵营；无观测的回合用相邻回合前/后向填充。对 team_num
    字段稀疏的国服 demo 也稳健（每回合只需任意 1 名玩家可见）。
    """
    if not round_freeze_end_ticks or not steam_to_final_team:
        return {}
    ticks = sorted(set(round_freeze_end_ticks.values()))
    df = pd.DataFrame()
    if player_ticks_df is not None and not player_ticks_df.empty:
        df = coalesce_player_team_num(player_ticks_df)
        if "tick" in df.columns:
            df = df.loc[pd.to_numeric(df["tick"], errors="coerce").isin(ticks)]

    def _ticks_with_usable_observation(frame: pd.DataFrame) -> set[int]:
        usable: set[int] = set()
        if frame.empty or "tick" not in frame.columns:
            return usable
        for tick, grp in frame.groupby("tick", sort=False):
            for _, row in grp.iterrows():
                final_team = steam_to_final_team.get(_norm_steam_id(row.get("steamid")))
                if final_team in (2, 3) and _cell_team(row.get("team_num")) in (2, 3):
                    usable.add(int(tick))
                    break
        return usable

    missing_ticks = sorted(set(ticks) - _ticks_with_usable_observation(df))
    if missing_ticks:
        try:
            fresh_df = coalesce_player_team_num(_to_pandas_df(parser.parse_ticks(
                PLAYER_TEAM_PARSE_FIELDS + ["steamid"],
                ticks=missing_ticks,
            )))
        except Exception:
            fresh_df = pd.DataFrame()
        if not fresh_df.empty:
            df = pd.concat([df, fresh_df], ignore_index=True)
    if df.empty or "tick" not in df.columns:
        return {}

    obs_by_tick: dict[int, dict[int, int]] = {}
    for tick, grp in df.groupby("tick", sort=False):
        side_for_group: dict[int, int] = {}
        for _, r in grp.iterrows():
            ft = steam_to_final_team.get(_norm_steam_id(r.get("steamid")))
            if ft not in (2, 3):
                continue
            tm = _cell_team(r.get("team_num"))
            if tm in (2, 3):
                side_for_group[ft] = tm
        if side_for_group:
            obs_by_tick[int(tick)] = side_for_group

    def _complete(side_for_group: dict[int, int]) -> Optional[dict[int, int]]:
        if 2 in side_for_group:
            s = side_for_group[2]
            return {2: s, 3: (3 if s == 2 else 2)}
        if 3 in side_for_group:
            s = side_for_group[3]
            return {3: s, 2: (3 if s == 2 else 2)}
        return None

    rounds_sorted = sorted(round_freeze_end_ticks.keys())
    raw: dict[int, Optional[dict[int, int]]] = {
        rn: _complete(obs_by_tick.get(round_freeze_end_ticks[rn], {}))
        for rn in rounds_sorted
    }

    last: Optional[dict[int, int]] = None
    for rn in rounds_sorted:
        if raw[rn] is not None:
            last = raw[rn]
        elif last is not None:
            raw[rn] = dict(last)
    nxt: Optional[dict[int, int]] = None
    for rn in reversed(rounds_sorted):
        if raw[rn] is not None:
            nxt = raw[rn]
        elif nxt is not None:
            raw[rn] = dict(nxt)

    return {rn: v for rn, v in raw.items() if v is not None}


def build_round_winner_side_map(
    re_df: pd.DataFrame,
    match_start_tick: int = 0,
) -> dict[int, int]:
    """{round_num: 该回合获胜阵营 engine team_num 2/3}。无 total_rounds_played 时按 tick 顺序编号。"""
    if re_df is None or re_df.empty or "winner" not in re_df.columns:
        return {}
    re = re_df
    if match_start_tick > 0 and "tick" in re.columns:
        re = re.loc[pd.to_numeric(re["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
    if re.empty:
        return {}
    if "tick" in re.columns:
        re = re.sort_values("tick", kind="mergesort")
    trc = "total_rounds_played" if "total_rounds_played" in re.columns else None
    out: dict[int, int] = {}
    seq = 0
    for _, row in re.iterrows():
        w = _round_end_winner_team_num(row.get("winner"))
        if w is None:
            continue
        if trc is not None:
            rn = _int(row.get(trc)) + 1
        else:
            seq += 1
            rn = seq
        if rn > 0:
            out[rn] = w
    return out


def round_target_team_map_from_groups(
    group_side_by_round: dict[int, dict[int, int]],
    target_final_team: Optional[int],
) -> dict[int, int]:
    """由每回合各队阵营表，取目标玩家（按其末段队伍身份）逐回合所处阵营。"""
    if target_final_team not in (2, 3):
        return {}
    return {
        rn: gs[target_final_team]
        for rn, gs in group_side_by_round.items()
        if target_final_team in gs
    }


def compute_team_identity_scoreline(
    parser: DemoParser,
    match_start_tick: int,
    re_df: pd.DataFrame,
) -> tuple[int, int]:
    """对坏数据稳健的总比分：返回 (开赛先打 T 的队伍总胜场, 开赛先打 CT 的队伍总胜场)。

    与 ``_scoreline_by_starting_roster`` 同语义，但用 parse_player_info + 逐回合阵营观测，
    不依赖几乎全空的逐 tick team_num。无法计算时返回 (0, 0)。
    """
    from .player_roster import build_steam_to_team_from_player_info

    steam_to_final = build_steam_to_team_from_player_info(parser)
    if not steam_to_final:
        return 0, 0

    fr = _safe_parse_event(parser, "round_freeze_end")
    if fr.empty or "tick" not in fr.columns:
        return 0, 0
    if match_start_tick > 0:
        fr = fr.loc[pd.to_numeric(fr["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
    ticks_sorted = sorted(set(pd.to_numeric(fr["tick"], errors="coerce").dropna().astype(int).tolist()))
    if not ticks_sorted:
        return 0, 0
    round_freeze_end_ticks = {i: t for i, t in enumerate(ticks_sorted, start=1)}

    group_side = build_group_side_by_round(parser, round_freeze_end_ticks, steam_to_final)
    winner_side = build_round_winner_side_map(re_df, match_start_tick)
    if not group_side or not winner_side:
        return 0, 0

    wins: dict[int, int] = {2: 0, 3: 0}  # 按末段队伍身份累计
    for rn, win_side in winner_side.items():
        gs = group_side.get(rn)
        if not gs:
            continue
        for final_team, side in gs.items():
            if side == win_side:
                wins[final_team] = wins.get(final_team, 0) + 1
                break

    first_rn = min(group_side.keys())
    start_sides = group_side[first_rn]  # {final_team: 开赛阵营}
    team_a = team_b = 0
    for final_team, start_side in start_sides.items():
        if start_side == 2:
            team_a = wins.get(final_team, 0)
        elif start_side == 3:
            team_b = wins.get(final_team, 0)
    return team_a, team_b


def _scoreline_by_starting_roster(
    parser: DemoParser,
    match_start_tick: int,
    re_df: pd.DataFrame,
) -> tuple[int, int]:
    """
    按开赛时 engine 队伍号（2/3）归属累计胜场。
    返回 (开赛时 team_num==2 的阵容总胜场, 开赛时 team_num==3 的阵容总胜场)。
    """
    if match_start_tick <= 0 or re_df.empty:
        return 0, 0
    rounds = re_df.copy()
    if "tick" in rounds.columns:
        rounds = rounds.loc[
            pd.to_numeric(rounds["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ]
    if "winner" not in rounds.columns:
        return 0, 0
    rounds = rounds[rounds["winner"].notna()].copy()
    if rounds.empty:
        return 0, 0

    try:
        roster_df = _to_pandas_df(
            parser.parse_ticks(
                ["steamid", *PLAYER_TEAM_PARSE_FIELDS, "name"],
                ticks=[match_start_tick],
            ),
        )
        roster_df = coalesce_player_team_num(roster_df)
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        return 0, 0
    if roster_df.empty or "steamid" not in roster_df.columns:
        return 0, 0

    steam_to_start_team: dict[str, int] = {}
    for _, r in roster_df.iterrows():
        sid = _norm_steam_id(r.get("steamid"))
        tm = _cell_team(r.get("team_num"))
        if sid and tm in (2, 3):
            steam_to_start_team[sid] = tm

    tick_list = pd.to_numeric(rounds["tick"], errors="coerce").fillna(0).astype(int).tolist()
    ticks_needed = sorted({int(x) for x in tick_list if int(x) > 0})
    if not ticks_needed:
        return 0, 0

    try:
        big = _to_pandas_df(
            parser.parse_ticks(
                ["steamid", *PLAYER_TEAM_PARSE_FIELDS, "name"],
                ticks=ticks_needed,
            ),
        )
        big = coalesce_player_team_num(big)
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        return 0, 0
    if big.empty or "tick" not in big.columns:
        return 0, 0

    wins_start2 = 0
    wins_start3 = 0

    for _, row in rounds.iterrows():
        t = int(pd.to_numeric(row.get("tick"), errors="coerce") or 0)
        if t <= 0:
            continue
        win_side = _winner_side_engine_num(row.get("winner"))
        if win_side is None:
            continue
        g = big[big["tick"] == t]
        if g.empty:
            g2 = None
            for delta in (1, 2, 4, 8, 16, 32, 64, 128):
                cand = big[big["tick"] == t - delta]
                if not cand.empty:
                    g2 = cand
                    break
            g = g2 if g2 is not None else g
        if g.empty:
            continue
        tm_col = pd.to_numeric(g["team_num"], errors="coerce")
        sub = g[tm_col == float(win_side)]
        if sub.empty:
            continue
        sid = _norm_steam_id(sub.iloc[0].get("steamid"))
        st = steam_to_start_team.get(sid)
        if st == 2:
            wins_start2 += 1
        elif st == 3:
            wins_start3 += 1

    return wins_start2, wins_start3


def _extract_team_names_from_demo(parser: DemoParser, tick: int) -> tuple[Optional[str], Optional[str]]:
    """从 Demo 内部实体属性提取队伍名称（CCSTeam.m_szClanTeamname）。"""
    try:
        t = max(1, tick)
        df = _to_pandas_df(
            parser.parse_ticks(
                ["CCSTeam.m_szClanTeamname", "CCSTeam.m_iTeamNum"],
                ticks=[t],
            )
        )
        if df.empty:
            return None, None

        col_name = "CCSTeam.m_szClanTeamname"
        col_num = "CCSTeam.m_iTeamNum"
        if col_name not in df.columns or col_num not in df.columns:
            return None, None

        t2_name: Optional[str] = None
        t3_name: Optional[str] = None
        for _, row in df.iterrows():
            tn = _cell_team(row.get(col_num))
            name = _cell_str(row.get(col_name))
            if not name or name.lower() in ("ct", "terrorist", "t"):
                continue
            if tn == 2:
                t2_name = name
            elif tn == 3:
                t3_name = name
            if t2_name and t3_name:
                break
        return t2_name, t3_name
    except Exception:
        return None, None
