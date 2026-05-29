"""名牌烧录：从 recorded_clips 行解析 category / 眉标 / 标签 / RESULT。"""

from __future__ import annotations

import re
from typing import Any, Optional

# 与 video_composer._CATEGORY_EYEBROW 对齐；非时间线片段使用
_EYEBROW_BY_CATEGORY: dict[str, str] = {
    "highlight": "HIGHLIGHT · 高光",
    "fail": "LOWLIGHT · 下饭",
    "meme_death": "MEME · 梗死亡",
    "compilation": "ROUND · 合集",
}

_KILL_COUNT_TAGS: frozenset[str] = frozenset({
    "五杀 (ACE)",
    "四杀",
    "三杀",
    "双杀",
    "单杀",
})

_KILL_COUNT_BY_N: dict[int, str] = {1: "单杀", 2: "双杀", 3: "三杀", 4: "四杀", 5: "五杀 (ACE)"}

# 名牌 tag 区只保留解析梗/场景标签；击杀对象与凶手信息不进 tag（时间线片段除外）
_NAME_CARD_FILTER_COMBAT_TAGS = frozenset({
    "highlight",
    "fail",
    "compilation",
    "meme_death",
})

_RIVAL_STAT_TAG = re.compile(r"^.+\s×\s*\d+\s*$")


def _timeline_kind(row: dict[str, Any]) -> Optional[str]:
    """时间线片段子类型：kill | death | round；非时间线返回 None。"""
    wck = str(
        row.get("workbench_clip_kind") or row.get("recording_request_type") or ""
    ).strip()
    if wck == "timeline_kill":
        return "kill"
    if wck == "timeline_death":
        return "death"
    if wck == "timeline_round":
        return "round"

    ts = str(row.get("timeline_source") or "").strip()
    kind = str(row.get("timeline_record_kind") or "").strip()
    if ts == "round_timeline_round" or kind == "round":
        return "round"
    if ts == "round_timeline_event" or str(row.get("category") or "").strip().lower() == "timeline":
        if kind == "kill":
            return "kill"
        if kind == "death":
            return "death"
        if kind == "round":
            return "round"
    return None


def _round_number(row: dict[str, Any]) -> Optional[int]:
    r = row.get("round")
    if r is not None:
        try:
            n = int(r)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    src = row.get("source_rounds")
    if isinstance(src, list) and src:
        try:
            n = int(src[0])
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    return None


def _format_round_eyebrow(row: dict[str, Any]) -> str:
    n = _round_number(row)
    if n is not None:
        return f"ROUND {n}"
    return "ROUND · 时间线"


def resolve_name_card_category(row: dict[str, Any]) -> str:
    """时间线片段 DB 里 category 常为 timeline；映射到高光/下饭/合集配色。"""
    cat = str(row.get("category") or "").strip().lower()
    wck = str(
        row.get("workbench_clip_kind") or row.get("recording_request_type") or ""
    ).strip()
    kind = str(row.get("timeline_record_kind") or "").strip()

    if wck == "timeline_kill" or (cat == "timeline" and kind == "kill"):
        return "highlight"
    if wck == "timeline_death" or (cat == "timeline" and kind == "death"):
        return "fail"
    if wck == "timeline_round" or cat == "timeline_round" or (
        cat == "timeline" and kind == "round"
    ):
        return "compilation"
    if wck in ("kill_compilation", "death_compilation", "round_compilation"):
        return "compilation"
    if cat in _EYEBROW_BY_CATEGORY:
        return cat
    if cat == "meme_death":
        return "meme_death"
    return "highlight"


def resolve_name_card_eyebrow(row: dict[str, Any], category: str) -> str:
    tk = _timeline_kind(row)
    if tk:
        base = _format_round_eyebrow(row)
        if tk == "round":
            return f"{base} · 整回合"
        return base
    return _EYEBROW_BY_CATEGORY.get(category, _EYEBROW_BY_CATEGORY["highlight"])


def _weapon_chip(row: dict[str, Any]) -> str:
    raw = str(row.get("weapon_used") or "").strip()
    if not raw:
        return ""
    return raw.split(" / ")[0].strip()


def _first_qsl_part(qsl: str) -> str:
    return qsl.split(" · ")[0].strip() if qsl else ""


def _combat_player_names(row: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for v in row.get("victims") or []:
        s = str(v).strip()
        if s:
            names.add(s)
    for k in row.get("killers") or []:
        s = str(k).strip()
        if s:
            names.add(s)
    kn = str(row.get("killer_name") or "").strip()
    if kn:
        names.add(kn)
    return names


def _is_combat_identity_tag(tag: str, combat_names: set[str]) -> bool:
    """是否为「击杀了谁 / 被谁击杀 / 纯玩家名」类 tag，应从名牌 chip 区剔除。"""
    t = tag.strip()
    if not t:
        return True
    if t in combat_names:
        return True
    if t.startswith("击杀"):
        return True
    if t.startswith("被 ") and "击杀" in t:
        return True
    if _RIVAL_STAT_TAG.match(t):
        lead = t.lstrip()
        for prefix in ("👉", "💀", "🎯", "🥩", "☠️"):
            if lead.startswith(prefix):
                return True
        for name in combat_names:
            if name and name in t:
                return True
    return False


def _filter_combat_identity_tags(chips: list[str], row: dict[str, Any]) -> list[str]:
    combat_names = _combat_player_names(row)
    return [t for t in chips if t and not _is_combat_identity_tag(t, combat_names)]


def _build_timeline_name_card_tags_and_result(
    row: dict[str, Any],
    kind: str,
) -> tuple[list[str], Optional[str]]:
    chips: list[str] = []
    qsl = str(row.get("queue_summary_line") or "").strip()

    if kind == "kill":
        victims = [str(v).strip() for v in (row.get("victims") or []) if str(v).strip()]
        if victims:
            chips.append(f"击杀 {victims[0]}")
        elif qsl:
            part = _first_qsl_part(qsl)
            chips.append(part if part.startswith("击杀") else (part or "击杀"))
        wpn = _weapon_chip(row)
        if wpn and wpn not in chips:
            chips.append(wpn)
        return chips, None

    if kind == "death":
        killer = str(row.get("killer_name") or "").strip()
        if not killer:
            killers = row.get("killers") or []
            if killers:
                killer = str(killers[0]).strip()
        if killer:
            chips.append(f"被 {killer} 击杀")
        elif qsl:
            chips.append(_first_qsl_part(qsl))
        wpn = _weapon_chip(row)
        if wpn and wpn not in chips:
            chips.append(wpn)
        return chips, None

    if kind == "round":
        if qsl:
            chips = [qsl]
        return chips, None

    return chips, None


def build_name_card_tags_and_result(
    row: dict[str, Any],
    category: str,
) -> tuple[list[str], Optional[str]]:
    tk = _timeline_kind(row)
    if tk:
        return _build_timeline_name_card_tags_and_result(row, tk)

    chips: list[str] = [str(t).strip() for t in (row.get("context_tags") or []) if str(t).strip()]
    qsl = str(row.get("queue_summary_line") or "").strip()
    kind = str(row.get("timeline_record_kind") or "").strip()

    if not chips and qsl:
        chips = [qsl]
    elif category == "compilation" and kind == "round" and qsl and not chips:
        chips = [qsl]

    if category in _NAME_CARD_FILTER_COMBAT_TAGS:
        chips = _filter_combat_identity_tags(chips, row)

    result_tag: Optional[str] = None
    if category == "highlight":
        result_tag = next((t for t in chips if t in _KILL_COUNT_TAGS), None)
        if result_tag is None:
            kc = int(row.get("kill_count") or 0)
            if kc in _KILL_COUNT_BY_N:
                result_tag = _KILL_COUNT_BY_N[kc]
        chips = [t for t in chips if t != result_tag]
    else:
        chips = list(chips)

    return chips, result_tag
