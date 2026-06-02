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
    _BACKSTAB_SKIP_IF_DAMAGE,
    _BACKSTAB_MIN_FIRES,
    _BACKSTAB_ATTACKER_BACK_DEG,
    _BACKSTAB_VICTIM_AIM_DEG,
    _BACKSTAB_BACKAIM_MIN_PASS_RATIO,
    _BACKSTAB_DEAGLE_MIN_SPATIAL_PASSES,
    _backstab_aim_sample_offsets_sec,
    _BACKSTAB_SPRAY_WEAPONS,
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
    _RUNGUN_IMMEDIATE_VEL_MIN,
    _SLIDE_VEL_XY_MIN,
    _AIRBORNE_VEL_Z_MIN,
    _AIRBORNE_LOOKBACK_TICKS,
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


def _spatial_player_row(snapshot: Optional[pd.DataFrame], player: str) -> Optional[pd.Series]:
    if snapshot is None or snapshot.empty or not str(player).strip():
        return None
    nc = "name" if "name" in snapshot.columns else None
    if nc is None:
        return None
    m = snapshot[snapshot[nc] == player]
    if m.empty:
        pl = str(player).strip().lower()
        for cand in snapshot[nc].astype(str).unique():
            if str(cand).strip().lower() == pl:
                m = snapshot[snapshot[nc] == cand]
                break
    if m.empty:
        return None
    return m.iloc[0]


def _victim_facing_attacker(
    snapshot: Optional[pd.DataFrame],
    attacker: str,
    victim: str,
    *,
    max_angle_deg: float = 45.0,
) -> bool:
    """死亡瞬间受害者的 yaw 是否指向攻击者（±max_angle_deg 内）。"""
    v = _spatial_player_row(snapshot, victim)
    a = _spatial_player_row(snapshot, attacker)
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


def _row_health(row: pd.Series) -> Optional[int]:
    for k in ("health", "m_iHealth"):
        if k not in row.index:
            continue
        v = row[k]
        if pd.isna(v):
            continue
        try:
            h = int(float(v))
        except (TypeError, ValueError):
            continue
        return h
    return None


def _spatial_snap_pre_kill(
    spatial_cache: dict[int, pd.DataFrame],
    kill_tick: int,
) -> Optional[pd.DataFrame]:
    """击杀 tick 前几帧的快照，避免该 tick 上受害者已被标为 is_alive=False。"""
    kt = int(kill_tick)
    for off in (8, 16, 24, 32):
        s = spatial_cache.get(kt - off)
        if s is not None and not s.empty:
            return s
    s = spatial_cache.get(kt)
    return s if s is not None and not s.empty else None


def _alive_mates_and_enemies(
    snap: pd.DataFrame,
    target_player: str,
) -> Optional[tuple[int, int]]:
    """返回 (同队存活队友数不含自己, 敌方存活人数)；无法统计时返回 None。"""
    row_self = _spatial_player_row(snap, target_player)
    if row_self is None:
        return None
    name_col = "name" if "name" in snap.columns else None
    if not name_col or "is_alive" not in snap.columns or "team_num" not in snap.columns:
        return None
    tgt_team = row_self.get("team_num")
    if tgt_team is None or (isinstance(tgt_team, float) and pd.isna(tgt_team)):
        return None
    try:
        tgt_team_i = int(float(tgt_team))
    except (TypeError, ValueError):
        return None
    alive_df = snap[snap["is_alive"].astype(bool)]
    tm = pd.to_numeric(alive_df["team_num"], errors="coerce")
    mates = alive_df[
        tm.notna()
        & (tm == float(tgt_team_i))
        & (alive_df[name_col].astype(str) != target_player)
    ]
    enems = alive_df[tm.notna() & (tm != float(tgt_team_i))]
    return len(mates), len(enems)


def parse_spatial_snapshots(
    parser: DemoParser,
    ticks: list[int],
) -> dict[int, pd.DataFrame]:
    """解析指定 tick 的玩家坐标与偏航（原 DemoAnalyzer._parse_spatial_snapshots）。"""
    if not ticks:
        return {}
    unique_ticks = sorted(set(ticks))
    try:
        result = parser.parse_ticks(
            [
                "X", "Y", "Z",
                "vel_x", "vel_y", "vel_z",
                "yaw", "name", "is_alive", "team_num", "health",
            ],
            ticks=unique_ticks,
        )
    except Exception:
        try:
            result = parser.parse_ticks(
                ["X", "Y", "Z", "vel_z", "yaw", "name", "is_alive", "team_num", "health"],
                ticks=unique_ticks,
            )
        except Exception:
            return {}
    try:
        df = _to_pandas_df(result)
        if df.empty:
            return {}
        return {tick: group for tick, group in df.groupby("tick")}
    except Exception:
        return {}


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
    spatial_cache: dict[int, pd.DataFrame],
) -> list[str]:
    """判定: 被爆头时, ≥2 名存活队友比自己更靠近敌人（距离 < 60%）。"""
    tick = death["tick"]
    attacker_name = death["attacker"]

    snapshot = spatial_cache.get(tick)
    if snapshot is None or snapshot.empty:
        return []

    name_col = "name" if "name" in snapshot.columns else None
    if name_col is None:
        return []

    attacker_rows = snapshot[snapshot[name_col] == attacker_name]
    victim_rows = snapshot[snapshot[name_col] == target_player]
    if attacker_rows.empty or victim_rows.empty:
        return []

    ax, ay = float(attacker_rows.iloc[0]["X"]), float(attacker_rows.iloc[0]["Y"])
    vx, vy = float(victim_rows.iloc[0]["X"]), float(victim_rows.iloc[0]["Y"])

    d_victim = math.hypot(ax - vx, ay - vy)
    if d_victim < 1.0:
        return []

    victim_team = victim_rows.iloc[0].get("team_num")
    if victim_team is None:
        return []

    teammates = snapshot[
        (snapshot["team_num"] == victim_team)
        & (snapshot[name_col] != target_player)
        & (snapshot[name_col] != attacker_name)
        & (snapshot["is_alive"].astype(bool))
    ]

    threshold = d_victim * _MAGNET_RATIO
    closer = sum(
        1 for _, tm in teammates.iterrows()
        if math.hypot(ax - float(tm["X"]), ay - float(tm["Y"])) < threshold
    )

    if closer >= _MAGNET_MIN_CLOSER:
        return ["人肉吸铁石", "保镖无用"]
    return []


def _backstab_spatial_ok_at_snapshot(
    snapshot: pd.DataFrame,
    *,
    killer: str,
    target_player: str,
    name_col: str,
    yaw_col: str,
) -> bool:
    """目标在击杀者背后架住背身：击杀者朝向背对目标，且目标朝向大致指向击杀者。"""
    attacker_rows = snapshot[snapshot[name_col] == killer]
    victim_rows = snapshot[snapshot[name_col] == target_player]
    if attacker_rows.empty or victim_rows.empty:
        return False

    ax = float(attacker_rows.iloc[0]["X"])
    ay = float(attacker_rows.iloc[0]["Y"])
    vx = float(victim_rows.iloc[0]["X"])
    vy = float(victim_rows.iloc[0]["Y"])
    attacker_yaw = float(attacker_rows.iloc[0][yaw_col])
    victim_yaw = float(victim_rows.iloc[0][yaw_col])

    if math.hypot(ax - vx, ay - vy) < 1.0:
        return False

    angle_atk_toward_vic = math.degrees(math.atan2(vy - ay, vx - ax))
    atk_facing_vs_line = _smallest_angle_diff_deg(attacker_yaw, angle_atk_toward_vic)
    if atk_facing_vs_line < (180.0 - _BACKSTAB_ATTACKER_BACK_DEG):
        return False

    angle_vic_toward_atk = math.degrees(math.atan2(ay - vy, ax - vx))
    vic_aim_vs_line = _smallest_angle_diff_deg(victim_yaw, angle_vic_toward_atk)
    if vic_aim_vs_line > _BACKSTAB_VICTIM_AIM_DEG:
        return False

    return True


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
    spatial_cache: dict[int, pd.DataFrame],
    target_player: str,
    round_target_kill_ticks: dict[int, list[int]],
) -> list[str]:
    """死前在「对方背身」位架枪 + 死前 3s 内开枪并被反杀。"""
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
    deagle_fire_count = sum(1 for _, w in fires_in_window if w == "deagle")
    spray_fire_count = sum(1 for _, w in fires_in_window if w in _BACKSTAB_SPRAY_WEAPONS)

    lo_h = bisect_left(hurt_index, w_start, key=lambda e: e[0])
    hi_h = bisect_right(hurt_index, w_end, key=lambda e: e[0])
    total_damage = sum(
        hurt_index[i][2]
        for i in range(lo_h, hi_h)
        if hurt_index[i][1] == killer
    )

    if total_damage >= _BACKSTAB_SKIP_IF_DAMAGE:
        return []
    if total_fire_count < _BACKSTAB_MIN_FIRES:
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
        if snapshot is None or snapshot.empty:
            return False
        name_col = "name" if "name" in snapshot.columns else None
        yaw_col = "yaw" if "yaw" in snapshot.columns else None
        if name_col is None or yaw_col is None:
            return False
        return _backstab_spatial_ok_at_snapshot(
            snapshot,
            killer=killer,
            target_player=target_player,
            name_col=name_col,
            yaw_col=yaw_col,
        )

    passes = sum(1 for tick in sample_ticks_ordered if _spatial_pass_at_tick(tick))

    is_deagle_meme = deagle_fire_count >= 3 and total_damage == 0
    is_spray_meme = spray_fire_count >= 4 and total_damage <= 27

    if is_deagle_meme:
        need_deagle_spatial = min(_BACKSTAB_DEAGLE_MIN_SPATIAL_PASSES, n_samples)
        if passes < need_deagle_spatial:
            return []
        return ["NiKo附体", "沙鹰背身三发"]
    if is_spray_meme:
        if passes < min_pass:
            return []
        if any_kill_tick_in_round_shield(
            _int(death.get("round")),
            death_tick,
            w_start,
            round_target_kill_ticks,
        ):
            return []
        return ["背身打不死", "人体描边"]
    return []


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
    spatial_cache: dict[int, pd.DataFrame],
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
        if r is None or "vel_z" not in r.index:
            continue
        try:
            vz = r["vel_z"]
            if vz is not None and not (isinstance(vz, float) and pd.isna(vz)):
                if abs(float(vz)) > 80.0:
                    return True
        except (TypeError, ValueError):
            pass

    if "Z" in row.index:
        snap_before = spatial_cache.get(kill_tick - 16)
        if snap_before is not None:
            row_before = _spatial_player_row(snap_before, player_name)
            if row_before is not None and "Z" in row_before.index:
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
    spatial_cache: dict[int, pd.DataFrame],
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
            atk  = _spatial_player_row(snap, target_player) if snap is not None and not snap.empty else None

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
            if vx is None and snap is not None:
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
            if weapon not in KNIFE_WEAPONS and vic_name and snap is not None:
                if not _victim_facing_attacker(snap, target_player, vic_name):
                    extra.append("🔙 偷背身")

            # ── 速度：直接读 vel_x/vel_y（比位置差更准，消除方向性误差）──
            vxy: Optional[float] = None
            if atk is not None and "vel_x" in atk.index and "vel_y" in atk.index:
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
            if (atk is not None and "yaw" in atk.index and not _is_jump
                    and vxy is not None and vxy > _SLIDE_VEL_XY_MIN
                    and "vel_x" in atk.index and "vel_y" in atk.index):
                try:
                    move_angle   = math.degrees(math.atan2(float(atk["vel_y"]), float(atk["vel_x"])))
                    strafe_angle = _smallest_angle_diff_deg(move_angle, float(atk["yaw"]))
                    if strafe_angle >= 45.0:
                        extra.append("🎿 一个大拉")
                except (TypeError, ValueError):
                    pass

            # ── 乌鸦坐飞机：优先用事件字段，vel_z 作兜底（事件字段缺失时）──
            if "🛸 乌鸦坐飞机" not in (k.get("tags") or []):
                if atk is not None and "vel_z" in atk.index:
                    try:
                        if float(atk["vel_z"]) > _AIRBORNE_VEL_Z_MIN:
                            extra.append("🛸 乌鸦坐飞机")
                    except (TypeError, ValueError):
                        pass

            # ── 甩狙：扩展 lookback 到 32 ticks（0.5s），阈值 25°──
            if weapon in SNIPER_WEAPONS and atk is not None and "yaw" in atk.index:
                _flick_max_yd = 0.0
                try:
                    _cur_yaw = float(atk["yaw"])
                    for _flick_off in _QUICKSCOPE_LOOKBACK_OFFSETS:
                        _snap_p = spatial_cache.get(kt - _flick_off)
                        _prev_r = _spatial_player_row(_snap_p, target_player) if _snap_p is not None else None
                        if _prev_r is not None and "yaw" in _prev_r.index:
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
