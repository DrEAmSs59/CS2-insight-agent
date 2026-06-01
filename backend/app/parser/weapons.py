from __future__ import annotations

import pandas as pd

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
# 半自动狙（自动连发狙）不算颗秒，AWP/SSG08 也排除
_KEQIAO_SEMI_SNIPERS = frozenset({"scar20", "g3sg1"})
_KEQIAO_RIFLES       = frozenset(PRIMARY_WEAPONS) - SNIPER_WEAPONS - _KEQIAO_SEMI_SNIPERS
_KEQIAO_WEAPONS      = _KEQIAO_RIFLES | DEAGLE_VARIANTS
GRENADE_ITEMS = {"flashbang", "hegrenade", "smokegrenade", "molotov", "incgrenade", "decoy"}


def _translate_weapon(raw: str) -> str:
    return WEAPON_TRANSLATION_MAP.get(raw, raw.replace("_", " ").capitalize())


def _highlight_weapon_used_label(kills_sorted: list[dict]) -> str:
    """多杀高光主武器展示：按击杀数降序，同数量按首次出现顺序。"""
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
