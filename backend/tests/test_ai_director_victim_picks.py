#!/usr/bin/env python3
"""Unit tests for AI director victim POV selection."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.recording.ai_director import (
    AIDirectorBlock,
    AIDirectorOutline,
    _is_victim_pov_eligible,
    _pick_victim_pov_indices,
    count_eligible_victim_pov,
    finalize_ai_director_outline,
    victim_pov_omitted_kills,
)
from app.recording.models import (
    DemoContext,
    EventInfo,
    EventType,
    Perspective,
    RecordingOptions,
    TargetPlayer,
)
from app.recording.normalizer import NormalizedRequest

PLAYER = TargetPlayer(name="p", steamid64="1", spec_slot=1)
VICTIM = TargetPlayer(name="v", steamid64="2", spec_slot=2)


def _kill(idx: int, *, tags=None, headshot=False, stk=None, tick=None) -> EventInfo:
    return EventInfo(
        event_type=EventType.kill,
        tick=tick if tick is not None else 1000 + idx * 500,
        round=1 + idx // 5,
        killer=PLAYER,
        victim=VICTIM,
        target_player=PLAYER,
        perspective=Perspective.killer,
        tags=list(tags or []),
        headshot=headshot,
        shots_to_kill=stk,
    )


def _req(events: list[EventInfo]) -> NormalizedRequest:
    return NormalizedRequest(
        request_id="t",
        request_type=__import__("app.recording.models", fromlist=["RequestType"]).RequestType.kill_compilation,
        source_type=__import__("app.recording.models", fromlist=["SourceType"]).SourceType.kill,
        demo=DemoContext(
            demo_path="/x.dem",
            demo_filename="x.dem",
            map_name="de_dust2",
            tick_rate=64.0,
            first_tick=0,
            demo_end_tick=999999,
            final_round=30,
            final_round_start_tick=0,
            final_round_end_tick=0,
        ),
        target_player=PLAYER,
        events=events,
        rounds=[],
        options=RecordingOptions(enable_victim_pov=True),
        source_ref=__import__("app.recording.models", fromlist=["SourceRef"]).SourceRef(),
        warnings=[],
    )


def test_heuristic_picks_all_eligible_instant_kills():
    events = []
    instant_indices = [2, 7, 12, 17, 20, 22]
    for i in range(23):
        if i in instant_indices:
            events.append(_kill(i, tags=["💥 颗秒"], headshot=True, stk=1))
        else:
            events.append(_kill(i))
    picked = _pick_victim_pov_indices(events, 23)
    assert picked == instant_indices
    assert count_eligible_victim_pov(events) == len(instant_indices)


def test_excludes_multi_shot_and_non_headshot():
    events = [
        _kill(0, headshot=True, stk=3),
        _kill(1, headshot=False, stk=1),
        _kill(2, headshot=True, stk=2),
        _kill(3, headshot=True, stk=1),
        _kill(4),
    ]
    picked = _pick_victim_pov_indices(events, len(events))
    assert picked == [2, 3]
    assert not _is_victim_pov_eligible(events[0])
    assert not _is_victim_pov_eligible(events[1])


def test_finalize_keeps_merge_and_adds_every_victim_pov():
    events = []
    for i in range(10):
        if i % 2 == 0:
            events.append(_kill(i, tags=["💥 颗秒"], headshot=True, stk=1))
        else:
            events.append(_kill(i))
    req = _req(events)
    outline = finalize_ai_director_outline(
        AIDirectorOutline(
            blocks=[
                AIDirectorBlock(type="killer_merged", kill_indices=[0, 1, 2, 3, 4], label="连杀"),
                *[AIDirectorBlock(type="killer_single", kill_index=i, label="") for i in range(5, 10)],
            ],
            rationale="test",
        ),
        req,
    )
    victim_blocks = [b for b in outline.blocks if b.type == "kill_with_victim"]
    assert outline.blocks[0].type == "killer_merged_with_victims"
    assert len(victim_blocks) == 5
    assert victim_pov_omitted_kills(outline, req) == []


if __name__ == "__main__":
    test_heuristic_picks_all_eligible_instant_kills()
    test_excludes_multi_shot_and_non_headshot()
    test_finalize_keeps_merge_and_adds_every_victim_pov()
    print("test_ai_director_victim_picks: OK")
