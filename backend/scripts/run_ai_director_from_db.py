#!/usr/bin/env python3
"""Run AI director on a real all_kills clip from cs2-insight.db."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.env_utils import load_config, resolve_config_path
from app.recording.ai_director import outline_to_preview_lines, suggest_recording_outline
from app.recording.models import (
    DemoContext,
    EventInfo,
    EventType,
    Perspective,
    RecordingOptions,
    RecordingRequestDTO,
    RequestType,
    SourceRef,
    SourceType,
    TargetPlayer,
)
from app.recording.normalizer import normalize
from app.recording.planners.ai_directed_planner import plan_from_ai_outline


def _find_all_kills_clip(result_json: str, *, kill_count: int | None = None):
    data = json.loads(result_json)
    clips = data.get("clips") or []
    best = None
    for c in clips:
        if c.get("compilation_kind") != "all_kills" and c.get("category") != "compilation":
            continue
        if c.get("compilation_kind") not in ("all_kills", "rival_kills", None):
            continue
        if c.get("compilation_kind") is None and "all_kills" not in (c.get("context_tags") or []):
            continue
        n = len(c.get("kill_ticks") or [])
        if kill_count is not None and n != kill_count:
            continue
        if best is None or n > len(best.get("kill_ticks") or []):
            best = c
    return best, data.get("match_meta") or {}


def _clip_to_dto(clip: dict, demo_path: str, match_meta: dict) -> RecordingRequestDTO:
    player = match_meta.get("target_player") or clip.get("target_player") or ""
    steam = match_meta.get("target_steam_id") or ""
    name_to_steam = match_meta.get("nameToSteamId") or {}
    spec_slot = clip.get("target_spec_slot")
    target = TargetPlayer(name=player, steamid64=str(steam), spec_slot=spec_slot)

    events: list[EventInfo] = []
    for i, tick in enumerate(clip.get("kill_ticks") or []):
        vic_name = (clip.get("victims") or [""])[i] if i < len(clip.get("victims") or []) else ""
        vic_steam = (clip.get("victim_steamid64s") or [""])[i] if i < len(clip.get("victim_steamid64s") or []) else ""
        if not vic_steam and vic_name:
            vic_steam = name_to_steam.get(vic_name, "")
        rnd = (clip.get("source_rounds") or [clip.get("round")])[i] if clip.get("source_rounds") else clip.get("round")
        tags = (clip.get("kill_tag_lists") or [[]])[i] if i < len(clip.get("kill_tag_lists") or []) else []
        weapon = (clip.get("kill_weapons") or [""])[i] if i < len(clip.get("kill_weapons") or []) else ""
        headshot = bool((clip.get("kill_headshots") or [False])[i]) if i < len(clip.get("kill_headshots") or []) else False
        stk = (clip.get("shots_to_kill") or [None])[i] if i < len(clip.get("shots_to_kill") or []) else None
        events.append(
            EventInfo(
                event_type=EventType.kill,
                tick=int(tick),
                round=int(rnd or 0),
                killer=target,
                victim=TargetPlayer(name=vic_name, steamid64=str(vic_steam or "")),
                target_player=target,
                perspective=Perspective.killer,
                weapon=str(weapon or ""),
                headshot=headshot,
                tags=list(tags or []),
                shots_to_kill=int(stk) if stk is not None else None,
            )
        )

    demo = DemoContext(
        demo_path=demo_path,
        demo_filename=os.path.basename(demo_path),
        map_name=clip.get("map_name") or match_meta.get("map_name") or "unknown",
        tick_rate=float(clip.get("tick_rate") or 64),
        first_tick=0,
        demo_end_tick=int(clip.get("clip_max_tick") or clip.get("end_tick") or 0),
        final_round=int(match_meta.get("total_rounds") or 0),
        final_round_start_tick=0,
        final_round_end_tick=0,
    )

    return RecordingRequestDTO(
        request_id=str(uuid.uuid4()),
        request_type=RequestType.kill_compilation,
        source_type=SourceType.kill,
        demo=demo,
        target_player=target,
        events=events,
        options=RecordingOptions(enable_victim_pov=True, use_ai_director=True),
        source_ref=SourceRef(context_tags=list(clip.get("context_tags") or ["all_kills"])),
    )


async def main() -> int:
    import sqlite3

    cfg_path = resolve_config_path()
    db_path = cfg_path.parent / "cs2-insight.db"
    if not db_path.is_file():
        print(f"DB not found: {db_path}")
        return 1

    llm = load_config().llm
    print(f"LLM model={llm.model} base_url={llm.base_url}")
    print(f"DB: {db_path}\n")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    chosen = None
    for row in conn.execute("SELECT demo_path, result_json FROM match_results ORDER BY length(result_json) DESC"):
        clip, meta = _find_all_kills_clip(row["result_json"], kill_count=23)
        if clip:
            chosen = (row["demo_path"], clip, meta)
            break
    conn.close()

    if not chosen:
        print("No 23-kill all_kills compilation found in DB")
        return 1

    demo_path, clip, meta = chosen
    dto = _clip_to_dto(clip, demo_path, meta)
    req = normalize(dto)
    print(f"Demo: {demo_path}")
    print(f"Player: {req.target_player.name} | Map: {req.demo.map_name} | Kills: {len(req.events)}\n")

    outline, source, llm_error = await suggest_recording_outline(req)
    print(f"=== AI Director ({source}) ===")
    if llm_error:
        print(f"LLM error: {llm_error}")
    print(outline.rationale)
    print()
    for line in outline_to_preview_lines(outline, req):
        print(line)
    print()

    segs = plan_from_ai_outline(req, outline)
    victims = sum(1 for s in segs if s.perspective.value == "victim")
    print(f"Segments: {len(segs)} (victim POV: {victims})")
    return 0 if source == "llm" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
