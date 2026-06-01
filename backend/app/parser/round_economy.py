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
)
from .tag_constants import TICK_RATE, _EXTRA_EVENT_FIELDS


def build_round_economy(
    parser: DemoParser,
    target_player: str,
    match_start_tick: int = 0,
) -> tuple[dict[int, dict[int, int]], dict[int, int], dict[int, int], dict[int, int]]:
    """
    解析 round_freeze_end，汇总 Team 2 / Team 3 存活玩家 current_equip_value。

    返回四元组:
        economy_map               {round_num: {2: equip, 3: equip}}
        target_team_map           {round_num: team_num}
        round_freeze_end_ticks    {round_num: freeze_end_tick}
        round_freeze_start_ticks  {round_num: freeze_start_tick}
    """
    economy_map: dict[int, dict[int, int]] = {}
    target_team_map: dict[int, int] = {}
    round_freeze_end_ticks: dict[int, int] = {}
    round_freeze_start_ticks: dict[int, int] = {}
    fr = _safe_parse_event(parser, "round_freeze_end", other=list(_EXTRA_EVENT_FIELDS))
    if fr.shape[0] == 0 or "tick" not in fr.columns:
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks
    if match_start_tick > 0:
        fr = fr.loc[pd.to_numeric(fr["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
    if fr.shape[0] == 0:
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks
    trc = "total_rounds_played" if "total_rounds_played" in fr.columns else None
    if trc is None:
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks

    tick_to_round: dict[int, int] = {}
    for _, row in fr.sort_values("tick", kind="mergesort").iterrows():
        tick = _int(row.get("tick"))
        if tick <= 0:
            continue
        rn_here = _int(row.get(trc)) + 1
        tick_to_round[tick] = rn_here
        if rn_here not in round_freeze_end_ticks or tick < round_freeze_end_ticks[rn_here]:
            round_freeze_end_ticks[rn_here] = tick

    try:
        rs_df = _safe_parse_event(parser, "round_start")
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
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks

    try:
        raw = parser.parse_ticks(
            ["team_num", "current_equip_value", "is_alive", "name"],
            ticks=ticks,
        )
        pdf = _to_pandas_df(raw)
    except Exception:
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks
    if pdf.empty or "tick" not in pdf.columns:
        return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks

    tp = str(target_player or "").strip().lower()
    name_col = "name" if "name" in pdf.columns else None

    for tick, grp in pdf.groupby("tick", sort=False):
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

        if name_col and tp:
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

    return economy_map, target_team_map, round_freeze_end_ticks, round_freeze_start_ticks


def build_round_scores(
    parser: DemoParser,
    match_start_tick: int = 0,
) -> dict[int, dict[int, int]]:
    """解析 round_end，返回每回合**开始前**的双方比分 {round: {2: T胜场, 3: CT胜场}}。"""
    re = _safe_parse_event(parser, "round_end", other=list(_EXTRA_EVENT_FIELDS))
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
) -> dict[int, tuple[int, int]]:
    """
    按**队伍身份**（而非 T/CT 阵营角色）累计胜场。
    返回 {round_num: (own_wins_before_round, opp_wins_before_round)}
    """
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
            parser.parse_ticks(["steamid", "team_num", "name"], ticks=[match_start_tick]),
        )
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
            parser.parse_ticks(["steamid", "team_num", "name"], ticks=ticks_needed),
        )
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
