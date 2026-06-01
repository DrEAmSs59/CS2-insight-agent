from __future__ import annotations

import os

from .weapons import (
    SNIPER_WEAPONS,
    DEAGLE_VARIANTS,
    PRIMARY_WEAPONS,
)

TICK_RATE = 64

# 「冻结结束前 → 死亡后固定留白」合辑
_FREEZE_TO_DEATH_PRE_FREEZE_SEC = float(
    os.environ.get("CS2_INSIGHT_FREEZE_TO_DEATH_PRE_SEC", "8.0") or "8.0",
)
_FREEZE_TO_DEATH_POST_DEATH_SEC = float(
    os.environ.get("CS2_INSIGHT_FREEZE_TO_DEATH_POST_DEATH_SEC", "2.0") or "2.0",
)
BUFFER_SECONDS_BEFORE = 5
BUFFER_SECONDS_AFTER = 3
RAPID_KILL_WINDOW_SECONDS = 10
# 死亡类片段：导播 spec 需目标仍存活，起始 tick 至少提前本秒数
_DEATH_CLIP_LEAD_SECONDS = 6.0
# 「人体描边」免疫：开火窗口前后本秒内本回合有任何击杀则不下饭判定
_OUTLINE_KILL_SHIELD_SECONDS = 3.0

# ── Tag 覆盖关系（去除强语义重叠）──────────────────────────────
_TAG_COVERAGE_RULES: tuple[tuple[str, str], ...] = (
    ("🔫 手枪哥",   "🔫 手枪局专家"),
    ("🔫 手枪哥",   "🔫 ECO特种兵"),
    ("爆头",        "🔫 手枪哥"),
    ("爆头",        "👃 零距离"),
    ("爆头",        "NiKo附体"),
    ("爆头",        "沙鹰爆头"),
    ("爆头",        "💥 颗秒"),
    ("爆头",        "枪枪爆头"),
    ("🫵 贴脸超度", "👃 零距离"),
    ("🧱 穿墙杀",   "🎯 超远穿墙"),
    ("🙈 盲狙",     "✈️ 飞天盲狙"),
)


def _dedup_context_tags(tags: list[str]) -> list[str]:
    """保序去掉精确重复的 tag，并按 _TAG_COVERAGE_RULES 丢掉被更具体 tag 覆盖的宽泛 tag。"""
    if not tags:
        return []
    tag_set = set(tags)
    seen: set[str] = set()
    out: list[str] = []
    for t in tags:
        if t in seen:
            continue
        if any(t == covered and covered_by in tag_set
               for covered, covered_by in _TAG_COVERAGE_RULES):
            continue
        seen.add(t)
        out.append(t)
    return out


# 高光：回合冻结结束时队伍存活装备总价
ECO_MAX_VALUE = 8000
FULL_BUY_MIN_VALUE = 15000
# 高光「800里开外」：大狙 / 沙鹰系
_HIGHLIGHT_LONGRANGE_WEAPONS = SNIPER_WEAPONS | {"deagle", "revolver"}
_HIGHLIGHT_LONG_RANGE_DIST = 1500.0
# C4 / 飞天狙
_DEFUSE_EXTREME_MIN_SEC = 39.0
_NINJA_ENEMY_MAX_DIST_3D = 1000.0
_FLYING_SNIPER_LOOKBACK_TICKS = 16
_FLYING_SNIPER_Z_DELTA_MIN = 15.0

# ── 高级场景阈值 ──
_TIMING_SWITCH_WINDOW = int(TICK_RATE * 1.5)    # 切刀后 1.5 秒内被杀
_TIMING_HOLD_MIN      = TICK_RATE * 10           # 之前架枪至少 10 秒
_OUTLINE_WINDOW       = TICK_RATE * 3            # 死前 3 秒窗口
_OUTLINE_MIN_FIRES    = 10                       # 至少开 10 枪
_OUTLINE_MAX_DAMAGE   = 25                       # 造成伤害 ≤ 25
_MAGNET_RATIO         = 0.6                      # 队友距敌 < 60% × 你距敌
_MAGNET_MIN_CLOSER    = 2                        # 至少 2 个队友更近

# ── 背身打不死 / NiKo 沙鹰背身 ──
_BACKSTAB_WINDOW_TICKS = int(TICK_RATE * 3)
_BACKSTAB_SKIP_IF_DAMAGE = 50
_BACKSTAB_MIN_FIRES = 2
_BACKSTAB_ATTACKER_BACK_DEG = 60.0
_BACKSTAB_VICTIM_AIM_DEG = 55.0
_BACKSTAB_BACKAIM_STEP_SEC = 0.5
_BACKSTAB_BACKAIM_MAX_SEC = 6.0
_BACKSTAB_BACKAIM_MIN_PASS_RATIO = 0.78
_BACKSTAB_DEAGLE_MIN_SPATIAL_PASSES = 3

# ── 击杀风格 / 回合级 / 合集 标签阈值 ──
_PB_DIST_POINT_BLANK      = 120.0
_PB_DIST_EXECUTION        = 60.0
_RUSH_VEL_MIN             = 220.0
_RUNGUN_VEL_MIN           = 120.0
_RUNGUN_VEL_MAX           = 220.0
_RUNGUN_IMMEDIATE_VEL_MIN = 70.0
_WALLBANG_DIST_MIN        = 400.0
_QUICKSCOPE_YAW_DELTA_MIN  = 40.0
_QUICKSCOPE_LOOKBACK_OFFSETS = (8, 16)
_AIRBORNE_VEL_Z_MIN       = 80.0
_AIRBORNE_LOOKBACK_TICKS  = 16
_SLIDE_VEL_XY_MIN         = 150.0

# 回合级标签
_CLUTCH_ROUNDEND_SEC      = 5.0
_CLUTCH_BOMB_SEC          = 3.0
_AVENGE_WINDOW_TICKS      = int(TICK_RATE * 2.5)
_BAREFOOT_EQUIP_MAX       = 5000
_COMEBACK_HP_MAX          = 20
_IRONSHIRT_HITS_MIN       = 4
_IRONSHIRT_DMG_MIN        = 95
_EXTREME_DEFUSE_ZERO_SEC  = 0.2

# 手枪梗专用集合
PISTOL_WEAPONS = frozenset({
    "glock", "hkp2000", "usp_silencer", "p250", "cz75a",
    "fiveseven", "tec9", "elite",
})
# 非子弹 / 道具类伤害来源（🪨 挨揍王 排除）
_UTILITY_DMG_WEAPONS = frozenset({
    "hegrenade", "inferno", "molotov", "incgrenade",
    "flashbang", "c4", "planted_c4", "world",
})

# Fail 扩展
_ZOMBIE_STEP_PRE_TICKS    = int(TICK_RATE * 3.0)
_ZOMBIE_STEP_MAX_DISP     = 20.0
_STROLL_PRE_TICKS         = int(TICK_RATE * 1.0)
_STROLL_MIN_VEL           = 150.0
_MAGNET_NADE_LOOKBACK_TICKS = int(TICK_RATE * 5.0)
_MAGNET_NADE_DIST_DROP    = 200.0
_FLASH_SEND_MIN_DUR       = 2.5
_FLASH_SEND_WINDOW_TICKS  = int(TICK_RATE * 3.0)

# 合集类
_RIVAL_KILL_THRESHOLD     = 8
_NEMESIS_DEATH_THRESHOLD  = 8

# ── 肩并肩（Shoulder-to-Shoulder）下饭检测 ──
_SHOULDER_DIST            = 60.0
_SHOULDER_MIN_SECS        = 2.0
_SHOULDER_SAMPLE_INTERVAL = 64
_SHOULDER_PRE_SECS        = 6.0
_SHOULDER_POST_SECS       = 7.0

# 颗秒武器分类（全局复用）
_KEQIAO_SEMI_SNIPERS = frozenset({"scar20", "g3sg1"})
_KEQIAO_RIFLES       = frozenset(PRIMARY_WEAPONS) - SNIPER_WEAPONS - _KEQIAO_SEMI_SNIPERS
_KEQIAO_WEAPONS      = _KEQIAO_RIFLES | DEAGLE_VARIANTS

# 步枪 + 微冲，用于「背身打不死」武器门槛
_BACKSTAB_SPRAY_WEAPONS = (
    (PRIMARY_WEAPONS - SNIPER_WEAPONS - {"scar20", "g3sg1", "negev", "m249"})
    | {"mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"}
)

_EXTRA_EVENT_FIELDS = ["total_rounds_played"]
_PLAYER_DEATH_GAME_KEYS = [
    "headshot",
    "noscope",
    "thrusmoke",
    "attackerblind",
    "penetrated",
    "assistedflash",
    "attackerinair",
    "attacker_in_air",
    "inair",
    "through_smoke",
    "penetrated_objects",
]


def _backstab_aim_sample_offsets_sec() -> tuple[float, ...]:
    step = max(1e-6, float(_BACKSTAB_BACKAIM_STEP_SEC))
    n = int(round(float(_BACKSTAB_BACKAIM_MAX_SEC) / step))
    n = max(1, n)
    return tuple(round(i * _BACKSTAB_BACKAIM_STEP_SEC, 4) for i in range(1, n + 1))
