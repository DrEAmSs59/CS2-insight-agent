from __future__ import annotations

import math
import os
import uuid
from typing import Any, Optional

import pandas as pd

from .models import Clip
from .parse_utils import _int, _bool, _cell_str
from .tag_constants import (
    TICK_RATE,
    BUFFER_SECONDS_BEFORE,
    BUFFER_SECONDS_AFTER,
    _DEATH_CLIP_LEAD_SECONDS,
    _DEFUSE_EXTREME_MIN_SEC,
    _NINJA_ENEMY_MAX_DIST_3D,
    _FREEZE_TO_DEATH_PRE_FREEZE_SEC,
    _FREEZE_TO_DEATH_POST_DEATH_SEC,
    _RIVAL_KILL_THRESHOLD,
    _NEMESIS_DEATH_THRESHOLD,
    _SHOULDER_DIST,
    _SHOULDER_MIN_SECS,
    _SHOULDER_SAMPLE_INTERVAL,
    _SHOULDER_PRE_SECS,
    _SHOULDER_POST_SECS,
    _dedup_context_tags,
)
from .weapons import _translate_weapon
from .spatial_analysis import (
    _spatial_player_row,
    build_equip_timeline,
    check_timing_law,
    check_human_magnet,
    check_outline_master,
    check_backstab_fail,
)
from .tag_detection import (
    detect_fail_tags,
    check_zombie_step,
    check_stroll,
    check_magnet_nade,
    check_flash_send,
    _fail_killer_display_name,
    check_victim_in_air,
)


# ── 小工具（原 DemoAnalyzer 静态方法） ──────────────────────────

def _df_filter_match_start(df: pd.DataFrame, match_start_tick: int) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    if match_start_tick > 0 and "tick" in df.columns:
        return df[pd.to_numeric(df["tick"], errors="coerce").fillna(0).astype(float) >= match_start_tick].copy()
    return df


def _defuser_name_from_row(row: pd.Series) -> str:
    for col in ("user_name", "defuser", "defuser_name", "player_name"):
        v = _cell_str(row.get(col))
        if v:
            return v
    return ""


def is_mr12_regulation_decided_score(
    score_own: Optional[int],
    score_opp: Optional[int],
) -> bool:
    """MR12 正规时间已定局：一方胜场 ≥13 且另一方仍 ≤11。"""
    if score_own is None or score_opp is None:
        return False
    lo, hi = min(score_own, score_opp), max(score_own, score_opp)
    return hi >= 13 and lo <= 11


def match_metrics_from_round_scores(
    round_team_score_map: dict[int, tuple[int, int]],
) -> tuple[int, Optional[tuple[int, int]]]:
    """从记分进度里取「已打完的回合总数」与终局比分线。"""
    if not round_team_score_map:
        return 0, None
    best_sum = -1
    best_pair: Optional[tuple[int, int]] = None
    for o, e in round_team_score_map.values():
        s = o + e
        if s > best_sum:
            best_sum = s
            best_pair = (o, e)
    if best_sum < 0 or best_pair is None:
        return 0, None
    return best_sum, best_pair


def is_post_match_round(
    round_num: int,
    score_own: Optional[int],
    score_opp: Optional[int],
    *,
    completed_rounds: int,
    final_scoreline: Optional[tuple[int, int]],
) -> bool:
    """是否应视为正赛已结束后的无意义回合。"""
    if completed_rounds > 0 and round_num > completed_rounds:
        return True
    if is_mr12_regulation_decided_score(score_own, score_opp):
        return True
    if (
        score_own is not None
        and score_opp is not None
        and final_scoreline is not None
        and (score_own, score_opp) == final_scoreline
        and (score_own + score_opp) == completed_rounds
        and completed_rounds > 0
    ):
        return True
    return False


def round_start_scores_for_target(
    round_num: int,
    round_team_score_map: dict[int, tuple[int, int]],
) -> tuple[Optional[int], Optional[int]]:
    """本回合开局时目标队与对方队的真实比赛胜场。"""
    result = round_team_score_map.get(round_num) if round_team_score_map else None
    if result is None:
        return None, None
    return result[0], result[1]


def make_clip(
    round_num: int,
    category: str,
    weapon: str,
    kill_count: int,
    tick: int,
    tags: list[str],
    end_tick_override: int | None = None,
    killer_name: Optional[str] = None,
    killer_steamid64: Optional[str] = None,
    victims: Optional[list[str]] = None,
    *,
    death_core: bool = False,
    score_own: Optional[int] = None,
    score_opp: Optional[int] = None,
    round_won: Optional[bool] = None,
    clip_min_tick: Optional[int] = None,
    map_name: str = "unknown",
) -> Clip:
    if death_core:
        start = max(0, tick - int(TICK_RATE * float(_DEATH_CLIP_LEAD_SECONDS)))
    else:
        start = max(0, tick - BUFFER_SECONDS_BEFORE * TICK_RATE)
    end = end_tick_override if end_tick_override else tick + BUFFER_SECONDS_AFTER * TICK_RATE
    return Clip(
        clip_id=f"c_{uuid.uuid4().hex[:8]}",
        map_name=map_name,
        round=round_num,
        category=category,
        weapon_used=_translate_weapon(weapon),
        kill_count=kill_count,
        start_tick=start,
        end_tick=end,
        context_tags=_dedup_context_tags(tags),
        killer_name=killer_name,
        killer_steamid64=killer_steamid64 or None,
        victims=list(victims) if victims else [],
        score_own=score_own,
        score_opp=score_opp,
        round_won=round_won,
        clip_min_tick=clip_min_tick,
        death_tick=tick if death_core else None,
    )


def collect_target_defuse_ticks_for_spatial(
    planted_df: pd.DataFrame,
    defused_df: pd.DataFrame,
    target_player: str,
    match_start_tick: int,
) -> list[int]:
    """目标玩家完成拆包时，需要解析拆包 tick 的空间快照（忍者判定）。"""
    tp = str(target_player or "").strip().lower()
    if not tp or defused_df.empty or planted_df.empty:
        return []
    pd_df = _df_filter_match_start(planted_df, match_start_tick)
    dd_df = _df_filter_match_start(defused_df, match_start_tick)
    plant_ticks = sorted(
        {_int(r.get("tick")) for _, r in pd_df.iterrows() if _int(r.get("tick")) > 0}
    )
    if not plant_ticks:
        return []
    out: list[int] = []
    for _, row in dd_df.sort_values("tick", kind="mergesort").iterrows():
        d_tick = _int(row.get("tick"))
        if d_tick <= 0:
            continue
        if _defuser_name_from_row(row).strip().lower() != tp:
            continue
        plant_tick = None
        for pt in reversed(plant_ticks):
            if pt < d_tick:
                plant_tick = pt
                break
        if plant_tick is not None:
            out.append(d_tick)
    return out


def _ninja_defuse_ok(snapshot: pd.DataFrame, defuser: str, target_player: str) -> bool:
    if snapshot is None or snapshot.empty:
        return False
    if not defuser or defuser.strip().lower() != str(target_player or "").strip().lower():
        return False
    for col in ("X", "Y", "Z"):
        if col not in snapshot.columns:
            return False
    name_col = "name" if "name" in snapshot.columns else None
    if name_col is None or "team_num" not in snapshot.columns or "is_alive" not in snapshot.columns:
        return False
    alive_df = snapshot[snapshot["is_alive"].astype(bool)]
    def_row = _spatial_player_row(alive_df, defuser)
    if def_row is None:
        return False
    try:
        dx = float(def_row["X"])
        dy = float(def_row["Y"])
        dz = float(def_row["Z"])
        def_team = int(float(def_row["team_num"]))
    except (TypeError, ValueError, KeyError):
        return False

    enemies: list[tuple[float, float, float]] = []
    for _, r in alive_df.iterrows():
        nm = str(r.get(name_col) or "").strip()
        if not nm or nm.strip().lower() == defuser.strip().lower():
            continue
        try:
            tm = int(float(r["team_num"]))
        except (TypeError, ValueError):
            continue
        if tm == def_team:
            continue
        try:
            enemies.append((float(r["X"]), float(r["Y"]), float(r["Z"])))
        except (TypeError, ValueError, KeyError):
            return False

    if len(enemies) < 2:
        return False
    for ex, ey, ez in enemies:
        d3 = math.sqrt((ex - dx) ** 2 + (ey - dy) ** 2 + (ez - dz) ** 2)
        if d3 >= _NINJA_ENEMY_MAX_DIST_3D:
            return False
    return True


def analyze_bomb_defuse_highlights(
    planted_df: pd.DataFrame,
    defused_df: pd.DataFrame,
    target_player: str,
    match_start_tick: int,
    spatial_cache: dict[int, pd.DataFrame],
    round_freeze_end_ticks: dict[int, int],
) -> list[dict]:
    """目标玩家拆包：极限拆包时间 + 忍者偷包。"""
    tp = str(target_player or "").strip().lower()
    out: list[dict] = []
    if not tp or defused_df.empty or planted_df.empty:
        return out
    pd_df = _df_filter_match_start(planted_df, match_start_tick)
    dd_df = _df_filter_match_start(defused_df, match_start_tick)
    plant_ticks = sorted(
        {_int(r.get("tick")) for _, r in pd_df.iterrows() if _int(r.get("tick")) > 0}
    )
    if not plant_ticks:
        return out
    trc = "total_rounds_played" if "total_rounds_played" in dd_df.columns else None

    for _, row in dd_df.sort_values("tick", kind="mergesort").iterrows():
        d_tick = _int(row.get("tick"))
        if d_tick <= 0:
            continue
        defuser = _defuser_name_from_row(row)
        if defuser.strip().lower() != tp:
            continue
        plant_tick = None
        for pt in reversed(plant_ticks):
            if pt < d_tick:
                plant_tick = pt
                break
        if plant_tick is None:
            continue
        rnd = 0
        if trc is not None:
            rnd = _int(row.get(trc)) + 1
        elif "round" in row.index:
            rnd = _int(row.get("round"))
        if rnd <= 0 and round_freeze_end_ticks:
            for rn, ft_tick in sorted(round_freeze_end_ticks.items(), reverse=True):
                if ft_tick <= d_tick:
                    rnd = rn
                    break
        if rnd <= 0:
            continue

        tags: list[str] = []
        elapsed = (d_tick - plant_tick) / float(TICK_RATE)
        if elapsed >= _DEFUSE_EXTREME_MIN_SEC:
            tags.append(f"⏱️ 极限拆包 ({40.0 - elapsed:.1f}s)")
        snap = spatial_cache.get(d_tick)
        if snap is not None and _ninja_defuse_ok(snap, defuser, target_player):
            tags.append("🥷 忍者偷包")
        if tags:
            out.append({"round": rnd, "defuse_tick": d_tick, "tags": tags})
    return out


def build_fail_clips(
    target_player: str,
    death_records: list[dict],
    equip_df: pd.DataFrame,
    fire_df: pd.DataFrame,
    hurt_df: pd.DataFrame,
    spatial_cache: dict[int, pd.DataFrame],
    round_target_kill_ticks: dict[int, list[int]],
    round_team_score_map: dict[int, tuple[int, int]],
    round_result_map: dict[int, bool],
    round_freeze_end_ticks: dict[int, int],
    *,
    map_name: str,
    grenade_detonate_points: Optional[list[tuple[int, float, float]]] = None,
) -> tuple[list[Clip], set[tuple[int, int]]]:
    equip_timeline = build_equip_timeline(target_player, equip_df)
    from .spatial_analysis import build_fire_index, build_hurt_index
    fire_index = build_fire_index(target_player, fire_df)
    hurt_index = build_hurt_index(target_player, hurt_df)

    clips: list[Clip] = []
    fail_death_keys: set[tuple[int, int]] = set()

    for death in death_records:
        backstab_tags = check_backstab_fail(
            death, fire_index, hurt_index, spatial_cache,
            target_player, round_target_kill_ticks,
        )
        if backstab_tags:
            so, se = round_start_scores_for_target(death["round"], round_team_score_map)
            clips.append(make_clip(
                round_num=death["round"],
                category="fail",
                weapon=death["weapon"],
                kill_count=0,
                tick=death["tick"],
                tags=backstab_tags,
                killer_name=_fail_killer_display_name(death, target_player),
                killer_steamid64=death.get("attacker_steamid"),
                death_core=True,
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(death["round"]),
                clip_min_tick=round_freeze_end_ticks.get(death["round"]),
                map_name=map_name,
            ))
            fail_death_keys.add((death["round"], death["tick"]))
            continue

        tags: list[str] = []

        tags.extend(detect_fail_tags(
            weapon=death["weapon"],
            headshot=death["headshot"],
            attacker=death["attacker"],
            victim=target_player,
            attacker_team=death["attacker_team"],
            victim_team=death["victim_team"],
            attackerblind=death["attackerblind"],
            assistedflash=death["assistedflash"],
        ))

        tags.extend(check_timing_law(death, equip_timeline))

        if death["headshot"] and spatial_cache:
            tags.extend(check_human_magnet(death, target_player, spatial_cache))

        tags.extend(check_outline_master(death, fire_index, hurt_index, round_target_kill_ticks))

        if spatial_cache:
            tags.extend(check_zombie_step(death, spatial_cache, target_player))
            tags.extend(check_stroll(death, spatial_cache, target_player))
            tags.extend(check_magnet_nade(death, spatial_cache, target_player, grenade_detonate_points))
        tags.extend(check_flash_send(death, death["round"], round_freeze_end_ticks))
        tags.extend(check_victim_in_air(death))

        seen: set[str] = set()
        unique_tags = [t for t in tags if not (t in seen or seen.add(t))]  # type: ignore[func-returns-value]

        if unique_tags:
            so, se = round_start_scores_for_target(death["round"], round_team_score_map)
            clips.append(make_clip(
                round_num=death["round"],
                category="fail",
                weapon=death["weapon"],
                kill_count=0,
                tick=death["tick"],
                tags=unique_tags,
                killer_name=_fail_killer_display_name(death, target_player),
                killer_steamid64=death.get("attacker_steamid"),
                death_core=True,
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(death["round"]),
                clip_min_tick=round_freeze_end_ticks.get(death["round"]),
                map_name=map_name,
            ))
            fail_death_keys.add((death["round"], death["tick"]))

    return clips, fail_death_keys


def detect_shoulder_clips(
    *,
    spatial_cache: dict[int, pd.DataFrame],
    target_player: str,
    round_freeze_end_ticks: dict[int, int],
    round_result_map: dict[int, bool | None],
    round_team_score_map: dict,
    round_death_tick_map: dict[int, int],
    map_name: str,
) -> list[Clip]:
    """检测「目标玩家与敌人肩并肩」下饭场景。"""
    clips: list[Clip] = []
    if not round_freeze_end_ticks:
        return clips

    sorted_rounds = sorted(round_freeze_end_ticks.keys())

    for i, rnd in enumerate(sorted_rounds):
        freeze_start = round_freeze_end_ticks[rnd]
        if i + 1 < len(sorted_rounds):
            round_end = round_freeze_end_ticks[sorted_rounds[i + 1]] - int(5 * TICK_RATE)
        else:
            round_end = freeze_start + int(150 * TICK_RATE)

        best_start: int | None = None
        best_end:   int | None = None
        best_enemy: str | None = None
        best_min_dist: float   = float("inf")

        cur_start: int | None  = None
        cur_enemy: str | None  = None
        cur_min_dist: float    = float("inf")

        tick = freeze_start
        while tick < round_end:
            snap = spatial_cache.get(tick)
            if snap is None or snap.empty:
                cur_start = None
                tick += _SHOULDER_SAMPLE_INTERVAL
                continue

            tgt_row = _spatial_player_row(snap, target_player)
            if tgt_row is None or not _bool(tgt_row.get("is_alive")):
                cur_start = None
                tick += _SHOULDER_SAMPLE_INTERVAL
                continue

            try:
                tgt_x    = float(tgt_row["X"])
                tgt_y    = float(tgt_row["Y"])
                tgt_team = int(float(tgt_row["team_num"]))
            except (TypeError, ValueError, KeyError):
                cur_start = None
                tick += _SHOULDER_SAMPLE_INTERVAL
                continue

            closest_dist: float = float("inf")
            closest_name: str | None = None
            for _, erow in snap.iterrows():
                ename = str(erow.get("name") or "").strip()
                if not ename or ename == target_player:
                    continue
                if not _bool(erow.get("is_alive")):
                    continue
                try:
                    eteam = int(float(erow["team_num"]))
                    if eteam == tgt_team:
                        continue
                    ex = float(erow["X"])
                    ey = float(erow["Y"])
                    d  = math.hypot(tgt_x - ex, tgt_y - ey)
                    if d < closest_dist:
                        closest_dist = d
                        closest_name = ename
                except (TypeError, ValueError):
                    pass

            if closest_dist <= _SHOULDER_DIST:
                if cur_start is None or closest_name != cur_enemy:
                    cur_start    = tick
                    cur_enemy    = closest_name
                    cur_min_dist = closest_dist
                else:
                    cur_min_dist = min(cur_min_dist, closest_dist)

                if (tick - cur_start) >= int(_SHOULDER_MIN_SECS * TICK_RATE):
                    if best_start is None or (tick - cur_start) > (best_end - best_start):  # type: ignore[operator]
                        best_start    = cur_start
                        best_end      = tick
                        best_enemy    = cur_enemy
                        best_min_dist = cur_min_dist
            else:
                cur_start = None
                cur_enemy = None

            tick += _SHOULDER_SAMPLE_INTERVAL

        if best_start is None:
            continue

        duration_secs = (best_end - best_start) / TICK_RATE  # type: ignore[operator]
        so, se = round_start_scores_for_target(rnd, round_team_score_map)
        death_tick = round_death_tick_map.get(rnd)

        ctx_tags = ["🧍 肩并肩", "🙈 视而不见"]
        if best_enemy:
            ctx_tags.append(f"👫 同框: {best_enemy}")
        if duration_secs >= 4.0:
            ctx_tags.append(f"⏳ 持续 {duration_secs:.1f}s")

        clips.append(Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            map_name=map_name,
            round=rnd,
            category="fail",
            weapon_used="",
            kill_count=0,
            start_tick=max(0, best_start - int(_SHOULDER_PRE_SECS * TICK_RATE)),
            end_tick=best_end + int(_SHOULDER_POST_SECS * TICK_RATE),
            context_tags=ctx_tags,
            victims=[],
            kill_ticks=[],
            score_own=so,
            score_opp=se,
            round_won=round_result_map.get(rnd),
            clip_min_tick=round_freeze_end_ticks.get(rnd),
            death_tick=death_tick,
        ))

    return clips


def build_rival_compilations(
    target_player: str,
    round_kills: dict[int, list[dict]],
    death_records: list[dict],
    round_team_score_map: dict[int, tuple[int, int]],
    round_result_map: dict[int, bool],
    round_freeze_end_ticks: dict[int, int],
    *,
    freeze_to_death_rounds: Optional[list[int]] = None,
    round_freeze_start_ticks: Optional[dict[int, int]] = None,
    map_name: str,
    demo_max_tick: int = 0,
) -> list[Clip]:
    compilations: list[Clip] = []
    _done_rounds, _final_line = match_metrics_from_round_scores(round_team_score_map)

    _last_compilation_event_buf_ticks = int(float(
        os.environ.get("CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC", "0.70") or "0.70"
    ) * TICK_RATE)

    def _segment_around_tick(
        tick: int,
        *,
        round_num: int = 0,
        lead_seconds: float = BUFFER_SECONDS_BEFORE,
    ) -> list[int]:
        end_tick = tick + BUFFER_SECONDS_AFTER * TICK_RATE
        if _done_rounds > 0 and round_num == _done_rounds:
            end_tick = min(end_tick, tick + _last_compilation_event_buf_ticks)
        return [
            max(0, tick - int(float(lead_seconds) * TICK_RATE)),
            max(tick + 1, end_tick),
        ]

    all_target_kills: list[tuple[int, int, str, str]] = []
    for rnd, kills in round_kills.items():
        for k in kills:
            kt = _int(k.get("tick"))
            victim = str(k.get("victim") or "").strip()
            victim_steamid = str(k.get("victim_steamid") or "").strip()
            if kt <= 0 or not victim:
                continue
            so, se = round_start_scores_for_target(rnd, round_team_score_map)
            if is_post_match_round(rnd, so, se, completed_rounds=_done_rounds, final_scoreline=_final_line):
                continue
            all_target_kills.append((rnd, kt, victim, victim_steamid))
    all_target_kills.sort(key=lambda item: (item[1], item[0], item[2]))

    all_target_deaths: list[tuple[int, int, str, str]] = []
    for d in death_records:
        rn = _int(d.get("round"))
        dt = _int(d.get("tick"))
        attacker = str(d.get("attacker") or "").strip()
        attacker_steamid = str(d.get("attacker_steamid") or "").strip()
        if rn <= 0 or dt <= 0 or not attacker or attacker == target_player:
            continue
        so, se = round_start_scores_for_target(rn, round_team_score_map)
        if is_post_match_round(rn, so, se, completed_rounds=_done_rounds, final_scoreline=_final_line):
            continue
        all_target_deaths.append((rn, dt, attacker, attacker_steamid))
    all_target_deaths.sort(key=lambda item: (item[1], item[0], item[2]))

    # —— 🥩 亲儿子喂饭 ——
    kills_by_enemy: dict[str, list[tuple[int, int]]] = {}
    for rnd, kills in round_kills.items():
        for k in kills:
            v = str(k.get("victim") or "").strip()
            if not v:
                continue
            kills_by_enemy.setdefault(v, []).append((rnd, _int(k.get("tick"))))

    for enemy, items in kills_by_enemy.items():
        filtered: list[tuple[int, int]] = []
        for rn, kt in items:
            so, se = round_start_scores_for_target(rn, round_team_score_map)
            if not is_post_match_round(rn, so, se, completed_rounds=_done_rounds, final_scoreline=_final_line):
                filtered.append((rn, kt))
        items = filtered
        if len(items) < _RIVAL_KILL_THRESHOLD:
            continue
        items.sort()
        source_ticks: list[list[int]] = []
        for (_rnd, kt) in items:
            source_ticks.append([
                max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                _segment_around_tick(kt, round_num=_rnd)[1],
            ])
        first_rnd, first_t = items[0]
        _last_rnd, last_t = items[-1]
        compilations.append(Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            map_name=map_name,
            round=first_rnd,
            category="compilation",
            weapon_used="",
            kill_count=len(items),
            start_tick=source_ticks[0][0],
            end_tick=source_ticks[-1][1],
            context_tags=["🥩 亲儿子喂饭", f"👉 {enemy} × {len(items)}"],
            killers=[target_player] * len(items),
            victims=[enemy] * len(items),
            kill_ticks=[kt for _, kt in items],
            round_won=round_result_map.get(first_rnd),
            clip_min_tick=round_freeze_end_ticks.get(first_rnd),
            source_ticks=source_ticks,
            source_rounds=[rn for rn, _ in items],
            compilation_kind="rival_kills",
        ))

    # —— ☠️ 本命苦主 ——
    deaths_by_attacker: dict[str, list[tuple[int, int]]] = {}
    for d in death_records:
        atk = str(d.get("attacker") or "").strip()
        if not atk or atk == target_player:
            continue
        deaths_by_attacker.setdefault(atk, []).append(
            (_int(d.get("round")), _int(d.get("tick"))),
        )

    for attacker, items in deaths_by_attacker.items():
        filtered = []
        for rn, dt in items:
            so, se = round_start_scores_for_target(rn, round_team_score_map)
            if not is_post_match_round(rn, so, se, completed_rounds=_done_rounds, final_scoreline=_final_line):
                filtered.append((rn, dt))
        items = filtered
        if len(items) < _NEMESIS_DEATH_THRESHOLD:
            continue
        items.sort()
        source_ticks = []
        for (_rnd, dt) in items:
            source_ticks.append([
                max(0, dt - int(TICK_RATE * float(_DEATH_CLIP_LEAD_SECONDS))),
                _segment_around_tick(dt, round_num=_rnd)[1],
            ])
        first_rnd, first_t = items[0]
        _last_rnd, last_t = items[-1]
        compilations.append(Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            map_name=map_name,
            round=first_rnd,
            category="compilation",
            weapon_used="",
            kill_count=0,
            start_tick=source_ticks[0][0],
            end_tick=source_ticks[-1][1],
            context_tags=["☠️ 本命苦主", f"💀 {attacker} × {len(items)}"],
            killer_name=attacker,
            killers=[attacker] * len(items),
            victims=[target_player] * len(items),
            kill_ticks=[dt for _, dt in items],
            round_won=round_result_map.get(first_rnd),
            clip_min_tick=round_freeze_end_ticks.get(first_rnd),
            source_ticks=source_ticks,
            source_rounds=[rn for rn, _ in items],
            compilation_kind="nemesis_deaths",
        ))

    if all_target_kills:
        first_rnd, first_t, _, _ = all_target_kills[0]
        _last_rnd, last_t, _, _ = all_target_kills[-1]
        source_ticks = [
            _segment_around_tick(kt, round_num=rn)
            for rn, kt, _, _ in all_target_kills
        ]
        victims = [victim for _, _, victim, _ in all_target_kills]
        victim_steamids = [vsid for _, _, _, vsid in all_target_kills]
        compilations.append(Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            map_name=map_name,
            round=first_rnd,
            category="compilation",
            weapon_used="",
            kill_count=len(all_target_kills),
            start_tick=source_ticks[0][0],
            end_tick=source_ticks[-1][1],
            context_tags=["🎬 全部击杀", f"🎯 {target_player} × {len(all_target_kills)}"],
            killers=[target_player] * len(all_target_kills),
            victims=victims,
            victim_steamid64s=victim_steamids,
            kill_ticks=[kt for _, kt, _, _ in all_target_kills],
            round_won=round_result_map.get(first_rnd),
            clip_min_tick=round_freeze_end_ticks.get(first_rnd),
            source_ticks=source_ticks,
            source_rounds=[rn for rn, _, _, _ in all_target_kills],
            compilation_kind="all_kills",
        ))

    if all_target_deaths:
        first_rnd, first_t, _, _ = all_target_deaths[0]
        _last_rnd, last_t, _, _ = all_target_deaths[-1]
        source_ticks = [
            _segment_around_tick(dt, round_num=rn, lead_seconds=float(_DEATH_CLIP_LEAD_SECONDS))
            for rn, dt, _, _ in all_target_deaths
        ]
        killers = [attacker for _, _, attacker, _ in all_target_deaths]
        killer_steamids = [asid for _, _, _, asid in all_target_deaths]
        compilations.append(Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            map_name=map_name,
            round=first_rnd,
            category="compilation",
            weapon_used="",
            kill_count=0,
            start_tick=source_ticks[0][0],
            end_tick=source_ticks[-1][1],
            context_tags=["💀 全部死亡", f"☠️ {target_player} × {len(all_target_deaths)}"],
            killer_name=None,
            killers=killers,
            killers_steamid64s=killer_steamids,
            victims=[target_player] * len(all_target_deaths),
            kill_ticks=[dt for _, dt, _, _ in all_target_deaths],
            round_won=round_result_map.get(first_rnd),
            clip_min_tick=round_freeze_end_ticks.get(first_rnd),
            source_ticks=source_ticks,
            source_rounds=[rn for rn, _, _, _ in all_target_deaths],
            compilation_kind="all_deaths",
        ))

    # —— 🎥 冻结结束前 → 死亡合集 ——
    if freeze_to_death_rounds is not None and len(freeze_to_death_rounds) == 0:
        pass
    else:
        _ftd_demo_mx = max(0, int(demo_max_tick or 0))
        ftd_filter: Optional[set[int]] = None
        if freeze_to_death_rounds is not None:
            ftd_filter = {int(x) for x in freeze_to_death_rounds if int(x) > 0}
        death_tick_by_round: dict[int, int] = {}
        for d in death_records:
            rn = _int(d.get("round"))
            dt = _int(d.get("tick"))
            if rn <= 0 or dt <= 0:
                continue
            prev = death_tick_by_round.get(rn)
            if prev is None or dt < prev:
                death_tick_by_round[rn] = dt

        pre_ticks = max(1, int(abs(_FREEZE_TO_DEATH_PRE_FREEZE_SEC) * TICK_RATE))
        post_ticks = max(1, int(abs(_FREEZE_TO_DEATH_POST_DEATH_SEC) * TICK_RATE))

        def _ftd_cap_at_death_round(rnd: int, death_tick: int) -> int:
            fe = int(round_freeze_end_ticks.get(rnd) or 0)
            raw_end = int(death_tick) + post_ticks
            next_fe = round_freeze_end_ticks.get(rnd + 1)
            if next_fe and next_fe > fe:
                return min(raw_end, int(next_fe) - int(5 * TICK_RATE))
            return raw_end

        def _ftd_safe_end_alive_round(rnd: int) -> int:
            next_fe = round_freeze_end_ticks.get(rnd + 1)
            if next_fe:
                return max(int(next_fe) - int(5 * TICK_RATE), 0)
            fe = int(round_freeze_end_ticks.get(rnd) or 0)
            return fe + int(150 * TICK_RATE) if fe > 0 else int(150 * TICK_RATE)

        eligible: list[int] = []
        for rnd in sorted(round_freeze_end_ticks.keys()):
            if ftd_filter is not None and rnd not in ftd_filter:
                continue
            so, se = round_start_scores_for_target(rnd, round_team_score_map)
            if is_post_match_round(rnd, so, se, completed_rounds=_done_rounds, final_scoreline=_final_line):
                continue
            fe = int(round_freeze_end_ticks.get(rnd) or 0)
            if fe <= 0:
                continue
            eligible.append(rnd)

        ftd_round_windows: list[dict[str, Any]] = []
        for rnd in eligible:
            fe = int(round_freeze_end_ticks.get(rnd) or 0)
            if fe <= 0:
                continue
            dt = death_tick_by_round.get(rnd)
            s = max(0, fe - pre_ticks)
            if dt is not None and int(dt) > 0:
                _dtk = int(dt)
                raw_end = _dtk + post_ticks
                cap_e = _ftd_cap_at_death_round(rnd, _dtk)
                e = max(s + 1, min(raw_end, cap_e))
            else:
                e = max(s + 1, _ftd_safe_end_alive_round(rnd))
            if _ftd_demo_mx > 0:
                e = max(s + 1, min(e, _ftd_demo_mx))
            ftd_round_windows.append({
                "round": int(rnd),
                "freeze_end_tick": int(fe),
                "start_tick": int(s),
                "end_tick": int(e),
                "death_tick": int(dt) if dt is not None and int(dt) > 0 else None,
                "round_start_tick": (round_freeze_start_ticks or {}).get(rnd),
            })

        ftd_segments: list[tuple[int, int, int, int, Optional[int]]] = []
        run_start_r: Optional[int] = None
        run_start_tick: int = 0
        last_r: Optional[int] = None

        def _emit_death_segment(sr: int, s_tick: int, er: int, d_tick: int) -> None:
            raw_end = int(d_tick) + post_ticks
            cap_e = _ftd_cap_at_death_round(er, d_tick)
            seg_end = max(s_tick + 1, min(raw_end, cap_e))
            if _ftd_demo_mx > 0:
                seg_end = max(s_tick + 1, min(seg_end, _ftd_demo_mx))
            if seg_end <= s_tick:
                return
            ftd_segments.append((s_tick, seg_end, sr, er, d_tick))

        def _emit_alive_segment(sr: int, s_tick: int, er: int) -> None:
            cap_e = _ftd_safe_end_alive_round(er)
            if _ftd_demo_mx > 0:
                cap_e = min(cap_e, _ftd_demo_mx)
            if cap_e <= s_tick:
                return
            ftd_segments.append((s_tick, cap_e, sr, er, None))

        def _flush_open_run() -> None:
            nonlocal run_start_r, run_start_tick, last_r
            if run_start_r is None or last_r is None:
                return
            _emit_alive_segment(run_start_r, run_start_tick, last_r)
            run_start_r = None
            last_r = None

        for rnd in eligible:
            fe = int(round_freeze_end_ticks.get(rnd) or 0)
            if fe <= 0:
                continue
            dt = death_tick_by_round.get(rnd)

            if run_start_r is None:
                run_start_r = rnd
                run_start_tick = max(0, fe - pre_ticks)
                last_r = rnd
                if dt is not None and dt > 0:
                    _emit_death_segment(run_start_r, run_start_tick, rnd, dt)
                    run_start_r = None
                    last_r = None
                continue

            if rnd != last_r + 1:
                _flush_open_run()
                run_start_r = rnd
                run_start_tick = max(0, fe - pre_ticks)
                last_r = rnd
                if dt is not None and dt > 0:
                    _emit_death_segment(run_start_r, run_start_tick, rnd, dt)
                    run_start_r = None
                    last_r = None
                continue

            last_r = rnd
            if dt is not None and dt > 0:
                _emit_death_segment(run_start_r, run_start_tick, rnd, dt)
                run_start_r = None
                last_r = None

        _flush_open_run()

        if ftd_segments:
            source_ticks = [[s, e] for (s, e, _sr, _er, _d) in ftd_segments]
            first_rnd = ftd_segments[0][2]
            kill_anchors: list[int] = []
            for (_s, e, _sr, _er, dtk) in ftd_segments:
                if dtk is not None and dtk > 0:
                    kill_anchors.append(int(dtk))
                else:
                    kill_anchors.append(max(_s, e - 1))
            last_death = next((d for (_s, _e, _sr, _er, d) in reversed(ftd_segments) if d is not None), None)
            ftd_round_filter_out: Optional[list[int]] = None
            if ftd_filter is not None:
                ftd_round_filter_out = sorted(ftd_filter)
            compilations.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                map_name=map_name,
                round=first_rnd,
                category="compilation",
                weapon_used="",
                kill_count=0,
                start_tick=source_ticks[0][0],
                end_tick=source_ticks[-1][1],
                context_tags=["🎬 回合合集"],
                killer_name=None,
                killers=[],
                victims=[],
                kill_ticks=kill_anchors,
                round_won=round_result_map.get(first_rnd),
                clip_min_tick=round_freeze_end_ticks.get(first_rnd),
                death_tick=last_death,
                source_ticks=source_ticks,
                source_rounds=[sr for (_s, _e, sr, _er, _d) in ftd_segments],
                source_round_ends=[_er for (_s, _e, sr, _er, _d) in ftd_segments],
                compilation_kind="freeze_to_death",
                fixed_segment_pacing=True,
                freeze_to_death_round_filter=ftd_round_filter_out,
                freeze_to_death_round_windows=ftd_round_windows,
            ))

    return compilations
