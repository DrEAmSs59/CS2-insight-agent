"""LLM-driven recording outline for kill compilations / multi-kill highlights."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Literal, Optional

from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, RateLimitError
from pydantic import BaseModel, Field, ValidationError, field_validator

from ..env_utils import LLMConfig, llm_api_key_configured, llm_base_url_is_local_host, load_config, resolve_config_path
from ..llm_compat import completion_extra_body, message_text, normalize_llm_base_url
from .normalizer import NormalizedRequest
from .models import EventInfo

logger = logging.getLogger(__name__)

BlockType = Literal["killer_merged", "killer_single", "kill_with_victim"]


class AIDirectorBlock(BaseModel):
    type: BlockType
    label: str = ""
    kill_indices: list[int] = Field(default_factory=list)
    kill_index: Optional[int] = None

    @field_validator("kill_indices")
    @classmethod
    def _non_negative_indices(cls, v: list[int]) -> list[int]:
        for i in v:
            if i < 0:
                raise ValueError("kill_indices must be non-negative")
        return v


class AIDirectorOutline(BaseModel):
    blocks: list[AIDirectorBlock]
    rationale: str = ""


DIRECTOR_SYSTEM_PROMPT = """你是 CS2 击杀合辑 / 多杀高光的「导播 + 剪辑大纲」助手。
用户会给你按时间排序的击杀列表（含回合、间隔、受害者、武器、爆头、标签、victim_pov_score 等），你要决定 OBS 录制顺序与是否插入受害者视角。

核心原则：**凡 victim_pov_eligible=true 的颗秒/秒杀击杀，一律 kill_with_victim（全插受害者 POV）。** 非 eligible 的击杀只用击杀者视角。

【仅以下击杀 victim_pov_eligible=true，必须 kill_with_victim】
1. **颗秒 / 秒杀 / 一枪头**：tags 含颗秒/💥/秒杀，或 headshot=true 且 shots_to_kill≤2（含一枪头+一枪身）
2. **禁止**对 victim_pov_eligible=false 使用 kill_with_victim（非爆头、shots_to_kill≥3、普通补枪）

【一般只用击杀者视角（killer_single / killer_merged）】
- 普通步枪点射、补枪、shots_to_kill≥3 的击杀
- 非爆头且无颗秒/秒杀标签的击杀
- 间隔极短的多杀合并段用 killer_merged；其中 eligible 的颗秒/秒杀仍单独 kill_with_victim

【插入顺序】
- blocks 顺序 = 成片时间顺序；每个 eligible 击杀各一个 kill_with_victim block
- 同回合且 gap_sec ≤ jump_cut_threshold 的非 eligible 击杀可 killer_merged
- **跨回合或 gap 超过阈值必须拆 block**

【输出】只输出一行合法 JSON，不要 markdown：
{
  "blocks": [
    {"type": "killer_merged", "kill_indices": [0, 1], "label": "短说明"},
    {"type": "killer_single", "kill_index": 5, "label": "短说明"},
    {"type": "kill_with_victim", "kill_index": 12, "label": "颗秒受害者反应"}
  ],
  "rationale": "100字以内：说明受害者 POV 选在哪几杀、为何、节奏安排"
}

【block 类型】
- killer_merged：连续击杀合并为一段击杀者视角
- killer_single：单杀击杀者视角，不插受害者
- kill_with_victim：该击杀 K→V 连贯（仅高观赏价值）。**必须在 blocks 里单独列出，不能只在 rationale 里写、却用 killer_merged 覆盖该 kill**

【硬性规则】
1. 每个 kill 索引 0..N-1 恰好出现一次
2. blocks 顺序 = 成片顺序
3. **victim_pov_eligible=true 的击杀必须全部 kill_with_victim，不可遗漏**
4. gap_sec ≤ jump_cut_threshold 的同回合短间隔、且非 eligible 的击杀可 killer_merged
5. **禁止**对 victim_pov_eligible=false 的击杀使用 kill_with_victim
6. **rationale 与 blocks 一致：eligible 击杀均应有 kill_with_victim**

【禁止】省略 kill 索引；输出 coverage 以外的顶层字段。"""


def _resolve_api_key(llm: LLMConfig) -> str:
    key = (llm.api_key or "").strip()
    if key.startswith("****"):
        raise ValueError("LLM api_key is masked; paste full key in settings")
    if not key and llm_base_url_is_local_host(llm.base_url):
        return (os.environ.get("CS2_INSIGHT_LOCAL_LLM_API_KEY") or "local").strip() or "local"
    if not llm_api_key_configured(llm.api_key):
        raise ValueError("LLM api_key not configured")
    return key


def _extract_json_object(text: str) -> Optional[dict[str, Any]]:
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def _kill_tags(ev) -> list[str]:
    return list(getattr(ev, "tags", None) or [])


def _tag_blob(tags: list[str]) -> str:
    return " ".join(str(t) for t in tags)


def score_victim_pov_worthiness(
    *,
    tags: list[str],
    headshot: bool = False,
    shots_to_kill: Optional[int] = None,
    weapon: str = "",
) -> float:
    """Higher = more worth recording victim POV (颗秒 / 秒杀 / 一枪头~两枪爆头)."""
    _ = weapon
    blob = _tag_blob(tags)
    if "颗秒" in blob or "💥" in blob or "秒杀" in blob:
        return 12.0
    if headshot and shots_to_kill == 1:
        return 10.0
    if headshot and shots_to_kill == 2:
        return 9.0
    if headshot and shots_to_kill is None and ("爆头" in blob or "一枪头" in blob):
        return 8.0
    return 0.0


def _event_shots_to_kill(ev) -> Optional[int]:
    shots = getattr(ev, "shots_to_kill", None)
    if shots is None:
        return None
    try:
        return int(shots)
    except (TypeError, ValueError):
        return None


def _is_victim_pov_eligible(ev) -> bool:
    """
    受害者 POV：颗秒/秒杀/一枪头，含爆头两枪（一枪头+一枪身）。
    排除：非爆头且无关键标签、shots_to_kill≥3、普通多枪击杀。
    """
    tags = _kill_tags(ev)
    headshot = bool(getattr(ev, "headshot", False))
    stk = _event_shots_to_kill(ev)
    blob = _tag_blob(tags)

    if stk is not None and stk >= 3:
        return False

    if "颗秒" in blob or "💥" in blob or "秒杀" in blob or "一枪头" in blob:
        return True

    if headshot and stk in (1, 2):
        return True

    return False


def _event_victim_pov_score(ev) -> float:
    if not _is_victim_pov_eligible(ev):
        return 0.0
    shots = _event_shots_to_kill(ev)
    return score_victim_pov_worthiness(
        tags=_kill_tags(ev),
        headshot=bool(getattr(ev, "headshot", False)),
        shots_to_kill=shots,
        weapon=str(getattr(ev, "weapon", "") or ""),
    )


def build_kill_brief_payload(req: NormalizedRequest) -> dict[str, Any]:
    """Compact table for the LLM (no raw demo paths)."""
    opts = req.options
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    jump = float(opts.kill_jump_cut_threshold_sec or opts.kill_compilation_jump_cut_threshold_sec or 12.0)
    tick_rate = req.demo.tick_rate or 64.0
    rows: list[dict[str, Any]] = []
    prev_tick: Optional[int] = None
    round_kill_counts: dict[int, int] = {}
    for ev in events:
        round_kill_counts[ev.round] = round_kill_counts.get(ev.round, 0) + 1

    for idx, ev in enumerate(events):
        gap_sec = None
        if prev_tick is not None:
            gap_sec = round((ev.tick - prev_tick) / tick_rate, 2)
        prev_tick = ev.tick
        victim_name = (ev.victim.name if ev.victim else "") or ""
        tags = _kill_tags(ev)
        shots = getattr(ev, "shots_to_kill", None)
        if shots is not None:
            try:
                shots = int(shots)
            except (TypeError, ValueError):
                shots = None
        pov_score = round(_event_victim_pov_score(ev), 1)
        rows.append(
            {
                "index": idx,
                "round": ev.round,
                "tick": ev.tick,
                "gap_sec_since_prev": gap_sec,
                "victim": victim_name,
                "weapon": str(getattr(ev, "weapon", "") or ""),
                "headshot": bool(getattr(ev, "headshot", False)),
                "shots_to_kill": shots,
                "tags": tags,
                "victim_pov_eligible": _is_victim_pov_eligible(ev),
                "victim_pov_score": pov_score,
                "round_kill_count": round_kill_counts.get(ev.round, 1),
            }
        )
    tags = list(req.source_ref.context_tags or []) if req.source_ref else []
    return {
        "map": req.demo.map_name,
        "player": req.target_player.name,
        "kill_count": len(rows),
        "jump_cut_threshold_sec": jump,
        "compilation_kind": req.request_type.value,
        "context_tags": tags,
        "director_hint": "victim_pov_eligible=true 的颗秒/秒杀/爆头≤2枪：全部 kill_with_victim，无数量上限",
        "kills": rows,
    }


def _validate_outline(outline: AIDirectorOutline, kill_count: int) -> None:
    seen: set[int] = set()
    for block in outline.blocks:
        indices: list[int] = []
        if block.type == "killer_merged":
            indices = list(block.kill_indices)
            if len(indices) < 1:
                raise ValueError("killer_merged requires at least one kill_index")
        else:
            if block.kill_index is None:
                raise ValueError(f"{block.type} requires kill_index")
            indices = [block.kill_index]
        for i in indices:
            if i in seen:
                raise ValueError(f"duplicate kill index {i}")
            if i < 0 or i >= kill_count:
                raise ValueError(f"kill index out of range: {i}")
            seen.add(i)
    if seen != set(range(kill_count)):
        missing = sorted(set(range(kill_count)) - seen)
        extra = sorted(seen - set(range(kill_count)))
        raise ValueError(f"coverage mismatch missing={missing} extra={extra}")


def _parse_outline(data: dict[str, Any], kill_count: int) -> AIDirectorOutline:
    outline = AIDirectorOutline.model_validate(data)
    _validate_outline(outline, kill_count)
    return outline


def _indices_in_block(block: AIDirectorBlock) -> list[int]:
    if block.type == "killer_merged":
        return list(block.kill_indices)
    if block.kill_index is not None:
        return [block.kill_index]
    return []


def _promote_kill_to_victim_pov(blocks: list[AIDirectorBlock], idx: int, label: str) -> list[AIDirectorBlock]:
    """Split blocks so kill `idx` becomes kill_with_victim."""
    out: list[AIDirectorBlock] = []
    for block in blocks:
        if block.type == "kill_with_victim" and block.kill_index == idx:
            out.append(block)
            continue
        if block.type != "killer_merged" or idx not in block.kill_indices:
            if block.type != "killer_merged" and block.kill_index == idx:
                out.append(AIDirectorBlock(type="kill_with_victim", kill_index=idx, label=label))
            else:
                out.append(block)
            continue
        parts = block.kill_indices
        pos = parts.index(idx)
        before, after = parts[:pos], parts[pos + 1 :]
        if len(before) == 1:
            out.append(AIDirectorBlock(type="killer_single", kill_index=before[0], label="单杀"))
        elif len(before) > 1:
            out.append(AIDirectorBlock(type="killer_merged", kill_indices=before, label=f"合并 {len(before)} 杀"))
        out.append(AIDirectorBlock(type="kill_with_victim", kill_index=idx, label=label))
        if len(after) == 1:
            out.append(AIDirectorBlock(type="killer_single", kill_index=after[0], label="单杀"))
        elif len(after) > 1:
            out.append(AIDirectorBlock(type="killer_merged", kill_indices=after, label=f"合并 {len(after)} 杀"))
    return out


def _demote_kill_from_victim_pov(blocks: list[AIDirectorBlock], idx: int) -> list[AIDirectorBlock]:
    """Revert kill_with_victim → killer_single when kill is not eligible."""
    out: list[AIDirectorBlock] = []
    for block in blocks:
        if block.type == "kill_with_victim" and block.kill_index == idx:
            out.append(
                AIDirectorBlock(
                    type="killer_single",
                    kill_index=idx,
                    label=block.label or "单杀",
                )
            )
        else:
            out.append(block)
    return out


def _sanitize_victim_pov_outline(outline: AIDirectorOutline, req: NormalizedRequest) -> AIDirectorOutline:
    """Remove victim POV from kills that are not instant headshot / 颗秒."""
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    blocks = list(outline.blocks)
    demoted: list[int] = []
    for block in outline.blocks:
        if block.type != "kill_with_victim" or block.kill_index is None:
            continue
        idx = block.kill_index
        if 0 <= idx < len(events) and not _is_victim_pov_eligible(events[idx]):
            blocks = _demote_kill_from_victim_pov(blocks, idx)
            demoted.append(idx)
    if not demoted:
        return outline
    disp = [i + 1 for i in sorted(set(demoted))]
    note = outline.rationale.strip()
    note += f"（已移除非颗秒/一枪头的受害者 POV：#{', #'.join(map(str, disp))}）"
    logger.info("AI director demoted ineligible victim POV: %s", demoted)
    return AIDirectorOutline(blocks=blocks, rationale=note)


def _to_kill_index(value: int, kill_count: int) -> Optional[int]:
    if 0 <= value < kill_count:
        return value
    if 1 <= value <= kill_count:
        return value - 1
    return None


def _ints_from_list_chunk(chunk: str, kill_count: int) -> list[int]:
    out: list[int] = []
    for part in re.split(r"[,、\s]+", chunk):
        part = part.strip()
        if not part.isdigit():
            continue
        idx = _to_kill_index(int(part), kill_count)
        if idx is not None:
            out.append(idx)
    return out


def _parse_rationale_victim_indices(rationale: str, kill_count: int) -> list[int]:
    """Extract kill indices LLM claimed for victim POV (0-based)."""
    if not rationale or kill_count <= 0:
        return []

    if "仅保留" in rationale:
        tail = rationale.split("仅保留", 1)[1]
        narrow: list[int] = []
        for m in re.finditer(r"[（(]([\d,\s、]+)[）)]", tail):
            narrow.extend(_ints_from_list_chunk(m.group(1), kill_count))
        if not narrow:
            for part in re.findall(r"\b(\d+)\b", tail[:160]):
                idx = _to_kill_index(int(part), kill_count)
                if idx is not None:
                    narrow.append(idx)
        if narrow:
            return sorted(set(narrow))

    found: list[int] = []
    for m in re.finditer(r"索引\s*([\d,\s、及和]+)", rationale):
        found.extend(_ints_from_list_chunk(m.group(1), kill_count))
    for m in re.finditer(r"[（(]([\d,\s、]+)[）)]", rationale):
        found.extend(_ints_from_list_chunk(m.group(1), kill_count))
    if not found:
        for m in re.finditer(r"(?:受害者|victim|POV|爆头|颗秒)[^\d]{0,24}([\d,\s、]+)", rationale, re.I):
            found.extend(_ints_from_list_chunk(m.group(1), kill_count))
    return sorted(set(found))


def _victim_indices_in_outline(outline: AIDirectorOutline) -> set[int]:
    out: set[int] = set()
    for block in outline.blocks:
        if block.type == "kill_with_victim" and block.kill_index is not None:
            out.add(block.kill_index)
    return out


# Victim POV policy: all eligible instant-kill types get K→V
VICTIM_POV_MUST_SCORE = 8.0


def _eligible_victim_pov_indices(events: list) -> list[int]:
    """All kill indices that qualify for victim POV (颗秒/秒杀/HS≤2 shots)."""
    return sorted(i for i, ev in enumerate(events) if _is_victim_pov_eligible(ev))


def count_eligible_victim_pov(events: list) -> int:
    return len(_eligible_victim_pov_indices(events))


def _jump_threshold_sec(req: NormalizedRequest) -> float:
    opts = req.options
    return float(opts.kill_jump_cut_threshold_sec or opts.kill_compilation_jump_cut_threshold_sec or 12.0)


def _is_kill_cluster_end(events: list, idx: int, jump_threshold_sec: float, tick_rate: float) -> bool:
    if idx >= len(events) - 1:
        return True
    ev, nxt = events[idx], events[idx + 1]
    if ev.round != nxt.round:
        return True
    gap = (nxt.tick - ev.tick) / (tick_rate or 64.0)
    return gap > jump_threshold_sec


def _pick_victim_pov_indices(
    events: list,
    n: int,
    *,
    jump_threshold_sec: float = 12.0,
    tick_rate: float = 64.0,
) -> list[int]:
    """All eligible 颗秒/秒杀 kills get victim POV (no cap)."""
    _ = jump_threshold_sec, tick_rate
    if n <= 0:
        return []
    return _eligible_victim_pov_indices(events[:n])


def victim_pov_omitted_kills(outline: AIDirectorOutline, req: NormalizedRequest) -> list[dict[str, Any]]:
    """Eligible kills still missing kill_with_victim after reconcile — for preview UI."""
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    selected = _victim_indices_in_outline(outline)
    omitted: list[dict[str, Any]] = []
    for idx, ev in enumerate(events):
        if not _is_victim_pov_eligible(ev) or idx in selected:
            continue
        score = _event_victim_pov_score(ev)
        victim_name = (ev.victim.name if ev.victim else "") or ""
        omitted.append(
            {
                "index": idx,
                "display_index": idx + 1,
                "victim_pov_score": round(score, 1),
                "victim": victim_name,
                "tags": _kill_tags(ev),
                "headshot": bool(getattr(ev, "headshot", False)),
            }
        )
    omitted.sort(key=lambda row: (-float(row["victim_pov_score"]), -row["index"]))
    return omitted


def _reconcile_victim_pov_outline(outline: AIDirectorOutline, req: NormalizedRequest) -> AIDirectorOutline:
    """
    LLM often writes victim POV in rationale but only emits killer_merged blocks.
    Promote promised / high-score kills to kill_with_victim when missing.
    """
    if not req.options.enable_victim_pov:
        return outline
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    n = len(events)
    if n == 0:
        return outline

    existing = _victim_indices_in_outline(outline)
    ideal = _pick_victim_pov_indices(events, n, jump_threshold_sec=_jump_threshold_sec(req), tick_rate=req.demo.tick_rate or 64.0)

    want: set[int] = {i for i in existing if _is_victim_pov_eligible(events[i])}
    want.update(ideal)

    need = sorted(i for i in want if i not in existing)
    if not need:
        return outline

    blocks = list(outline.blocks)
    for idx in need:
        if idx in _victim_indices_in_outline(AIDirectorOutline(blocks=blocks, rationale="")):
            continue
        ev = events[idx]
        blob = _tag_blob(_kill_tags(ev))
        if "颗秒" in blob or "秒杀" in blob or "💥" in blob:
            label = "颗秒+受害者"
        elif bool(getattr(ev, "headshot", False)):
            label = "一枪头+受害者"
        else:
            label = "受害者反应"
        blocks = _promote_kill_to_victim_pov(blocks, idx, label)

    disp = [i + 1 for i in need]
    note = outline.rationale.strip()
    note += f"（系统已补全 kill_with_victim：#{', #'.join(map(str, disp))}）"
    logger.info("AI director reconciled victim POV blocks: %s", need)
    return AIDirectorOutline(blocks=blocks, rationale=note)


def _heuristic_outline(req: NormalizedRequest) -> AIDirectorOutline:
    """Fallback: merge by jump threshold; victim POV on high-score kills (颗秒等)."""
    opts = req.options
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    n = len(events)
    if n == 0:
        return AIDirectorOutline(blocks=[], rationale="无击杀事件")
    threshold = float(opts.kill_jump_cut_threshold_sec or opts.kill_compilation_jump_cut_threshold_sec or 12.0)
    tick_rate = req.demo.tick_rate or 64.0
    threshold_ticks = int(threshold * tick_rate)

    blocks: list[AIDirectorBlock] = []
    group: list[int] = []
    prev_tick: Optional[int] = None

    def flush() -> None:
        nonlocal group
        if not group:
            return
        if len(group) == 1:
            blocks.append(AIDirectorBlock(type="killer_single", kill_index=group[0], label="单杀"))
        else:
            blocks.append(
                AIDirectorBlock(
                    type="killer_merged",
                    kill_indices=group,
                    label=f"合并 {len(group)} 杀",
                )
            )
        group = []

    for idx, ev in enumerate(events):
        if prev_tick is not None and ev.tick - prev_tick <= threshold_ticks and group:
            group.append(idx)
        else:
            flush()
            group = [idx]
        prev_tick = ev.tick
    flush()

    has_meta = any(_event_victim_pov_score(ev) > 0 for ev in events)
    if opts.enable_victim_pov and n >= 1:
        jump = _jump_threshold_sec(req)
        tick_rate = req.demo.tick_rate or 64.0
        victim_picks = _pick_victim_pov_indices(events, n, jump_threshold_sec=jump, tick_rate=tick_rate)
        for idx in victim_picks:
            ev = events[idx]
            tags = _kill_tags(ev)
            blob = _tag_blob(tags)
            if "颗秒" in blob or "秒杀" in blob or "💥" in blob:
                label = "颗秒+受害者"
            elif bool(getattr(ev, "headshot", False)):
                label = "一枪头+受害者"
            else:
                label = "受害者反应"
            blocks = _promote_kill_to_victim_pov(blocks, idx, label)

    meta_note = "" if has_meta else "（击杀无颗秒/一枪头元数据，请重新解析 demo）"
    outline = AIDirectorOutline(
        blocks=blocks,
        rationale=f"规则回退：按跳剪合并；受害者 POV 仅颗秒/一枪头{meta_note}",
    )
    return finalize_ai_director_outline(outline, req)


def finalize_ai_director_outline(outline: AIDirectorOutline, req: NormalizedRequest) -> AIDirectorOutline:
    """Sanitize ineligible victim POV + reconcile + split over-long killer_merged blocks."""
    from .planners.ai_directed_planner import normalize_outline_jump_cuts

    outline = _sanitize_victim_pov_outline(outline, req)
    outline = _reconcile_victim_pov_outline(outline, req)
    outline = _sanitize_victim_pov_outline(outline, req)
    return normalize_outline_jump_cuts(outline, req)


def _block_contains_index(block: AIDirectorBlock, idx: int) -> bool:
    if block.type == "killer_merged":
        return idx in block.kill_indices
    return block.kill_index == idx


def _event_needs_meta_enrich(ev: EventInfo) -> bool:
    return not _kill_tags(ev) and _event_victim_pov_score(ev) <= 0


def enrich_kill_events_from_library(req: NormalizedRequest) -> tuple[NormalizedRequest, list[str]]:
    """Fill missing per-kill tags from demo library (highlights + all_kills metadata)."""
    notes: list[str] = []
    if not req.events or not any(_event_needs_meta_enrich(ev) for ev in req.events):
        return req, notes

    clips = _load_match_clips_for_demo(req.demo.demo_path)
    if not clips:
        notes.append("AI director: 部分击杀缺少标签，且 demo 库无解析结果可补全")
        return req, notes

    tick_meta = _build_tick_kill_meta(clips)
    if not tick_meta:
        notes.append("AI director: demo 库中未找到可匹配的击杀标签")
        return req, notes

    new_events: list[EventInfo] = []
    enriched = 0
    for ev in req.events:
        if not _event_needs_meta_enrich(ev):
            new_events.append(ev)
            continue
        m = tick_meta.get(ev.tick)
        if not m:
            new_events.append(ev)
            continue
        stk = m.get("shots_to_kill")
        try:
            stk = int(stk) if stk is not None else ev.shots_to_kill
        except (TypeError, ValueError):
            stk = ev.shots_to_kill
        new_events.append(
            ev.model_copy(
                update={
                    "tags": list(m.get("tags") or []),
                    "headshot": bool(m.get("headshot")) or ev.headshot,
                    "weapon": str(m.get("weapon") or ev.weapon or ""),
                    "shots_to_kill": stk,
                }
            )
        )
        enriched += 1

    if enriched == 0:
        notes.append("AI director: 未能从 demo 库匹配缺失标签的击杀 tick")
        return req, notes

    from dataclasses import replace

    notes.append(f"AI director: 已从 demo 库补全 {enriched}/{len(req.events)} 个击杀标签")
    return replace(req, events=new_events), notes


def _load_match_clips_for_demo(demo_path: str) -> Optional[list[dict[str, Any]]]:
    """Load parsed clips from cs2-insight.db (sync; for AI director enrichment)."""
    import sqlite3
    from pathlib import Path

    raw = (demo_path or "").strip()
    if not raw:
        return None
    db_path = resolve_config_path().parent / "cs2-insight.db"
    if not db_path.is_file():
        return None

    def _fetch(path: str) -> Optional[str]:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT result_json FROM match_results WHERE demo_path = ? ORDER BY id DESC LIMIT 1",
                (path,),
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    blob = _fetch(raw)
    if not blob:
        base = Path(raw).name
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT result_json FROM match_results WHERE demo_path LIKE ? ORDER BY id DESC LIMIT 1",
                (f"%{base}",),
            ).fetchone()
            blob = row[0] if row else None
        finally:
            conn.close()
    if not blob:
        return None
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        return None
    clips = data.get("clips")
    return clips if isinstance(clips, list) else None


def _build_tick_kill_meta(clips: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Map kill tick -> tags / headshot / weapon from parsed clips."""
    meta: dict[int, dict[str, Any]] = {}

    def _merge_tick(tick: int, entry: dict[str, Any]) -> None:
        if tick <= 0:
            return
        prev = meta.get(tick, {})
        tags = list(entry.get("tags") or [])
        if tags:
            prev["tags"] = tags
        if entry.get("headshot"):
            prev["headshot"] = True
        if entry.get("weapon"):
            prev["weapon"] = entry["weapon"]
        if entry.get("shots_to_kill") is not None:
            prev["shots_to_kill"] = entry["shots_to_kill"]
        meta[tick] = prev

    for clip in clips:
        if not isinstance(clip, dict):
            continue
        if clip.get("compilation_kind") == "all_kills":
            kills = clip.get("kill_ticks") or []
            tag_lists = clip.get("kill_tag_lists") or []
            headshots = clip.get("kill_headshots") or []
            weapons = clip.get("kill_weapons") or []
            shots = clip.get("shots_to_kill") or []
            for i, kt in enumerate(kills):
                try:
                    tick = int(kt)
                except (TypeError, ValueError):
                    continue
                tags = tag_lists[i] if i < len(tag_lists) else []
                hs = bool(headshots[i]) if i < len(headshots) else False
                w = weapons[i] if i < len(weapons) else ""
                stk = shots[i] if i < len(shots) else None
                _merge_tick(tick, {"tags": tags, "headshot": hs, "weapon": w, "shots_to_kill": stk})
        elif clip.get("category") == "highlight":
            ctx = [
                str(t).strip()
                for t in (clip.get("context_tags") or [])
                if str(t).strip() and not str(t).startswith("🎯")
            ]
            if not ctx:
                continue
            blob = _tag_blob(ctx)
            hs = "爆头" in blob or "颗秒" in blob or "headshot" in blob.lower()
            for kt in clip.get("kill_ticks") or []:
                try:
                    tick = int(kt)
                except (TypeError, ValueError):
                    continue
                if tick in meta and meta[tick].get("tags"):
                    continue
                _merge_tick(tick, {"tags": ctx, "headshot": hs})

    return meta


def _is_zhipu_glm_model(model: str, base_url: Optional[str]) -> bool:
    from ..llm_compat import is_zhipu_glm_model

    return is_zhipu_glm_model(model, base_url)


def _completion_extra_body(model: str, base_url: Optional[str]) -> Optional[dict[str, Any]]:
    return completion_extra_body(model, base_url)


def _message_text(message) -> str:
    return message_text(message)


def _format_llm_error(exc: BaseException) -> str:
    """Human-readable LLM/API failure for UI."""
    name = type(exc).__name__
    msg = str(exc).strip()
    if not msg:
        msg = repr(exc)
    body = getattr(exc, "body", None)
    if body and body not in msg:
        try:
            extra = json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)
            if extra and extra not in msg:
                msg = f"{msg} | {extra}"
        except (TypeError, ValueError):
            pass
    return f"{name}: {msg}"


async def suggest_recording_outline(
    req: NormalizedRequest,
    *,
    llm: Optional[LLMConfig] = None,
    timeout_sec: float = 180.0,
    locale: str = "zh",
) -> tuple[AIDirectorOutline, str, Optional[str]]:
    """
    Returns (outline, source, llm_error).
    source is 'llm' or 'heuristic'. llm_error is set when LLM path failed and outline is heuristic fallback.
    """
    req, enrich_notes = enrich_kill_events_from_library(req)
    payload = build_kill_brief_payload(req)
    kill_count = payload["kill_count"]
    if kill_count == 0:
        return AIDirectorOutline(blocks=[], rationale="无击杀"), "heuristic", None

    flashy = sum(1 for row in payload.get("kills", []) if float(row.get("victim_pov_score") or 0) >= 4.0)
    if flashy == 0 and enrich_notes:
        payload["metadata_gap"] = (
            "部分击杀仍无颗秒/爆头标签；若合辑应有名场面，请重新解析 demo 以写入 kill_tag_lists"
        )
    elif flashy == 0:
        payload["metadata_gap"] = "击杀列表未携带标签/爆头字段，LLM 无法识别颗秒等名场面"

    cfg_llm = llm or load_config().llm
    try:
        api_key = _resolve_api_key(cfg_llm)
    except ValueError as e:
        err = str(e)
        logger.warning("AI director fallback (no API key): %s", err)
        return _heuristic_outline(req), "heuristic", err

    model = (cfg_llm.model or "").strip() or "gpt-4o-mini"
    base_url = normalize_llm_base_url(cfg_llm.base_url)
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout_sec)

    user_msg = (
        "请为以下击杀列表生成录制大纲 JSON。\n"
        f"locale={locale}\n"
        f"payload={json.dumps(payload, ensure_ascii=False)}"
    )

    try:
        create_kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": DIRECTOR_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            "temperature": 0.35,
            "max_tokens": 2048,
        }
        extra_body = _completion_extra_body(model, base_url)
        if extra_body:
            create_kwargs["extra_body"] = extra_body
        resp = await asyncio.wait_for(
            client.chat.completions.create(**create_kwargs),
            timeout=timeout_sec + 5.0,
        )
    except (APITimeoutError, APIConnectionError, RateLimitError, APIError, asyncio.TimeoutError) as e:
        err = _format_llm_error(e)
        logger.warning("AI director LLM failed: %s", err)
        return _heuristic_outline(req), "heuristic", err

    msg = resp.choices[0].message if resp.choices else None
    content = _message_text(msg)
    data = _extract_json_object(content)
    if not data:
        if not content:
            err = (
                "LLM 返回 content 为空（glm-4.7 等智谱模型默认「思考模式」时常见；"
                "已发送 thinking=disabled 并尝试 reasoning_content，仍无 JSON）"
            )
        else:
            snippet = (content[:300] + "…") if len(content) > 300 else content
            err = f"LLM 返回无法解析为 JSON: {snippet!r}"
        logger.warning("AI director unparseable JSON: content=%r", content[:400])
        return _heuristic_outline(req), "heuristic", err

    try:
        outline = _parse_outline(data, kill_count)
        outline = finalize_ai_director_outline(outline, req)
        if enrich_notes and outline.rationale and "均无" in outline.rationale and flashy > 0:
            outline = AIDirectorOutline(
                blocks=outline.blocks,
                rationale=outline.rationale + f"（注：payload 中 {flashy} 个击杀 victim_pov_score≥4）",
            )
        return outline, "llm", None
    except (ValidationError, ValueError) as e:
        err = f"LLM 大纲校验失败: {e}"
        logger.warning("AI director invalid outline: %s raw=%r", e, content[:400])
        return _heuristic_outline(req), "heuristic", err


def outline_to_preview_lines(outline: AIDirectorOutline, req: NormalizedRequest) -> list[str]:
    """Human-readable plan for CLI / API."""
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    lines: list[str] = []
    for i, block in enumerate(outline.blocks):
        if block.type == "killer_merged":
            ticks = [events[j].tick for j in block.kill_indices if j < len(events)]
            vics = sum(1 for _ in block.kill_indices)  # placeholder count
            lines.append(
                f"{i + 1}. [合并击杀×{len(block.kill_indices)}] R? ticks={ticks[:3]}{'…' if len(ticks) > 3 else ''} "
                f"— {block.label or 'merged'}"
            )
        elif block.type == "killer_single":
            ki = block.kill_index or 0
            ev = events[ki] if ki < len(events) else None
            lines.append(
                f"{i + 1}. [仅击杀] idx={ki} R{ev.round if ev else '?'} tick={ev.tick if ev else '?'} "
                f"— {block.label or 'single'}"
            )
        else:
            ki = block.kill_index or 0
            ev = events[ki] if ki < len(events) else None
            vic = (ev.victim.name if ev and ev.victim else "") if ev else ""
            lines.append(
                f"{i + 1}. [击杀→受害者] idx={ki} R{ev.round if ev else '?'} vs {vic} "
                f"— {block.label or 'highlight'}"
            )
    return lines
