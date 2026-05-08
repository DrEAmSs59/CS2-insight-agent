"""按回合聚合目标玩家事件；输出 legacy ``timeline`` 与 killfeed 用 ``round_timeline``。"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from typing import Any, Optional

import pandas as pd

logger = logging.getLogger(__name__)


def _merge_highlight_tags_per_round(clips: list[Any], total_rounds: int) -> dict[int, list[str]]:
    """从解析结果中 ``category == highlight`` 的片段按 ``round`` 合并 ``context_tags``。"""
    from . import demo_parser as dp

    tr = max(1, int(total_rounds or 1))
    acc: dict[int, list[str]] = defaultdict(list)
    for c in clips or []:
        if not isinstance(c, dict):
            continue
        if str(c.get("category") or "") != "highlight":
            continue
        tags = c.get("context_tags") or []
        if not isinstance(tags, list):
            continue
        try:
            cr = int(c.get("round") or 0)
        except (TypeError, ValueError):
            continue
        if cr < 1 or cr > tr:
            continue
        for t in tags:
            s = str(t).strip()
            if s:
                acc[cr].append(s)
    return {r: dp._dedup_context_tags(lst) for r, lst in acc.items()}


def _team_num_to_side(tn: Optional[int]) -> Optional[str]:
    if tn == 2:
        return "T"
    if tn == 3:
        return "CT"
    return None


def _norm_steam_cell(val: object) -> Optional[str]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            i = int(val)
            if i > 0:
                return str(i)
    except (TypeError, ValueError):
        pass
    s = str(val).strip()
    return s or None


def _pick_assister_column(df: pd.DataFrame) -> Optional[str]:
    for col in ("assister_name", "assister", "assistor_name"):
        if col in df.columns:
            return col
    return None


def _adjust_round_for_pre_freeze(
    round_num: int,
    tick: int,
    round_freeze_end_ticks: dict[int, int],
) -> int:
    rn = int(round_num)
    t = int(tick)
    while rn > 1 and rn in round_freeze_end_ticks:
        ft = int(round_freeze_end_ticks.get(rn) or 0)
        if ft <= 0 or t >= ft:
            break
        rn -= 1
    return rn


# 整回合时间线录制结束 tick：固定缓冲（与 demo_parser 默认策略一致），不读环境变量。
_TIMELINE_ROUND_POST_ROUND_END_SEC = 3.0
_TIMELINE_LAST_ROUND_KILL_TAIL_SEC = 2.5


def _timeline_round_record_end_tick(
    rn: int,
    raw_round_end: Optional[int],
    tick_rate: float,
    round_freeze_end_ticks: dict[int, int],
    evs: list[dict[str, Any]],
) -> Optional[int]:
    """与 ``demo_parser`` 填充 ``clip_max_tick`` 的非最后一回合策略对齐：``round_end`` 后留缓冲并顶到下一回合 freeze。

    整回合时间线若仅用 ``round_end`` 原始 tick 作为 ``end_tick``，最后一杀常与 ``round_end`` 同刻度或略早，
    成片会在击杀动画/死亡反馈播完前结束。录制应使用本函数返回值（经 ``record_end_tick`` 暴露给前端）。
    """
    if raw_round_end is None:
        return None
    re = int(raw_round_end)
    trf = float(tick_rate) if float(tick_rate) > 0 else 64.0
    buf_mid = int(_TIMELINE_ROUND_POST_ROUND_END_SEC * trf)
    kill_ts = [
        int(x.get("tick") or 0)
        for x in evs
        if str(x.get("type") or "") == "kill" and int(x.get("tick") or 0) > 0
    ]
    last_k = max(kill_ts) if kill_ts else None

    nxt_raw = round_freeze_end_ticks.get(int(rn) + 1)
    nxt_fe = int(nxt_raw) if nxt_raw is not None else None

    if nxt_fe is not None and nxt_fe > re:
        clip_lim = re + buf_mid
        if last_k is not None and last_k > re and nxt_fe > re:
            clip_lim = nxt_fe
        return int(min(clip_lim, nxt_fe))

    tail = int(_TIMELINE_LAST_ROUND_KILL_TAIL_SEC * trf)
    fe0 = round_freeze_end_ticks.get(int(rn))
    fe_tick = int(fe0) if fe0 is not None else re
    loose_cap = fe_tick + int(60.0 * trf)
    out = re + buf_mid
    if last_k is not None:
        out = max(out, last_k + tail)
    return int(min(out, loose_cap))


def _parse_round_winners_side(round_end_df: pd.DataFrame, match_start_tick: int) -> dict[int, str]:
    from .demo_parser import _round_end_winner_team_num

    out: dict[int, str] = {}
    if round_end_df is None or round_end_df.empty or "winner" not in round_end_df.columns:
        return out
    df = round_end_df
    if match_start_tick > 0 and "tick" in df.columns:
        df = df.loc[
            pd.to_numeric(df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ]
    if df.empty:
        return out
    if "tick" in df.columns:
        df = df.sort_values("tick", kind="mergesort")
    trc = "total_rounds_played" if "total_rounds_played" in df.columns else None
    seq = 0
    for _, row in df.iterrows():
        wn = _round_end_winner_team_num(row.get("winner"))
        if wn is None:
            continue
        side = _team_num_to_side(wn)
        if not side:
            continue
        if trc is not None:
            try:
                ended = int(float(row.get(trc)))
            except (TypeError, ValueError):
                seq += 1
                ended = seq
        else:
            seq += 1
            ended = seq
        out[int(ended)] = side
    return out


def _round_scoreboard_at_round_start(
    round_num: int,
    round_scores_by_round: dict[int, dict[int, int]],
) -> tuple[Optional[int], Optional[int]]:
    d = round_scores_by_round.get(int(round_num)) or round_scores_by_round.get(1) or {}
    if not isinstance(d, dict):
        return None, None
    return int(d.get(2, 0)), int(d.get(3, 0))


def _related_clip_ids(tick: int, rnd: int, clips: list[dict]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for c in clips or []:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("clip_id") or "").strip()
        if not cid or cid in seen:
            continue
        cr = c.get("round")
        try:
            if cr is not None and int(cr) == int(rnd):
                seen.add(cid)
                ordered.append(cid)
                continue
        except (TypeError, ValueError):
            pass
        try:
            st = int(c.get("start_tick") or 0)
            et = int(c.get("end_tick") or 0)
        except (TypeError, ValueError):
            continue
        if st <= int(tick) <= et:
            seen.add(cid)
            ordered.append(cid)
    return ordered


def _weapon_label(raw: str) -> str:
    from . import demo_parser as dp

    norm = dp._normalize_item(raw)
    return dp.WEAPON_TRANSLATION_MAP.get(norm, raw or "?")


def _time_text_from_seconds(sec: Optional[float]) -> str:
    if sec is None or not isinstance(sec, (int, float)) or not math.isfinite(float(sec)):
        return "--:--"
    s = max(0, int(float(sec)))
    return f"{s // 60:02d}:{s % 60:02d}"


def _target_team_for_round(rn: int, round_target_team_map: dict[int, int]) -> Optional[int]:
    if rn in round_target_team_map:
        return int(round_target_team_map[rn])
    best: Optional[int] = None
    for r in sorted(round_target_team_map.keys()):
        if r <= rn:
            best = int(round_target_team_map[r])
        else:
            break
    return best


def _death_notice_flags(row: pd.Series, dp) -> dict[str, bool]:
    _bool = dp._bool
    thr = _bool(row.get("thrusmoke")) or _bool(row.get("through_smoke"))
    pen_raw = row.get("penetrated_objects") if "penetrated_objects" in row.index else row.get("penetrated")
    try:
        pen = int(float(pen_raw)) if pen_raw is not None and str(pen_raw).strip() != "" else 0
    except (TypeError, ValueError):
        pen = 0
    wall = pen > 0
    jk = False
    for k in ("attackerinair", "attacker_in_air", "inair"):
        if k in row.index and row.get(k) is not None:
            jk = jk or _bool(row.get(k))
    return {
        "is_headshot": _bool(row.get("headshot")),
        "is_noscope": _bool(row.get("noscope")),
        "is_through_smoke": thr,
        "is_blind": _bool(row.get("attackerblind")),
        "is_wallbang": wall,
        "is_jump_kill": jk,
        "is_flash_assist": _bool(row.get("assistedflash")),
    }


def _modifiers_from_killfeed_event(ev: dict[str, Any], *, first_kill: bool, trade_kill: bool = False) -> dict[str, bool]:
    return {
        "headshot": bool(ev.get("is_headshot")),
        "through_smoke": bool(ev.get("is_through_smoke")),
        "attacker_blind": bool(ev.get("is_blind")),
        "no_scope": bool(ev.get("is_noscope")),
        "through_wall": bool(ev.get("is_wallbang")),
        "airborne": bool(ev.get("is_jump_kill")),
        "flash_assisted": bool(ev.get("is_flash_assist")),
        "trade_kill": bool(trade_kill),
        "first_kill": bool(first_kill),
    }


def _enrich_killfeed_events(kf: list[dict[str, Any]]) -> int:
    """Annotate killfeed rows with ``modifiers``; return headshot count (kills+deaths with HS)."""
    kill_ticks = [int(x.get("tick") or 0) for x in kf if x.get("type") == "kill"]
    min_kill_t = min(kill_ticks) if kill_ticks else None
    headshots = 0
    for e in kf:
        typ = str(e.get("type") or "")
        if typ in ("kill", "death") and e.get("is_headshot"):
            headshots += 1
        fk = typ == "kill" and min_kill_t is not None and int(e.get("tick") or 0) == min_kill_t
        if typ in ("kill", "death"):
            e["modifiers"] = _modifiers_from_killfeed_event(e, first_kill=fk, trade_kill=False)
        elif typ == "assist_only":
            e["modifiers"] = {}
    return headshots


def build_round_timeline(
    *,
    demo_path: str,
    map_name: str,
    target_player: str,
    target_player_user_id: Optional[int],
    target_steam_id: Optional[str],
    target_team_num: Optional[int],
    round_target_team_map: dict[int, int],
    events: pd.DataFrame,
    round_freeze_end_ticks: dict[int, int],
    round_result_map: dict[int, Any],
    round_scores_by_round: dict[int, dict[int, int]],
    round_end_df: pd.DataFrame,
    round_end_tick_map: dict[int, int],
    clips: list[dict],
    total_rounds: int,
    match_start_tick: int,
    tick_rate: float,
) -> dict[str, Any]:
    from . import demo_parser as dp

    _int = dp._int
    _bool = dp._bool
    _normalize_item = dp._normalize_item

    tp = str(target_player or "").strip()
    tr = max(1, int(total_rounds or 1))
    assist_col = _pick_assister_column(events) if events is not None and not events.empty else None
    winners_by_ended = _parse_round_winners_side(round_end_df, match_start_tick)

    freeze_sorted = sorted(round_freeze_end_ticks.keys()) if round_freeze_end_ticks else []

    def freeze_tick_for_round(rn: int) -> Optional[int]:
        if rn in round_freeze_end_ticks:
            return int(round_freeze_end_ticks[rn])
        return None

    def round_end_tick_for(rn: int) -> Optional[int]:
        v = round_end_tick_map.get(int(rn))
        if v is not None:
            return int(v)
        if not freeze_sorted:
            return None
        try:
            idx = freeze_sorted.index(int(rn))
        except ValueError:
            return None
        if idx + 1 < len(freeze_sorted):
            nxt = int(round_freeze_end_ticks[freeze_sorted[idx + 1]])
            return nxt - int(5 * tick_rate)
        fe = int(round_freeze_end_ticks.get(int(rn)) or 0)
        return fe + int(30 * tick_rate) if fe else None

    rows_out: list[dict[str, Any]] = []
    killfeed_by_round: dict[int, list[dict[str, Any]]] = defaultdict(list)
    ev_seq = 0

    if events is not None and not events.empty and tp:
        for _, row in events.iterrows():
            attacker = str(row.get("attacker_name", "") or "").strip()
            victim = str(row.get("user_name", "") or "").strip()
            if not victim and "player_name" in row:
                victim = str(row.get("player_name", "") or "").strip()
            assister = ""
            if assist_col:
                raw_ast = row.get(assist_col, "")
                if pd.isna(raw_ast):
                    assister = ""
                else:
                    assister = str(raw_ast).strip()
                if assister.lower() in ("nan", "nat", "none"):
                    assister = ""
            tick = _int(row.get("tick"))
            base_rn = _int(row.get("total_rounds_played")) + 1
            weapon = _normalize_item(row.get("weapon", ""))
            weapon_name = _weapon_label(weapon)
            headshot = _bool(row.get("headshot"))
            attacker_sid = _norm_steam_cell(row.get("attacker_steamid"))
            victim_sid = _norm_steam_cell(row.get("user_steamid"))
            assister_sid = _norm_steam_cell(row.get("assister_steamid"))
            flags = _death_notice_flags(row, dp)

            is_att = attacker == tp and attacker and attacker != victim
            is_vic = victim == tp
            is_ast = bool(assister) and assister == tp and attacker and attacker != victim

            if not (is_att or is_vic or is_ast):
                continue

            if is_att:
                typ = "kill"
            elif is_vic:
                typ = "death"
            elif is_ast:
                typ = "assist"
            else:
                typ = "unknown"

            eff_rn = _adjust_round_for_pre_freeze(base_rn, tick, round_freeze_end_ticks)

            fe_tick = freeze_tick_for_round(eff_rn)
            round_time_sec: Optional[float] = None
            if fe_tick is not None and tick >= fe_tick and tick_rate > 0:
                round_time_sec = (tick - fe_tick) / float(tick_rate)
            time_text = _time_text_from_seconds(round_time_sec)

            freeze_for_suggest = fe_tick if fe_tick is not None else freeze_tick_for_round(eff_rn) or 0
            pre_w = int(tick_rate * 6.0)
            post_w = int(tick_rate * 4.0)
            st_s = max(int(freeze_for_suggest), tick - pre_w)
            et_s = tick + post_w
            rem = _related_clip_ids(tick, eff_rn, clips)

            if typ == "kill":
                desc = f"{tp} 使用 {weapon_name}{' 爆头' if headshot else ''} 击杀 {victim or '?'}"
            elif typ == "death":
                killer = attacker if attacker and attacker != victim else "?"
                desc = f"{tp} 被 {killer} 使用 {weapon_name}{' 爆头' if headshot else ''} 击杀"
            else:
                desc = f"{tp} 助攻 {attacker} 击杀 {victim}"

            ev_seq += 1
            eid = f"r{eff_rn}-t{tick}-{typ}-{ev_seq}"
            legacy_ev = {
                "id": eid,
                "type": typ,
                "round": int(eff_rn),
                "tick": int(tick),
                "round_time_seconds": round_time_sec,
                "attacker_name": attacker or None,
                "attacker_steamid": attacker_sid,
                "victim_name": victim or None,
                "victim_steamid": victim_sid,
                "assister_name": (assister or None) if assist_col else None,
                "assister_steamid": assister_sid,
                "weapon": weapon or None,
                "headshot": bool(headshot),
                "is_target_attacker": bool(is_att),
                "is_target_victim": bool(is_vic),
                "is_target_assister": bool(is_ast),
                "side": _team_num_to_side(_int(row.get("attackerteam"))) if is_att else (
                    _team_num_to_side(_int(row.get("userteam"))) if is_vic else None
                ),
                "description": desc,
                "recordable": typ in ("kill", "death"),
                "suggested_clip": {
                    "start_tick": int(st_s),
                    "end_tick": int(et_s),
                    "pre_seconds": 6.0,
                    "post_seconds": 4.0,
                },
                "_related_clip_ids": rem,
            }
            rows_out.append(legacy_ev)

            if typ == "kill":
                killfeed_by_round[eff_rn].append(
                    {
                        "id": eid,
                        "type": "kill",
                        "round": int(eff_rn),
                        "tick": int(tick),
                        "time_text": time_text,
                        "attacker_name": attacker,
                        "victim_name": victim,
                        "assister_name": (assister or None) if (assist_col and assister) else None,
                        "weapon_name": weapon_name,
                        "weapon_key": weapon or None,
                        "weapon_icon": None,
                        **flags,
                        "is_player_kill": True,
                        "is_player_death": False,
                        "can_record": True,
                        "record_type": "kill",
                        "start_tick": int(st_s),
                        "end_tick": int(et_s),
                        "suggested_clip": legacy_ev["suggested_clip"],
                        "related_clip_ids": rem,
                    },
                )
            elif typ == "death":
                killer = attacker if attacker and attacker != victim else ""
                killfeed_by_round[eff_rn].append(
                    {
                        "id": eid,
                        "type": "death",
                        "round": int(eff_rn),
                        "tick": int(tick),
                        "time_text": time_text,
                        "attacker_name": killer,
                        "victim_name": victim,
                        "assister_name": (assister or None) if (assist_col and assister) else None,
                        "weapon_name": weapon_name,
                        "weapon_key": weapon or None,
                        "weapon_icon": None,
                        **flags,
                        "is_player_kill": False,
                        "is_player_death": True,
                        "can_record": True,
                        "record_type": "death",
                        "start_tick": int(st_s),
                        "end_tick": int(et_s),
                        "suggested_clip": legacy_ev["suggested_clip"],
                        "related_clip_ids": rem,
                    },
                )
            elif typ == "assist":
                killfeed_by_round[eff_rn].append(
                    {
                        "id": eid,
                        "type": "assist_only",
                        "round": int(eff_rn),
                        "tick": int(tick),
                        "time_text": time_text,
                        "attacker_name": attacker,
                        "victim_name": victim,
                        "assister_name": tp,
                        "weapon_name": weapon_name,
                        "weapon_key": weapon or None,
                        "weapon_icon": None,
                        **{k: False for k in (
                            "is_headshot", "is_noscope", "is_through_smoke",
                            "is_blind", "is_wallbang", "is_jump_kill", "is_flash_assist",
                        )},
                        "is_player_kill": False,
                        "is_player_death": False,
                        "can_record": False,
                        "record_type": None,
                        "assist_note": f"助攻：协助 {attacker} 击杀 {victim}",
                        "start_tick": int(st_s),
                        "end_tick": int(et_s),
                        "suggested_clip": legacy_ev["suggested_clip"],
                        "related_clip_ids": rem,
                    },
                )

    by_round: dict[int, list[dict[str, Any]]] = {i: [] for i in range(1, tr + 1)}
    for ev in rows_out:
        rem = ev.pop("_related_clip_ids", [])
        rn = int(ev.get("round") or 1)
        rn = max(1, min(tr, rn))
        by_round.setdefault(rn, []).append(ev)
        ev["related_clip_ids"] = rem

    rounds_payload: list[dict[str, Any]] = []
    kill_sum = death_sum = assist_sum = 0
    round_tl_out: list[dict[str, Any]] = []
    hl_by_round = _merge_highlight_tags_per_round(clips, tr)

    for rn in range(1, tr + 1):
        evs = sorted(by_round.get(rn, []), key=lambda x: (int(x.get("tick") or 0), str(x.get("id") or "")))
        tk = sum(1 for x in evs if x.get("type") == "kill")
        td = sum(1 for x in evs if x.get("type") == "death")
        ta = sum(1 for x in evs if x.get("type") == "assist")
        kill_sum += tk
        death_sum += td
        assist_sum += ta

        fe = freeze_tick_for_round(rn)
        ret = round_end_tick_for(rn)
        record_end = _timeline_round_record_end_tick(
            rn, ret, float(tick_rate), round_freeze_end_ticks, evs,
        )

        target_won = round_result_map.get(rn)
        winner_tct = winners_by_ended.get(int(rn))

        st_t, ct_t = _round_scoreboard_at_round_start(rn, round_scores_by_round)
        score_text = (
            f"{st_t}:{ct_t}" if st_t is not None and ct_t is not None else "--"
        )

        rel_ids: list[str] = []
        seen_c: set[str] = set()
        for ev in evs:
            for cid in ev.get("related_clip_ids") or []:
                if cid and cid not in seen_c:
                    seen_c.add(cid)
                    rel_ids.append(cid)
        for c in clips or []:
            if not isinstance(c, dict):
                continue
            try:
                if int(c.get("round") or -1) == rn:
                    cid = str(c.get("clip_id") or "").strip()
                    if cid and cid not in seen_c:
                        seen_c.add(cid)
                        rel_ids.append(cid)
            except (TypeError, ValueError):
                pass

        rounds_payload.append(
            {
                "round": rn,
                "round_start_tick": int(fe) if fe is not None else None,
                "round_end_tick": int(ret) if ret is not None else None,
                "record_end_tick": int(record_end) if record_end is not None else None,
                "winner": winner_tct,
                "target_won_round": bool(target_won) if isinstance(target_won, bool) else None,
                "score_t": st_t,
                "score_ct": ct_t,
                "target_kills": tk,
                "target_deaths": td,
                "target_assists": ta,
                "events": evs,
                "related_clip_ids": rel_ids,
                "highlight_tags": list(hl_by_round.get(rn, [])),
            },
        )

        tside = _team_num_to_side(_target_team_for_round(rn, round_target_team_map) or target_team_num)
        res = None
        if isinstance(target_won, bool):
            res = "win" if target_won else "loss"
        kf_sorted = sorted(
            killfeed_by_round.get(rn, []),
            key=lambda x: (int(x.get("tick") or 0), str(x.get("id") or "")),
        )
        headshots = _enrich_killfeed_events(kf_sorted)
        round_tl_out.append(
            {
                "round_number": rn,
                "side": tside,
                "result": res,
                "score_text": score_text,
                "start_tick": int(fe) if fe is not None else None,
                "end_tick": int(ret) if ret is not None else None,
                "record_end_tick": int(record_end) if record_end is not None else None,
                "focused_player": tp,
                "summary": {"kills": tk, "deaths": td, "assists": ta},
                "player_stats": {"kills": tk, "deaths": td, "assists": ta, "headshots": headshots},
                "events": kf_sorted,
                "related_clip_ids": rel_ids,
                "highlight_tags": list(hl_by_round.get(rn, [])),
            },
        )

    legacy = {
        "demo_path": demo_path,
        "map_name": map_name or None,
        "target_player": {
            "name": tp,
            "steamid": target_steam_id,
            "user_id": target_player_user_id,
            "team": _team_num_to_side(target_team_num),
        },
        "rounds": rounds_payload,
        "summary": {
            "round_count": tr,
            "kill_count": kill_sum,
            "death_count": death_sum,
            "assist_count": assist_sum,
        },
    }
    return {"timeline": legacy, "round_timeline": round_tl_out}


def build_round_timeline_error_fallback(
    *,
    demo_path: str,
    map_name: str,
    target_player: str,
    target_steam_id: Optional[str],
    target_player_user_id: Optional[int],
    total_rounds: int,
) -> dict[str, Any]:
    n = max(1, int(total_rounds))
    empty_round = {
        "round": 0,
        "round_start_tick": None,
        "round_end_tick": None,
        "record_end_tick": None,
        "winner": None,
        "target_won_round": None,
        "score_t": None,
        "score_ct": None,
        "target_kills": 0,
        "target_deaths": 0,
        "target_assists": 0,
        "events": [],
        "related_clip_ids": [],
        "highlight_tags": [],
    }
    rt_empty = [
        {
            "round_number": i,
            "side": None,
            "result": None,
            "score_text": "--",
            "start_tick": None,
            "end_tick": None,
            "record_end_tick": None,
            "focused_player": target_player,
            "summary": {"kills": 0, "deaths": 0, "assists": 0},
            "player_stats": {"kills": 0, "deaths": 0, "assists": 0, "headshots": 0},
            "events": [],
            "related_clip_ids": [],
            "highlight_tags": [],
        }
        for i in range(1, n + 1)
    ]
    return {
        "timeline": {
            "demo_path": demo_path,
            "map_name": map_name,
            "target_player": {
                "name": target_player,
                "steamid": target_steam_id,
                "user_id": target_player_user_id,
                "team": None,
            },
            "rounds": [{**empty_round, "round": j} for j in range(1, n + 1)],
            "summary": {
                "round_count": n,
                "kill_count": 0,
                "death_count": 0,
                "assist_count": 0,
            },
        },
        "round_timeline": rt_empty,
    }
