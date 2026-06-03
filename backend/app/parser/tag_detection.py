from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from typing import Optional

import pandas as pd

from .parse_utils import _int, _bool
from .tag_constants import (
    TICK_RATE,
    RAPID_KILL_WINDOW_SECONDS,
    ECO_MAX_VALUE,
    FULL_BUY_MIN_VALUE,
    _TAG_COVERAGE_RULES,
    _dedup_context_tags,
    _CLUTCH_ROUNDEND_SEC,
    _CLUTCH_BOMB_SEC,
    _AVENGE_WINDOW_TICKS,
    _COMEBACK_HP_MAX,
    _IRONSHIRT_HITS_MIN,
    _IRONSHIRT_DMG_MIN,
    _UTILITY_DMG_WEAPONS,
    _ZOMBIE_STEP_PRE_TICKS,
    _ZOMBIE_STEP_MAX_DISP,
    _STROLL_PRE_TICKS,
    _STROLL_MIN_VEL,
    _MAGNET_NADE_LOOKBACK_TICKS,
    _MAGNET_NADE_DIST_DROP,
    _HIGHLIGHT_LONGRANGE_WEAPONS,
    _HIGHLIGHT_LONG_RANGE_DIST,
    _FLYING_SNIPER_LOOKBACK_TICKS,
    _FLYING_SNIPER_Z_DELTA_MIN,
    _KEQIAO_SEMI_SNIPERS,
    _KEQIAO_WEAPONS,
)
from .weapons import (
    SNIPER_WEAPONS,
    KNIFE_WEAPONS,
    GRENADE_KILL_WEAPONS,
    WORLD_KILL_WEAPONS,
    SUICIDE_WEAPONS,
    FAIL_WEAPONS,
    DEAGLE_VARIANTS,
    _normalize_item,
    _is_knife_highlight_weapon,
    _death_by_planted_c4,
)
from .spatial_analysis import (
    _spatial_player_row,
    _alive_mates_and_enemies,
    _spatial_snap_pre_kill,
    _row_health,
    _victim_facing_attacker,
    is_jump_kill,
    _smallest_angle_diff_deg,
)


def _extend_tags_unique(base: list[str], extra: list[str]) -> list[str]:
    out = list(base)
    seen = set(base)
    for t in extra:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _fail_killer_display_name(death: dict, target_player: str) -> Optional[str]:
    """下饭/死亡集锦击杀者名；自雷、世界伤害等无对立击杀者时返回 None。"""
    atk = str(death.get("attacker") or "").strip()
    if not atk or atk == target_player:
        return None
    return atk


def detect_fail_tags(
    *,
    weapon: str,
    headshot: bool,
    attacker: str,
    victim: str,
    attacker_team,
    victim_team,
    attackerblind: bool,
    assistedflash: bool,
) -> list[str]:
    tags: list[str] = []

    if _death_by_planted_c4(weapon):
        tags.append("💣 惨遭C4洗礼")
    if weapon in FAIL_WEAPONS:
        tags.append("电击处刑")
    if weapon in DEAGLE_VARIANTS and headshot:
        tags.append("沙鹰爆头")
    if weapon in KNIFE_WEAPONS:
        tags.append("被刀取辱")
    if attacker == victim and weapon not in SUICIDE_WEAPONS and not _death_by_planted_c4(weapon):
        tags.append("自杀")
    if weapon in GRENADE_KILL_WEAPONS and not _death_by_planted_c4(weapon):
        tags.append("道具击杀")
    if weapon in WORLD_KILL_WEAPONS:
        tags.append("摔死")
    if (attacker != victim
            and attacker_team is not None
            and attacker_team == victim_team):
        tags.append("痛击队友")

    return tags


def check_knife_backstab_tag(
    kills_sorted: list[dict],
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
) -> bool:
    """🔙 背刺：任一刀杀中，攻击者与受害者朝向夹角 < 45°。"""
    for k in kills_sorted:
        if not _is_knife_highlight_weapon(str(k.get("weapon") or "")):
            continue
        kt = _int(k.get("tick"))
        snap = spatial_cache.get(kt)
        if not snap:
            continue
        atk = _spatial_player_row(snap, target_player)
        vic = _spatial_player_row(snap, str(k.get("victim") or "").strip())
        if atk is None or vic is None:
            continue
        try:
            if "yaw" not in atk or "yaw" not in vic:
                continue
            ya = float(atk["yaw"])
            yv = float(vic["yaw"])
            if _smallest_angle_diff_deg(ya, yv) < 45.0:
                return True
        except (TypeError, ValueError):
            continue
    return False


def check_clutch_time_tag(
    kills_sorted: list[dict],
    round_num: int,
    round_end_tick_map: Optional[dict[int, int]],
    bomb_explode_tick_map: Optional[dict[int, int]],
) -> bool:
    """🔔 极限操作：任一击杀距回合结束 ≤ 5s 或距 C4 爆炸 ≤ 3s。"""
    re_t = (round_end_tick_map or {}).get(round_num)
    be_t = (bomb_explode_tick_map or {}).get(round_num)
    if re_t is None and be_t is None:
        return False
    for k in kills_sorted:
        kt = _int(k.get("tick"))
        if re_t is not None and 0 <= (re_t - kt) <= int(_CLUTCH_ROUNDEND_SEC * TICK_RATE):
            return True
        if be_t is not None and 0 <= (be_t - kt) <= int(_CLUTCH_BOMB_SEC * TICK_RATE):
            return True
    return False


def check_last_round_debt_tag(
    kills_sorted: list[dict],
    round_num: int,
    prev_round_killers_of_target: Optional[dict[int, set[str]]],
) -> bool:
    """🧾 上回合的债：本回合击杀对象中，至少一人在上一回合杀过目标。"""
    if not prev_round_killers_of_target:
        return False
    prev_set = prev_round_killers_of_target.get(round_num - 1) or set()
    if not prev_set:
        return False
    for k in kills_sorted:
        if str(k.get("victim") or "").strip() in prev_set:
            return True
    return False


def check_avenge_tag(
    kills_sorted: list[dict],
    teammate_hurt_victim_index: Optional[dict[str, list[int]]],
) -> bool:
    """⚰️ 补枪：击杀对象在过去 ≤ 2.5s 内被目标队友打过。"""
    if not teammate_hurt_victim_index:
        return False
    for k in kills_sorted:
        vic = str(k.get("victim") or "").strip()
        if not vic:
            continue
        arr = teammate_hurt_victim_index.get(vic)
        if not arr:
            continue
        kt = _int(k.get("tick"))
        lo = bisect_left(arr, kt - _AVENGE_WINDOW_TICKS)
        hi = bisect_right(arr, kt)
        if lo < hi:
            return True
    return False


def check_sweep_tag(
    n: int,
    round_num: int,
    teammate_kills_per_round: Optional[dict[int, int]],
) -> bool:
    """🧹 清盘：本回合目标 5 杀 且 队友 0 杀。"""
    if n < 5:
        return False
    mates = (teammate_kills_per_round or {}).get(round_num, 0)
    return mates == 0


def check_barefoot_tag(
    round_num: int,
    target_team_at_freeze: Optional[int],
    round_economy_map: dict[int, dict[int, int]],
) -> bool:
    """👢 光脚干皮鞋：己方 ≤ 3000 且 对面 ≥ 12000。"""
    if target_team_at_freeze not in (2, 3):
        return False
    rd = round_economy_map.get(round_num, {})
    if not rd:
        return False
    target_equip = int(rd.get(target_team_at_freeze, 0))
    enemy_tm = 3 if target_team_at_freeze == 2 else 2
    enemy_equip = int(rd.get(enemy_tm, 0))
    return target_equip > 0 and target_equip <= 3000 and enemy_equip >= 12000


def check_comeback_lowhp_tag(
    n: int,
    first_tick: int,
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
) -> bool:
    """❤️‍🩹 残血绝地反击：多杀 (n≥2) 起始 HP ≤ 20。"""
    if n < 2:
        return False
    snap = spatial_cache.get(int(first_tick))
    if not snap:
        snap = spatial_cache.get(int(first_tick) - 8)
    if not snap:
        return False
    row = _spatial_player_row(snap, target_player)
    if row is None:
        return False
    hp = _row_health(row)
    return hp is not None and 0 < hp <= _COMEBACK_HP_MAX


def check_ironshirt_tag(
    round_num: int,
    last_kill_tick: int,
    round_hurt_on_target_index: Optional[dict[int, list[tuple[int, int, str]]]],
    round_death_tick_map: Optional[dict[int, int]],
) -> bool:
    """🪨 挨揍王：本回合受到非道具命中 ≥ 4 次 且 累计 ≥ 95 HP。"""
    if not round_hurt_on_target_index:
        return False
    hits = round_hurt_on_target_index.get(round_num) or []
    if not hits:
        return False
    valid = [(t, d, w) for (t, d, w) in hits
             if t <= last_kill_tick and w not in _UTILITY_DMG_WEAPONS]
    if len(valid) < _IRONSHIRT_HITS_MIN:
        return False
    total = sum(d for _, d, _ in valid)
    if total < _IRONSHIRT_DMG_MIN:
        return False
    dth = (round_death_tick_map or {}).get(round_num)
    if dth is not None and dth <= last_kill_tick:
        return False
    return True


def check_defuse_open_tag(
    round_num: int,
    kills_sorted: list[dict],
    defuse_window_map: Optional[dict[int, tuple[int, int]]],
) -> bool:
    """💣 拆包开光：本回合目标拆包过程中完成击杀。"""
    if not defuse_window_map:
        return False
    win = defuse_window_map.get(round_num)
    if not win:
        return False
    lo, hi = win
    for k in kills_sorted:
        kt = _int(k.get("tick"))
        if lo <= kt <= hi:
            return True
    return False


def check_zombie_step(
    death: dict,
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
) -> list[str]:
    """🗿 僵尸步：死前 3s 位移 < 20 且被爆头。"""
    if not _bool(death.get("headshot")):
        return []
    dt = _int(death.get("tick"))
    snap_now = spatial_cache.get(dt)
    snap_pre = spatial_cache.get(dt - _ZOMBIE_STEP_PRE_TICKS)
    if snap_now is None or snap_pre is None:
        return []
    r_now = _spatial_player_row(snap_now, target_player)
    r_pre = _spatial_player_row(snap_pre, target_player)
    if r_now is None or r_pre is None:
        return []
    try:
        dx = float(r_now["X"]) - float(r_pre["X"])
        dy = float(r_now["Y"]) - float(r_pre["Y"])
        if math.hypot(dx, dy) < _ZOMBIE_STEP_MAX_DISP:
            return ["🗿 僵尸步"]
    except (TypeError, ValueError, KeyError):
        return []
    return []


def check_stroll(
    death: dict,
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
) -> list[str]:
    """🐢 散步流：死前 1s 平均 |vel_xy| ≥ 150 且被爆头。"""
    if not _bool(death.get("headshot")):
        return []
    dt = _int(death.get("tick"))
    snap_now = spatial_cache.get(dt)
    snap_pre = spatial_cache.get(dt - _STROLL_PRE_TICKS)
    if snap_now is None or snap_pre is None:
        return []
    r_now = _spatial_player_row(snap_now, target_player)
    r_pre = _spatial_player_row(snap_pre, target_player)
    if r_now is None or r_pre is None:
        return []
    try:
        dx = float(r_now["X"]) - float(r_pre["X"])
        dy = float(r_now["Y"]) - float(r_pre["Y"])
        disp = math.hypot(dx, dy)
        avg_v = disp * TICK_RATE / float(_STROLL_PRE_TICKS)
        if avg_v >= _STROLL_MIN_VEL:
            return ["🐢 散步流"]
    except (TypeError, ValueError, KeyError):
        return []
    return []


def check_magnet_nade(
    death: dict,
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
    grenade_detonate_points: Optional[list[tuple[int, float, float]]],
) -> list[str]:
    """🧲 吸铁石：死于雷/火 且 死前 5s 目标 → 雷/火中心距离递减 ≥ 200 units。"""
    weapon = _normalize_item(str(death.get("weapon") or ""))
    if weapon not in GRENADE_KILL_WEAPONS:
        return []
    dt = _int(death.get("tick"))
    snap_now = spatial_cache.get(dt)
    snap_pre = spatial_cache.get(dt - _MAGNET_NADE_LOOKBACK_TICKS)
    if snap_now is None or snap_pre is None:
        return []
    r_now = _spatial_player_row(snap_now, target_player)
    r_pre = _spatial_player_row(snap_pre, target_player)
    if r_now is None or r_pre is None:
        return []
    cx: Optional[float] = None
    cy: Optional[float] = None
    if grenade_detonate_points:
        lo_t = dt - _MAGNET_NADE_LOOKBACK_TICKS
        candidates = [(t, x, y) for (t, x, y) in grenade_detonate_points
                      if lo_t <= t <= dt]
        if candidates:
            try:
                now_x, now_y = float(r_now["X"]), float(r_now["Y"])
                best = min(candidates, key=lambda e: math.hypot(e[1] - now_x, e[2] - now_y))
                cx, cy = float(best[1]), float(best[2])
            except (TypeError, ValueError, KeyError):
                pass
    if cx is None or cy is None:
        return []
    try:
        d_pre = math.hypot(float(r_pre["X"]) - cx, float(r_pre["Y"]) - cy)
        d_now = math.hypot(float(r_now["X"]) - cx, float(r_now["Y"]) - cy)
        if (d_pre - d_now) >= _MAGNET_NADE_DIST_DROP:
            return ["🧲 吸铁石"]
    except (TypeError, ValueError, KeyError):
        return []
    return []


def check_flash_send(
    death: dict,
    round_num: int,
    round_freeze_end_ticks: Optional[dict[int, int]],
) -> list[str]:
    """🚪 闪送：开局 8 秒内就死。"""
    if not round_freeze_end_ticks:
        return []
    freeze_tick = round_freeze_end_ticks.get(round_num)
    if freeze_tick is None:
        return []
    dt = _int(death.get("tick"))
    if 0 < dt - freeze_tick <= int(8.0 * TICK_RATE):
        return ["🚪 闪送"]
    return []


def build_highlight_tags(
    kills_sorted: list[dict],
    first_tick: int,
    last_tick: int,
    round_num: int,
    round_first_death_tick: dict[int, int],
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
    round_economy_map: dict[int, dict[int, int]],
    target_team_at_freeze: Optional[int],
    round_team_score: Optional[tuple[int, int]],
    round_won: Optional[bool] = None,
    *,
    round_end_tick_map: Optional[dict[int, int]] = None,
    bomb_explode_tick_map: Optional[dict[int, int]] = None,
    prev_round_killers_of_target: Optional[dict[int, set[str]]] = None,
    teammate_hurt_victim_index: Optional[dict[str, list[int]]] = None,
    teammate_kills_per_round: Optional[dict[int, int]] = None,
    round_hurt_on_target_index: Optional[dict[int, list[tuple[int, int, str]]]] = None,
    round_death_tick_map: Optional[dict[int, int]] = None,
    defuse_window_map: Optional[dict[int, tuple[int, int]]] = None,
    alive_summary: "Optional[dict[int, dict[int, frozenset]]]" = None,
) -> list[str]:
    tags: list[str] = []
    n = len(kills_sorted)

    if n >= 5:
        tags.append("五杀 (ACE)")
    elif n == 4:
        tags.append("四杀")
    elif n == 3:
        tags.append("三杀")
    elif n == 2:
        tags.append("双杀")

    if any(_is_knife_highlight_weapon(str(k.get("weapon") or "")) for k in kills_sorted):
        tags.append("🔪 刀杀")

    rapid_window = 3.0 if n == 2 else float(RAPID_KILL_WINDOW_SECONDS)
    if (last_tick - first_tick) <= rapid_window * TICK_RATE:
        tags.append("爆发刷屏")

    if all(k["headshot"] for k in kills_sorted):
        tags.append("枪枪爆头")

    rfd = round_first_death_tick.get(round_num)
    if rfd is not None and kills_sorted[0]["tick"] == rfd:
        tags.append("⚔️ 首杀")

    _eco_round = False
    _nt_1v_active = False
    _nt_1v_n_enemies = 0
    _nt_1v_clutch_kills = 0

    if round_num == 1 or round_num == 13:
        tags.append("🔫 手枪局专家")
    else:
        rd = round_economy_map.get(round_num, {})
        tgt_tm = target_team_at_freeze
        if tgt_tm is not None and tgt_tm in (2, 3):
            enemy_tm = 3 if tgt_tm == 2 else 2
            target_team_equip = int(rd.get(tgt_tm, 0))
            enemy_team_equip = int(rd.get(enemy_tm, 0))
            if target_team_equip <= ECO_MAX_VALUE and enemy_team_equip >= FULL_BUY_MIN_VALUE:
                tags.append("💸 ECO翻盘")
                _eco_round = True
            elif target_team_equip >= FULL_BUY_MIN_VALUE and enemy_team_equip <= ECO_MAX_VALUE:
                tags.append("🔫 ECO特种兵")

    if round_team_score is not None:
        target_score, enemy_score = round_team_score
    else:
        target_score = enemy_score = 0

    is_enemy_match_point = (enemy_score >= 12 and enemy_score % 3 == 0 and target_score < enemy_score)
    is_target_match_point = (target_score >= 12 and target_score % 3 == 0 and target_score > enemy_score)

    if is_enemy_match_point and target_score < enemy_score:
        if enemy_score - target_score == 1:
            tags.extend(["🛡️ 赛点救世主", "命悬一线"])
        else:
            tags.extend(["📈 绝地追分", "拒绝下班"])
    elif is_target_match_point and target_score > enemy_score:
        if target_score - enemy_score == 1:
            tags.extend(["🗡️ 赛点终结者", "一锤定音"])
    elif target_score == enemy_score and target_score >= 12:
        tags.extend(["⚔️ 加时生死战", "大心脏"])

    if target_score >= 8 and enemy_score <= 2:
        tags.extend(["🔥 顺风局战神", "无情碾压"])

    if target_score >= 10 and enemy_score >= 10 and target_score == enemy_score:
        tags.append("⛰️ 天王山之战")

    snap_last = spatial_cache.get(int(last_tick))

    row_last = _spatial_player_row(snap_last, target_player)
    if row_last is not None:
        hp = _row_health(row_last)
        if hp is not None and 0 < hp <= 15:
            tags.append("❤️ 极限锁血战神")

    best_epic_1v = -1
    best_nt_1v = -1
    best_nt_start = -1
    best_2v_n = -1
    any_3v5 = False
    for start in range(n):
        kt = _int(kills_sorted[start].get("tick"))
        sk = _spatial_snap_pre_kill(spatial_cache, kt)
        if sk is None:
            continue
        # 镜像 _spatial_snap_pre_kill 的偏移顺序：8→16→24→32→0
        _as = alive_summary or {}
        alive_by_team_at_kt = (
            _as.get(kt - 8) or _as.get(kt - 16)
            or _as.get(kt - 24) or _as.get(kt - 32) or _as.get(kt)
        )
        pair = _alive_mates_and_enemies(sk, target_player, alive_by_team=alive_by_team_at_kt)
        if pair is None:
            continue
        n_mates, n_enems = pair
        total_friendly = n_mates + 1
        kills_from_here = n - start
        if total_friendly == 1 and n_enems >= 2:
            if kills_from_here >= n_enems and n_enems > best_epic_1v:
                best_epic_1v = n_enems
            need_nt = max(1, n_enems - 1)
            if kills_from_here >= need_nt and n_enems > best_nt_1v:
                best_nt_1v = n_enems
                best_nt_start = start
        elif total_friendly == 2 and n_enems >= 4:
            if n_enems > best_2v_n:
                best_2v_n = n_enems
        elif total_friendly == 3 and n_enems == 5:
            any_3v5 = True

    if best_epic_1v >= 2:
        tags.append(f"🔥 1v{best_epic_1v} 史诗残局")
    if best_2v_n >= 4:
        tags.append(f"🔥 2v{best_2v_n} 兄弟齐心")
    if any_3v5:
        tags.append("🔥 3v5 绝地反击")

    if best_nt_1v >= 2 and best_nt_start >= 0:
        _nt_1v_active = True
        _nt_1v_n_enemies = best_nt_1v
        _nt_1v_clutch_kills = n - best_nt_start

    tick_counts: dict[int, int] = {}
    for kill in kills_sorted:
        w = kill.get("weapon") or ""
        if w in {"awp", "ssg08", "deagle", "revolver"}:
            kt = _int(kill.get("tick"))
            found_group = False
            for t in tick_counts:
                if abs(t - kt) <= 2:
                    tick_counts[t] += 1
                    found_group = True
                    break
            if not found_group:
                tick_counts[kt] = 1
    if any(c >= 2 for c in tick_counts.values()):
        tags.append("🍡 一石二鸟")

    _ALL_SNIPERS_KQ = SNIPER_WEAPONS | _KEQIAO_SEMI_SNIPERS

    _ns_kills = [k for k in kills_sorted
                 if str(k.get("weapon") or "").strip() not in _ALL_SNIPERS_KQ]
    _ns_hs = [k for k in _ns_kills if _bool(k.get("headshot"))]

    if _ns_hs:
        def _is_precise(k: dict) -> bool:
            w = str(k.get("weapon") or "").strip()
            if w not in _KEQIAO_WEAPONS:
                return False
            shots = _int(k.get("shots_to_kill"), 0)
            return shots == 0 or shots <= 3

        cond_a = any(_is_precise(k) for k in _ns_hs)
        cond_b = len(_ns_hs) == len(_ns_kills) >= 2
        if cond_a or cond_b:
            tags.append("💥 颗秒")
            if any(
                _bool(k.get("victim_had_awp"))
                and _victim_facing_attacker(
                    spatial_cache.get(_int(k.get("tick"))),
                    target_player,
                    str(k.get("victim") or ""),
                )
                for k in kills_sorted
            ):
                tags.append("🔪 手撕大狙")

    long_added = False
    for kill in kills_sorted:
        if long_added:
            break
        w = kill.get("weapon") or ""
        if w not in _HIGHLIGHT_LONGRANGE_WEAPONS:
            continue
        kt = _int(kill.get("tick"))
        sk = spatial_cache.get(kt)
        vic_name = str(kill.get("victim") or "").strip()
        atk_row = _spatial_player_row(sk, target_player)
        vic_row = _spatial_player_row(sk, vic_name) if vic_name else None
        if atk_row is None or vic_row is None:
            continue
        try:
            dist = math.hypot(
                float(atk_row["X"]) - float(vic_row["X"]),
                float(atk_row["Y"]) - float(vic_row["Y"]),
            )
        except (TypeError, ValueError, KeyError):
            continue
        if dist > _HIGHLIGHT_LONG_RANGE_DIST:
            tags.append("🔭 百步穿杨")
            long_added = True

    flying_added = False
    for kill in kills_sorted:
        if flying_added:
            break
        w = kill.get("weapon") or ""
        if w not in SNIPER_WEAPONS:
            continue
        nosc = _bool(kill.get("noscope")) or "盲狙" in (kill.get("tags") or [])
        if not nosc:
            continue
        kt = _int(kill.get("tick"))
        t_prev = max(0, kt - _FLYING_SNIPER_LOOKBACK_TICKS)
        snap_cur = spatial_cache.get(kt)
        snap_prev = spatial_cache.get(t_prev)
        if snap_cur is None or snap_prev is None:
            continue
        row_c = _spatial_player_row(snap_cur, target_player)
        row_p = _spatial_player_row(snap_prev, target_player)
        if row_c is None or row_p is None:
            continue
        if "Z" not in row_c or "Z" not in row_p:
            continue
        try:
            zc = float(row_c["Z"])
            zp = float(row_p["Z"])
        except (TypeError, ValueError):
            continue
        if abs(zc - zp) > _FLYING_SNIPER_Z_DELTA_MIN:
            tags.extend(["✈️ 飞天盲狙", "冷神附体"])
            flying_added = True

    if any(is_jump_kill(spatial_cache, _int(k.get("tick")), target_player) for k in kills_sorted):
        tags.append("🪂 跳杀")

    action_seen: set[str] = set()
    for kill in kills_sorted:
        for t in kill.get("tags", []):
            if t != "爆头" and t not in action_seen:
                action_seen.add(t)
                tags.append(t)

    if check_knife_backstab_tag(kills_sorted, spatial_cache, target_player):
        if "🔙 背刺" not in tags:
            tags.append("🔙 背刺")
    if check_clutch_time_tag(kills_sorted, round_num, round_end_tick_map, bomb_explode_tick_map):
        tags.append("🔔 极限操作")
    if check_last_round_debt_tag(kills_sorted, round_num, prev_round_killers_of_target):
        tags.append("🧾 上回合的债")
    if check_avenge_tag(kills_sorted, teammate_hurt_victim_index):
        tags.append("⚰️ 补枪")
    if check_sweep_tag(n, round_num, teammate_kills_per_round):
        tags.append("🧹 清盘")
    if n >= 1 and check_barefoot_tag(round_num, target_team_at_freeze, round_economy_map):
        tags.append("👢 光脚干皮鞋")
    if check_comeback_lowhp_tag(n, first_tick, spatial_cache, target_player):
        tags.append("❤️‍🩹 残血绝地反击")
    if check_ironshirt_tag(round_num, last_tick, round_hurt_on_target_index, round_death_tick_map):
        tags.append("🪨 挨揍王")
    if check_defuse_open_tag(round_num, kills_sorted, defuse_window_map):
        tags.append("💣 拆包开光")

    if round_won is False:
        if _nt_1v_active and _nt_1v_n_enemies >= 2:
            need_kills = max(1, _nt_1v_n_enemies - 1)
            if _nt_1v_clutch_kills >= need_kills:
                if _nt_1v_n_enemies == 2:
                    tags.append("😤 1v2 饮恨")
                else:
                    tags.append(f"💀 1v{_nt_1v_n_enemies} 封神未遂")

        if _eco_round and n >= 2:
            tags.append("💸 ECO反击")

        if is_enemy_match_point:
            if enemy_score - target_score == 1:
                tags.append("🛡️ 赛点失守")
            else:
                tags.append("📉 绝地追分未果")

        elif (target_score >= 10 and enemy_score >= 10
              and target_score == enemy_score and n >= 2):
            tags.append("⛰️ 天王山饮恨")

    return tags


def check_victim_in_air(death: dict) -> list[str]:
    """🪂 空中遇难：受害者腾空时被击杀（非刀/道具/自爆）。"""
    if not death.get("victim_in_air"):
        return []
    weapon = _normalize_item(str(death.get("weapon") or ""))
    if weapon in KNIFE_WEAPONS or weapon in WORLD_KILL_WEAPONS or weapon in SUICIDE_WEAPONS:
        return []
    return ["🪂 空中遇难"]
