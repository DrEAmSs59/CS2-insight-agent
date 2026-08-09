from __future__ import annotations

from ... import native_table as pd
from .cs2_item_catalog import cs2_weapon_translation_map, resolve_weapon_model

WEAPON_TRANSLATION_MAP: dict[str, str] = cs2_weapon_translation_map()
WEAPON_TRANSLATION_MAP.update(
    {
        # Parser/platform aliases and non-economy damage sources.
        "knife_ct": WEAPON_TRANSLATION_MAP["knife"],
        "mac_10": WEAPON_TRANSLATION_MAP["mac10"],
        "inferno": WEAPON_TRANSLATION_MAP["incgrenade"],
        "world": "坠落/世界伤害",
        "planted_c4": "C4 爆炸",
        "defuse_kit": "拆弹器",
    }
)

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
    if w in KNIFE_WEAPONS or resolve_weapon_model(w) in KNIFE_WEAPONS:
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
