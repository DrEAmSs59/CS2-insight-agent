#!/usr/bin/env python3
"""Test AI recording director with configured LLM (23-kill compilation scenario).

Usage (from repo root):
  set CS2_INSIGHT_CONFIG=%APPDATA%\\cs2-insight-agent\\data\\cs2-insight.config.json
  python backend/scripts/test_ai_director.py
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.env_utils import load_config
from app.recording.ai_director import (
    build_kill_brief_payload,
    outline_to_preview_lines,
    suggest_recording_outline,
)
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
from app.recording.plan_builder import build_plan
from app.recording.planners.ai_directed_planner import plan_from_ai_outline

TICK_RATE = 64.0
PLAYER = TargetPlayer(name="donk_fan", steamid64="76561198012345678", spec_slot=3)
ENEMIES = [
    TargetPlayer(name="mikaStarsAzu", steamid64="76561198011111111", spec_slot=7),
    TargetPlayer(name="s1mple_fan", steamid64="76561198022222222", spec_slot=9),
    TargetPlayer(name="ropz_clone", steamid64="76561198033333333", spec_slot=11),
    TargetPlayer(name="ZywOo_who", steamid64="76561198044444444", spec_slot=13),
]


def _synthetic_23_kill_events() -> list[EventInfo]:
    """Mimic a full-match all-kills compilation on de_inferno."""
    specs = [
        (3, 12000, 0),
        (3, 14500, 0),
        (4, 28000, 1),
        (4, 30200, 2),
        (5, 45000, 0),
        (6, 62000, 3),
        (7, 78000, 1),
        (8, 95000, 2),
        (9, 110000, 0),
        (10, 128000, 1),
        (11, 145000, 3),
        (12, 162000, 0),
        (13, 178000, 2),
        (14, 195000, 1),
        (15, 212000, 0),
        (16, 228000, 3),
        (17, 245000, 1),
        (18, 262000, 2),
        (19, 278000, 0),
        (20, 295000, 1),
        (21, 312000, 3),
        (22, 328000, 0),
        (23, 345000, 2),  # ace-style last kill
    ]
    events: list[EventInfo] = []
    for rnd, tick, ei in specs:
        victim = ENEMIES[ei % len(ENEMIES)]
        events.append(
            EventInfo(
                event_type=EventType.kill,
                tick=tick,
                round=rnd,
                killer=PLAYER,
                victim=victim,
                target_player=PLAYER,
                perspective=Perspective.killer,
            )
        )
    return events


def _make_dto(*, use_ai_director: bool) -> RecordingRequestDTO:
    return RecordingRequestDTO(
        request_id="ai-director-test",
        request_type=RequestType.kill_compilation,
        source_type=SourceType.kill,
        demo=DemoContext(
            demo_path="/demo/de_inferno.dem",
            demo_filename="de_inferno.dem",
            map_name="de_inferno",
            tick_rate=TICK_RATE,
            first_tick=0,
            demo_end_tick=400_000,
            final_round=23,
            final_round_start_tick=330_000,
            final_round_end_tick=360_000,
        ),
        target_player=PLAYER,
        events=_synthetic_23_kill_events(),
        options=RecordingOptions(
            enable_victim_pov=True,
            interleave_pov_pairs=False,
            use_ai_director=use_ai_director,
            kill_compilation_jump_cut_threshold_sec=12.0,
        ),
        source_ref=SourceRef(context_tags=["all_kills", "compilation"]),
    )


async def main() -> int:
    cfg = load_config()
    model = (cfg.llm.model or "").strip() or "(default)"
    base = (cfg.llm.base_url or "").strip() or "(default)"
    print(f"Config LLM: model={model} base_url={base}")
    print()

    dto = _make_dto(use_ai_director=False)
    req = normalize(dto)
    payload = build_kill_brief_payload(req)
    print(f"Synthetic kill compilation: {payload['kill_count']} kills on {payload['map']}")
    print()

    outline, source, llm_error = await suggest_recording_outline(req)
    print(f"=== AI Director ({source}) ===")
    if llm_error:
        print(f"LLM error: {llm_error}")
    print(f"Rationale: {outline.rationale}")
    print()
    for line in outline_to_preview_lines(outline, req):
        print(line)
    print()

    ai_segments = plan_from_ai_outline(req, outline)
    interleaved_all = build_plan(
        dto.model_copy(
            update={
                "options": dto.options.model_copy(update={"interleave_pov_pairs": True}),
            }
        )
    )
    batch_plan = build_plan(dto)

    print("=== Segment counts ===")
    print(f"  AI directed segments:     {len(ai_segments)}")
    print(f"  Legacy batch + victim POV: {len(batch_plan.segments)}")
    print(f"  Full interleaved K→V×23:  {len(interleaved_all.segments)}")
    print()

    kv_ai = sum(1 for s in ai_segments if s.perspective.value == "victim")
    print(f"  AI plan victim POV segments: {kv_ai}")
    print()

    if source != "llm":
        print("WARNING: fell back to heuristic — check API key / base_url / model.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
