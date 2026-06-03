from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from typing import Optional

import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import _to_pandas_df, _int, _bool, _DEMOPARSER_RE_RAISE
from .tag_constants import (
    TICK_RATE,
    PISTOL_WEAPONS,
    _BACKSTAB_WINDOW_TICKS,
    _BACKSTAB_ATTACKER_BACK_DEG,
    _BACKSTAB_VICTIM_AIM_DEG,
    _BACKSTAB_BACKAIM_MIN_PASS_RATIO,
    _backstab_aim_sample_offsets_sec,
    _TIMING_SWITCH_WINDOW,
    _TIMING_HOLD_MIN,
    _OUTLINE_WINDOW,
    _OUTLINE_MIN_FIRES,
    _OUTLINE_MAX_DAMAGE,
    _OUTLINE_KILL_SHIELD_SECONDS,
    _MAGNET_RATIO,
    _MAGNET_MIN_CLOSER,
    _PB_DIST_EXECUTION,
    _PB_DIST_POINT_BLANK,
    _WALLBANG_DIST_MIN,
    _RUSH_VEL_MIN,
    _RUNGUN_VEL_MIN,
    _RUNGUN_VEL_MAX,
    _SLIDE_VEL_XY_MIN,
    _AIRBORNE_VEL_Z_MIN,
    _QUICKSCOPE_LOOKBACK_OFFSETS,
    _QUICKSCOPE_YAW_DELTA_MIN,
)
from .weapons import (
    SNIPER_WEAPONS,
    KNIFE_WEAPONS,
    GRENADE_ITEMS,
    PRIMARY_WEAPONS,
    SPRAY_WEAPONS,
    _normalize_item,
)


def _smallest_angle_diff_deg(a: float, b: float) -> float:
    """两方位角之差，范围 [0, 180]。"""
    return abs((float(a) - float(b) + 180.0) % 360.0 - 180.0)


def _is_nan(v) -> bool:
    """NaN/None/pd.NA 检测，兼容 float / pandas NA / numpy NaN。"""
    if v is None:
        return True
    try:
        import pandas as _pd
        if _pd.isna(v):
            return True
    except (TypeError, ValueError):
        pass
    try:
        return math.isnan(float(v))
    except (TypeError, ValueError):
        return False


def _spatial_player_row(
    tick_dict: "Optional[dict[str, dict]]",
    player: str,
) -> "Optional[dict]":
    """O(1) 名称查找；大小写不匹配时做一次线性扫描兜底。"""
    if not tick_dict or not player:
        return None
    player = str(player).strip()
    row = tick_dict.get(player)
    if row is not None:
        return row
    pl = player.lower()
    for k, v in tick_dict.items():
        if k.lower() == pl:
            return v
    return None


def _victim_facing_attacker(
    tick_dict: "Optional[dict[str, dict]]",
    attacker: str,
    victim: str,
    *,
    max_angle_deg: float = 45.0,
) -> bool:
    """死亡瞬间受害者的 yaw 是否指向攻击者（±max_angle_deg 内）。"""
    v = _spatial_player_row(tick_dict, victim)
    a = _spatial_player_row(tick_dict, attacker)
    if v is None or a is None:
        return False
    try:
        vx, vy = float(v["X"]), float(v["Y"])
        ax, ay = float(a["X"]), float(a["Y"])
        vyaw   = float(v["yaw"])
    except (TypeError, ValueError, KeyError):
        return False
    target_yaw = math.degrees(math.atan2(ay - vy, ax - vx))
    diff = ((target_yaw - vyaw + 180.0) % 360.0) - 180.0
    return abs(diff) <= max_angle_deg


def _row_health(row: dict) -> Optional[int]:
    for k in ("health", "m_iHealth"):
        if k not in row:
            continue
        v = row[k]
        if _is_nan(v):
            continue
        try:
            h = int(float(v))
        except (TypeError, ValueError):
            continue
        return h
    return None


def _spatial_snap_pre_kill(
    spatial_cache: "dict[int, dict[str, dict]]",
    kill_tick: int,
) -> "Optional[dict[str, dict]]":
    """击杀 tick 前几帧的快照，避免该 tick 上受害者已被标为 is_alive=False。"""
    kt = int(kill_tick)
    for off in (8, 16, 24, 32):
        s = spatial_cache.get(kt - off)
        if s:
            return s
    s = spatial_cache.get(kt)
    return s if s else None


def _alive_mates_and_enemies(
    tick_dict: "dict[str, dict]",
    target_player: str,
    alive_by_team: "Optional[dict[int, frozenset]]" = None,
) -> "Optional[tuple[int, int]]":
    """返回 (同队存活队友数不含自己, 敌方存活人数)；无法统计时返回 None。"""
    row_self = _spatial_player_row(tick_dict, target_player)
    if row_self is None:
        return None
    tgt_team = row_self.get("team_num")
    if tgt_team is None or _is_nan(tgt_team):
        return None
    try:
        tgt_team_i = int(float(tgt_team))
    except (TypeError, ValueError):
        return None

    if alive_by_team is not None:
        # O(1) path using pre-computed summary
        my_team_alive = alive_by_team.get(tgt_team_i, frozenset())
        mates = len(my_team_alive) - (1 if target_player in my_team_alive else 0)
        enems = sum(
            len(names)
            for tm, names in alive_by_team.items()
            if tm != tgt_team_i
        )
        return mates, enems

    # Fallback: iterate tick_dict (O(n))
    mates = enems = 0
    for name, row in tick_dict.items():
        if not row.get("is_alive"):
            continue
        tm = row.get("team_num")
        if tm is None or _is_nan(tm):
            continue
        try:
            tm_i = int(float(tm))
        except (TypeError, ValueError):
            continue
        if tm_i == tgt_team_i and name != target_player:
            mates += 1
        elif tm_i != tgt_team_i:
            enems += 1
    return mates, enems


def parse_spatial_snapshots(
    parser: DemoParser,
    ticks: list[int],
) -> "tuple[dict[int, dict[str, dict]], dict[int, dict[int, frozenset]]]":
    """解析指定 tick 的玩家坐标与偏航（原 DemoAnalyzer._parse_spatial_snapshots）。"""
    if not ticks:
        return {}, {}
    unique_ticks = sorted(set(ticks))
    try:
        result = parser.parse_ticks(
            [
                "X", "Y", "Z",
                "vel_x", "vel_y", "vel_z",
                "yaw", "pitch",
                "name", "is_alive", "team_num", "health", "armor",
            ],
            ticks=unique_ticks,
        )
    except Exception:
        try:
            result = parser.parse_ticks(
                ["X", "Y", "Z", "vel_z", "yaw", "pitch", "name", "is_alive", "team_num", "health", "armor"],
                ticks=unique_ticks,
            )
        except Exception:
            return {}, {}
    try:
        df = _to_pandas_df(result)
        if df.empty:
            return {}, {}
        cache: dict[int, dict[str, dict]] = {}
        alive_summary: dict[int, dict[int, frozenset]] = {}
        for tick, group in df.groupby("tick"):
            tick_dict: dict[str, dict] = {}
            by_team: dict[int, set] = {}
            for _, row in group.iterrows():
                name = str(row.get("name") or "").strip()
                if name:
                    row_d = row.to_dict()
                    tick_dict[name] = row_d
                    if row_d.get("is_alive"):
                        try:
                            tm = int(float(row_d["team_num"]))
                            by_team.setdefault(tm, set()).add(name)
                        except (TypeError, ValueError, KeyError):
                            pass
            tick_i = int(tick)
            cache[tick_i] = tick_dict
            alive_summary[tick_i] = {tm: frozenset(names) for tm, names in by_team.items()}
        return cache, alive_summary
    except Exception:
        return {}, {}


def build_equip_timeline(
    target_player: str, equip_df: pd.DataFrame,
) -> list[tuple[int, str]]:
    """构建目标玩家的 (tick, item) 有序时间轴。"""
    if equip_df.empty or "user_name" not in equip_df.columns:
        return []
    item_col = "item" if "item" in equip_df.columns else None
    if item_col is None:
        return []
    pf = equip_df.loc[equip_df["user_name"] == target_player].sort_values("tick")
    return [(_int(r["tick"]), _normalize_item(r[item_col])) for _, r in pf.iterrows()]


def check_timing_law(
    death: dict,
    equip_timeline: list[tuple[int, str]],
) -> list[str]:
    """判定: 架枪 ≥10s → 切刀/投掷物 → 1.5s 内被杀。"""
    if len(equip_timeline) < 2:
        return []

    death_tick = death["tick"]
    idx = bisect_right(equip_timeline, death_tick, key=lambda e: e[0]) - 1
    if idx < 1:
        return []

    switch_tick, current_item = equip_timeline[idx]
    _, prev_item = equip_timeline[idx - 1]

    hold_start_tick = equip_timeline[idx - 1][0]
    for i in range(idx - 2, -1, -1):
        if equip_timeline[i][1] == prev_item:
            hold_start_tick = equip_timeline[i][0]
        else:
            break

    is_utility = current_item in KNIFE_WEAPONS or current_item in GRENADE_ITEMS
    just_switched = (death_tick - switch_tick) < _TIMING_SWITCH_WINDOW
    was_primary = prev_item in PRIMARY_WEAPONS
    held_long = (switch_tick - hold_start_tick) >= _TIMING_HOLD_MIN

    if is_utility and just_switched and was_primary and held_long:
        return ["CS定律", "切刀必死"]
    return []


def check_human_magnet(
    death: dict,
    target_player: str,
    spatial_cache: "dict[int, dict[str, dict]]",
) -> list[str]:
    """判定: 被爆头时, ≥2 名存活队友比自己更靠近敌人（距离 < 60%）。"""
    tick = death["tick"]
    attacker_name = death["attacker"]
    tick_dict = spatial_cache.get(tick)
    if not tick_dict:
        return []
    atk_row = _spatial_player_row(tick_dict, attacker_name)
    vic_row = _spatial_player_row(tick_dict, target_player)
    if atk_row is None or vic_row is None:
        return []
    try:
        ax, ay = float(atk_row["X"]), float(atk_row["Y"])
        vx, vy = float(vic_row["X"]), float(vic_row["Y"])
    except (TypeError, ValueError, KeyError):
        return []
    d_victim = math.hypot(ax - vx, ay - vy)
    if d_victim < 1.0:
        return []
    victim_team = vic_row.get("team_num")
    if victim_team is None:
        return []
    try:
        victim_team_i = int(float(victim_team))
    except (TypeError, ValueError):
        return []
    threshold = d_victim * _MAGNET_RATIO
    closer = 0
    for name, row in tick_dict.items():
        if name == target_player or name == attacker_name:
            continue
        if not row.get("is_alive"):
            continue
        tm = row.get("team_num")
        if tm is None:
            continue
        try:
            if int(float(tm)) != victim_team_i:
                continue
        except (TypeError, ValueError):
            continue
        try:
            if math.hypot(ax - float(row["X"]), ay - float(row["Y"])) < threshold:
                closer += 1
        except (TypeError, ValueError, KeyError):
            pass
    if closer >= _MAGNET_MIN_CLOSER:
        return ["人肉吸铁石", "保镖无用"]
    return []


def _backstab_spatial_ok_at_snapshot(
    tick_dict: "dict[str, dict]",
    *,
    killer: str,
    target_player: str,
) -> bool:
    """目标在击杀者背后架住背身：击杀者朝向背对目标，且目标朝向大致指向击杀者。"""
    atk_row = _spatial_player_row(tick_dict, killer)
    vic_row = _spatial_player_row(tick_dict, target_player)
    if atk_row is None or vic_row is None:
        return False
    try:
        ax, ay = float(atk_row["X"]), float(atk_row["Y"])
        vx, vy = float(vic_row["X"]), float(vic_row["Y"])
        attacker_yaw = float(atk_row["yaw"])
        victim_yaw   = float(vic_row["yaw"])
    except (TypeError, ValueError, KeyError):
        return False
    if math.hypot(ax - vx, ay - vy) < 1.0:
        return False
    angle_atk_toward_vic = math.degrees(math.atan2(vy - ay, vx - ax))
    atk_facing_vs_line   = _smallest_angle_diff_deg(attacker_yaw, angle_atk_toward_vic)
    if atk_facing_vs_line < (180.0 - _BACKSTAB_ATTACKER_BACK_DEG):
        return False
    angle_vic_toward_atk = math.degrees(math.atan2(ay - vy, ax - vx))
    vic_aim_vs_line      = _smallest_angle_diff_deg(victim_yaw, angle_vic_toward_atk)
    return vic_aim_vs_line <= _BACKSTAB_VICTIM_AIM_DEG


def any_kill_tick_in_round_shield(
    death_round: int,
    death_tick: int,
    window_start_tick: int,
    round_target_kill_ticks: dict[int, list[int]],
) -> bool:
    """本回合在 [window_start, death_tick] 开火窗口 ±3s 内存在目标任意击杀 → 免疫人体描边类判定。"""
    ticks = round_target_kill_ticks.get(int(death_round), [])
    if not ticks:
        return False
    pad = int(TICK_RATE * float(_OUTLINE_KILL_SHIELD_SECONDS))
    lo_t = int(window_start_tick) - pad
    hi_t = int(death_tick) + pad
    lo = bisect_left(ticks, lo_t)
    hi = bisect_right(ticks, hi_t)
    return lo < hi


def check_backstab_fail(
    death: dict,
    fire_index: list[tuple[int, str]],
    hurt_index: list[tuple[int, str, int]],
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
    round_target_kill_ticks: dict[int, list[int]],
) -> list[str]:
    """先开枪被反杀的下饭场景。

    人体描边：任意武器 ≥5 发，未秒杀手，无背向要求，本回合无击杀免疫。
    NiKo Play：背对杀手，≥1 发，未秒杀手，被反杀。
    """
    death_tick = _int(death.get("tick"))
    killer = str(death.get("attacker") or "")
    if not killer or killer == target_player:
        return []

    w_start = death_tick - _BACKSTAB_WINDOW_TICKS
    w_end = death_tick

    lo = bisect_left(fire_index, w_start, key=lambda e: e[0])
    hi = bisect_right(fire_index, w_end, key=lambda e: e[0])
    fires_in_window = [fire_index[i] for i in range(lo, hi)]

    total_fire_count = len(fires_in_window)
    lo_h = bisect_left(hurt_index, w_start, key=lambda e: e[0])
    hi_h = bisect_right(hurt_index, w_end, key=lambda e: e[0])
    total_damage = sum(
        hurt_index[i][2]
        for i in range(lo_h, hi_h)
        if hurt_index[i][1] == killer
    )

    if total_fire_count < 1:
        return []

    aim_secs = _backstab_aim_sample_offsets_sec()
    sample_ticks_ordered: list[int] = []
    seen_t: set[int] = set()
    for sec in aim_secs:
        t = max(0, death_tick - int(TICK_RATE * float(sec)))
        if t not in seen_t:
            seen_t.add(t)
            sample_ticks_ordered.append(t)
    sample_ticks_ordered.sort()

    if not sample_ticks_ordered:
        sample_ticks_ordered = [max(0, death_tick - int(TICK_RATE * 0.5))]

    n_samples = len(sample_ticks_ordered)
    min_pass = min(
        n_samples,
        max(1, math.ceil(n_samples * _BACKSTAB_BACKAIM_MIN_PASS_RATIO)),
    )

    def _spatial_pass_at_tick(tick: int) -> bool:
        snapshot = spatial_cache.get(tick)
        if not snapshot:
            return False
        return _backstab_spatial_ok_at_snapshot(
            snapshot,
            killer=killer,
            target_player=target_player,
        )

    passes = sum(1 for tick in sample_ticks_ordered if _spatial_pass_at_tick(tick))

    result: list[str] = []

    # 人体描边：≥5 发但没秒杀手，无背向要求
    if total_fire_count >= 5 and total_damage < 100:
        if not any_kill_tick_in_round_shield(
            _int(death.get("round")),
            death_tick,
            w_start,
            round_target_kill_ticks,
        ):
            result.append("人体描边")

    # NiKo Play：背对杀手，开枪但没秒，被反杀
    if total_fire_count >= 1 and total_damage < 100:
        if passes >= min_pass:
            result.append("NiKo Play")

    return result


def build_fire_index(
    target_player: str, fire_df: pd.DataFrame,
) -> list[tuple[int, str]]:
    """构建目标玩家的 (tick, weapon) 开火索引，有序。"""
    if fire_df.empty or "user_name" not in fire_df.columns:
        return []
    pf = fire_df.loc[fire_df["user_name"] == target_player].sort_values("tick")
    wcol = "weapon" if "weapon" in pf.columns else None
    return [
        (_int(r["tick"]), _normalize_item(r[wcol]) if wcol else "")
        for _, r in pf.iterrows()
    ]


def is_jump_kill(
    spatial_cache: "dict[int, dict[str, dict]]",
    kill_tick: int,
    player_name: str,
) -> bool:
    """检测目标玩家在击杀时是否处于跳跃中（vel_z 速度检测 + Z 坐标差兜底）。"""
    snap = spatial_cache.get(kill_tick)
    if snap is None:
        return False
    row = _spatial_player_row(snap, player_name)
    if row is None:
        return False

    for check_tick in (kill_tick, kill_tick - 8, kill_tick - 16):
        s = spatial_cache.get(check_tick)
        if s is None:
            continue
        r = _spatial_player_row(s, player_name)
        if r is None or "vel_z" not in r:
            continue
        try:
            vz = r["vel_z"]
            if not _is_nan(vz):
                if abs(float(vz)) > 80.0:
                    return True
        except (TypeError, ValueError):
            pass

    if "Z" in row:
        snap_before = spatial_cache.get(kill_tick - 16)
        if snap_before is not None:
            row_before = _spatial_player_row(snap_before, player_name)
            if row_before is not None and "Z" in row_before:
                try:
                    z_now = float(row["Z"])
                    z_before = float(row_before["Z"])
                    if abs(z_now - z_before) > 20.0:
                        return True
                except (TypeError, ValueError):
                    pass

    return False


def count_shots_before(
    fire_index: list[tuple[int, str]],
    kill_tick: int,
    weapon: str,
    window_ticks: int,
) -> int:
    """目标玩家在 (kill_tick - window_ticks, kill_tick] 区间内使用同名武器的开火次数。"""
    if not fire_index:
        return 0
    lo = bisect_left(fire_index, kill_tick - window_ticks, key=lambda e: e[0])
    hi = bisect_right(fire_index, kill_tick, key=lambda e: e[0])
    return sum(1 for i in range(lo, hi) if fire_index[i][1] == weapon)


def build_hurt_index(
    target_player: str, hurt_df: pd.DataFrame,
) -> list[tuple[int, str, int]]:
    """构建目标玩家造成的 (tick, victim_name, damage) 伤害索引，有序。"""
    if hurt_df.empty or "attacker_name" not in hurt_df.columns:
        return []
    dmg_col = "dmg_health" if "dmg_health" in hurt_df.columns else None
    if dmg_col is None:
        return []
    pf = hurt_df.loc[hurt_df["attacker_name"] == target_player].sort_values("tick")
    return [
        (_int(r["tick"]), str(r.get("user_name", "")), _int(r[dmg_col]))
        for _, r in pf.iterrows()
    ]


def check_outline_master(
    death: dict,
    fire_index: list[tuple[int, str]],
    hurt_index: list[tuple[int, str, int]],
    round_target_kill_ticks: dict[int, list[int]],
) -> list[str]:
    """判定: 死前 3 秒内用步枪/冲锋枪开了 ≥10 枪，但对击杀者伤害 ≤25。"""
    death_tick = death["tick"]
    attacker = death["attacker"]
    window_start = death_tick - _OUTLINE_WINDOW
    if any_kill_tick_in_round_shield(
        _int(death.get("round")),
        death_tick,
        window_start,
        round_target_kill_ticks,
    ):
        return []

    lo = bisect_left(fire_index, window_start, key=lambda e: e[0])
    hi = bisect_right(fire_index, death_tick, key=lambda e: e[0])
    spray_count = sum(
        1 for i in range(lo, hi) if fire_index[i][1] in SPRAY_WEAPONS
    )
    if spray_count < _OUTLINE_MIN_FIRES:
        return []

    lo_h = bisect_left(hurt_index, window_start, key=lambda e: e[0])
    hi_h = bisect_right(hurt_index, death_tick, key=lambda e: e[0])
    total_damage = sum(
        hurt_index[i][2] for i in range(lo_h, hi_h)
        if hurt_index[i][1] == attacker
    )

    if total_damage <= _OUTLINE_MAX_DAMAGE:
        return ["人体描边", "反向锁头"]
    return []


def detect_kill_action_tags(
    *,
    weapon: str,
    headshot: bool,
    noscope: bool,
    penetrated: int,
    thrusmoke: bool,
    attackerblind: bool,
    assistedflash: bool = False,
    attacker_in_air: bool = False,
    penetrated_objects: int = 0,
) -> list[str]:
    """单次击杀的基础动作标签（不依赖空间快照）。"""
    tags: list[str] = []
    if weapon in SNIPER_WEAPONS and noscope:
        tags.append("🙈 盲狙")
    if penetrated > 0:
        tags.append("🧱 穿墙杀")
    if thrusmoke:
        tags.append("🌫️ 混烟")
    if attackerblind:
        tags.append("😎 全白反杀")
    if assistedflash:
        tags.append("🤝 好闪配好人")
    if headshot:
        tags.append("爆头")
    if weapon in PISTOL_WEAPONS and headshot:
        tags.append("🔫 手枪哥")
    if attacker_in_air:
        tags.append("🛸 乌鸦坐飞机")
    if penetrated > 0 and penetrated_objects >= 2:
        tags.append("🔀 连穿")
    return tags


def enrich_kill_action_tags_spatial(
    round_kills: dict[int, list[dict]],
    spatial_cache: "dict[int, dict[str, dict]]",
    target_player: str,
) -> None:
    """把依赖位置/朝向/速度的击杀动作子标回填到每个 kill['tags']（就地修改）。"""
    for kills in round_kills.values():
        for k in kills:
            kt = _int(k.get("tick"))
            extra: list[str] = []
            weapon   = str(k.get("weapon") or "").strip()
            headshot = _bool(k.get("headshot"))
            penetrated = _int(k.get("penetrated"), 0)
            vic_name = str(k.get("victim") or "").strip()

            snap = spatial_cache.get(kt)
            atk  = _spatial_player_row(snap, target_player) if snap else None

            # ── 距离：优先用 player_death 事件自带坐标，fallback 到 spatial_cache ──
            ax: Optional[float] = k.get("atk_x")
            ay: Optional[float] = k.get("atk_y")
            az: Optional[float] = k.get("atk_z")
            vx: Optional[float] = k.get("vic_x")
            vy: Optional[float] = k.get("vic_y")
            vz: Optional[float] = k.get("vic_z")
            if ax is None and atk is not None:
                try: ax, ay, az = float(atk["X"]), float(atk["Y"]), float(atk["Z"])
                except (TypeError, ValueError, KeyError): pass
            if vx is None and snap:
                vic_row = _spatial_player_row(snap, vic_name)
                if vic_row is not None:
                    try: vx, vy, vz = float(vic_row["X"]), float(vic_row["Y"]), float(vic_row["Z"])
                    except (TypeError, ValueError, KeyError): pass

            dist: Optional[float] = None
            if ax is not None and vx is not None:
                try:
                    dz = (az - vz) if (az is not None and vz is not None) else 0.0
                    dist = math.sqrt((ax - vx) ** 2 + (ay - vy) ** 2 + dz ** 2)
                except (TypeError, ValueError):
                    pass
            if dist is not None:
                if dist <= _PB_DIST_EXECUTION and headshot:
                    extra.append("👃 零距离")
                elif dist <= _PB_DIST_POINT_BLANK:
                    extra.append("🫵 贴脸超度")
                if penetrated >= 1 and dist > _WALLBANG_DIST_MIN:
                    extra.append("🎯 超远穿墙")

            # ── 偷背身（枪版）：受害者背对攻击者 ──
            if weapon not in KNIFE_WEAPONS and vic_name and snap:
                if not _victim_facing_attacker(snap, target_player, vic_name):
                    extra.append("🔙 偷背身")

            # ── 速度：直接读 vel_x/vel_y（比位置差更准，消除方向性误差）──
            vxy: Optional[float] = None
            if atk is not None and "vel_x" in atk and "vel_y" in atk:
                try:
                    vxy = math.hypot(float(atk["vel_x"]), float(atk["vel_y"]))
                except (TypeError, ValueError):
                    pass

            _is_jump = is_jump_kill(spatial_cache, kt, target_player)
            if vxy is not None:
                if vxy > _RUSH_VEL_MIN:
                    extra.append("🚀 上去就是干")
                elif (_RUNGUN_VEL_MIN <= vxy <= _RUNGUN_VEL_MAX
                      and not _is_jump
                      and not _bool(k.get("noscope"))):
                    extra.append("🏃‍♂️ 跑打")

            # ── 一个大拉：用 vel_x/vel_y 方向与 yaw 夹角 ──
            if (atk is not None and "yaw" in atk and not _is_jump
                    and vxy is not None and vxy > _SLIDE_VEL_XY_MIN
                    and "vel_x" in atk and "vel_y" in atk):
                try:
                    move_angle   = math.degrees(math.atan2(float(atk["vel_y"]), float(atk["vel_x"])))
                    strafe_angle = _smallest_angle_diff_deg(move_angle, float(atk["yaw"]))
                    if strafe_angle >= 45.0:
                        extra.append("🎿 一个大拉")
                except (TypeError, ValueError):
                    pass

            # ── 乌鸦坐飞机：优先用事件字段，vel_z 作兜底（事件字段缺失时）──
            if "🛸 乌鸦坐飞机" not in (k.get("tags") or []):
                if atk is not None and "vel_z" in atk:
                    try:
                        if float(atk["vel_z"]) > _AIRBORNE_VEL_Z_MIN:
                            extra.append("🛸 乌鸦坐飞机")
                    except (TypeError, ValueError):
                        pass

            # ── 甩狙：扩展 lookback 到 32 ticks（0.5s），阈值 25°──
            if weapon in SNIPER_WEAPONS and atk is not None and "yaw" in atk:
                _flick_max_yd = 0.0
                try:
                    _cur_yaw = float(atk["yaw"])
                    for _flick_off in _QUICKSCOPE_LOOKBACK_OFFSETS:
                        _snap_p = spatial_cache.get(kt - _flick_off)
                        _prev_r = _spatial_player_row(_snap_p, target_player) if _snap_p else None
                        if _prev_r is not None and "yaw" in _prev_r:
                            try:
                                _flick_max_yd = max(
                                    _flick_max_yd,
                                    _smallest_angle_diff_deg(_cur_yaw, float(_prev_r["yaw"])),
                                )
                            except (TypeError, ValueError):
                                pass
                except (TypeError, ValueError):
                    pass
                if _flick_max_yd >= _QUICKSCOPE_YAW_DELTA_MIN:
                    extra.append("🌪️ 甩狙")

            base = list(k.get("tags") or [])
            seen = set(base)
            for t in extra:
                if t not in seen:
                    seen.add(t)
                    base.append(t)
            k["tags"] = base
