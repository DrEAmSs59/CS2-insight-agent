"""数据挖掘引擎 - CS2 Demo 解析与高光/下饭时刻提取

高级下饭场景检测基于三轨数据源:
  1. item_equip  — 武器切换时间轴 (CS定律)
  2. parse_ticks — 特定帧空间坐标 + yaw (人肉吸铁石 / 背身打不死)
  3. weapon_fire + player_hurt — 开火/伤害统计 (人体描边)
"""

from __future__ import annotations

import logging
import math
import os
import uuid
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field, asdict, replace
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# demoparser2 在坏/不兼容 demo 上可能 Rust panic → PyO3 的 PanicException 不是 Exception 子类。
_DEMOPARSER_RE_RAISE = (KeyboardInterrupt, SystemExit, GeneratorExit)

# 与前端 PlayerSelect.getMemeTags 判定顺序一致：211 → o → i18 → i → z
_CHIEF_RD_BADGE = "👨‍🔬 首席研发工程师"


def meme_series_badges_for_kd(kills: int, deaths: int) -> list[str]:
    """本局 K/D 对应的 CS2 社区梗标签（o / i / z / 211 系列）。"""
    k, d = int(kills), int(deaths)
    if k == 2 and d == 11:
        return ["🎓 211高材生"]
    if k == 0:
        return [f"🥚 o{d}", _CHIEF_RD_BADGE]
    if k == 1 and d == 18:
        return [f"🗿 i{d}", _CHIEF_RD_BADGE]
    if k == 1:
        return [f"👨‍💻 i{d}", _CHIEF_RD_BADGE]
    if k == 2:
        return [f"💤 z{d}", _CHIEF_RD_BADGE]
    return []
from demoparser2 import DemoParser


def _to_pandas_df(result) -> pd.DataFrame:
    """将 demoparser2 的 parse_event / parse_ticks 返回值统一为 pandas DataFrame。"""
    if isinstance(result, pd.DataFrame):
        return result
    if hasattr(result, "to_pandas"):
        return result.to_pandas()
    if isinstance(result, list):
        return pd.DataFrame(result) if result else pd.DataFrame()
    return pd.DataFrame()


# ━━━ 数据结构 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@dataclass
class MatchMeta:
    map_name: str
    target_player: str
    total_rounds: int
    # 解析侧的观战编号兜底；录制期以 GSI 校准出的 spec_player 槽位为准。
    target_player_user_id: Optional[int] = None
    # Steam64 十进制字符串；观战仍靠昵称在 seek tick 上算槽位（CS2 无按 Steam 切 spec 的官方命令）
    target_steam_id: Optional[str] = None
    # player_death 汇总；meme 合集条数可能小于 target_deaths（与下饭去重）
    target_kills: int = 0
    target_deaths: int = 0
    team_a_score: int = 0  # 通常为 Team 2
    team_b_score: int = 0  # 通常为 Team 3
    match_date: str = ""  # 预留；当前 Demo 无可靠真实开赛时间，保持空串
    duration_mins: int = 0  # 回放时长（分钟），来自 header playback_time
    # o/i/z/211 系梗标签（与前端 PlayerSelect 一致）；非梗局为空列表
    meme_series_badges: list[str] = field(default_factory=list)
    # 「研发全集」大卡专用：整局特殊战绩总评（仅在有 meme_death 合集且开启 AI 时填充）
    ai_meme_montage_score: Optional[float] = None
    ai_meme_montage_commentary: Optional[str] = None


@dataclass
class Clip:
    clip_id: str
    round: int
    category: str  # "highlight" | "fail" | "meme_death" | "compilation"
    weapon_used: str
    kill_count: int
    start_tick: int
    end_tick: int
    context_tags: list[str] = field(default_factory=list)
    # 玩家互动：下饭 = 谁杀了目标；高光 = 目标本回合多杀里杀了哪些人
    killer_name: Optional[str] = None
    victims: list[str] = field(default_factory=list)
    killers: list[str] = field(default_factory=list)
    # 高光多杀：本片段内目标玩家每次击杀的 tick（升序），供导播智能跳跃剪辑分段
    kill_ticks: list[int] = field(default_factory=list)
    # 本回合开局比分（目标方 round 胜场 : 对方），来自 round_freeze_end 刻度与 team_num
    score_own: Optional[int] = None
    score_opp: Optional[int] = None
    # 本回合目标方是否赢得该回合（True=赢, False=输, None=未知）
    round_won: Optional[bool] = None
    # 本回合 round_freeze_end 的绝对 tick（seek 时不应早于此，避免穿越到上一回合黑屏）
    clip_min_tick: Optional[int] = None
    # 目标玩家在本回合的死亡 tick（供"虽败犹荣"类片段延伸录制到结局画面；赢了的回合亦填充，但导播默认不延伸）
    death_tick: Optional[int] = None
    # 本回合 demo 可安全录制的最晚 tick 上限（约等于下一回合 freeze_end - 5s）。
    # 超过此 tick，CS2 比赛结算界面会单向锁定渲染，demo_gototick 倒退无法恢复画面。
    clip_max_tick: Optional[int] = None
    ai_score: Optional[float] = None
    ai_commentary: Optional[str] = None
    # 合集片段（category="compilation"）专用：跨回合多个子片段的 (start_tick, end_tick) 列表
    # 导播剪辑按此列表逐个跳转，中间可插转场。非合集片段保持空列表。
    source_ticks: list[list[int]] = field(default_factory=list)
    source_rounds: list[int] = field(default_factory=list)
    compilation_kind: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ParseResult:
    match_meta: MatchMeta
    clips: list[Clip]

    def to_dict(self) -> dict:
        return {
            "match_meta": asdict(self.match_meta),
            "clips": [c.to_dict() for c in self.clips],
        }


# ━━━ 武器中文翻译 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WEAPON_TRANSLATION_MAP: dict[str, str] = {
    # 步枪
    "ak47":             "AK-47",
    "m4a1":             "M4A4",
    "m4a1_silencer":    "消音 M4A1-S",
    "sg556":            "SG 553",
    "aug":              "AUG",
    "famas":            "法玛斯 (FAMAS)",
    "galilar":          "加利尔 (Galil)",
    # 狙击枪
    "awp":              "大狙 (AWP)",
    "ssg08":            "鸟狙 (SSG08)",
    "scar20":           "连狙 (SCAR-20)",
    "g3sg1":            "连狙 (G3SG1)",
    # 微冲
    "mac10":            "吹风机 (MAC-10)",
    "mac_10":           "吹风机 (MAC-10)",   # demoparser2 某些 demo 用下划线写法
    "mp9":              "小蜜蜂 (MP9)",
    "mp7":              "MP7",
    "mp5sd":            "MP5-SD",
    "ump45":            "车王 (UMP-45)",
    "p90":              "P90",
    "bizon":            "野牛 (PP-Bizon)",
    # 手枪
    "deagle":           "沙鹰",
    "revolver":         "左轮 (R8)",
    "usp_silencer":     "消音 USP-S",
    "hkp2000":          "P2000",
    "glock":            "格洛克 (Glock-18)",
    "elite":            "双持 (Dual Berettas)",
    "p250":             "P250",
    "fiveseven":        "五七 (Five-SeveN)",
    "tec9":             "TEC-9",
    "cz75a":            "CZ-75",
    # 霰弹枪
    "nova":             "Nova",
    "xm1014":           "XM1014",
    "sawedoff":         "截短霰弹枪",
    "mag7":             "MAG-7",
    # 机枪
    "m249":             "M249",
    "negev":            "内格夫 (Negev)",
    # 投掷物 & 装备
    "hegrenade":        "手雷",
    "flashbang":        "闪光弹",
    "smokegrenade":     "烟雾弹",
    "inferno":          "燃烧弹",
    "molotov":          "燃烧瓶",
    "incgrenade":       "燃烧弹",
    "decoy":            "诱饵弹",
    "taser":            "电击枪 (Zeus)",
    # 刀具 (全皮肤变体)
    "knife":                 "刀",
    "knife_t":               "刀",
    "knife_ct":              "刀",
    "bayonet":               "刺刀",
    "knife_karambit":        "爪子刀",
    "knife_m9_bayonet":      "M9 刺刀",
    "knife_butterfly":       "蝴蝶刀",
    "knife_flip":            "折叠刀",
    "knife_gut":             "穿肠刀",
    "knife_tactical":        "猎杀者匕首",
    "knife_falchion":        "弯刀",
    "knife_survival_bowie":  "博伊猎刀",
    "knife_push":            "暗影双匕",
    "knife_cord":            "系绳匕首",
    "knife_canis":           "求生匕首",
    "knife_ursus":           "熊刀",
    "knife_gypsy_jackknife": "流浪者匕首",
    "knife_outdoor":         "户外匕首",
    "knife_stiletto":        "短剑",
    "knife_widowmaker":      "锯齿爪刀",
    "knife_skeleton":        "骷髅匕首",
    "knife_css":             "经典刀",
    "knife_kukri":           "廓尔喀刀",
    # 其他
    "world":            "坠落/世界伤害",
    "c4":               "C4 爆炸",
    "planted_c4":       "C4 爆炸",
    "defuse_kit":       "拆弹器",
}


def _translate_weapon(raw: str) -> str:
    return WEAPON_TRANSLATION_MAP.get(raw, raw.replace("_", " ").capitalize())


def _highlight_weapon_used_label(kills_sorted: list[dict]) -> str:
    """
    多杀高光的主武器展示：按击杀数降序排列，击杀最多的武器优先展示。
    例如 1 杀 M4A1-S + 2 杀 M4A4 → 显示「M4A4 / 消音 M4A1-S」而非反过来。
    同等击杀数时按首次出现顺序排列（保留原始时间顺序的次级排序）。
    """
    counts: dict[str, int] = {}
    first_idx: dict[str, int] = {}
    for i, k in enumerate(kills_sorted):
        w = str(k.get("weapon") or "").strip()
        if not w:
            continue
        counts[w] = counts.get(w, 0) + 1
        if w not in first_idx:
            first_idx[w] = i
    if not counts:
        return ""
    order = sorted(counts.keys(), key=lambda w: (-counts[w], first_idx[w]))
    if len(order) == 1:
        return _translate_weapon(order[0])
    return " / ".join(_translate_weapon(w) for w in order)


# ━━━ 武器分类 & 常量 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TICK_RATE = 64
BUFFER_SECONDS_BEFORE = 5
BUFFER_SECONDS_AFTER = 3
RAPID_KILL_WINDOW_SECONDS = 10
# 死亡类片段：导播 spec 需目标仍存活，起始 tick 至少提前本秒数
_DEATH_CLIP_LEAD_SECONDS = 6.0
# 「人体描边」免疫：开火窗口前后本秒内本回合有任何击杀则不下饭判定
_OUTLINE_KILL_SHIELD_SECONDS = 3.0

SNIPER_WEAPONS = {"awp", "ssg08"}
FAIL_WEAPONS = {"taser"}
DEAGLE_VARIANTS = {"deagle", "revolver"}
KNIFE_WEAPONS = {k for k in WEAPON_TRANSLATION_MAP if k.startswith("knife") or k == "bayonet"}
# 被道具/环境伤害击杀（不含 C4，C4 单独处理）
GRENADE_KILL_WEAPONS = {"hegrenade", "molotov", "incgrenade", "inferno"}
WORLD_KILL_WEAPONS   = {"world"}
SUICIDE_WEAPONS = GRENADE_KILL_WEAPONS | WORLD_KILL_WEAPONS

PRIMARY_WEAPONS = {
    "ak47", "m4a1", "m4a1_silencer", "sg556", "aug", "famas", "galilar",
    "awp", "ssg08", "scar20", "g3sg1",
}
SPRAY_WEAPONS = PRIMARY_WEAPONS | {
    "mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon",
    "negev", "m249",
}
# ── 颗秒武器分类（全局复用：_build_highlight_tags + analyze 单杀检测）──
# 半自动狙（自动连发狙）不算颗秒，AWP/SSG08 也排除
_KEQIAO_SEMI_SNIPERS = frozenset({"scar20", "g3sg1"})
_KEQIAO_RIFLES       = frozenset(PRIMARY_WEAPONS) - SNIPER_WEAPONS - _KEQIAO_SEMI_SNIPERS  # AK/M4系/SG556/AUG/FAMAS/GALIL
_KEQIAO_WEAPONS      = _KEQIAO_RIFLES | DEAGLE_VARIANTS                                    # 颗秒判定武器总集合
GRENADE_ITEMS = {"flashbang", "hegrenade", "smokegrenade", "molotov", "incgrenade", "decoy"}

# ── Tag 覆盖关系（去除强语义重叠）─────────────────────────────
# (covered, covered_by)：当 covered_by 也在 tags 中时，covered 会被丢掉。
# 只处理"必然同时触发且语义包含"的强重叠；刻意保留的同义补充 tag
# （如 "CS定律"/"切刀必死"、"人肉吸铁石"/"保镖无用"）不在此处理。
_TAG_COVERAGE_RULES: tuple[tuple[str, str], ...] = (
    # 更具体的回合级/经济场景 tag 覆盖单次手枪爆头击杀
    ("🔫 手枪哥",   "🔫 手枪局专家"),
    ("🔫 手枪哥",   "🔫 ECO特种兵"),
    # 这些 tag 定义里已隐含"爆头"语义
    ("爆头",        "🔫 手枪哥"),
    ("爆头",        "👃 零距离"),
    ("爆头",        "NiKo附体"),
    ("爆头",        "沙鹰爆头"),
    ("爆头",        "💥 颗秒"),    # 颗秒条件之一就是 headshot
    ("爆头",        "枪枪爆头"),   # 枪枪爆头已隐含每杀都爆头
    # 距离阈值包含关系：60 units 必然 ≤ 120 units
    ("🫵 贴脸超度", "👃 零距离"),
    # 穿墙系：更具体的 tag 已包含穿墙语义，"穿墙杀"在这些情况下冗余
    ("🧱 穿墙杀",   "🎯 超远穿墙"),  # 超远穿墙 = 穿墙 + 远距离
    ("🧱 穿墙杀",   "🔫 一弹双穿"),  # 一弹双穿定义里至少一杀 penetrated≥1
    # 飞天盲狙 = 盲狙 + 跳跃，盲狙冗余
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

# 高光：回合冻结结束时队伍存活装备总价（round_freeze_end + parse_ticks）
ECO_MAX_VALUE = 8000
# 对方「有威胁的购买」下限：17500 易漏掉强起/小枪齐道具（全队冻结 tick 求和常 ~15k±）
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
_BACKSTAB_WINDOW_TICKS = int(TICK_RATE * 3)      # 死前 3 秒（开火/伤害统计）
_BACKSTAB_SKIP_IF_DAMAGE = 50                    # 对击杀者伤害 ≥ 此值则不算下饭背身
_BACKSTAB_MIN_FIRES = 2                          # 窗口内至少开枪次数（任意武器）
# 「瞄准对方背身」几何：击杀者朝向与「击杀者→目标」方位差需接近 180°（背对目标）
_BACKSTAB_ATTACKER_BACK_DEG = 60.0               # 与 180° 的容差：实际夹角 ≥ 180−此值 视为背身
# 目标准星大致指向击杀者（视线与「目标→击杀者」方位差）
_BACKSTAB_VICTIM_AIM_DEG = 55.0
# 死前「架背身」时间轴：每 step 秒采样一次，最远回看 max_sec（覆盖常见 5～6 秒预瞄）
_BACKSTAB_BACKAIM_STEP_SEC = 0.5
_BACKSTAB_BACKAIM_MAX_SEC = 6.0
# 采样点中至少该比例通过几何判定（步枪/扫射：长预瞄，偏严）
_BACKSTAB_BACKAIM_MIN_PASS_RATIO = 0.78
# 沙鹰背身：在整段采样里至少该帧数几何成立（通常 3/12，不要求全在近点几帧）
_BACKSTAB_DEAGLE_MIN_SPATIAL_PASSES = 3

# ── 新增：击杀风格 / 回合级 / 合集 标签阈值 ──
# 动作子标
_PB_DIST_POINT_BLANK      = 120.0   # 🫵 贴脸超度：距离 ≤ 此值
_PB_DIST_EXECUTION        = 60.0    # 👃 零距离：距离 ≤ 此值 且爆头
_RUSH_VEL_MIN             = 220.0   # 🚀 上去就是干：|vel_xy| > 此值
_RUNGUN_VEL_MIN           = 120.0   # 🏃‍♂️ 跑打 下限
_RUNGUN_VEL_MAX           = 220.0   # 🏃‍♂️ 跑打 上限（与上去就是干互斥）
_WALLBANG_DIST_MIN        = 400.0   # 🎯 超远穿墙：penetrated≥1 且距离 > 此值
_QUICKSCOPE_YAW_DELTA_MIN  = 40.0   # 🌪️ 甩狙：击杀前 N tick 与击杀时 yaw 最大差
# 同时采样 kt-8 和 kt-16 取最大值：甩枪动作可能在击杀前 125ms 已完成，
# 若只看 kt-8 会在"已对准但仍在扣扳机"阶段读到 0 差值，漏检。
_QUICKSCOPE_LOOKBACK_OFFSETS = (8, 16)  # 均已在 jump_sample_ticks 中覆盖
_AIRBORNE_VEL_Z_MIN       = 150.0   # 🛸 乌鸦坐飞机：击杀帧 vel_z 上限
_AIRBORNE_LOOKBACK_TICKS  = 16
_SLIDE_VEL_XY_MIN         = 150.0   # 🎿 一个大拉：下蹲+移动近似速度下限

# 回合级标签
_CAMPER_WINDOW_TICKS      = int(TICK_RATE * 4.0)  # 🐍 老六本色：回看 4s
_CAMPER_MAX_DISP          = 30.0                   # 攻击者位移上限
_CAMPER_SHOTS_MAX         = 2                      # shots_to_kill 上限
_CLUTCH_ROUNDEND_SEC      = 5.0     # 🔔 极限操作：距回合结束 ≤ 此秒
_CLUTCH_BOMB_SEC          = 3.0     # 🔔 极限操作：距 C4 爆炸 ≤ 此秒
_AVENGE_WINDOW_TICKS      = int(TICK_RATE * 2.5)   # ⚰️ 补枪：2.5s 内队友被打
_BAREFOOT_EQUIP_MAX       = 2000     # 👢 光脚干皮鞋：本回合队伍装备价值上限
_COMEBACK_HP_MAX          = 20       # ❤️‍🩹 残血绝地反击：起始 HP 上限
_IRONSHIRT_HITS_MIN       = 4        # 🪨 挨揍王：非道具命中次数下限
_IRONSHIRT_DMG_MIN        = 95       # 🪨 挨揍王：累计伤害下限
_EXTREME_DEFUSE_ZERO_SEC  = 0.2      # ⏱️ 零秒拆包 子标：拆完剩余 ≤ 此秒

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
_ZOMBIE_STEP_PRE_TICKS    = int(TICK_RATE * 3.0)   # 🗿 僵尸步：死前 3s
_ZOMBIE_STEP_MAX_DISP     = 20.0
_STROLL_PRE_TICKS         = int(TICK_RATE * 1.0)   # 🐢 散步流：死前 1s
_STROLL_MIN_VEL           = 150.0
_MAGNET_NADE_LOOKBACK_TICKS = int(TICK_RATE * 5.0) # 🧲 吸铁石：死前 5s
_MAGNET_NADE_DIST_DROP    = 200.0
_FLASH_SEND_MIN_DUR       = 2.5     # 🚪 闪送：flash_duration 下限
_FLASH_SEND_WINDOW_TICKS  = int(TICK_RATE * 3.0)

# 合集类
_RIVAL_KILL_THRESHOLD     = 8        # 🥩 亲儿子喂饭：击杀同一敌人次数
_NEMESIS_DEATH_THRESHOLD  = 8        # ☠️ 本命苦主：被同一敌人击杀次数

# ── 肩并肩（Shoulder-to-Shoulder）下饭检测 ──
_SHOULDER_DIST            = 60.0    # units：双方距离 ≤ 此值才算"贴身"（约 2 个身位）
# 玩家碰撞体宽 32u，60u ≈ 肩膀挨着肩膀；xbox box 两侧约 100-120u，不会误判。
_SHOULDER_MIN_SECS        = 2.0     # 至少持续 2 秒，才属于"下饭级搞笑"
_SHOULDER_SAMPLE_INTERVAL = 64      # 采样间隔（1s @ 64tick），节省 parse 开销
_SHOULDER_PRE_SECS        = 6.0     # 片段前缓冲（展示"怎么走到一起的"）
_SHOULDER_POST_SECS       = 7.0     # 片段后缓冲（展示"发现 / 逃跑 / 击杀"结局）


def _backstab_aim_sample_offsets_sec() -> tuple[float, ...]:
    step = max(1e-6, float(_BACKSTAB_BACKAIM_STEP_SEC))
    n = int(round(float(_BACKSTAB_BACKAIM_MAX_SEC) / step))
    n = max(1, n)
    return tuple(round(i * _BACKSTAB_BACKAIM_STEP_SEC, 4) for i in range(1, n + 1))
# 步枪 + 微冲（不含大狙 / 连狙 / 机枪），用于「背身打不死」武器门槛
_BACKSTAB_SPRAY_WEAPONS = (
    (PRIMARY_WEAPONS - SNIPER_WEAPONS - {"scar20", "g3sg1", "negev", "m249"})
    | {"mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"}
)

_EXTRA_EVENT_FIELDS = ["total_rounds_played"]


# ━━━ 工具函数 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _bool(val) -> bool:
    if val is None:
        return False
    if isinstance(val, bool):
        return val
    try:
        return int(val) != 0
    except (ValueError, TypeError):
        return False


def _int(val, default: int = 0) -> int:
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _round_end_winner_team_num(val) -> Optional[int]:
    """
    ``round_end`` 的 ``winner`` 转为 ``team_num``（2=T / 3=CT），与 ``parse_ticks`` 的 ``team_num`` 一致。
    CS2 常见为字符串 ``CT`` / ``T``；旧 demo 可能已是 ``2`` / ``3``。
    """
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        try:
            i = int(val)
        except (TypeError, ValueError):
            return None
        if i in (2, 3):
            return i
        return None
    s = str(val).strip().upper()
    if s == "CT":
        return 3
    if s in ("T", "TERRORIST", "TERRORISTS"):
        return 2
    return None


def _normalize_item(name) -> str:
    """统一武器/道具名: 小写、去 weapon_ 前缀。"""
    s = str(name).lower().strip()
    if s.startswith("weapon_"):
        s = s[7:]
    return s


def _is_knife_highlight_weapon(weapon: str) -> bool:
    """刀类击杀：用于强制单杀高光（含皮肤变体与关键词兜底）。"""
    w = _normalize_item(weapon)
    if not w:
        return False
    if w in KNIFE_WEAPONS:
        return True
    for key in (
        "knife", "bayonet", "karambit", "butterfly", "stiletto", "falchion",
        "bowie", "huntsman", "daggers", "shadow", "navaja", "ursus", "nomad",
        "skeleton", "survival", "paracord", "canis", "cord", "widowmaker",
        "gypsy", "outdoor", "css", "kukri",
    ):
        if key in w:
            return True
    return False


def _death_by_planted_c4(weapon: str) -> bool:
    w = _normalize_item(weapon)
    return w in ("c4", "planted_c4")


def _world_self_kill_cluster_c4_surrogate_keys(
    events: pd.DataFrame,
    match_start_tick: int,
) -> set[tuple[int, int]]:
    """
    CS2 中 C4 爆炸致死有时在 player_death 里记成 weapon=world 且 attacker==victim，
    而不会记为 planted_c4。若同一回合、短时间内出现多例这种死亡，可推断为包炸团灭。
    返回 (round, tick) 集合，供把对应死亡改写为 planted_c4 以统一标签与 weapon_used。
    """
    if events.empty or "tick" not in events.columns:
        return set()
    rows: list[tuple[int, int]] = []
    tcol = "tick"
    trc = "total_rounds_played" if "total_rounds_played" in events.columns else None
    if trc is None:
        return set()
    for _, row in events.iterrows():
        tick = _int(row.get(tcol))
        if match_start_tick > 0 and tick < match_start_tick:
            continue
        attacker = str(row.get("attacker_name", "") or "")
        victim = str(row.get("user_name", "") or "")
        if not attacker or attacker != victim:
            continue
        w = _normalize_item(row.get("weapon", ""))
        if w != "world":
            continue
        rnd = _int(row.get(trc)) + 1
        if rnd <= 0:
            continue
        rows.append((rnd, tick))
    if len(rows) < 2:
        return set()
    rows.sort(key=lambda x: (x[0], x[1]))
    gap = int(TICK_RATE * 4.0)
    out: set[tuple[int, int]] = set()
    i = 0
    n = len(rows)
    while i < n:
        rnd0, t0 = rows[i]
        cluster = [(rnd0, t0)]
        j = i + 1
        while j < n:
            rnd_j, t_j = rows[j]
            if rnd_j != rnd0:
                break
            if t_j - cluster[-1][1] > gap:
                break
            cluster.append((rnd_j, t_j))
            j += 1
        if len(cluster) >= 2:
            out.update(cluster)
        i = j
    return out


def _apply_c4_world_cluster_weapon_fixup(
    death_records: list[dict],
    surrogate_keys: set[tuple[int, int]],
) -> None:
    for d in death_records:
        key = (_int(d.get("round")), _int(d.get("tick")))
        if key not in surrogate_keys:
            continue
        if _normalize_item(d.get("weapon", "")) != "world":
            continue
        d["weapon"] = "planted_c4"


def _smallest_angle_diff_deg(a: float, b: float) -> float:
    """两方位角之差，范围 [0, 180]。"""
    return abs((float(a) - float(b) + 180.0) % 360.0 - 180.0)


# ━━━ 核心分析器 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class DemoAnalyzer:
    """Parse a .dem file and extract highlight / fail clips for a target player."""

    def __init__(self, dem_path: str | Path):
        self.dem_path = Path(dem_path)
        self.parser = DemoParser(str(self.dem_path))

    def _detect_map(self) -> str:
        try:
            header = self.parser.parse_header()
            return header.get("map_name", "unknown")
        except Exception:
            return "unknown"

    def _build_match_summary(self, match_start_tick: int) -> tuple[int, int, str, int]:
        """
        全局比赛信息：Team2/Team3 最终比分、Demo 文件修改时间、回放时长（分钟）。
        比分来自 round_end.winner（CT/T 或 2/3）；时长来自 parse_header().playback_time（秒）。
        """
        ta, tb, md, dm, _ = collect_match_summary_metrics(
            self.parser, self.dem_path, match_start_tick,
        )
        return ta, tb, md, dm

    def _safe_parse_event(
        self, event_name: str, other: Optional[list[str]] = None,
    ) -> pd.DataFrame:
        """解析事件, 失败时返回空 DataFrame。兼容 demoparser2 不同版本的返回类型。"""
        try:
            if other:
                return _to_pandas_df(self.parser.parse_event(event_name, other=other))
            return _to_pandas_df(self.parser.parse_event(event_name))
        except Exception:
            return pd.DataFrame()

    @staticmethod
    def _df_filter_match_start(df: pd.DataFrame, match_start_tick: int) -> pd.DataFrame:
        if df.empty or match_start_tick <= 0 or "tick" not in df.columns:
            return df
        return df.loc[
            pd.to_numeric(df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()

    @staticmethod
    def _defuser_name_from_row(row: pd.Series) -> str:
        for c in ("user_name", "player_name", "defuser", "defuser_name"):
            if c not in row.index:
                continue
            v = row.get(c)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                continue
            s = str(v).strip()
            if s:
                return s
        return ""

    @staticmethod
    def _collect_target_defuse_ticks_for_spatial(
        planted_df: pd.DataFrame,
        defused_df: pd.DataFrame,
        target_player: str,
        match_start_tick: int,
    ) -> list[int]:
        """目标玩家完成下包后拆包时，需要解析拆包 tick 的空间快照（忍者判定）。"""
        tp = str(target_player or "").strip().lower()
        if not tp or defused_df.empty or planted_df.empty:
            return []
        pd_df = DemoAnalyzer._df_filter_match_start(planted_df, match_start_tick)
        dd_df = DemoAnalyzer._df_filter_match_start(defused_df, match_start_tick)
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
            if DemoAnalyzer._defuser_name_from_row(row).strip().lower() != tp:
                continue
            plant_tick = None
            for pt in reversed(plant_ticks):
                if pt < d_tick:
                    plant_tick = pt
                    break
            if plant_tick is not None:
                out.append(d_tick)
        return out

    @staticmethod
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
        def_row = DemoAnalyzer._spatial_player_row(alive_df, defuser)
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

    def _analyze_bomb_defuse_highlights(
        self,
        planted_df: pd.DataFrame,
        defused_df: pd.DataFrame,
        target_player: str,
        match_start_tick: int,
        spatial_cache: dict[int, pd.DataFrame],
        round_freeze_end_ticks: dict[int, int],
    ) -> list[dict]:
        """目标玩家拆包：极限拆包时间 + 忍者偷包（需 spatial_cache 含拆包 tick）。"""
        tp = str(target_player or "").strip().lower()
        out: list[dict] = []
        if not tp or defused_df.empty or planted_df.empty:
            return out
        pd_df = self._df_filter_match_start(planted_df, match_start_tick)
        dd_df = self._df_filter_match_start(defused_df, match_start_tick)
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
            defuser = self._defuser_name_from_row(row)
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
                # C4 标准倒计时 40s；剩余 ≤ 1s 极限拆包;
                tags.append(f"⏱️ 极限拆包 ({40.0 - elapsed:.1f}s)")
            snap = spatial_cache.get(d_tick)
            if snap is not None and self._ninja_defuse_ok(snap, defuser, target_player):
                tags.append("🥷 忍者偷包")
            if tags:
                out.append({"round": rnd, "defuse_tick": d_tick, "tags": tags})
        return out

    def _build_round_economy(
        self,
        target_player: str,
        match_start_tick: int = 0,
    ) -> tuple[dict[int, dict[int, int]], dict[int, int], dict[int, int]]:
        """
        解析 round_freeze_end，在冻结结束 tick 上汇总 Team 2 / Team 3 存活玩家 current_equip_value，
        并记录目标玩家在该回合所属 team_num。

        返回三元组:
            economy_map            {round_num: {2: equip, 3: equip}}
            target_team_map        {round_num: team_num}
            round_freeze_end_ticks {round_num: freeze_end_tick}  ← 用于 clip_min_tick
        """
        economy_map: dict[int, dict[int, int]] = {}
        target_team_map: dict[int, int] = {}
        round_freeze_end_ticks: dict[int, int] = {}
        fr = self._safe_parse_event("round_freeze_end", other=list(_EXTRA_EVENT_FIELDS))
        if fr.shape[0] == 0 or "tick" not in fr.columns:
            return economy_map, target_team_map
        if match_start_tick > 0:
            fr = fr.loc[pd.to_numeric(fr["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick]
        if fr.shape[0] == 0:
            return economy_map, target_team_map
        trc = "total_rounds_played" if "total_rounds_played" in fr.columns else None
        if trc is None:
            return economy_map, target_team_map

        tick_to_round: dict[int, int] = {}
        for _, row in fr.sort_values("tick", kind="mergesort").iterrows():
            tick = _int(row.get("tick"))
            if tick <= 0:
                continue
            rn_here = _int(row.get(trc)) + 1
            tick_to_round[tick] = rn_here
            # 每回合只保留最早的 freeze_end tick（理论上每回合只有一个，但防御性取最小）
            if rn_here not in round_freeze_end_ticks or tick < round_freeze_end_ticks[rn_here]:
                round_freeze_end_ticks[rn_here] = tick

        ticks = sorted(tick_to_round.keys())
        if not ticks:
            return economy_map, target_team_map, round_freeze_end_ticks

        try:
            raw = self.parser.parse_ticks(
                ["team_num", "current_equip_value", "is_alive", "name"],
                ticks=ticks,
            )
            pdf = _to_pandas_df(raw)
        except Exception:
            return economy_map, target_team_map, round_freeze_end_ticks
        if pdf.empty or "tick" not in pdf.columns:
            return economy_map, target_team_map, round_freeze_end_ticks

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
                # 优先从存活玩家中找；死亡后仍在冻结时刻中，也需要知道其队伍编号
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

        return economy_map, target_team_map, round_freeze_end_ticks

    def _build_round_scores(self, match_start_tick: int = 0) -> dict[int, dict[int, int]]:
        """
        解析 round_end，按时间累加胜场；返回每回合**开始前**的双方比分 {2: T胜场, 3: CT胜场}。
        """
        re = self._safe_parse_event("round_end", other=list(_EXTRA_EVENT_FIELDS))
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
                ended_round = _int(row.get(trc)) + 1
            else:
                seq += 1
                ended_round = seq
            out[ended_round] = {2: scores[2], 3: scores[3]}
            scores[w] = scores.get(w, 0) + 1
            out[ended_round + 1] = {2: scores[2], 3: scores[3]}

        return out

    def _build_round_scores_team_based(
        self,
        round_target_team_map: dict[int, int],
        match_start_tick: int = 0,
    ) -> dict[int, tuple[int, int]]:
        """
        按**队伍身份**（而非 T/CT 阵营角色）累计胜场。
        CS2 换边后 team_num 会变：第一半场 T 方玩家在第二半场变成 CT 方。
        本函数通过比对每回合 round_end.winner 与 round_target_team_map[rnd] 确定
        "玩家所在队赢了这回合"，从而得出正确的比分。

        返回 {round_num: (own_wins_before_round, opp_wins_before_round)}
        """
        re = self._safe_parse_event("round_end", other=list(_EXTRA_EVENT_FIELDS))
        if match_start_tick > 0 and not re.empty and "tick" in re.columns:
            re = re.loc[
                pd.to_numeric(re["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
            ]
        if re.empty or "winner" not in re.columns:
            return {}
        if "tick" in re.columns:
            re = re.sort_values("tick", kind="mergesort")
        trc = "total_rounds_played" if "total_rounds_played" in re.columns else None

        # 未出现在 round_target_team_map 的回合（玩家死后冻结时间查不到）用最近已知值填充
        def get_player_team(rnd: int) -> Optional[int]:
            if rnd in round_target_team_map:
                return round_target_team_map[rnd]
            # 从有序 key 中找距离最近且 ≤ rnd 的条目
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
                # total_rounds_played 在 round_end 触发时已经是「已完成N回合」(1-indexed)
                # 例如 round 1 结束时 total_rounds_played = 1，即 ended_round = 1
                # freeze_end 中该字段为 0（本回合尚未完成），用 +1 → 1，两者对齐
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

    # ────────────────────────────────────────────────────────────
    #  主分析入口
    # ────────────────────────────────────────────────────────────
    def analyze(self, target_player: str) -> ParseResult:
        map_name = self._detect_map()

        match_start_tick = _get_match_start_tick(self.parser)

        # ── 每回合冻结结束瞬间：两队存活装备总价 + 目标所在阵营 ──
        round_economy_map, round_target_team_map, round_freeze_end_ticks = self._build_round_economy(
            target_player, match_start_tick,
        )
        # 以玩家队伍身份累计：own / opp 不随换边混淆，用于比分显示与赛点标签
        round_team_score_map = self._build_round_scores_team_based(
            round_target_team_map, match_start_tick,
        )
        # 每回合本方胜负：比较相邻回合的 own_wins 增量
        round_result_map: dict[int, bool] = {}
        for rnd, (own_before, opp_before) in round_team_score_map.items():
            after = round_team_score_map.get(rnd + 1)
            if after is not None:
                own_after, opp_after = after
                if own_after > own_before:
                    round_result_map[rnd] = True
                elif opp_after > opp_before:
                    round_result_map[rnd] = False

        planted_df = self._safe_parse_event("bomb_planted")
        defused_df = self._safe_parse_event("bomb_defused")

        # ── 解析所有需要的事件表 ──
        events = self.parser.parse_event("player_death", other=_EXTRA_EVENT_FIELDS)
        equip_df = self._safe_parse_event("item_equip")
        fire_df = self._safe_parse_event("weapon_fire")
        hurt_df = self._safe_parse_event("player_hurt")

        if match_start_tick > 0:
            tcol = "tick"
            if not events.empty and tcol in events.columns:
                events = events.loc[
                    pd.to_numeric(events[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()
            if not equip_df.empty and tcol in equip_df.columns:
                equip_df = equip_df.loc[
                    pd.to_numeric(equip_df[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()
            if not fire_df.empty and tcol in fire_df.columns:
                fire_df = fire_df.loc[
                    pd.to_numeric(fire_df[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()
            if not hurt_df.empty and tcol in hurt_df.columns:
                hurt_df = hurt_df.loc[
                    pd.to_numeric(hurt_df[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()
            if not planted_df.empty and tcol in planted_df.columns:
                planted_df = planted_df.loc[
                    pd.to_numeric(planted_df[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()
            if not defused_df.empty and tcol in defused_df.columns:
                defused_df = defused_df.loc[
                    pd.to_numeric(defused_df[tcol], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ].copy()

        # demoparser2 在不少事件里会给 *_name 字段加前导空格（0x20），
        # 直接比较 attacker/victim 会全部 miss → 零片段。统一 strip 一次。
        target_player = str(target_player or "").strip()
        _NAME_COLS = (
            "attacker_name", "user_name", "player_name", "assister_name",
            "defuser", "defuser_name",
        )
        for _df in (events, equip_df, fire_df, hurt_df, planted_df, defused_df):
            if _df is None or _df.empty:
                continue
            for _col in _NAME_COLS:
                if _col in _df.columns:
                    _df[_col] = _df[_col].astype(str).str.strip()

        # 目标玩家开火索引（用于颗秒判定：击杀前N秒内同武器开枪次数）
        _fire_index_full = DemoAnalyzer._build_fire_index(target_player, fire_df)

        # ── 受害者持有 AWP 检测：双轨方案（仅 AWP，不含 SSG08）──
        # CS2 新版 demo 格式中 item_equip 事件往往为空，改用两个可靠数据源：
        #   1. weapon_fire  — 受害者本回合开过 AWP → 必然持有（最常见）
        #   2. item_pickup  — 受害者本回合捡/买了 AWP → 捡枪但来不及开枪
        # 下界统一使用「上一局 freeze_end_tick」，因为买枪阶段紧接上一局结束。
        # （freeze_end - 25s 不够，实战中买枪发生在上一局结束后 0~5 秒内）

        # 构建每个玩家的 AWP 开火 tick 列表（仅 AWP，不含 SSG08）
        _awp_fire_index: dict[str, list[int]] = {}
        if not fire_df.empty and "user_name" in fire_df.columns and "weapon" in fire_df.columns:
            for _, _fr in fire_df.iterrows():
                _fp = str(_fr.get("user_name", "")).strip()
                _fw = _normalize_item(str(_fr.get("weapon", "") or ""))
                if _fw == "awp":
                    _awp_fire_index.setdefault(_fp, []).append(_int(_fr["tick"]))

        # 构建每个玩家的 AWP 捡取 tick 列表（item_pickup 事件，仅 AWP，不含 SSG08）
        _awp_pickup_index: dict[str, list[int]] = {}
        pickup_df = self._safe_parse_event("item_pickup")
        if not pickup_df.empty and "user_name" in pickup_df.columns:
            pickup_df["user_name"] = pickup_df["user_name"].astype(str).str.strip()
        if not pickup_df.empty and "user_name" in pickup_df.columns and "item" in pickup_df.columns:
            for _, _pk in pickup_df.iterrows():
                _pp = str(_pk.get("user_name", "")).strip()
                _pi = _normalize_item(str(_pk.get("item", "") or ""))
                if _pi == "awp":
                    _awp_pickup_index.setdefault(_pp, []).append(_int(_pk["tick"]))

        round_kills: dict[int, list[dict]] = {}
        death_records: list[dict] = []
        target_total_kills = 0
        round_first_death_tick: dict[int, int] = {}

        for _, row in events.iterrows():
            round_num = _int(row.get("total_rounds_played")) + 1
            # demoparser2 在 player_death 的 *_name 字段前偶现一个前导空格，统一 strip，
            # 否则 attacker/victim 与 target_player 永远不相等 → 零击杀零死亡零片段
            attacker = str(row.get("attacker_name", "") or "").strip()
            victim = str(row.get("user_name", "") or "").strip()
            weapon = _normalize_item(row.get("weapon", ""))
            tick = _int(row.get("tick"))

            if round_num not in round_first_death_tick and attacker and attacker != victim:
                round_first_death_tick[round_num] = tick

            headshot = _bool(row.get("headshot"))
            noscope = _bool(row.get("noscope"))
            penetrated = _int(row.get("penetrated"))
            thrusmoke = _bool(row.get("thrusmoke"))
            attackerblind = _bool(row.get("attackerblind"))
            assistedflash = _bool(row.get("assistedflash"))

            attacker_team = row.get("attackerteam")
            victim_team = row.get("userteam")

            is_attacker = (attacker == target_player)
            is_victim = (victim == target_player)

            # ── 收集目标玩家的所有死亡记录 ──
            if is_victim:
                death_records.append({
                    "round": round_num,
                    "tick": tick,
                    "weapon": weapon,
                    "headshot": headshot,
                    "attacker": attacker,
                    "attacker_team": attacker_team,
                    "victim_team": victim_team,
                    "attackerblind": attackerblind,
                    "assistedflash": assistedflash,
                })

            # ── 高光击杀积累 + 目标玩家总击杀 ──
            if is_attacker and attacker != victim:
                target_total_kills += 1
                per_kill_tags = self._detect_kill_action_tags(
                    weapon=weapon,
                    headshot=headshot,
                    noscope=noscope,
                    penetrated=penetrated,
                    thrusmoke=thrusmoke,
                    attackerblind=attackerblind,
                )
                # 颗秒判定：击杀前 2 秒内用同武器开枪的次数（0 = 无 fire 数据）
                shots_to_kill = DemoAnalyzer._count_shots_before(
                    _fire_index_full, tick, weapon, window_ticks=int(TICK_RATE * 2.0),
                )
                # 受害者是否"正持有"AWP：双轨检测（weapon_fire + item_pickup，仅 AWP）
                # 历史版本下界用"上一回合 freeze_end"，会让下半手枪局（第 13 回合）命中
                # 上半最后一局的 AWP 开火记录；且整段回合窗口会收录"捡起-丢枪-死亡"假阳性。
                # 新规则：严格本回合 freeze_end → kill_tick，且收紧到死前 5s 内仍在持枪。
                _vic_str       = str(victim).strip()
                _rnd_lo_awp    = round_freeze_end_ticks.get(round_num, 0)
                _awp_lo_tick   = max(_rnd_lo_awp, tick - int(TICK_RATE * 5.0))
                _vic_fired     = any(_awp_lo_tick <= _t <= tick for _t in _awp_fire_index.get(_vic_str, []))
                _vic_picked    = any(_awp_lo_tick <= _t <= tick for _t in _awp_pickup_index.get(_vic_str, []))
                _victim_had_awp = _vic_fired or _vic_picked
                round_kills.setdefault(round_num, []).append({
                    "weapon": weapon,
                    "tick": tick,
                    "headshot": headshot,
                    "noscope": noscope,
                    "tags": per_kill_tags,
                    "victim": victim,
                    "thrusmoke": thrusmoke,
                    "penetrated": penetrated,
                    "shots_to_kill": shots_to_kill,
                    "victim_had_awp": _victim_had_awp,
                })

        c4_world_cluster_keys = _world_self_kill_cluster_c4_surrogate_keys(events, match_start_tick)
        _apply_c4_world_cluster_weapon_fixup(death_records, c4_world_cluster_keys)

        # ── 炸弹爆炸后击杀回合修正 ──────────────────────────────────────────
        # CS2 中炸弹爆炸时 total_rounds_played 立即自增，使得爆炸后（下一冻结期前）
        # 发生的击杀被归到 round_num = N+1（幽灵回合）。
        # 修正：若某条击杀 tick 早于该回合的 freeze_end_tick，说明它发生在上一回合
        # （K-1）的尾声/回合间隙。逐条回拨，避免“回合间击杀 + 本回合击杀”被误合成双杀。
        _moved_pre_freeze_target_kills: list[tuple[int, int, int, str]] = []
        for _rn, _kills in list(round_kills.items()):
            if _rn <= 1 or _rn not in round_freeze_end_ticks:
                continue
            _freeze_tick = _int(round_freeze_end_ticks.get(_rn))
            if _freeze_tick <= 0:
                continue
            _kept: list[dict] = []
            for _k in _kills:
                _kt = _int(_k.get("tick"))
                if _kt < _freeze_tick:
                    _prev_rn = _rn - 1
                    round_kills.setdefault(_prev_rn, []).append(_k)
                    _moved_pre_freeze_target_kills.append((_rn, _prev_rn, _kt, str(_k.get("victim") or "")))
                else:
                    _kept.append(_k)
            if _kept:
                round_kills[_rn] = _kept
            else:
                round_kills.pop(_rn, None)
        if _moved_pre_freeze_target_kills:
            logger.info(
                "Moved pre-freeze target kills to previous round target=%r moved=%s",
                target_player,
                _moved_pre_freeze_target_kills,
            )

        # ── 空间快照：爆头帧 + 背身采样 + 目标所有击杀 tick（高光判定）──
        hs_ticks = [d["tick"] for d in death_records if d["headshot"]]
        aim_secs = _backstab_aim_sample_offsets_sec()
        backstab_ticks = [
            max(0, _int(d["tick"]) - int(TICK_RATE * float(sec)))
            for d in death_records
            for sec in aim_secs
        ]
        highlight_ticks = [
            _int(k["tick"])
            for kills in round_kills.values()
            for k in kills
        ]
        bomb_def_ticks = self._collect_target_defuse_ticks_for_spatial(
            planted_df, defused_df, target_player, match_start_tick,
        )
        flying_ticks: list[int] = []
        for kills in round_kills.values():
            for k in kills:
                w = str(k.get("weapon") or "")
                if w not in SNIPER_WEAPONS:
                    continue
                if not (_bool(k.get("noscope")) or "盲狙" in (k.get("tags") or [])):
                    continue
                kt = _int(k.get("tick"))
                flying_ticks.extend([kt, max(0, kt - _FLYING_SNIPER_LOOKBACK_TICKS)])

        # 击杀前多帧采样（复用于跳杀检测 + 智斗耐心窗口检测）
        # -8 / -16  : 跳跃速度采样
        # -64 / -128: 耐心窗口——检测受害者是否在击杀前 1s/2s 就已在攻击者射程内
        jump_sample_ticks = [
            max(0, _int(k["tick"]) - off)
            for kills in round_kills.values()
            for k in kills
            for off in (8, 16, 64, 128)
        ]

        # 肩并肩检测：全场按 1s 间隔均匀采样（合并进同一次 parse_ticks，避免二次 IO）
        # 从最早的 round_freeze_end 到最后回合开始再加 150 秒缓冲，覆盖整场比赛
        _shoulder_sample_ticks: list[int] = []
        if round_freeze_end_ticks:
            _sh_start = min(round_freeze_end_ticks.values())
            _sh_end   = max(round_freeze_end_ticks.values()) + int(150 * TICK_RATE)
            _shoulder_sample_ticks = list(range(_sh_start, _sh_end, _SHOULDER_SAMPLE_INTERVAL))

        spatial_ticks = sorted(set(
            hs_ticks + backstab_ticks + highlight_ticks + bomb_def_ticks
            + flying_ticks + jump_sample_ticks + _shoulder_sample_ticks,
        ))
        spatial_cache = self._parse_spatial_snapshots(spatial_ticks)
        bomb_highlights = self._analyze_bomb_defuse_highlights(
            planted_df, defused_df, target_player, match_start_tick, spatial_cache,
            round_freeze_end_ticks,
        )

        # spatial_cache 构建完成后，回填几何/速度/yaw 类击杀动作子标
        # （🫵 贴脸超度 / 👃 零距离 / 🚀 上去就是干 / 🏃‍♂️ 跑打 / 🎯 B 大穿点 /
        #  🌪️ 甩狙 / 🎿 一个大拉 / 🛸 乌鸦坐飞机）
        DemoAnalyzer._enrich_kill_action_tags_spatial(
            round_kills, spatial_cache, target_player,
        )

        round_target_kill_ticks: dict[int, list[int]] = {
            rn: sorted({_int(k["tick"]) for k in ks})
            for rn, ks in round_kills.items()
        }

        # ── 新增辅助事件 / 索引（供新标签使用） ─────────────
        # 1) player_blind：目标被闪事件（🚪 闪送）
        flash_on_target_index: list[tuple[int, float]] = []
        try:
            blind_df = self._safe_parse_event("player_blind")
            if not blind_df.empty and "user_name" in blind_df.columns:
                blind_df["user_name"] = blind_df["user_name"].astype(str).str.strip()
                bdf = blind_df.loc[blind_df["user_name"] == target_player]
                if match_start_tick > 0 and "tick" in bdf.columns:
                    bdf = bdf.loc[
                        pd.to_numeric(bdf["tick"], errors="coerce").fillna(0).astype(int)
                        >= match_start_tick
                    ]
                dur_col = None
                for _c in ("blind_duration", "duration"):
                    if _c in bdf.columns:
                        dur_col = _c
                        break
                for _, _br in bdf.iterrows():
                    _bt = _int(_br.get("tick"))
                    _bd = 0.0
                    if dur_col is not None:
                        try:
                            _bd = float(_br.get(dur_col) or 0.0)
                        except (TypeError, ValueError):
                            _bd = 0.0
                    if _bt > 0:
                        flash_on_target_index.append((_bt, _bd))
                flash_on_target_index.sort()
        except Exception:
            flash_on_target_index = []

        # 2) hegrenade / inferno / flashbang 爆点：🧲 吸铁石
        grenade_detonate_points: list[tuple[int, float, float]] = []
        for _ev in ("hegrenade_detonate", "inferno_startburn", "molotov_detonate"):
            try:
                _gdf = self._safe_parse_event(_ev)
                if _gdf.empty:
                    continue
                if match_start_tick > 0 and "tick" in _gdf.columns:
                    _gdf = _gdf.loc[
                        pd.to_numeric(_gdf["tick"], errors="coerce").fillna(0).astype(int)
                        >= match_start_tick
                    ]
                xcol = "x" if "x" in _gdf.columns else ("X" if "X" in _gdf.columns else None)
                ycol = "y" if "y" in _gdf.columns else ("Y" if "Y" in _gdf.columns else None)
                if xcol is None or ycol is None:
                    continue
                for _, _gr in _gdf.iterrows():
                    try:
                        grenade_detonate_points.append((
                            _int(_gr.get("tick")),
                            float(_gr.get(xcol)),
                            float(_gr.get(ycol)),
                        ))
                    except (TypeError, ValueError):
                        pass
            except Exception:
                pass
        grenade_detonate_points.sort()

        # 3) bomb_explode_tick_map / round_end_tick_map（🔔 极限操作）
        bomb_explode_tick_map: dict[int, int] = {}
        try:
            _be = self._safe_parse_event("bomb_exploded", other=list(_EXTRA_EVENT_FIELDS))
            if not _be.empty and "tick" in _be.columns and "total_rounds_played" in _be.columns:
                for _, _br in _be.iterrows():
                    _bt = _int(_br.get("tick"))
                    _rn = _int(_br.get("total_rounds_played")) + 1
                    if _bt > 0 and _rn > 0 and _rn not in bomb_explode_tick_map:
                        bomb_explode_tick_map[_rn] = _bt
        except Exception:
            pass

        round_end_tick_map: dict[int, int] = {}
        try:
            _re = self._safe_parse_event("round_end", other=list(_EXTRA_EVENT_FIELDS))
            if not _re.empty and "tick" in _re.columns:
                _seq = 0
                for _, _rr in _re.sort_values("tick", kind="mergesort").iterrows():
                    _rt = _int(_rr.get("tick"))
                    _trc = _rr.get("total_rounds_played")
                    if _trc is not None and not (isinstance(_trc, float) and pd.isna(_trc)):
                        try:
                            _rn = int(float(_trc))
                        except (ValueError, TypeError):
                            _seq += 1
                            _rn = _seq
                    else:
                        _seq += 1
                        _rn = _seq
                    if _rt > 0 and _rn > 0 and _rn not in round_end_tick_map:
                        round_end_tick_map[_rn] = _rt
        except Exception:
            pass

        # Some third-party demos can emit post-round player_death events on the same tick
        # as round_end (commonly knife kills during the transition). Do not count those as
        # target multi-kills, otherwise a real single kill can become a false "双杀".
        _transition_knife_highlight_kills: list[dict] = []
        for _rn, _kills in list(round_kills.items()):
            _round_end_tick = _int(round_end_tick_map.get(_rn))
            if _round_end_tick <= 0:
                continue
            _has_prior_valid_kill = any(_int(_k.get("tick")) < _round_end_tick for _k in _kills)
            _kept_kills: list[dict] = []
            for _k in _kills:
                _kt = _int(_k.get("tick"))
                _weapon = str(_k.get("weapon") or "")
                _is_end_tick_transition_knife = (
                    _kt == _round_end_tick
                    and _has_prior_valid_kill
                    and _is_knife_highlight_weapon(_weapon)
                )
                if _is_end_tick_transition_knife:
                    _knife_k = dict(_k)
                    _knife_k["_round"] = _rn
                    _transition_knife_highlight_kills.append(_knife_k)
                    continue
                _kept_kills.append(_k)
            if _kept_kills:
                round_kills[_rn] = _kept_kills
            else:
                round_kills.pop(_rn, None)
        if _transition_knife_highlight_kills:
            logger.info(
                "Detached round-end knife kills from multi-kill aggregation target=%r kills=%s",
                target_player,
                [
                    (_int(k.get("_round")), _int(k.get("tick")), str(k.get("victim") or ""), str(k.get("weapon") or ""))
                    for k in _transition_knife_highlight_kills
                ],
            )
        if _transition_knife_highlight_kills:
            round_target_kill_ticks = {
                rn: sorted({_int(k["tick"]) for k in ks})
                for rn, ks in round_kills.items()
            }

        # 4) defuse_window_map：begindefuse → defused，用于 💣 拆包开光
        defuse_window_map: dict[int, tuple[int, int]] = {}
        try:
            _bd = self._safe_parse_event("bomb_begindefuse", other=list(_EXTRA_EVENT_FIELDS))
            if not _bd.empty and "user_name" in _bd.columns:
                _bd["user_name"] = _bd["user_name"].astype(str).str.strip()
            if not _bd.empty and "tick" in _bd.columns and "total_rounds_played" in _bd.columns:
                _begin_map: dict[int, int] = {}
                for _, _br in _bd.iterrows():
                    _u = str(_br.get("user_name") or "")
                    if _u != target_player:
                        continue
                    _bt = _int(_br.get("tick"))
                    _rn = _int(_br.get("total_rounds_played")) + 1
                    if _bt > 0 and _rn > 0 and _rn not in _begin_map:
                        _begin_map[_rn] = _bt
                if not defused_df.empty and "tick" in defused_df.columns:
                    for _, _dr in defused_df.iterrows():
                        _u = str(_dr.get("user_name") or "")
                        if _u != target_player:
                            continue
                        _dt = _int(_dr.get("tick"))
                        # 找到对应回合
                        for _rn, _bt in _begin_map.items():
                            if 0 < _bt <= _dt and _rn not in defuse_window_map:
                                defuse_window_map[_rn] = (_bt, _dt)
                                break
        except Exception:
            pass

        # 5) prev_round_killers_of_target：每回合谁杀了目标 → 🧾 上回合的债
        prev_round_killers_of_target: dict[int, set[str]] = {}
        round_death_tick_map: dict[int, int] = {}
        for _dr in death_records:
            _rn = _int(_dr.get("round"))
            _atk = str(_dr.get("attacker") or "").strip()
            _dt = _int(_dr.get("tick"))
            if _rn > 0 and _atk and _atk != target_player:
                prev_round_killers_of_target.setdefault(_rn, set()).add(_atk)
            if _rn > 0 and _dt > 0:
                round_death_tick_map[_rn] = _dt

        # 6) teammate_hurt_victim_index：每个敌人被目标队友打过的 tick 列表 → ⚰️ 补枪
        teammate_hurt_victim_index: dict[str, list[int]] = {}
        if not hurt_df.empty and {"attacker_name", "user_name", "tick"}.issubset(hurt_df.columns):
            # 按回合取目标所在 team 判定队友；统一用 attacker_team / user_team 字段（若有）兜底
            team_col_a = "attacker_team" if "attacker_team" in hurt_df.columns else None
            team_col_u = "user_team" if "user_team" in hurt_df.columns else None
            for _, _hr in hurt_df.iterrows():
                _atk = str(_hr.get("attacker_name") or "").strip()
                _vic = str(_hr.get("user_name") or "").strip()
                if not _atk or not _vic or _atk == target_player or _atk == _vic:
                    continue
                # 仅保留"攻击者是目标队友"的命中
                if team_col_a is not None and team_col_u is not None:
                    try:
                        if _hr.get(team_col_a) != _hr.get(team_col_u):
                            # 攻击者与被害者不同队 → 可能是队友打敌人，符合"补枪"前置
                            # 需额外校验 attacker 与 target 同队；此处用 round_target_team_map 近似
                            _rn = _int(_hr.get("total_rounds_played")) + 1 if "total_rounds_played" in hurt_df.columns else 0
                            _tgt_team = round_target_team_map.get(_rn)
                            # 若解析不到回合团队信息，宽松处理：只要 attacker ≠ target 即保留
                            if _tgt_team is not None and _hr.get(team_col_a) != _tgt_team:
                                continue
                        else:
                            # 队友互伤（误伤），不算补枪前置
                            continue
                    except Exception:
                        pass
                teammate_hurt_victim_index.setdefault(_vic, []).append(_int(_hr.get("tick")))
        for _v in teammate_hurt_victim_index:
            teammate_hurt_victim_index[_v].sort()

        # 7) teammate_kills_per_round：每回合队友总击杀 → 🧹 清盘
        teammate_kills_per_round: dict[int, int] = {}
        if not events.empty:
            for _, _er in events.iterrows():
                _atk = str(_er.get("attacker_name") or "").strip()
                _vic = str(_er.get("user_name") or "").strip()
                if not _atk or _atk == _vic or _atk == target_player:
                    continue
                _rn = _int(_er.get("total_rounds_played")) + 1
                _tgt_team = round_target_team_map.get(_rn)
                _atk_team = _er.get("attackerteam")
                _vic_team = _er.get("userteam")
                # 攻击者与目标同队 且 与受害者不同队
                if _tgt_team is not None and _atk_team == _tgt_team and _atk_team != _vic_team:
                    teammate_kills_per_round[_rn] = teammate_kills_per_round.get(_rn, 0) + 1

        # 8) round_hurt_on_target_index：每回合目标受到的伤害事件 → 🪨 挨揍王
        round_hurt_on_target_index: dict[int, list[tuple[int, int, str]]] = {}
        if not hurt_df.empty and "user_name" in hurt_df.columns:
            for _, _hr in hurt_df.iterrows():
                if str(_hr.get("user_name") or "") != target_player:
                    continue
                _rn = _int(_hr.get("total_rounds_played")) + 1 if "total_rounds_played" in hurt_df.columns else 0
                if _rn <= 0:
                    continue
                _ht = _int(_hr.get("tick"))
                _hd = 0
                for _dc in ("dmg_health", "damage", "health_damage"):
                    if _dc in hurt_df.columns:
                        _hd = _int(_hr.get(_dc))
                        break
                _hw = _normalize_item(_hr.get("weapon", ""))
                round_hurt_on_target_index.setdefault(_rn, []).append((_ht, _hd, _hw))
        for _rn in round_hurt_on_target_index:
            round_hurt_on_target_index[_rn].sort()

        # ── 构建下饭片段 (基础规则 + 三大高级场景 + 新扩展) ─────────────
        fail_clips, fail_death_keys = self._build_fail_clips(
            target_player,
            death_records,
            equip_df,
            fire_df,
            hurt_df,
            spatial_cache,
            round_target_kill_ticks,
            round_team_score_map,
            round_result_map,
            round_freeze_end_ticks,
            flash_on_target_index=flash_on_target_index,
            grenade_detonate_points=grenade_detonate_points,
        )
        target_total_deaths = len(death_records)

        # round_death_tick_map 已在上文新上下文构建阶段生成

        # ── 聚合回合击杀 → 高光片段 ──────────────────────────
        highlight_clips: list[Clip] = []
        for rnd, kills in round_kills.items():
            if len(kills) < 2:
                continue

            kills_sorted = sorted(kills, key=lambda k: k["tick"])
            first_tick = kills_sorted[0]["tick"]
            last_tick = kills_sorted[-1]["tick"]
            tags = self._build_highlight_tags(
                kills_sorted,
                first_tick,
                last_tick,
                rnd,
                round_first_death_tick,
                spatial_cache,
                target_player,
                round_economy_map,
                round_target_team_map.get(rnd),
                round_team_score_map.get(rnd),
                round_won=round_result_map.get(rnd),
                round_end_tick_map=round_end_tick_map,
                bomb_explode_tick_map=bomb_explode_tick_map,
                prev_round_killers_of_target=prev_round_killers_of_target,
                teammate_hurt_victim_index=teammate_hurt_victim_index,
                teammate_kills_per_round=teammate_kills_per_round,
                round_hurt_on_target_index=round_hurt_on_target_index,
                round_death_tick_map=round_death_tick_map,
                defuse_window_map=defuse_window_map,
            )

            # === 胜负语义过滤：输了的回合移除"翻盘/破局/赛点"类标签 ===
            if round_result_map.get(rnd) is False:
                # 这些标签需要"赢得本回合"才有叙事意义；输了保留只会产生语义矛盾
                _WIN_ONLY_TAGS = frozenset({
                    "💸 ECO翻盘",
                    "🛡️ 赛点救世主", "命悬一线",
                    "📈 绝地追分", "拒绝下班",
                    "🗡️ 赛点终结者", "一锤定音",
                    "⚔️ 加时生死战", "大心脏",
                    "🔥 3v5 绝地反击",
                })
                _WIN_ONLY_PREFIXES = ("🔥 1v", "🔥 2v")
                tags = [
                    t for t in tags
                    if t not in _WIN_ONLY_TAGS
                    and not any(t.startswith(p) for p in _WIN_ONLY_PREFIXES)
                ]
            # ===================================================

            # === [核心新增] 平庸双杀过滤器 ===
            if len(kills_sorted) == 2:
                # 凡是仅仅只拥有以下基础/平庸标签的双杀，都不配作为高光，强制 3 杀起步！
                boring_tags = {
                    "双杀", "爆头", "枪枪爆头", "⚔️ 破局首杀",
                    "🔥 顺风局战神", "无情碾压",
                    # "💥 颗秒" 已移出：精准双杀本身就是高光，不应被过滤
                }
                # 如果这个双杀片段里的所有标签都在 boring_tags 里，说明没有任何节目效果，直接过滤掉
                if all(t in boring_tags for t in tags):
                    continue
            # =================================

            victims_list = [str(k.get("victim") or "") for k in kills_sorted]
            kill_ticks_sorted = sorted({_int(k["tick"]) for k in kills_sorted})
            so, se = DemoAnalyzer._round_start_scores_for_target(
                rnd, round_team_score_map,
            )

            # 虽败犹荣：仅当片段携带了明确的"虽败犹荣"叙事标签时，才将 end_tick
            # 延伸到玩家死亡时刻 + 3s，呈现完整的悲剧结局弧线。
            # 普通高光（如颗秒）在输了的回合也不应无缘无故录下死亡画面。
            _rnd_death_tick = round_death_tick_map.get(rnd)
            _clip_end_tick = last_tick + BUFFER_SECONDS_AFTER * TICK_RATE
            _NICE_TRY_TAGS_SET = frozenset({
                "😤 1v2 饮恨",
                "💸 ECO反击 (差点成了)",
                "🛡️ 赛点失守",
                "📉 绝地追分未果",
                "⛰️ 天王山饮恨",
            })
            _has_nice_try = any(
                t in _NICE_TRY_TAGS_SET or t.startswith("💀 1v")
                for t in tags
            )
            if (_rnd_death_tick is not None
                    and _rnd_death_tick > last_tick
                    and round_result_map.get(rnd) is False
                    and _has_nice_try):
                _clip_end_tick = max(_clip_end_tick,
                                     _rnd_death_tick + int(3.0 * TICK_RATE))

            highlight_clips.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                round=rnd,
                category="highlight",
                weapon_used=_highlight_weapon_used_label(kills_sorted),
                kill_count=len(kills_sorted),
                start_tick=max(0, first_tick - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=_clip_end_tick,
                context_tags=_dedup_context_tags(tags),
                victims=victims_list,
                kill_ticks=kill_ticks_sorted,
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(rnd),
                clip_min_tick=round_freeze_end_ticks.get(rnd),
                death_tick=_rnd_death_tick,
            ))

        # ── 刀杀：单回合仅 1 杀且为刀时强制提取（≥2 杀已由多杀高光覆盖）──
        for rnd, kills in round_kills.items():
            if len(kills) >= 2:
                continue
            for k in kills:
                if not _is_knife_highlight_weapon(str(k.get("weapon") or "")):
                    continue
                kt = _int(k.get("tick"))
                vic = str(k.get("victim") or "")
                wpn = str(k.get("weapon") or "")
                so, se = DemoAnalyzer._round_start_scores_for_target(
                    rnd, round_team_score_map,
                )
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    round=rnd,
                    category="highlight",
                    weapon_used=_translate_weapon(wpn),
                    kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                    context_tags=["🔪 刀杀"],
                    victims=[vic] if vic else [],
                    kill_ticks=[kt],
                    score_own=so,
                    score_opp=se,
                    round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd),
                ))
        for k in _transition_knife_highlight_kills:
            rnd = _int(k.get("_round"))
            if rnd <= 0:
                continue
            kt = _int(k.get("tick"))
            vic = str(k.get("victim") or "")
            wpn = str(k.get("weapon") or "")
            so, se = DemoAnalyzer._round_start_scores_for_target(
                rnd, round_team_score_map,
            )
            highlight_clips.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                round=rnd,
                category="highlight",
                weapon_used=_translate_weapon(wpn),
                kill_count=1,
                start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                context_tags=["🔪 刀杀"],
                victims=[vic] if vic else [],
                kill_ticks=[kt],
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(rnd),
                clip_min_tick=round_freeze_end_ticks.get(rnd),
            ))

        # ── 跳杀：单回合仅 1 杀且检测到跳跃击杀时强制提取（已有刀杀/多杀高光的回合跳过）──
        _single_clip_rounds = {c.round for c in highlight_clips}
        for rnd, kills in round_kills.items():
            if len(kills) >= 2 or rnd in _single_clip_rounds:
                continue
            for k in kills:
                kt = _int(k.get("tick"))
                if not DemoAnalyzer._is_jump_kill(spatial_cache, kt, target_player):
                    continue
                wpn = str(k.get("weapon") or "")
                vic = str(k.get("victim") or "")
                # 组装标签：跳杀主标 + 动作子标（穿烟/穿墙/盲打等）
                _jump_ctx: list[str] = ["🪂 跳杀"]
                for _t in k.get("tags", []):
                    if _t != "爆头" and _t not in _jump_ctx:
                        _jump_ctx.append(_t)
                if k.get("headshot"):
                    _jump_ctx.append("爆头")
                # 跳杀同时是一发爆头颗秒 → 双重高光标签
                _jk_w = str(k.get("weapon") or "").strip()
                _jk_shots = _int(k.get("shots_to_kill"), 0)
                if (_bool(k.get("headshot")) and _jk_w in _KEQIAO_WEAPONS
                        and (_jk_shots == 1 or (_jk_shots == 0 and _jk_w in DEAGLE_VARIANTS))):
                    _jump_ctx.append("💥 颗秒")
                    if _bool(k.get("victim_had_awp")) and DemoAnalyzer._victim_facing_attacker(
                        spatial_cache.get(kt), target_player, vic,
                    ):
                        _jump_ctx.append("🔪 手撕大狙")
                so, se = DemoAnalyzer._round_start_scores_for_target(rnd, round_team_score_map)
                _rnd_dt = round_death_tick_map.get(rnd)
                _end = kt + BUFFER_SECONDS_AFTER * TICK_RATE
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    round=rnd,
                    category="highlight",
                    weapon_used=_translate_weapon(wpn),
                    kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=_end,
                    context_tags=_dedup_context_tags(_jump_ctx),
                    victims=[vic] if vic else [],
                    kill_ticks=[kt],
                    score_own=so,
                    score_opp=se,
                    round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd),
                    death_tick=_rnd_dt,
                ))
                break  # 该回合只有 1 杀，内层循环直接结束

        # ── 颗秒：单杀 + 极度苛刻精准一发爆头 → 强制提取高光 ──
        # 沙鹰/左轮/步枪系 shots_to_kill == 1 且 headshot，属于顶级操作力单杀展示
        # 已被刀杀/跳杀/多杀覆盖的回合直接跳过（不重复生成）
        _keqiao_covered = {c.round for c in highlight_clips}
        for rnd, kills in round_kills.items():
            if len(kills) >= 2 or rnd in _keqiao_covered:
                continue
            for k in kills:
                _kq_w = str(k.get("weapon") or "").strip()
                _kq_hs = _bool(k.get("headshot"))
                _kq_shots = _int(k.get("shots_to_kill"), 0)
                if not _kq_hs or _kq_w not in _KEQIAO_WEAPONS:
                    continue
                # 极度苛刻：必须 shots_to_kill == 1（纯一发带走）
                # Deagle/左轮在无 weapon_fire 数据（shots == 0）时降级为「爆头即算」
                _kq_one_tap = (_kq_shots == 1) or (_kq_shots == 0 and _kq_w in DEAGLE_VARIANTS)
                if not _kq_one_tap:
                    continue
                kt = _int(k.get("tick"))
                vic = str(k.get("victim") or "")
                _kq_ctx: list[str] = ["💥 颗秒", "爆头"]
                if _bool(k.get("victim_had_awp")) and DemoAnalyzer._victim_facing_attacker(
                    spatial_cache.get(kt), target_player, vic,
                ):
                    _kq_ctx.append("🔪 手撕大狙")
                for _t in k.get("tags", []):
                    if _t not in _kq_ctx:
                        _kq_ctx.append(_t)
                so, se = DemoAnalyzer._round_start_scores_for_target(rnd, round_team_score_map)
                _rnd_dt = round_death_tick_map.get(rnd)
                _end = kt + BUFFER_SECONDS_AFTER * TICK_RATE
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    round=rnd,
                    category="highlight",
                    weapon_used=_translate_weapon(_kq_w),
                    kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=_end,
                    context_tags=_dedup_context_tags(_kq_ctx),
                    victims=[vic] if vic else [],
                    kill_ticks=[kt],
                    score_own=so,
                    score_opp=se,
                    round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd),
                    death_tick=_rnd_dt,
                ))
                break  # 单杀回合只处理第一个命中的 kill

        rounds_with_kill_highlight = {c.round for c in highlight_clips}
        bomb_round_defuse_ticks: dict[int, int] = {bh["round"]: bh["defuse_tick"] for bh in bomb_highlights}
        merged_highlights: list[Clip] = []
        for c in highlight_clips:
            extra_tags: list[str] = []
            defuse_tick = bomb_round_defuse_ticks.get(c.round)
            new_start = c.start_tick
            new_end = c.end_tick
            for bh in bomb_highlights:
                if bh["round"] == c.round:
                    extra_tags.extend(bh["tags"])
                    if defuse_tick is None or bh["defuse_tick"] < defuse_tick:
                        defuse_tick = bh["defuse_tick"]
            if extra_tags:
                if defuse_tick is not None:
                    new_start = min(c.start_tick, defuse_tick - BUFFER_SECONDS_BEFORE * TICK_RATE)
                    new_end = max(c.end_tick, defuse_tick + BUFFER_SECONDS_AFTER * TICK_RATE)
                merged_highlights.append(
                    replace(
                        c,
                        start_tick=new_start,
                        end_tick=new_end,
                        context_tags=_dedup_context_tags(
                            DemoAnalyzer._extend_tags_unique(c.context_tags, extra_tags),
                        ),
                    ),
                )
            else:
                merged_highlights.append(c)
        for bh in bomb_highlights:
            if bh["round"] in rounds_with_kill_highlight:
                continue
            so, se = DemoAnalyzer._round_start_scores_for_target(
                bh["round"], round_team_score_map,
            )
            merged_highlights.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                round=bh["round"],
                category="highlight",
                weapon_used=_translate_weapon("defuse_kit"),
                kill_count=0,
                start_tick=max(0, bh["defuse_tick"] - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=bh["defuse_tick"] + BUFFER_SECONDS_AFTER * TICK_RATE,
                context_tags=list(bh["tags"]),
                killer_name=None,
                victims=[],
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(bh["round"]),
                clip_min_tick=round_freeze_end_ticks.get(bh["round"]),
            ))
        highlight_clips = merged_highlights

        # 旧版会为 0/1/2 杀的特殊战绩额外生成 meme_death 研发合集。
        # 现在通用 compilation_kind="all_deaths" 已覆盖“全部死亡合集”，避免重复放出两套合集。
        meme_clips: list[Clip] = []

        # ── 肩并肩（Shoulder-to-Shoulder）下饭片段 ──
        shoulder_clips = self._detect_shoulder_clips(
            spatial_cache=spatial_cache,
            target_player=target_player,
            round_freeze_end_ticks=round_freeze_end_ticks,
            round_result_map=round_result_map,
            round_team_score_map=round_team_score_map,
            round_death_tick_map=round_death_tick_map,
        )
        fail_clips = fail_clips + shoulder_clips

        # ── 跨回合合集片段（🥩 亲儿子喂饭 / ☠️ 本命苦主）──
        compilation_clips = self._build_rival_compilations(
            target_player,
            round_kills,
            death_records,
            round_team_score_map,
            round_result_map,
            round_freeze_end_ticks,
        )

        clips = fail_clips + highlight_clips + meme_clips + compilation_clips
        _done_rounds, _final_line = DemoAnalyzer._match_metrics_from_round_scores(
            round_team_score_map,
        )
        clips = [
            c for c in clips
            if not DemoAnalyzer._is_post_match_round(
                c.round,
                c.score_own,
                c.score_opp,
                completed_rounds=_done_rounds,
                final_scoreline=_final_line,
            )
        ]
        clips.sort(key=lambda c: (c.round, c.start_tick))

        # 批量填充 clip_max_tick：本回合 demo 可安全录制的最晚 tick。
        # 超过此点 CS2 进入比赛结算界面，渲染器单向锁定，即使 demo_gototick 倒退也无法恢复画面。
        #
        # 策略：
        #   - 最后一回合：round_end 事件在最后击杀后数秒才 fire（比赛庆典动画），
        #     但结算界面在「最后一击」那一刻就出现，所以不能用 round_end_tick。
        #     改为：clip.kill_ticks[-1]（或 death_tick）+ 小缓冲（默认 0.5s），
        #     刚好能看到击杀动画但在结算界面出现前截断。
        #   - 非最后回合：回合间歇 5-7s，结算界面不出现，
        #     使用 round_end_tick + 宽松缓冲（默认 3.0s）。
        #   - fallback（无 kill_ticks/death_tick 时）：round_end_tick + 负偏移（默认 -3.0s）。
        _re_offset_last_ticks = int(float(
            os.environ.get("CS2_INSIGHT_LAST_ROUND_END_OFFSET_SEC", "-3.0") or "-3.0"
        ) * TICK_RATE)
        _re_buf_mid_ticks = int(float(
            os.environ.get("CS2_INSIGHT_MID_ROUND_END_BUFFER_SEC", "3.0") or "3.0"
        ) * TICK_RATE)

        _round_end_evt_tick_map: dict[int, int] = {}
        try:
            _re_df = self._safe_parse_event("round_end", other=["total_rounds_played"])
            if not _re_df.empty and "tick" in _re_df.columns:
                if match_start_tick > 0:
                    _re_df = _re_df[
                        pd.to_numeric(_re_df["tick"], errors="coerce")
                        .fillna(0).astype(int) >= match_start_tick
                    ]
                _re_df = _re_df.sort_values("tick", kind="mergesort")
                _re_seq = 0
                for _, _re_row in _re_df.iterrows():
                    _re_t = int(pd.to_numeric(_re_row.get("tick"), errors="coerce") or 0)
                    if _re_t <= 0:
                        continue
                    _trc = _re_row.get("total_rounds_played")
                    if _trc is not None:
                        try:
                            # total_rounds_played 在 round_end 触发时已是「已完成N回合」(1-indexed)
                            # round 1 结束时 = 1，故直接使用，无需 +1
                            _re_rn = int(float(_trc))
                        except (ValueError, TypeError):
                            _re_seq += 1
                            _re_rn = _re_seq
                    else:
                        _re_seq += 1
                        _re_rn = _re_seq
                    _round_end_evt_tick_map[_re_rn] = _re_t
        except Exception:
            pass

        # fallback：若 round_end 事件不可用，用 next_freeze_end - 5s 估算
        if not _round_end_evt_tick_map and round_freeze_end_ticks:
            _sorted_rnds = sorted(round_freeze_end_ticks.keys())
            for _i, _rn in enumerate(_sorted_rnds):
                if _i + 1 < len(_sorted_rnds):
                    _round_end_evt_tick_map[_rn] = (
                        round_freeze_end_ticks[_sorted_rnds[_i + 1]] - int(5 * TICK_RATE)
                    )
                else:
                    _round_end_evt_tick_map[_rn] = (
                        round_freeze_end_ticks[_rn] + int(30 * TICK_RATE)
                    )

        _last_rnd_num = max(_round_end_evt_tick_map.keys()) if _round_end_evt_tick_map else None
        # 最后一回合：结算界面在「最后击杀」帧同时出现，与 round_end 事件无关。
        # round_end 在击杀后数秒才 fire（比赛庆典动画），用 round_end_tick 做基准永远不准。
        # 改为：用 clip 自身的最后击杀/死亡 tick 作为 clip_max_tick 上限（不加正缓冲）。
        # 正缓冲会让录制越过结算 tick，且 POV 段切换时 demo 可能滑入结算状态导致黑屏。
        # CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC = 相对最后击杀 tick 的偏移（秒）。
        # 默认 0.5：允许看到击杀后 0.5s 的画面；demo_pause 注入兜底保证不会长时间停留在结算界面。
        # 如果仍然进入结算界面，可将此值调小（如 0.0 或 -0.3）；若 POV 截断太早则调大。
        _last_kill_buf_ticks = int(float(
            os.environ.get("CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC", "0.45") or "0.45"
        ) * TICK_RATE)

        logger.info(
            "[clip_max_tick] round_end_evt_tick_map rounds=%s last_rnd=%s",
            sorted(_round_end_evt_tick_map.keys()),
            _last_rnd_num,
        )
        for _c in clips:
            if _c.clip_max_tick is not None:
                pass  # 已由外部设置，跳过
            elif _c.category == "compilation":
                pass
            elif _c.round == _last_rnd_num:
                # 最后一回合：以该 clip 自身的最后击杀/死亡 tick 为基准
                if _c.kill_ticks:
                    _last_evt_tick = max(_c.kill_ticks)
                elif _c.death_tick is not None:
                    _last_evt_tick = _c.death_tick
                else:
                    # 无精确事件 tick，回退到 round_end 事件 tick + 负偏移
                    _re_t = _round_end_evt_tick_map.get(_c.round, 0)
                    _last_evt_tick = _re_t + _re_offset_last_ticks if _re_t else None
                if _last_evt_tick:
                    _c.clip_max_tick = _last_evt_tick + _last_kill_buf_ticks
            elif _c.round in _round_end_evt_tick_map:
                # 非最后回合：round_end_tick + 宽松缓冲（不存在结算界面问题）
                _round_end_tick = _round_end_evt_tick_map[_c.round]
                _next_freeze_tick = _int(round_freeze_end_ticks.get(_c.round + 1))
                _round_end_limit = _round_end_tick + _re_buf_mid_ticks
                _clip_limit = _round_end_limit
                if _c.kill_ticks:
                    _last_kill_tick = max(_c.kill_ticks)
                    if _last_kill_tick > _round_end_tick:
                        if _next_freeze_tick > _round_end_tick:
                            _clip_limit = _next_freeze_tick
                            logger.info(
                                "[clip_max_tick] post-round kill window round=%s round_end=%s next_freeze=%s window_sec=%.3f last_kill=%s",
                                _c.round,
                                _round_end_tick,
                                _next_freeze_tick,
                                (_next_freeze_tick - _round_end_tick) / float(TICK_RATE),
                                _last_kill_tick,
                            )
                        else:
                            _clip_limit = max(
                                _clip_limit,
                                _last_kill_tick + int(BUFFER_SECONDS_AFTER * TICK_RATE),
                            )
                if _next_freeze_tick > _round_end_tick:
                    _clip_limit = min(_clip_limit, _next_freeze_tick)
                _c.clip_max_tick = _clip_limit
                if _c.end_tick > _c.clip_max_tick:
                    _c.end_tick = _c.clip_max_tick
            logger.info(
                "[clip_max_tick] clip_id=%s round=%s last_evt_tick=%s clip_max_tick=%s (last_rnd=%s)",
                _c.clip_id,
                _c.round,
                max(_c.kill_ticks) if _c.kill_ticks else _c.death_tick,
                _c.clip_max_tick,
                _c.round == _last_rnd_num,
            )

        team_a_score, team_b_score, match_date, duration_mins = self._build_match_summary(
            match_start_tick,
        )

        name_to_uid = build_player_name_to_user_id(self.parser, match_start_tick)
        roster_tick = (
            match_start_tick
            if match_start_tick > 0
            else max(1, _int(events["tick"].min()) if events.shape[0] > 0 and "tick" in events.columns else 1)
        )
        observed_user_ids = tuple(name_to_uid.values())
        event_user_id = _lookup_user_id_for_name(name_to_uid, target_player)
        target_player_user_id = _spec_player_slot_from_event_user_id(
            event_user_id,
            self.dem_path,
            observed_user_ids,
        )
        if target_player_user_id is None:
            spec_slots = build_player_name_to_spec_player_slot_dict(self.parser, roster_tick, self.dem_path)
            target_player_user_id = lookup_spec_player_slot_for_name(spec_slots, target_player)
        name_to_sid = build_player_name_to_steam_id(self.parser, match_start_tick)
        tsid = _lookup_steam_id_for_name(name_to_sid, target_player)
        target_steam_id = str(tsid) if tsid is not None else None

        total_rounds = max(round_kills.keys(), default=0)
        if events.shape[0] > 0:
            total_rounds = max(total_rounds, _int(events["total_rounds_played"].max()) + 1)
        rounds_by_wins = team_a_score + team_b_score
        if rounds_by_wins > 0:
            total_rounds = rounds_by_wins

        return ParseResult(
            match_meta=MatchMeta(
                map_name=map_name,
                target_player=target_player,
                total_rounds=total_rounds,
                target_player_user_id=target_player_user_id,
                target_steam_id=target_steam_id,
                target_kills=target_total_kills,
                target_deaths=target_total_deaths,
                team_a_score=team_a_score,
                team_b_score=team_b_score,
                match_date=match_date,
                duration_mins=duration_mins,
                meme_series_badges=meme_series_badges_for_kd(target_total_kills, target_total_deaths),
            ),
            clips=clips,
        )

    # ────────────────────────────────────────────────────────────
    #  肩并肩（Shoulder-to-Shoulder）下饭检测
    # ────────────────────────────────────────────────────────────
    def _detect_shoulder_clips(
        self,
        *,
        spatial_cache: "dict[int, pd.DataFrame]",
        target_player: str,
        round_freeze_end_ticks: dict[int, int],
        round_result_map: "dict[int, bool | None]",
        round_team_score_map: dict,
        round_death_tick_map: dict[int, int],
    ) -> "list[Clip]":
        """
        检测「我与敌人肩并肩」场景：目标玩家与敌方玩家在某一段时间内持续近距离
        共处（≤60 units，约两个身位紧贴）且双方均存活，属于节目效果极强的"下饭"情节。

        典型案例：
        - 双方同处一颗烟雾弹内而互相未觉察
        - Nuke 死门 / 犄角旮旯等小空间各自偷懒
        - chopper vs teses 名场面（肩膀贴肩膀长时间共存）

        检测方法：利用已合并进 spatial_cache 的全场 1s 采样点，逐回合扫描。
        若连续 ≥ _SHOULDER_MIN_SECS 秒的采样均满足距离条件，则生成片段。
        每回合只生成一个片段（选持续时间最长的窗口）。
        """
        clips: list[Clip] = []
        if not round_freeze_end_ticks:
            return clips

        sorted_rounds = sorted(round_freeze_end_ticks.keys())

        for i, rnd in enumerate(sorted_rounds):
            freeze_start = round_freeze_end_ticks[rnd]
            # 本回合的近似结束 tick：下一回合冻结开始前 5 秒（排除开枪庆祝阶段）
            if i + 1 < len(sorted_rounds):
                round_end = round_freeze_end_ticks[sorted_rounds[i + 1]] - int(5 * TICK_RATE)
            else:
                round_end = freeze_start + int(150 * TICK_RATE)

            # 用于记录"最长"肩并肩窗口
            best_start: int | None = None
            best_end:   int | None = None
            best_enemy: str | None = None
            best_min_dist: float   = float("inf")

            # 当前窗口状态
            cur_start: int | None  = None
            cur_enemy: str | None  = None
            cur_min_dist: float    = float("inf")

            tick = freeze_start
            while tick < round_end:
                snap = spatial_cache.get(tick)
                if snap is None or snap.empty:
                    # 当前采样点缺数据 → 重置窗口
                    cur_start = None
                    tick += _SHOULDER_SAMPLE_INTERVAL
                    continue

                tgt_row = DemoAnalyzer._spatial_player_row(snap, target_player)
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

                # 找最近的存活敌人
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
                            continue  # 队友，跳过
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
                        # 新窗口开始（或换了敌人）
                        cur_start    = tick
                        cur_enemy    = closest_name
                        cur_min_dist = closest_dist
                    else:
                        cur_min_dist = min(cur_min_dist, closest_dist)

                    # 检查是否超过最短有效时长
                    if (tick - cur_start) >= int(_SHOULDER_MIN_SECS * TICK_RATE):
                        # 更新最长窗口记录
                        if best_start is None or (tick - cur_start) > (best_end - best_start):  # type: ignore[operator]
                            best_start    = cur_start
                            best_end      = tick
                            best_enemy    = cur_enemy
                            best_min_dist = cur_min_dist
                else:
                    # 距离超出阈值 → 重置当前窗口
                    cur_start = None
                    cur_enemy = None

                tick += _SHOULDER_SAMPLE_INTERVAL

            if best_start is None:
                continue  # 本回合无有效肩并肩事件

            # 生成下饭片段
            duration_secs = (best_end - best_start) / TICK_RATE  # type: ignore[operator]
            so, se = DemoAnalyzer._round_start_scores_for_target(rnd, round_team_score_map)
            death_tick = round_death_tick_map.get(rnd)

            ctx_tags = ["🧍 肩并肩", "🙈 视而不见"]
            if best_enemy:
                ctx_tags.append(f"👫 同框: {best_enemy}")
            if duration_secs >= 4.0:
                ctx_tags.append(f"⏳ 持续 {duration_secs:.1f}s")

            clips.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
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

    # ────────────────────────────────────────────────────────────
    #  合集片段（compilation）：跨回合、同敌人聚合
    # ────────────────────────────────────────────────────────────
    def _build_rival_compilations(
        self,
        target_player: str,
        round_kills: dict[int, list[dict]],
        death_records: list[dict],
        round_team_score_map: dict[int, tuple[int, int]],
        round_result_map: dict[int, bool],
        round_freeze_end_ticks: dict[int, int],
    ) -> list[Clip]:
        """合集片段：
        - 🥩 亲儿子喂饭：本局击杀同一敌人 ≥ 8 次 → 把所有对该敌人的击杀拼为合集 clip
        - ☠️ 本命苦主：本局被同一敌人击杀 ≥ 3 次 → 把所有被他杀的死亡拼为合集 clip

        合集 clip 的 `source_ticks` 记录每个子片段的 [start,end]，导播按此列表串剪。
        `start_tick`/`end_tick` 覆盖全域以方便上层判空，实际剪辑以 `source_ticks` 为准。"""
        compilations: list[Clip] = []
        _done_rounds, _final_line = DemoAnalyzer._match_metrics_from_round_scores(
            round_team_score_map,
        )

        _last_compilation_event_buf_ticks = int(float(
            os.environ.get("CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC", "0.45") or "0.45"
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

        all_target_kills: list[tuple[int, int, str]] = []
        for rnd, kills in round_kills.items():
            for k in kills:
                kt = _int(k.get("tick"))
                victim = str(k.get("victim") or "").strip()
                if kt <= 0 or not victim:
                    continue
                if DemoAnalyzer._is_post_match_round(
                    rnd,
                    *DemoAnalyzer._round_start_scores_for_target(rnd, round_team_score_map),
                    completed_rounds=_done_rounds,
                    final_scoreline=_final_line,
                ):
                    continue
                all_target_kills.append((rnd, kt, victim))
        all_target_kills.sort(key=lambda item: (item[1], item[0], item[2]))

        all_target_deaths: list[tuple[int, int, str]] = []
        for d in death_records:
            rn = _int(d.get("round"))
            dt = _int(d.get("tick"))
            attacker = str(d.get("attacker") or "").strip()
            if rn <= 0 or dt <= 0 or not attacker or attacker == target_player:
                continue
            if DemoAnalyzer._is_post_match_round(
                rn,
                *DemoAnalyzer._round_start_scores_for_target(rn, round_team_score_map),
                completed_rounds=_done_rounds,
                final_scoreline=_final_line,
            ):
                continue
            all_target_deaths.append((rn, dt, attacker))
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
            items = [
                (rn, kt)
                for rn, kt in items
                if not DemoAnalyzer._is_post_match_round(
                    rn,
                    *DemoAnalyzer._round_start_scores_for_target(rn, round_team_score_map),
                    completed_rounds=_done_rounds,
                    final_scoreline=_final_line,
                )
            ]
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
            items = [
                (rn, dt)
                for rn, dt in items
                if not DemoAnalyzer._is_post_match_round(
                    rn,
                    *DemoAnalyzer._round_start_scores_for_target(rn, round_team_score_map),
                    completed_rounds=_done_rounds,
                    final_scoreline=_final_line,
                )
            ]
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
            first_rnd, first_t, _ = all_target_kills[0]
            _last_rnd, last_t, _ = all_target_kills[-1]
            source_ticks = [
                _segment_around_tick(kt, round_num=rn)
                for rn, kt, _ in all_target_kills
            ]
            victims = [victim for _, _, victim in all_target_kills]
            compilations.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                round=first_rnd,
                category="compilation",
                weapon_used="",
                kill_count=len(all_target_kills),
                start_tick=source_ticks[0][0],
                end_tick=source_ticks[-1][1],
                context_tags=["🎬 全部击杀", f"🎯 {target_player} × {len(all_target_kills)}"],
                killers=[target_player] * len(all_target_kills),
                victims=victims,
                kill_ticks=[kt for _, kt, _ in all_target_kills],
                round_won=round_result_map.get(first_rnd),
                clip_min_tick=round_freeze_end_ticks.get(first_rnd),
                source_ticks=source_ticks,
                source_rounds=[rn for rn, _, _ in all_target_kills],
                compilation_kind="all_kills",
            ))

        if all_target_deaths:
            first_rnd, first_t, _ = all_target_deaths[0]
            _last_rnd, last_t, _ = all_target_deaths[-1]
            source_ticks = [
                _segment_around_tick(dt, round_num=rn, lead_seconds=float(_DEATH_CLIP_LEAD_SECONDS))
                for rn, dt, _ in all_target_deaths
            ]
            killers = [attacker for _, _, attacker in all_target_deaths]
            compilations.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                round=first_rnd,
                category="compilation",
                weapon_used="",
                kill_count=0,
                start_tick=source_ticks[0][0],
                end_tick=source_ticks[-1][1],
                context_tags=["💀 全部死亡", f"☠️ {target_player} × {len(all_target_deaths)}"],
                killer_name=None,
                killers=killers,
                victims=[target_player] * len(all_target_deaths),
                kill_ticks=[dt for _, dt, _ in all_target_deaths],
                round_won=round_result_map.get(first_rnd),
                clip_min_tick=round_freeze_end_ticks.get(first_rnd),
                source_ticks=source_ticks,
                source_rounds=[rn for rn, _, _ in all_target_deaths],
                compilation_kind="all_deaths",
            ))

        return compilations

    # ────────────────────────────────────────────────────────────
    #  下饭片段总装配 (基础 + 三大高级场景)
    # ────────────────────────────────────────────────────────────
    def _build_fail_clips(
        self,
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
        flash_on_target_index: Optional[list[tuple[int, float]]] = None,
        grenade_detonate_points: Optional[list[tuple[int, float, float]]] = None,
    ) -> tuple[list[Clip], set[tuple[int, int]]]:

        # ── 预构建索引 (只遍历一次, 后续二分查找) ─────────────
        equip_timeline = self._build_equip_timeline(target_player, equip_df)
        fire_index = self._build_fire_index(target_player, fire_df)
        hurt_index = self._build_hurt_index(target_player, hurt_df)

        clips: list[Clip] = []
        fail_death_keys: set[tuple[int, int]] = set()

        for death in death_records:
            backstab_tags = self._check_backstab_fail(
                death,
                fire_index,
                hurt_index,
                spatial_cache,
                target_player,
                round_target_kill_ticks,
            )
            if backstab_tags:
                so, se = DemoAnalyzer._round_start_scores_for_target(
                    death["round"], round_team_score_map,
                )
                clips.append(self._make_clip(
                    round_num=death["round"],
                    category="fail",
                    weapon=death["weapon"],
                    kill_count=0,
                    tick=death["tick"],
                    tags=backstab_tags,
                    killer_name=DemoAnalyzer._fail_killer_display_name(death, target_player),
                    death_core=True,
                    score_own=so,
                    score_opp=se,
                    round_won=round_result_map.get(death["round"]),
                    clip_min_tick=round_freeze_end_ticks.get(death["round"]),
                ))
                fail_death_keys.add((death["round"], death["tick"]))
                continue

            tags: list[str] = []

            # ① 基础下饭规则
            tags.extend(self._detect_fail_tags(
                weapon=death["weapon"],
                headshot=death["headshot"],
                attacker=death["attacker"],
                victim=target_player,
                attacker_team=death["attacker_team"],
                victim_team=death["victim_team"],
                attackerblind=death["attackerblind"],
                assistedflash=death["assistedflash"],
            ))

            # ② CS定律 / 切道具就死
            tags.extend(self._check_timing_law(death, equip_timeline))

            # ③ 人肉吸铁石 / 越过山丘来爆头
            if death["headshot"] and spatial_cache:
                tags.extend(self._check_human_magnet(
                    death, target_player, spatial_cache,
                ))

            # ④ 人体描边大师
            tags.extend(self._check_outline_master(
                death, fire_index, hurt_index, round_target_kill_ticks,
            ))

            # ⑤ 僵尸步 / 散步流 / 吸铁石 / 闪送（新增下饭扩展）
            if spatial_cache:
                tags.extend(DemoAnalyzer._check_zombie_step(
                    death, spatial_cache, target_player,
                ))
                tags.extend(DemoAnalyzer._check_stroll(
                    death, spatial_cache, target_player,
                ))
                tags.extend(DemoAnalyzer._check_magnet_nade(
                    death, spatial_cache, target_player, grenade_detonate_points,
                ))
            tags.extend(DemoAnalyzer._check_flash_send(death, flash_on_target_index))

            # 去重 (保持顺序)
            seen: set[str] = set()
            unique_tags = [t for t in tags if not (t in seen or seen.add(t))]  # type: ignore[func-returns-value]

            if unique_tags:
                so, se = DemoAnalyzer._round_start_scores_for_target(
                    death["round"], round_team_score_map,
                )
                clips.append(self._make_clip(
                    round_num=death["round"],
                    category="fail",
                    weapon=death["weapon"],
                    kill_count=0,
                    tick=death["tick"],
                    tags=unique_tags,
                    killer_name=DemoAnalyzer._fail_killer_display_name(death, target_player),
                    death_core=True,
                    score_own=so,
                    score_opp=se,
                    round_won=round_result_map.get(death["round"]),
                    clip_min_tick=round_freeze_end_ticks.get(death["round"]),
                ))
                fail_death_keys.add((death["round"], death["tick"]))

        return clips, fail_death_keys

    # ────────────────────────────────────────────────────────────
    #  场景一: CS定律 / 切道具就死
    # ────────────────────────────────────────────────────────────

    @staticmethod
    def _build_equip_timeline(
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

    @staticmethod
    def _check_timing_law(
        death: dict,
        equip_timeline: list[tuple[int, str]],
    ) -> list[str]:
        """
        判定: 架枪 ≥10s → 切刀/投掷物 → 1.5s 内被杀。
        使用 bisect 在有序 equip_timeline 上定位, O(log n)。
        """
        if len(equip_timeline) < 2:
            return []

        death_tick = death["tick"]

        idx = bisect_right(equip_timeline, death_tick, key=lambda e: e[0]) - 1
        if idx < 1:
            return []

        switch_tick, current_item = equip_timeline[idx]
        _, prev_item = equip_timeline[idx - 1]

        # 往前找到上一把 *不同* 武器的最早持有时刻
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

    # ────────────────────────────────────────────────────────────
    #  场景二: 人肉吸铁石 / 越过山丘来爆头
    # ────────────────────────────────────────────────────────────

    def _parse_spatial_snapshots(
        self, ticks: list[int],
    ) -> dict[int, pd.DataFrame]:
        """解析指定 tick 的玩家坐标与偏航 (含爆头帧 + 背身多时刻采样帧)。"""
        if not ticks:
            return {}
        unique_ticks = sorted(set(ticks))
        # 新字段（vel_x / vel_y）用于跑打 / 上去就是干 / 一个大拉等速度类标签。
        # 若 demoparser2 版本不支持，回退到旧字段集，几何标签会被动失效而非崩溃。
        try:
            result = self.parser.parse_ticks(
                [
                    "X", "Y", "Z",
                    "vel_x", "vel_y", "vel_z",
                    "yaw", "name", "is_alive", "team_num", "health",
                ],
                ticks=unique_ticks,
            )
        except Exception:
            try:
                result = self.parser.parse_ticks(
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

    @staticmethod
    def _check_human_magnet(
        death: dict,
        target_player: str,
        spatial_cache: dict[int, pd.DataFrame],
    ) -> list[str]:
        """
        判定: 被爆头时, ≥2 名存活队友比自己更靠近敌人 (距离 < 60%)。
        说明敌人子弹 "穿过" 队友精准命中了后排的你。
        """
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

    @staticmethod
    def _backstab_spatial_ok_at_snapshot(
        snapshot: pd.DataFrame,
        *,
        killer: str,
        target_player: str,
        name_col: str,
        yaw_col: str,
    ) -> bool:
        """
        目标在击杀者背后「架住背身」：击杀者朝向背对目标，且目标朝向大致指向击杀者。
        """
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

        # 击杀者面朝方向 与 「击杀者 → 目标」地理方位 的夹角：接近 180° 表示背对目标
        angle_atk_toward_vic = math.degrees(math.atan2(vy - ay, vx - ax))
        atk_facing_vs_line = _smallest_angle_diff_deg(attacker_yaw, angle_atk_toward_vic)
        if atk_facing_vs_line < (180.0 - _BACKSTAB_ATTACKER_BACK_DEG):
            return False

        # 目标朝向 与 「目标 → 击杀者」地理方位 的夹角：小表示准星对着人（背身输出）
        angle_vic_toward_atk = math.degrees(math.atan2(ay - vy, ax - vx))
        vic_aim_vs_line = _smallest_angle_diff_deg(victim_yaw, angle_vic_toward_atk)
        if vic_aim_vs_line > _BACKSTAB_VICTIM_AIM_DEG:
            return False

        return True

    @staticmethod
    def _any_kill_tick_in_round_shield(
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

    @staticmethod
    def _check_backstab_fail(
        death: dict,
        fire_index: list[tuple[int, str]],
        hurt_index: list[tuple[int, str, int]],
        spatial_cache: dict[int, pd.DataFrame],
        target_player: str,
        round_target_kill_ticks: dict[int, list[int]],
    ) -> list[str]:
        """
        死前在「对方背身」位架枪 + 死前 3s 内开枪并被反杀。
        步枪/扫射：死前至多 6s 采样，多数帧几何成立；沙鹰：同一批采样里至少 3 帧成立即可。
        沙鹰多枪零伤 → NiKo 梗；步枪/微冲多枪低伤 → 背身打不死。
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

        # aim_secs 恒应非空；若仍为空（例如本地常量被改坏），至少采死前半秒一帧避免误退
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
            return DemoAnalyzer._backstab_spatial_ok_at_snapshot(
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
            if DemoAnalyzer._any_kill_tick_in_round_shield(
                _int(death.get("round")),
                death_tick,
                w_start,
                round_target_kill_ticks,
            ):
                return []
            return ["背身打不死", "人体描边"]
        return []

    # ────────────────────────────────────────────────────────────
    #  场景三: 人体描边大师
    # ────────────────────────────────────────────────────────────

    @staticmethod
    def _build_fire_index(
        target_player: str, fire_df: pd.DataFrame,
    ) -> list[tuple[int, str]]:
        """构建目标玩家的 (tick, weapon) 开火索引, 有序。"""
        if fire_df.empty or "user_name" not in fire_df.columns:
            return []
        pf = fire_df.loc[fire_df["user_name"] == target_player].sort_values("tick")
        wcol = "weapon" if "weapon" in pf.columns else None
        return [
            (_int(r["tick"]), _normalize_item(r[wcol]) if wcol else "")
            for _, r in pf.iterrows()
        ]

    @staticmethod
    def _is_jump_kill(
        spatial_cache: "dict[int, pd.DataFrame]",
        kill_tick: int,
        player_name: str,
    ) -> bool:
        """
        检测目标玩家在击杀时是否处于跳跃中。双重检测策略：

        方法 A — vel_z 速度检测（高可信度）：
          在 kill_tick、kill_tick-8、kill_tick-16 三个采样点中，
          任意一点的 |vel_z| > 80 即判定为跳跃。
          目的：捕获起跳初期/末期阶段（此时竖直速度最高）。

        方法 B — Z 坐标差兜底（捕获顶点 vel_z≈0 的盲区）：
          若方法 A 未命中，比较 kill_tick 与 kill_tick-16 的 Z 坐标差；
          |ΔZ| > 20 unit 说明玩家在 0.25s 内有明显垂直位移，判定为跳跃中。

        若 demo 中无相关字段则返回 False（不影响其余逻辑）。
        """
        snap = spatial_cache.get(kill_tick)
        if snap is None:
            return False
        row = DemoAnalyzer._spatial_player_row(snap, player_name)
        if row is None:
            return False

        # 方法 A：逐帧检查 vel_z（包含 kill_tick 前两个采样点）
        for check_tick in (kill_tick, kill_tick - 8, kill_tick - 16):
            s = spatial_cache.get(check_tick)
            if s is None:
                continue
            r = DemoAnalyzer._spatial_player_row(s, player_name)
            if r is None or "vel_z" not in r.index:
                continue
            try:
                vz = r["vel_z"]
                if vz is not None and not (isinstance(vz, float) and pd.isna(vz)):
                    if abs(float(vz)) > 80.0:
                        return True
            except (TypeError, ValueError):
                pass

        # 方法 B：Z 坐标变化量兜底（jump-peek 顶点 vel_z 趋近于 0 时仍可检测）
        if "Z" in row.index:
            snap_before = spatial_cache.get(kill_tick - 16)
            if snap_before is not None:
                row_before = DemoAnalyzer._spatial_player_row(snap_before, player_name)
                if row_before is not None and "Z" in row_before.index:
                    try:
                        z_now = float(row["Z"])
                        z_before = float(row_before["Z"])
                        if abs(z_now - z_before) > 20.0:
                            return True
                    except (TypeError, ValueError):
                        pass

        return False

    @staticmethod
    def _count_shots_before(
        fire_index: list[tuple[int, str]],
        kill_tick: int,
        weapon: str,
        window_ticks: int,
    ) -> int:
        """
        目标玩家在 (kill_tick - window_ticks, kill_tick] 区间内
        使用同名武器的开火次数。返回 0 表示无 fire 数据或未开枪。
        """
        if not fire_index:
            return 0
        lo = bisect_left(fire_index, kill_tick - window_ticks, key=lambda e: e[0])
        hi = bisect_right(fire_index, kill_tick, key=lambda e: e[0])
        return sum(1 for i in range(lo, hi) if fire_index[i][1] == weapon)

    @staticmethod
    def _build_hurt_index(
        target_player: str, hurt_df: pd.DataFrame,
    ) -> list[tuple[int, str, int]]:
        """构建目标玩家造成的 (tick, victim_name, damage) 伤害索引, 有序。"""
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

    @staticmethod
    def _check_outline_master(
        death: dict,
        fire_index: list[tuple[int, str]],
        hurt_index: list[tuple[int, str, int]],
        round_target_kill_ticks: dict[int, list[int]],
    ) -> list[str]:
        """
        判定: 死前 3 秒内用步枪/冲锋枪开了 ≥10 枪,
        但对击杀者造成的总伤害 ≤25。一顿操作猛如虎。
        """
        death_tick = death["tick"]
        attacker = death["attacker"]
        window_start = death_tick - _OUTLINE_WINDOW
        if DemoAnalyzer._any_kill_tick_in_round_shield(
            _int(death.get("round")),
            death_tick,
            window_start,
            round_target_kill_ticks,
        ):
            return []

        # 开火次数 (二分定位窗口左右边界)
        lo = bisect_left(fire_index, window_start, key=lambda e: e[0])
        hi = bisect_right(fire_index, death_tick, key=lambda e: e[0])
        spray_count = sum(
            1 for i in range(lo, hi) if fire_index[i][1] in SPRAY_WEAPONS
        )
        if spray_count < _OUTLINE_MIN_FIRES:
            return []

        # 对击杀者造成的伤害
        lo_h = bisect_left(hurt_index, window_start, key=lambda e: e[0])
        hi_h = bisect_right(hurt_index, death_tick, key=lambda e: e[0])
        total_damage = sum(
            hurt_index[i][2] for i in range(lo_h, hi_h)
            if hurt_index[i][1] == attacker
        )

        if total_damage <= _OUTLINE_MAX_DAMAGE:
            return ["人体描边", "反向锁头"]
        return []

    # ────────────────────────────────────────────────────────────
    #  单次击杀动作标签 (高光用)
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _detect_kill_action_tags(
        *,
        weapon: str,
        headshot: bool,
        noscope: bool,
        penetrated: int,
        thrusmoke: bool,
        attackerblind: bool,
    ) -> list[str]:
        tags: list[str] = []
        if weapon in SNIPER_WEAPONS and noscope:
            tags.append("🙈 盲狙")
        if penetrated > 0:
            tags.append("🧱 穿墙杀")
        if thrusmoke:
            tags.append("🌫️ 混烟")
        if attackerblind:
            tags.append("😎 全白反杀")
        if headshot:
            tags.append("爆头")
        # 🔫 手枪哥：出生手枪爆头击杀（不依赖 spatial_cache，事件期内即可判定）
        if weapon in PISTOL_WEAPONS and headshot:
            tags.append("🔫 手枪哥")
        return tags

    # ────────────────────────────────────────────────────────────
    #  单次击杀动作标签（几何 / 空间相关） — 在 spatial_cache 构建后补齐
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _enrich_kill_action_tags_spatial(
        round_kills: dict[int, list[dict]],
        spatial_cache: dict[int, pd.DataFrame],
        target_player: str,
    ) -> None:
        """把依赖位置/朝向/速度的击杀动作子标回填到每个 kill['tags']。
        已去重，不重复追加既有标签。"""
        for kills in round_kills.values():
            for k in kills:
                kt = _int(k.get("tick"))
                extra: list[str] = []
                snap = spatial_cache.get(kt)
                if snap is not None and not snap.empty:
                    atk = DemoAnalyzer._spatial_player_row(snap, target_player)
                    vic = DemoAnalyzer._spatial_player_row(
                        snap, str(k.get("victim") or "").strip(),
                    )
                    headshot = _bool(k.get("headshot"))
                    weapon = str(k.get("weapon") or "").strip()
                    penetrated = _int(k.get("penetrated"), 0)

                    # —— 距离相关 ——
                    dist: Optional[float] = None
                    if atk is not None and vic is not None:
                        try:
                            ax, ay = float(atk["X"]), float(atk["Y"])
                            vx, vy = float(vic["X"]), float(vic["Y"])
                            dist = math.hypot(ax - vx, ay - vy)
                        except (TypeError, ValueError, KeyError):
                            dist = None
                    if dist is not None:
                        if dist <= _PB_DIST_EXECUTION and headshot:
                            extra.append("👃 零距离")
                        elif dist <= _PB_DIST_POINT_BLANK:
                            extra.append("🫵 贴脸超度")
                        if penetrated >= 1 and dist > _WALLBANG_DIST_MIN:
                            extra.append("🎯 超远穿墙")

                    # —— 攻击者速度：上去就是干 / 跑打 / 一个大拉 ——
                    vxy: Optional[float] = None
                    vz_a: Optional[float] = None
                    if atk is not None:
                        try:
                            if "vel_x" in atk.index and "vel_y" in atk.index:
                                vxy = math.hypot(float(atk["vel_x"]), float(atk["vel_y"]))
                        except (TypeError, ValueError):
                            vxy = None
                        try:
                            if "vel_z" in atk.index:
                                vz_a = float(atk["vel_z"])
                        except (TypeError, ValueError):
                            vz_a = None

                    is_jump = DemoAnalyzer._is_jump_kill(spatial_cache, kt, target_player)
                    if vxy is not None:
                        if vxy > _RUSH_VEL_MIN:
                            extra.append("🚀 上去就是干")
                        elif (_RUNGUN_VEL_MIN <= vxy <= _RUNGUN_VEL_MAX
                              and not is_jump
                              and not _bool(k.get("noscope"))):
                            extra.append("🏃‍♂️ 跑打")

                    # 🎿 一个大拉：下蹲近似（vel_z < 0 且 vxy > 阈值；跳跃中不算）
                    if (vxy is not None and vz_a is not None
                            and vz_a < 0 and vxy > _SLIDE_VEL_XY_MIN and not is_jump):
                        extra.append("🎿 一个大拉")

                    # 🛸 乌鸦坐飞机：击杀帧竖直速度大且相对 16 tick 前 Z 上升
                    if vz_a is not None and vz_a > _AIRBORNE_VEL_Z_MIN and atk is not None:
                        snap_prev = spatial_cache.get(kt - _AIRBORNE_LOOKBACK_TICKS)
                        prev_row = (
                            DemoAnalyzer._spatial_player_row(snap_prev, target_player)
                            if snap_prev is not None else None
                        )
                        try:
                            if (prev_row is not None
                                    and "Z" in atk.index and "Z" in prev_row.index
                                    and float(atk["Z"]) > float(prev_row["Z"])):
                                extra.append("🛸 乌鸦坐飞机")
                        except (TypeError, ValueError):
                            pass

                    # 🌪️ 甩狙：大狙类武器击杀时 yaw 与击杀前多帧 yaw 的最大差 ≥ 阈值
                    # 同时检查 kt-8（125ms）和 kt-16（250ms），取最大角度差，
                    # 避免甩枪动作恰好在 kt-8 ~ kt 之间完成时漏检。
                    if (weapon in SNIPER_WEAPONS and atk is not None
                            and "yaw" in atk.index):
                        _flick_max_yd = 0.0
                        for _flick_off in _QUICKSCOPE_LOOKBACK_OFFSETS:
                            _snap_p = spatial_cache.get(kt - _flick_off)
                            _prev_r = (
                                DemoAnalyzer._spatial_player_row(_snap_p, target_player)
                                if _snap_p is not None else None
                            )
                            if _prev_r is not None and "yaw" in _prev_r.index:
                                try:
                                    _flick_max_yd = max(
                                        _flick_max_yd,
                                        _smallest_angle_diff_deg(
                                            float(atk["yaw"]), float(_prev_r["yaw"]),
                                        ),
                                    )
                                except (TypeError, ValueError):
                                    pass
                        if _flick_max_yd >= _QUICKSCOPE_YAW_DELTA_MIN:
                            extra.append("🌪️ 甩狙")

                # 合并去重回写
                base = list(k.get("tags") or [])
                seen = set(base)
                for t in extra:
                    if t not in seen:
                        seen.add(t)
                        base.append(t)
                k["tags"] = base

    # ────────────────────────────────────────────────────────────
    #  回合级新增高光标签
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _check_knife_backstab_tag(kills_sorted: list[dict],
                                   spatial_cache: dict[int, pd.DataFrame],
                                   target_player: str) -> bool:
        """🔙 背刺：任一刀杀中，攻击者与受害者朝向夹角 < 45°（从受害者背后捅）。"""
        for k in kills_sorted:
            if not _is_knife_highlight_weapon(str(k.get("weapon") or "")):
                continue
            kt = _int(k.get("tick"))
            snap = spatial_cache.get(kt)
            if snap is None or snap.empty:
                continue
            atk = DemoAnalyzer._spatial_player_row(snap, target_player)
            vic = DemoAnalyzer._spatial_player_row(
                snap, str(k.get("victim") or "").strip(),
            )
            if atk is None or vic is None:
                continue
            try:
                if "yaw" not in atk.index or "yaw" not in vic.index:
                    continue
                ya = float(atk["yaw"])
                yv = float(vic["yaw"])
                if _smallest_angle_diff_deg(ya, yv) < 45.0:
                    return True
            except (TypeError, ValueError):
                continue
        return False

    @staticmethod
    def _check_camper_tag(kills_sorted: list[dict],
                          spatial_cache: dict[int, pd.DataFrame],
                          target_player: str) -> bool:
        """🐍 老六本色：任一杀满足 击杀前 4s 攻击者位移 < 30 且 shots_to_kill ≤ 2。"""
        for k in kills_sorted:
            shots = _int(k.get("shots_to_kill"), 0)
            if shots == 0 or shots > _CAMPER_SHOTS_MAX:
                continue
            kt = _int(k.get("tick"))
            snap_now = spatial_cache.get(kt)
            snap_pre = spatial_cache.get(kt - _CAMPER_WINDOW_TICKS)
            if snap_now is None or snap_pre is None:
                continue
            r_now = DemoAnalyzer._spatial_player_row(snap_now, target_player)
            r_pre = DemoAnalyzer._spatial_player_row(snap_pre, target_player)
            if r_now is None or r_pre is None:
                continue
            try:
                dx = float(r_now["X"]) - float(r_pre["X"])
                dy = float(r_now["Y"]) - float(r_pre["Y"])
                if math.hypot(dx, dy) < _CAMPER_MAX_DISP:
                    return True
            except (TypeError, ValueError, KeyError):
                continue
        return False

    @staticmethod
    def _check_clutch_time_tag(kills_sorted: list[dict],
                                round_num: int,
                                round_end_tick_map: Optional[dict[int, int]],
                                bomb_explode_tick_map: Optional[dict[int, int]]) -> bool:
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

    @staticmethod
    def _check_last_round_debt_tag(kills_sorted: list[dict],
                                    round_num: int,
                                    prev_round_killers_of_target: Optional[dict[int, set[str]]]) -> bool:
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

    @staticmethod
    def _check_avenge_tag(kills_sorted: list[dict],
                          teammate_hurt_victim_index: Optional[dict[str, list[int]]]) -> bool:
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

    @staticmethod
    def _check_sweep_tag(n: int,
                          round_num: int,
                          teammate_kills_per_round: Optional[dict[int, int]]) -> bool:
        """🧹 清盘：本回合目标 5 杀 且 队友 0 杀。"""
        if n < 5:
            return False
        mates = (teammate_kills_per_round or {}).get(round_num, 0)
        return mates == 0

    @staticmethod
    def _check_barefoot_tag(round_num: int,
                             target_team_at_freeze: Optional[int],
                             round_economy_map: dict[int, dict[int, int]]) -> bool:
        """👢 光脚干皮鞋：本回合目标所在队伍装备价值 ≤ 2000 且 ≥1 杀（本函数在外部已保证 ≥1 杀）。"""
        if target_team_at_freeze not in (2, 3):
            return False
        rd = round_economy_map.get(round_num, {})
        if not rd:
            return False
        val = int(rd.get(target_team_at_freeze, 0))
        return val > 0 and val <= _BAREFOOT_EQUIP_MAX

    @staticmethod
    def _check_double_penetrate_tag(kills_sorted: list[dict]) -> bool:
        """🔫 一弹双穿：同 tick 两杀 且 至少一杀 penetrated ≥ 1。"""
        by_tick: dict[int, list[dict]] = {}
        for k in kills_sorted:
            by_tick.setdefault(_int(k.get("tick")), []).append(k)
        for kt, ks in by_tick.items():
            if len(ks) >= 2 and any(_int(k.get("penetrated"), 0) >= 1 for k in ks):
                return True
        return False

    @staticmethod
    def _check_comeback_lowhp_tag(n: int,
                                   first_tick: int,
                                   spatial_cache: dict[int, pd.DataFrame],
                                   target_player: str) -> bool:
        """❤️‍🩹 残血绝地反击：多杀 (n≥2) 起始 HP ≤ 20。"""
        if n < 2:
            return False
        snap = spatial_cache.get(int(first_tick))
        if snap is None:
            snap = spatial_cache.get(int(first_tick) - 8)
        if snap is None or snap.empty:
            return False
        row = DemoAnalyzer._spatial_player_row(snap, target_player)
        if row is None:
            return False
        hp = DemoAnalyzer._row_health(row)
        return hp is not None and 0 < hp <= _COMEBACK_HP_MAX

    @staticmethod
    def _check_ironshirt_tag(round_num: int,
                              last_kill_tick: int,
                              round_hurt_on_target_index: Optional[dict[int, list[tuple[int, int, str]]]],
                              round_death_tick_map: Optional[dict[int, int]]) -> bool:
        """🪨 挨揍王：本回合目标在最后一杀之前受到非道具命中 ≥ 4 次 且 累计 ≥ 95 HP，且目标未在该窗口内死亡。"""
        if not round_hurt_on_target_index:
            return False
        hits = round_hurt_on_target_index.get(round_num) or []
        if not hits:
            return False
        # 最后一杀前的命中才算（证明"挨揍之后仍完成击杀"）
        valid = [(t, d, w) for (t, d, w) in hits
                 if t <= last_kill_tick and w not in _UTILITY_DMG_WEAPONS]
        if len(valid) < _IRONSHIRT_HITS_MIN:
            return False
        total = sum(d for _, d, _ in valid)
        if total < _IRONSHIRT_DMG_MIN:
            return False
        # 死亡校验：若目标在最后一杀之前已死，不算
        dth = (round_death_tick_map or {}).get(round_num)
        if dth is not None and dth <= last_kill_tick:
            return False
        return True

    @staticmethod
    def _check_defuse_open_tag(round_num: int,
                                kills_sorted: list[dict],
                                defuse_window_map: Optional[dict[int, tuple[int, int]]]) -> bool:
        """💣 拆包开光：本回合目标拆包过程中（begindefuse → defused）完成击杀。"""
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

    # ────────────────────────────────────────────────────────────
    #  下饭扩展（spatial / 事件驱动）
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _check_zombie_step(death: dict,
                            spatial_cache: dict[int, pd.DataFrame],
                            target_player: str) -> list[str]:
        """🗿 僵尸步：死前 3s 位移 < 20 且被爆头。"""
        if not _bool(death.get("headshot")):
            return []
        dt = _int(death.get("tick"))
        snap_now = spatial_cache.get(dt)
        snap_pre = spatial_cache.get(dt - _ZOMBIE_STEP_PRE_TICKS)
        if snap_now is None or snap_pre is None:
            return []
        r_now = DemoAnalyzer._spatial_player_row(snap_now, target_player)
        r_pre = DemoAnalyzer._spatial_player_row(snap_pre, target_player)
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

    @staticmethod
    def _check_stroll(death: dict,
                       spatial_cache: dict[int, pd.DataFrame],
                       target_player: str) -> list[str]:
        """🐢 散步流：死前 1s 平均 |vel_xy| ≥ 150 且被爆头。"""
        if not _bool(death.get("headshot")):
            return []
        dt = _int(death.get("tick"))
        snap_now = spatial_cache.get(dt)
        snap_pre = spatial_cache.get(dt - _STROLL_PRE_TICKS)
        if snap_now is None or snap_pre is None:
            return []
        r_now = DemoAnalyzer._spatial_player_row(snap_now, target_player)
        r_pre = DemoAnalyzer._spatial_player_row(snap_pre, target_player)
        if r_now is None or r_pre is None:
            return []
        try:
            dx = float(r_now["X"]) - float(r_pre["X"])
            dy = float(r_now["Y"]) - float(r_pre["Y"])
            disp = math.hypot(dx, dy)
            # 平均速度 = disp / (_STROLL_PRE_TICKS / TICK_RATE)
            avg_v = disp * TICK_RATE / float(_STROLL_PRE_TICKS)
            if avg_v >= _STROLL_MIN_VEL:
                return ["🐢 散步流"]
        except (TypeError, ValueError, KeyError):
            return []
        return []

    @staticmethod
    def _check_magnet_nade(death: dict,
                            spatial_cache: dict[int, pd.DataFrame],
                            target_player: str,
                            grenade_detonate_points: Optional[list[tuple[int, float, float]]]) -> list[str]:
        """🧲 吸铁石：死于雷/火 且 死前 5s 目标 → 雷/火中心距离递减 ≥ 200 units。

        grenade_detonate_points: [(tick, x, y), ...] 已按 tick 排序。缺失时退化为
        使用击杀者位置（若不同于目标）近似。"""
        weapon = _normalize_item(str(death.get("weapon") or ""))
        if weapon not in GRENADE_KILL_WEAPONS:
            return []
        dt = _int(death.get("tick"))
        # 目标位置时间序列
        snap_now = spatial_cache.get(dt)
        snap_pre = spatial_cache.get(dt - _MAGNET_NADE_LOOKBACK_TICKS)
        if snap_now is None or snap_pre is None:
            return []
        r_now = DemoAnalyzer._spatial_player_row(snap_now, target_player)
        r_pre = DemoAnalyzer._spatial_player_row(snap_pre, target_player)
        if r_now is None or r_pre is None:
            return []
        # 选中心点：优先找 [dt-5s, dt] 内最近的雷爆点
        cx: Optional[float] = None
        cy: Optional[float] = None
        if grenade_detonate_points:
            lo_t = dt - _MAGNET_NADE_LOOKBACK_TICKS
            candidates = [(t, x, y) for (t, x, y) in grenade_detonate_points
                          if lo_t <= t <= dt]
            if candidates:
                # 距目标死亡位置最近的那颗
                try:
                    now_x, now_y = float(r_now["X"]), float(r_now["Y"])
                    best = min(candidates,
                               key=lambda e: math.hypot(e[1] - now_x, e[2] - now_y))
                    cx, cy = float(best[1]), float(best[2])
                except (TypeError, ValueError, KeyError):
                    pass
        if cx is None or cy is None:
            # 退化：用死亡位置自身作为"雷中心"（不可解析出方向性），直接跳过
            return []
        try:
            d_pre = math.hypot(float(r_pre["X"]) - cx, float(r_pre["Y"]) - cy)
            d_now = math.hypot(float(r_now["X"]) - cx, float(r_now["Y"]) - cy)
            if (d_pre - d_now) >= _MAGNET_NADE_DIST_DROP:
                return ["🧲 吸铁石"]
        except (TypeError, ValueError, KeyError):
            return []
        return []

    @staticmethod
    def _check_flash_send(death: dict,
                           flash_on_target_index: Optional[list[tuple[int, float]]]) -> list[str]:
        """🚪 闪送：flash_duration ≥ 2.5s 后 ≤ 3s 被杀，或被闪期间死亡。

        flash_on_target_index: 目标被闪事件列表 [(tick, duration_sec), ...] 已按 tick 排序。
        """
        if not flash_on_target_index:
            return []
        dt = _int(death.get("tick"))
        for (ft, dur) in flash_on_target_index:
            if dur < _FLASH_SEND_MIN_DUR:
                continue
            flash_end = ft + int(dur * TICK_RATE)
            # 被闪期间死亡 —— 或 闪完后 3s 内死亡
            if ft <= dt <= flash_end + _FLASH_SEND_WINDOW_TICKS:
                return ["🚪 闪送"]
        return []

    # ────────────────────────────────────────────────────────────
    #  基础下饭标签
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _detect_fail_tags(
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
            # 用自己的武器打死自己（如手枪走火、AWP 自爆等）
            tags.append("自杀")
        if weapon in GRENADE_KILL_WEAPONS and not _death_by_planted_c4(weapon):
            # 被手雷/燃烧瓶/火焰击杀（无论是敌方还是队友投的）
            tags.append("道具击杀")
        if weapon in WORLD_KILL_WEAPONS:
            tags.append("摔死")
        if (attacker != victim
                and attacker_team is not None
                and attacker_team == victim_team):
            tags.append("痛击队友")

        return tags

    # ────────────────────────────────────────────────────────────
    #  高光回合标签聚合（含极品情绪标签）
    # ────────────────────────────────────────────────────────────
    @staticmethod
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

    @staticmethod
    def _victim_facing_attacker(
        snapshot: Optional[pd.DataFrame],
        attacker: str,
        victim: str,
        *,
        max_angle_deg: float = 45.0,
    ) -> bool:
        """死亡瞬间受害者的 yaw 是否指向攻击者（±max_angle_deg 内）。

        "手撕大狙" 语义：受害者正举着 AWP 对着我起枪，被我反杀。
        因此必须排除"背身被秒 / 侧身被打 / 根本没瞄到你"的 AWP 受害者。
        """
        import math as _math
        v = DemoAnalyzer._spatial_player_row(snapshot, victim)
        a = DemoAnalyzer._spatial_player_row(snapshot, attacker)
        if v is None or a is None:
            return False
        try:
            vx, vy = float(v["X"]), float(v["Y"])
            ax, ay = float(a["X"]), float(a["Y"])
            vyaw   = float(v["yaw"])
        except (TypeError, ValueError, KeyError):
            return False
        target_yaw = _math.degrees(_math.atan2(ay - vy, ax - vx))
        diff = ((target_yaw - vyaw + 180.0) % 360.0) - 180.0
        return abs(diff) <= max_angle_deg

    @staticmethod
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

    @staticmethod
    def _extend_tags_unique(base: list[str], extra: list[str]) -> list[str]:
        out = list(base)
        seen = set(base)
        for t in extra:
            if t in seen:
                continue
            seen.add(t)
            out.append(t)
        return out

    @staticmethod
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

    @staticmethod
    def _alive_mates_and_enemies(
        snap: pd.DataFrame,
        target_player: str,
    ) -> Optional[tuple[int, int]]:
        """返回 (同队存活队友数不含自己, 敌方存活人数)；无法统计时返回 None。"""
        row_self = DemoAnalyzer._spatial_player_row(snap, target_player)
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

    def _build_highlight_tags(
        self,
        kills_sorted: list[dict],
        first_tick: int,
        last_tick: int,
        round_num: int,
        round_first_death_tick: dict[int, int],
        spatial_cache: dict[int, pd.DataFrame],
        target_player: str,
        round_economy_map: dict[int, dict[int, int]],
        target_team_at_freeze: Optional[int],
        round_team_score: Optional[tuple[int, int]],
        round_won: Optional[bool] = None,
        *,
        # 新增上下文（全部可选，缺失时相关标签静默跳过）
        round_end_tick_map: Optional[dict[int, int]] = None,
        bomb_explode_tick_map: Optional[dict[int, int]] = None,
        prev_round_killers_of_target: Optional[dict[int, set[str]]] = None,
        teammate_hurt_victim_index: Optional[dict[str, list[int]]] = None,
        teammate_kills_per_round: Optional[dict[int, int]] = None,
        round_hurt_on_target_index: Optional[dict[int, list[tuple[int, int, str]]]] = None,
        round_death_tick_map: Optional[dict[int, int]] = None,
        defuse_window_map: Optional[dict[int, tuple[int, int]]] = None,
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

        # 连杀中含刀杀（如 MAG 两枪收尾刀）：仍打上刀杀高光标签，避免仅被归入主武器多杀
        if any(_is_knife_highlight_weapon(str(k.get("weapon") or "")) for k in kills_sorted):
            tags.append("🔪 刀杀")

        # 双杀的“刷屏”门槛必须极其严格（3秒内），三杀及以上才使用默认的宽容度
        rapid_window = 3.0 if n == 2 else float(RAPID_KILL_WINDOW_SECONDS)
        if (last_tick - first_tick) <= rapid_window * TICK_RATE:
            tags.append("爆发刷屏")

        if all(k["headshot"] for k in kills_sorted):
            tags.append("枪枪爆头")

        # —— 首杀 ——
        rfd = round_first_death_tick.get(round_num)
        if rfd is not None and kills_sorted[0]["tick"] == rfd:
            tags.append("⚔️ 首杀")

        # 供"虽败犹荣"标签判定的状态追踪（在下方各判断块中填充）
        _eco_round = False       # 本回合己方 ECO 且对面全装
        _nt_1v_active = False    # 片段中存在符合判定的 1vN 残局段（逐杀前快照）
        _nt_1v_n_enemies = 0     # 「虽败犹荣」1vN：敌方存活数（取最优残局起点）
        _nt_1v_clutch_kills = 0  # 从残局起点到片段末尾的击杀数（不再只按首杀前快照）

        # MR12 手枪局 + 真实装备经济对比（不依赖击杀武器）
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
                    _eco_round = True  # 记录供"虽败犹荣"判断
                elif target_team_equip >= FULL_BUY_MIN_VALUE and enemy_team_equip <= ECO_MAX_VALUE:
                    tags.append("🔫 ECO特种兵")

        # —— ⛰️ 比分与赛点高光判定 ——
        if round_team_score is not None:
            target_score, enemy_score = round_team_score
        else:
            target_score = enemy_score = 0

        # CS2 MR12 赛点算法：12, 15, 18, 21 恰好都是 3 的倍数 且对方比分小于己方 (兼容常规与加时)
        is_enemy_match_point = (enemy_score >= 12 and enemy_score % 3 == 0 and target_score < enemy_score)
        is_target_match_point = (target_score >= 12 and target_score % 3 == 0 and target_score > enemy_score)

        if is_enemy_match_point and target_score < enemy_score:
            if enemy_score - target_score == 1:
                # 如 11:12，真正意义上命悬一线的最后一回合
                tags.extend(["🛡️ 赛点救世主", "命悬一线"])
            else:
                # 如 9:12, 5:12，处于连续追分阶段
                tags.extend(["📈 绝地追分", "拒绝下班"])
        elif is_target_match_point and target_score > enemy_score:
            if target_score - enemy_score == 1:
                # 12:11，差一分带走比赛
                tags.extend(["🗡️ 赛点终结者", "一锤定音"])
        elif target_score == enemy_score and target_score >= 12:
            # 12:12, 15:15 等加时赛平局时刻
            tags.extend(["⚔️ 加时生死战", "大心脏"])

        if target_score >= 8 and enemy_score <= 2:
            tags.extend(["🔥 顺风局战神", "无情碾压"])

        # 天王山：双方均 ≥ 10 分且比分相同（真正均势）；独立 if，可与赛点、「⚔️ 加时生死战」等并存
        # 核心逻辑：均势下输一局连败奖励归零 → 经济断崖 → 下一分压力大
        if target_score >= 10 and enemy_score >= 10 and target_score == enemy_score:
            tags.append("⛰️ 天王山之战")

        snap_last = spatial_cache.get(int(last_tick))

        # —— ❤️ 极限锁血战神（连杀结束时自身血量）——
        row_last = DemoAnalyzer._spatial_player_row(snap_last, target_player)
        if row_last is not None:
            hp = DemoAnalyzer._row_health(row_last)
            if hp is not None and 0 < hp <= 15:
                tags.append("❤️ 极限锁血战神")

        # —— 🔥 劣势破局与残局（逐杀前快照人数，避免「首杀尚为 4v5、后段实为 1v3」仍按开局算）——
        best_epic_1v = -1
        best_nt_1v = -1
        best_nt_start = -1
        best_2v_n = -1
        any_3v5 = False
        for start in range(n):
            kt = _int(kills_sorted[start].get("tick"))
            sk = DemoAnalyzer._spatial_snap_pre_kill(spatial_cache, kt)
            if sk is None:
                continue
            pair = DemoAnalyzer._alive_mates_and_enemies(sk, target_player)
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

        # —— 🍡 一石二鸟 ——
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

        # —— 💥 颗秒 ——
        # 颗秒定义：非狙武器以单点/精准开枪完成爆头击杀（控头准度 + 子弹经济）
        #
        # 条件 A（主判）：步枪或重型手枪 × 爆头 × 击杀前 2 秒内同武器开枪 ≤ 3 发
        #   → 覆盖「3K 里只有一个 headshot」的场景：只要 _ns_hs 里有一个满足即可
        #   → shots_to_kill == 0 表示无 fire 事件数据，降级为「有爆头即算」
        #
        # 条件 B（副判）：所有非狙击杀均为爆头 且 ≥2 kill（全程控头风格）
        #   → 不要求一定是步枪，SMG/普通手枪也算，但要求"枪枪到头"
        # 使用模块级常量 _KEQIAO_WEAPONS / _KEQIAO_SEMI_SNIPERS，避免重复定义
        _ALL_SNIPERS_KQ = SNIPER_WEAPONS | _KEQIAO_SEMI_SNIPERS         # AWP/SSG08 + 半自动狙

        _ns_kills = [k for k in kills_sorted
                     if str(k.get("weapon") or "").strip() not in _ALL_SNIPERS_KQ]
        _ns_hs = [k for k in _ns_kills if _bool(k.get("headshot"))]

        if _ns_hs:
            def _is_precise(k: dict) -> bool:
                """步枪/重手枪爆头 且 开枪数符合单点节奏（≤3发，或无 fire 数据则不限）"""
                w = str(k.get("weapon") or "").strip()
                if w not in _KEQIAO_WEAPONS:
                    return False
                shots = _int(k.get("shots_to_kill"), 0)
                # shots == 0 → 无 weapon_fire 数据，退化为只看武器+爆头
                return shots == 0 or shots <= 3

            cond_a = any(_is_precise(k) for k in _ns_hs)
            cond_b = len(_ns_hs) == len(_ns_kills) >= 2  # 全程非狙爆头 且 ≥2 kill
            if cond_a or cond_b:
                tags.append("💥 颗秒")
                # 手撕大狙：至少一名受害者"持 AWP 且正对攻击者起枪"。
                # 双重过滤：本回合持 AWP（victim_had_awp）+ 死亡瞬间 yaw 指向 attacker。
                if any(
                    _bool(k.get("victim_had_awp"))
                    and DemoAnalyzer._victim_facing_attacker(
                        spatial_cache.get(_int(k.get("tick"))),
                        target_player,
                        str(k.get("victim") or ""),
                    )
                    for k in kills_sorted
                ):
                    tags.append("🔪 手撕大狙")

        # —— 🥷 智斗 ——
        if n >= 2:
            # 过滤1：大狙架枪、混烟、穿墙不属于“忍耐绕后”
            ws = [str(k.get("weapon") or "").strip() for k in kills_sorted]
            all_sniper = bool(ws) and all(w in SNIPER_WEAPONS for w in ws)
            dirty = all_sniper or any(
                _bool(k.get("thrusmoke")) or _int(k.get("penetrated"), 0) > 0 for k in kills_sorted
            )

            # 混烟、穿墙不能在此排除
            dirty = False

            if not dirty:
                backstab_count = 0
                for kill in kills_sorted:
                    kt       = _int(kill.get("tick"))
                    sk_at    = spatial_cache.get(kt)
                    vic_name = str(kill.get("victim") or "").strip()

                    atk_row     = DemoAnalyzer._spatial_player_row(sk_at, target_player)
                    vic_pos_row = DemoAnalyzer._spatial_player_row(sk_at, vic_name) if vic_name else None

                    if atk_row is None or vic_pos_row is None:
                        continue

                    try:
                        ax, ay = float(atk_row["X"]),     float(atk_row["Y"])
                        vx, vy = float(vic_pos_row["X"]), float(vic_pos_row["Y"])

                        # 过滤2：距离必须在近中距离（约 1200 units 以内），太远说明只是架枪
                        dist = math.hypot(ax - vx, ay - vy)
                        if dist >= 1200.0:
                            continue

                        # —— 过滤3：耐心窗口（patience window）——
                        # 完全弃用 yaw（demoparser2 坐标系可能与 atan2 不一致，容易误判）
                        # 改用纯位置向量判断：
                        #
                        #   检查A：受害者在过去 ~1 秒内位移 ≥ 100 units（有明显移动）
                        #           → 受害者路过/横穿，攻击者放人通过后击杀
                        #
                        #   检查B：攻击者→受害者方位角变化 ≥ 60°
                        #           → 受害者横穿或攻击者绕到背后
                        #
                        #   防误判C：若受害者移动方向正对着攻击者（< 60° 偏差），
                        #           说明是头对头冲撞而非"放人通过"，不算绕后
                        #
                        # 数据不可用时降级为宽松兜底（patience_ok = True）。
                        patience_ok = True
                        for _pw_off in (64, 128):
                            _pw_snap = spatial_cache.get(kt - _pw_off)
                            if _pw_snap is None:
                                continue
                            _pw_vic = DemoAnalyzer._spatial_player_row(_pw_snap, vic_name)
                            _pw_atk = DemoAnalyzer._spatial_player_row(_pw_snap, target_player)
                            if _pw_vic is None or _pw_atk is None:
                                continue
                            try:
                                vex = float(_pw_vic["X"])
                                vey = float(_pw_vic["Y"])
                                aex = float(_pw_atk["X"])
                                aey = float(_pw_atk["Y"])

                                # A：受害者平面位移
                                vic_disp  = math.hypot(vx - vex, vy - vey)
                                # B：攻击者→受害者方位角变化量
                                ang_early = math.degrees(math.atan2(vey - aey, vex - aex))
                                ang_kill  = math.degrees(math.atan2(vy - ay, vx - ax))
                                ang_delta = _smallest_angle_diff_deg(ang_early, ang_kill)

                                # C：排除受害者直冲攻击者的情况（头对头不算绕后）
                                moving_toward_atk = False
                                if vic_disp > 5.0:
                                    victim_move_ang  = math.degrees(math.atan2(vy - vey, vx - vex))
                                    vic_to_atk_ang   = math.degrees(math.atan2(ay - vy, ax - vx))
                                    # 45° 阈值：0-45° 视为"冲向"攻击者（head-on），46-180° 视为横穿/背离
                                    moving_toward_atk = _smallest_angle_diff_deg(victim_move_ang, vic_to_atk_ang) < 45.0

                                # D：攻击者自身位移（相对击杀帧前 N ticks）
                                # 真正的"忍耐等待"要求攻击者低速甚至静止；
                                # 若攻击者也在正常跑动，说明是拐角碰撞而非埋伏。
                                # _pw_off / 64 = 秒数，160 units/s 为判定"缓慢/等待"的上限
                                atk_disp = math.hypot(ax - aex, ay - aey)
                                _atk_patience_units = 160.0 * (_pw_off / 64.0)
                                atk_was_patient = atk_disp < _atk_patience_units
                                # 极大绕后角（≥80°）即使攻击者在移动也认可（正面绕后）
                                atk_flanked = ang_delta >= 80.0

                                patience_ok = (
                                    (vic_disp >= 100.0 or ang_delta >= 1.0)
                                    and not moving_toward_atk
                                    and (atk_was_patient or atk_flanked)
                                )
                            except (TypeError, ValueError):
                                patience_ok = True
                            break  # 用最近可用帧即可

                        if patience_ok:
                            backstab_count += 1
                    except (TypeError, ValueError, KeyError):
                        pass

                # 过滤3：动态容错。双杀只要 1 人满足，三杀及以上需要 2 人
                need = 1 if n == 2 else 2
                if backstab_count >= need:
                    tags.append("🥷 智斗")

        # —— 800里开外（狙击 / 沙鹰系，距离阈值，只加一次）——
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
            atk_row = DemoAnalyzer._spatial_player_row(sk, target_player)
            vic_row = DemoAnalyzer._spatial_player_row(sk, vic_name) if vic_name else None
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
            row_c = DemoAnalyzer._spatial_player_row(snap_cur, target_player)
            row_p = DemoAnalyzer._spatial_player_row(snap_prev, target_player)
            if row_c is None or row_p is None:
                continue
            if "Z" not in row_c.index or "Z" not in row_p.index:
                continue
            try:
                zc = float(row_c["Z"])
                zp = float(row_p["Z"])
            except (TypeError, ValueError):
                continue
            if abs(zc - zp) > _FLYING_SNIPER_Z_DELTA_MIN:
                tags.extend(["✈️ 飞天盲狙", "冷神附体"])
                flying_added = True

        # —— 🪂 跳杀 ——
        # 任意一杀时检测到玩家处于跳跃状态（vel_z > 80 units/s）即打标签
        if any(
            DemoAnalyzer._is_jump_kill(spatial_cache, _int(k.get("tick")), target_player)
            for k in kills_sorted
        ):
            tags.append("🪂 跳杀")

        action_seen: set[str] = set()
        for kill in kills_sorted:
            for t in kill.get("tags", []):
                if t != "爆头" and t not in action_seen:
                    action_seen.add(t)
                    tags.append(t)

        # ===== 新增 · 回合级标签（CS 黑话系列） =====
        if DemoAnalyzer._check_knife_backstab_tag(kills_sorted, spatial_cache, target_player):
            if "🔙 背刺" not in tags:
                tags.append("🔙 背刺")
        if DemoAnalyzer._check_camper_tag(kills_sorted, spatial_cache, target_player):
            tags.append("🐍 老六本色")
        if DemoAnalyzer._check_clutch_time_tag(
            kills_sorted, round_num, round_end_tick_map, bomb_explode_tick_map,
        ):
            tags.append("🔔 极限操作")
        if DemoAnalyzer._check_last_round_debt_tag(
            kills_sorted, round_num, prev_round_killers_of_target,
        ):
            tags.append("🧾 上回合的债")
        if DemoAnalyzer._check_avenge_tag(kills_sorted, teammate_hurt_victim_index):
            tags.append("⚰️ 补枪")
        if DemoAnalyzer._check_sweep_tag(n, round_num, teammate_kills_per_round):
            tags.append("🧹 清盘")
        if n >= 1 and DemoAnalyzer._check_barefoot_tag(
            round_num, target_team_at_freeze, round_economy_map,
        ):
            tags.append("👢 光脚干皮鞋")
        if DemoAnalyzer._check_double_penetrate_tag(kills_sorted):
            tags.append("🔫 一弹双穿")
        if DemoAnalyzer._check_comeback_lowhp_tag(n, first_tick, spatial_cache, target_player):
            tags.append("❤️‍🩹 残血绝地反击")
        if DemoAnalyzer._check_ironshirt_tag(
            round_num, last_tick, round_hurt_on_target_index, round_death_tick_map,
        ):
            tags.append("🪨 挨揍王")
        if DemoAnalyzer._check_defuse_open_tag(round_num, kills_sorted, defuse_window_map):
            tags.append("💣 拆包开光")
        # =================================================

        # ===== 🥀 虽败犹荣 (Nice Try) 标签 — 仅在本回合输掉时追加 =====
        # 是对称的"赢了版"标签的悲剧镜像，叙事弧线：高光输出 → 最终结局
        if round_won is False:
            # —— 1vN 封神未遂 ——
            # 条件：玩家独自面对 N 个对手，至少打掉了 N-1 个但最终没能赢得回合
            # 1v2: 打了1K → "1v2 饮恨"；1v3+: 打了(N-1)K → "1vN 封神未遂"
            if _nt_1v_active and _nt_1v_n_enemies >= 2:
                need_kills = max(1, _nt_1v_n_enemies - 1)
                if _nt_1v_clutch_kills >= need_kills:
                    if _nt_1v_n_enemies == 2:
                        tags.append("😤 1v2 饮恨")
                    else:
                        tags.append(f"💀 1v{_nt_1v_n_enemies} 封神未遂")

            # —— ECO 翻盘差点成了 ——
            # 条件：己方 ECO 局拿到 ≥2 kill 但没赢，说明孤注一掷却功败垂成
            if _eco_round and n >= 2:
                tags.append("💸 ECO反击")

            # —— 赛点防守失守 ——
            # 对应赢了版的"赛点救世主"/"绝地追分"；输了就是"失守"
            if is_enemy_match_point:
                if enemy_score - target_score == 1:
                    # 11:12 这种真正命悬一线的最后一分：守住就是传说，没守住是遗憾
                    tags.append("🛡️ 赛点失守")
                else:
                    # 8:12 等连续追分阶段：仍在拼命但差距较大
                    tags.append("📉 绝地追分未果")

            # —— 天王山饮恨 ——
            # 与赢了版"天王山之战"对称：双方均 ≥ 10 分且平局开局、本回合多杀仍输掉
            elif (target_score >= 10 and enemy_score >= 10
                  and target_score == enemy_score and n >= 2):
                tags.append("⛰️ 天王山饮恨")
        # =============================================================

        return tags

    # ────────────────────────────────────────────────────────────
    #  工具方法
    # ────────────────────────────────────────────────────────────
    @staticmethod
    def _fail_killer_display_name(death: dict, target_player: str) -> Optional[str]:
        """下饭 / 死亡集锦：击杀者名；自雷、世界伤害等无对立击杀者时返回 None。"""
        atk = str(death.get("attacker") or "").strip()
        if not atk or atk == target_player:
            return None
        return atk

    @staticmethod
    def _is_mr12_regulation_decided_score(
        score_own: Optional[int],
        score_opp: Optional[int],
    ) -> bool:
        """MR12 正规时间已定局：一方胜场 ≥13 且另一方仍 ≤11。

        典型如 13:6、13:11；不含 13:12 及以后（12:12 后进入加时，双方均可 ≥12）。
        Demo 此后常有拼刀/庆祝或异常回合，解析出的片段无比赛意义。
        """
        if score_own is None or score_opp is None:
            return False
        lo, hi = min(score_own, score_opp), max(score_own, score_opp)
        return hi >= 13 and lo <= 11

    @staticmethod
    def _match_metrics_from_round_scores(
        round_team_score_map: dict[int, tuple[int, int]],
    ) -> tuple[int, Optional[tuple[int, int]]]:
        """从记分进度里取「已打完的回合总数」与当时的 (own, opp) 终局线。

        每回合恰有一方得分，故开局前 own+opp = 已完赛回合数；取全表最大和即终局前一刻的累计，
        对应比分即终局 freeze 常见示数（如 16:14），用于识别加时结束后的垃圾时间。
        """
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

    @staticmethod
    def _is_post_match_round(
        round_num: int,
        score_own: Optional[int],
        score_opp: Optional[int],
        *,
        completed_rounds: int,
        final_scoreline: Optional[tuple[int, int]],
    ) -> bool:
        """是否应视为正赛已结束后的无意义回合（含 MR12 终局与任意加时终局如 16:14）。"""
        if completed_rounds > 0 and round_num > completed_rounds:
            return True
        if DemoAnalyzer._is_mr12_regulation_decided_score(score_own, score_opp):
            return True
        # 终局比分已冻结仍多出的「回合」；或 demo 回合号错乱但比分已是终局线
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

    @staticmethod
    def _round_start_scores_for_target(
        round_num: int,
        round_team_score_map: dict[int, tuple[int, int]],
    ) -> tuple[Optional[int], Optional[int]]:
        """本回合开局时目标队与对方队的真实比赛胜场（按队伍身份，非阵营角色）。"""
        result = round_team_score_map.get(round_num) if round_team_score_map else None
        if result is None:
            return None, None
        return result[0], result[1]

    @staticmethod
    def _make_clip(
        round_num: int,
        category: str,
        weapon: str,
        kill_count: int,
        tick: int,
        tags: list[str],
        end_tick_override: int | None = None,
        killer_name: Optional[str] = None,
        victims: Optional[list[str]] = None,
        *,
        death_core: bool = False,
        score_own: Optional[int] = None,
        score_opp: Optional[int] = None,
        round_won: Optional[bool] = None,
        clip_min_tick: Optional[int] = None,
    ) -> Clip:
        if death_core:
            start = max(0, tick - int(TICK_RATE * float(_DEATH_CLIP_LEAD_SECONDS)))
        else:
            start = max(0, tick - BUFFER_SECONDS_BEFORE * TICK_RATE)
        end = end_tick_override if end_tick_override else tick + BUFFER_SECONDS_AFTER * TICK_RATE
        return Clip(
            clip_id=f"c_{uuid.uuid4().hex[:8]}",
            round=round_num,
            category=category,
            weapon_used=_translate_weapon(weapon),
            kill_count=kill_count,
            start_tick=start,
            end_tick=end,
            context_tags=_dedup_context_tags(tags),
            killer_name=killer_name,
            victims=list(victims) if victims else [],
            score_own=score_own,
            score_opp=score_opp,
            round_won=round_won,
            clip_min_tick=clip_min_tick,
            # fail 片段（death_core=True）的核心事件帧即玩家死亡帧，
            # 击杀者视角 POV 录制需要此字段作为时间锚点。
            death_tick=tick if death_core else None,
        )


# ━━━ 公共工具 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _cell_str(val) -> str:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    if not s or s.lower() == "nan":
        return ""
    return s


def _cell_team(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def _pick_assister_column(df: pd.DataFrame) -> Optional[str]:
    for col in ("assister_name", "assister", "assistor_name"):
        if col in df.columns:
            return col
    return None


def _pick_assister_team_column(df: pd.DataFrame) -> Optional[str]:
    for col in ("assister_team", "assisterteam", "assistersteam"):
        if col in df.columns:
            return col
    return None


def _get_match_start_tick(parser: DemoParser) -> int:
    """
    获取比赛正式开始的 Tick。
    通过解析 round_announce_match_start 事件，取最后一次宣布开始的 Tick
    （使用 max() 可以完美过滤掉拼刀局和前期的多次 Restart，直接定位正赛）。
    """
    try:
        df = _to_pandas_df(parser.parse_event("round_announce_match_start"))
        if not df.empty and "tick" in df.columns:
            return int(df["tick"].max())
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
    return 0


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


def _winner_to_team_num(val: object) -> Optional[int]:
    """
    round_end.winner：CS2 Demo 中多为字符串 CT / T，少数为队伍号 2 / 3。
    team_num 惯例：T = 2，CT = 3。
    """
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        try:
            i = int(float(val))
        except (TypeError, ValueError):
            return None
        if i in (2, 3):
            return i
        return None
    s = str(val).strip().upper()
    if not s or s == "NAN":
        return None
    if s in ("CT", "CTS", "COUNTER-TERRORISTS", "COUNTER_TERRORISTS"):
        return 3
    if s in ("T", "TERRORIST", "TERRORISTS", "TS"):
        return 2
    try:
        i = int(float(s))
        if i in (2, 3):
            return i
    except (TypeError, ValueError):
        pass
    return None


def _count_team_wins_from_round_end_df(re_df: pd.DataFrame) -> tuple[int, int]:
    team_a = 0
    team_b = 0
    if re_df.empty:
        return team_a, team_b
    wcol = next((c for c in re_df.columns if str(c).lower() == "winner"), None)
    if wcol is None:
        return team_a, team_b
    for _, row in re_df.iterrows():
        tm = _winner_to_team_num(row.get(wcol))
        if tm == 2:
            team_a += 1
        elif tm == 3:
            team_b += 1
    return team_a, team_b


def _infer_total_rounds_from_round_end(re_df: pd.DataFrame, match_start_tick: int) -> int:
    """用 round_end 的 round 序号估计总回合数（与 total_rounds_played+1 接近）。"""
    if re_df.empty or "round" not in re_df.columns:
        return 0
    df = re_df
    if match_start_tick > 0 and "tick" in re_df.columns:
        df = re_df.loc[
            pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()
    if df.empty:
        return 0
    mx = pd.to_numeric(df["round"], errors="coerce").max()
    if pd.isna(mx):
        return 0
    return int(mx) + 1


def _norm_steam_id(val: object) -> str:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def _winner_side_engine_num(w: object) -> Optional[int]:
    """本回合胜者对应的 engine team_num：T 方 = 2，CT 方 = 3（换边后仍表示当回合阵营）。"""
    if w is None or (isinstance(w, float) and pd.isna(w)):
        return None
    s = str(w).strip().upper()
    if s in ("T", "TERRORIST", "TERRORISTS", "TS"):
        return 2
    if s in ("CT", "CTS", "COUNTER-TERRORISTS", "COUNTER_TERRORISTS"):
        return 3
    return _winner_to_team_num(w)


def _max_demo_tick(parser: DemoParser, re_df: pd.DataFrame, match_start_tick: int) -> int:
    mx = 0
    if not re_df.empty and "tick" in re_df.columns:
        v = pd.to_numeric(re_df["tick"], errors="coerce").max()
        if not pd.isna(v):
            mx = max(mx, int(v))
    try:
        de = _to_pandas_df(parser.parse_event("player_death"))
        if not de.empty and "tick" in de.columns:
            if match_start_tick > 0:
                de = de.loc[
                    pd.to_numeric(de["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ]
            v2 = pd.to_numeric(de["tick"], errors="coerce").max()
            if not de.empty and not pd.isna(v2):
                mx = max(mx, int(v2))
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
    return mx


def _duration_mins_from_tick_span(match_start_tick: int, max_tick: int) -> int:
    if max_tick <= 0:
        return 0
    start = max(0, int(match_start_tick))
    return int(max(0, max_tick - start) / float(TICK_RATE) / 60.0)


def _scoreline_by_starting_roster(
    parser: DemoParser,
    match_start_tick: int,
    re_df: pd.DataFrame,
) -> tuple[int, int]:
    """
    按开赛时 engine 队伍号（2 / 3）归属累计胜场。
    round_end.winner 的 T/CT 表示「当回合」哪一侧获胜；换边后同一支战队会先后占用 2 与 3，
    因此必须把胜场记回开赛时同一批 Steam 所在的那一侧，才能与 5E/HLTV 大比分一致。
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


def collect_match_summary_metrics(
    parser: DemoParser,
    dem_path: Path,
    match_start_tick: int,
) -> tuple[int, int, str, int, int]:
    """
    全局比赛信息：开赛时 Team2 / Team3 阵容各自胜场、Demo 文件时间、时长（分钟）、总回合。
    """
    team_a_score = 0
    team_b_score = 0
    # Demo 内无可靠真实开赛时间，不向客户端展示误导性的文件时间
    match_date = ""
    duration_mins = 0
    total_rounds_est = 0

    duration_header = 0
    try:
        header = parser.parse_header()
        raw_pt = header.get("playback_time", 0)
        duration_header = int(float(raw_pt) // 60) if raw_pt is not None else 0
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        duration_header = 0

    try:
        re_df = _to_pandas_df(parser.parse_event("round_end"))
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        re_df = pd.DataFrame()

    if re_df.empty:
        return team_a_score, team_b_score, match_date, duration_mins, total_rounds_est

    re_filtered = re_df
    if match_start_tick > 0 and "tick" in re_df.columns:
        re_filtered = re_df.loc[
            pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()

    if match_start_tick > 0:
        team_a_score, team_b_score = _scoreline_by_starting_roster(
            parser, match_start_tick, re_df,
        )
    if team_a_score == 0 and team_b_score == 0:
        team_a_score, team_b_score = _count_team_wins_from_round_end_df(re_filtered)
        if team_a_score == 0 and team_b_score == 0 and match_start_tick > 0:
            ua, ub = _count_team_wins_from_round_end_df(re_df)
            if ua + ub > 0:
                team_a_score, team_b_score = ua, ub

    total_rounds_est = team_a_score + team_b_score
    if total_rounds_est <= 0:
        total_rounds_est = _infer_total_rounds_from_round_end(re_df, match_start_tick)

    max_tick = _max_demo_tick(parser, re_df, match_start_tick)
    duration_ticks = _duration_mins_from_tick_span(match_start_tick, max_tick)
    duration_mins = max(duration_header, duration_ticks)

    return team_a_score, team_b_score, match_date, duration_mins, total_rounds_est


def get_demo_match_summary(dem_path: str | Path) -> dict[str, object]:
    """
    上传后即刻可用的比赛摘要（无需选定玩家）。
    与 MatchMeta JSON 形状一致，便于前端共用计分板；target_kills/deaths 在深度解析前为 0。
    """
    path = Path(dem_path)
    fallback: dict[str, object] = {
        "map_name": "unknown",
        "target_player": "",
        "target_player_user_id": None,
        "target_steam_id": None,
        "total_rounds": 0,
        "target_kills": 0,
        "target_deaths": 0,
        "team_a_score": 0,
        "team_b_score": 0,
        "match_date": "",
        "duration_mins": 0,
    }
    try:
        parser = DemoParser(str(path))
        mst = _get_match_start_tick(parser)
        ta, tb, md, dm, tr_est = collect_match_summary_metrics(parser, path, mst)
        try:
            mn = parser.parse_header().get("map_name", "unknown") or "unknown"
        except BaseException as e:
            if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                raise
            mn = "unknown"
        return {
            "map_name": mn,
            "target_player": "",
            "target_player_user_id": None,
            "target_steam_id": None,
            "total_rounds": int(tr_est),
            "target_kills": 0,
            "target_deaths": 0,
            "team_a_score": int(ta),
            "team_b_score": int(tb),
            "match_date": md,
            "duration_mins": int(dm),
        }
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        logger.warning(
            "get_demo_match_summary: unreadable or corrupt demo %s (%s)",
            path,
            type(e).__name__,
        )
        return dict(fallback)


def _build_tick_team_lookup(parser: DemoParser, ticks: list[int]) -> dict[int, dict[str, int]]:
    """
    在若干 tick 上解析全场玩家 team_num + name。
    CS2 的 player_death 事件往往不带 attackerteam/userteam，必须用 tick 快照补队伍。
    """
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


def _user_id_cell(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        i = int(float(val))
    except (ValueError, TypeError):
        return None
    if i < 0:
        return None
    return i


def build_player_name_to_user_id(parser: DemoParser, match_start_tick: int) -> dict[str, int]:
    """
    从 player_death 的 user_id 扩展字段建立「昵称 -> 引擎 user id」（死亡事件里 victim/attacker 的 id）。
    注意：这与观战 ``spec_player`` 用的「记分板槽位」通常不是同一个数；槽位请用 ``compute_spec_player_slot_one_based``。
    """
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


def _steam_id_cell(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, bool):
        return None
    try:
        if isinstance(val, int):
            i = int(val)
        else:
            s = str(val).strip()
            if not s or s.lower() == "nan":
                return None
            if s.endswith(".0") and s[:-2].isdigit():
                s = s[:-2]
            i = int(s)
    except (ValueError, TypeError):
        return None
    if i <= 0:
        return None
    return i


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


def _spec_player_id_offset(
    dem_path: str | Path | None = None,
    observed_user_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> int:
    """
    ``parse_ticks`` 里每条玩家的 ``user_id`` 与客户端 ``spec_player`` 常用编号之差。
    仅做数据形态级兜底：若本场观测到 0-based user_id（含 0），转换为 1-based。
    平台差异由录制期 GSI 校准表处理，不在这里按平台名猜测。
    可用环境变量 ``CS2_SPEC_PLAYER_SLOT_OFFSET`` 覆盖。
    """
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
    """
    Extra fallback used only when GSI cannot expose a reliable current-player/spec mapping.
    ``compute_spec_player_slot_one_based`` already handles raw 0..9 and shifted 2..11/3..12
    shapes. A raw 1..10 table in some third-party demos still maps to console 2..11, so add
    one only for that data shape.
    """
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
    """
    在某一 tick 快照上建立「玩家昵称(小写) -> ``spec_player`` 应传入的整数」。
    数值为 ``parse_ticks`` 的 ``user_id`` + ``_spec_player_id_offset()``。
    """
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
    """旧版启发式：(team_num, steamid) 排序；与引擎槽位常不一致，仅作无 user_id 时的回退。"""
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
    """
    在当前 tick 的快照上解析目标玩家的观战槽位，供控制台 ``spec_player`` 使用。

    **优先**使用 demoparser2 ``parse_ticks`` 的 ``user_id``，再按数据形态和
    ``CS2_SPEC_PLAYER_SLOT_OFFSET`` 换算为 ``spec_player`` 实参；录制期不再依赖该推断，
    而是使用 GSI 实测校准表。
    **不要**与 ``player_death`` 里 ``user_user_id`` 混淆。

    若该 tick 无可用 ``user_id``，则回退到旧的 (team_num, steamid) 排序启发式，并同样加上 offset。
    设 ``CS2_SPEC_SLOT_ZERO_BASED=1`` 时仅影响启发式分支的内部序号，最后再统一加 offset。
    """
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
    """
    扫描 Demo 中所有在 player_death 出现过的玩家, 汇总 K/D/A 与队伍。
    返回 list[dict]: name, team, kills, deaths, assists, user_id, steam_id（均为可选）

    其中 ``user_id`` 为解析侧兜底用的观战编号（``parse_ticks`` 的 user_id +
    ``CS2_SPEC_PLAYER_SLOT_OFFSET``/数据形态修正），供前端回传录制接口使用；录制期优先使用
    GSI 校准表。它与 ``player_death`` 事件里的 ``user_user_id`` 不是同一套数字。
    """
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

    # 按 tick 排序, 保证「首次出现队伍」与比赛时间轴一致
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

        # 优先用 tick 快照中的 team_num（与 Demo 内队伍一致）
        if team_by_tick:
            if attacker:
                atk_team = _lookup_team_at_tick(team_by_tick, tick, attacker) or atk_team
            if victim:
                vic_team = _lookup_team_at_tick(team_by_tick, tick, victim) or vic_team
            if assister:
                ast_team = _lookup_team_at_tick(team_by_tick, tick, assister) or ast_team

        # 先记录队伍 (首次出现为准)
        if attacker:
            _set_team_if_missing(attacker, atk_team)
        if victim:
            _set_team_if_missing(victim, vic_team)
        if assister:
            _set_team_if_missing(assister, ast_team)

        # K / D / A
        if victim:
            _touch(victim)["deaths"] += 1

        if attacker and attacker != victim:
            _touch(attacker)["kills"] += 1

        if assister and assister != victim:
            _touch(assister)["assists"] += 1

    # 输出: 按击杀降序、再按名字升序
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

    # parse_player_info 补全尚未在死亡事件中出现过的 steam（如从未被杀过昵称）
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
        # Some third-party demos expose NaN team_num for a player in parse_ticks, while
        # parse_player_info still has a stable team_number. team_number may use the
        # opposite side numbering, so learn its mapping from already resolved players.
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
