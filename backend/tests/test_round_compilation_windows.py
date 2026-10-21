"""
Parser-level tests for freeze-to-death (回合合集) raw round facts.

Focus: the raw round facts must carry the *real* round_end event tick so the
recording planner can tell a mid-round death (round still
live, no scoreboard) apart from a round-ending death.

Run:  python -m pytest backend/tests/test_round_compilation_windows.py -v
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.features.demo_analysis.clip_builder import build_rival_compilations

TICK_RATE = 64


def _build(round_end_tick_map, selected=(5, 6)):
    """Two mid-match rounds (5, 6) where the target died mid-round."""
    # round -> freeze_end tick
    round_freeze_end_ticks = {5: 10_000, 6: 40_000}
    round_freeze_start_ticks = {5: 9_000, 6: 39_000}
    # target died mid-round in both
    death_records = [
        {"round": 5, "tick": 20_000, "attacker_name": "Enemy"},
        {"round": 6, "tick": 50_000, "attacker_name": "Enemy"},
    ]
    # scores well below MR12 decision so neither round is "post-match".
    # The high-sum entry (round 14) sets completed_rounds=12 so rounds 5/6 are
    # clearly mid-match (round_num <= completed_rounds and != final scoreline).
    round_team_score_map = {5: (2, 2), 6: (3, 2), 14: (7, 5)}
    round_result_map = {5: False, 6: True}
    return build_rival_compilations(
        "TargetPlayer",
        {},  # round_kills (unused for freeze_to_death path)
        death_records,
        round_team_score_map,
        round_result_map,
        round_freeze_end_ticks,
        freeze_to_death_rounds=list(selected),
        round_freeze_start_ticks=round_freeze_start_ticks,
        map_name="de_anubis",
        demo_max_tick=200_000,
        round_end_tick_map=round_end_tick_map,
    )


def _ftd_clip(clips):
    for c in clips:
        if getattr(c, "compilation_kind", None) == "freeze_to_death":
            return c
    raise AssertionError("no freeze_to_death compilation clip produced")


def test_windows_carry_real_round_end_tick():
    # round_end events land well after the deaths (round still live after death)
    round_end_tick_map = {5: 28_000, 6: 58_000}
    clips = _build(round_end_tick_map)
    clip = _ftd_clip(clips)
    windows = {w["round"]: w for w in clip.round_facts}
    assert set(windows) == {5, 6}
    assert windows[5]["round_end_tick"] == 28_000
    assert windows[6]["round_end_tick"] == 58_000
    assert windows[5]["death_tick"] == 20_000
    assert windows[6]["death_tick"] == 50_000
    assert "end_tick" not in windows[5]
    assert "start_tick" not in windows[5]


def test_round_end_tick_absent_falls_back_to_none():
    # a round missing from the map must not crash; field is None
    clips = _build({5: 28_000})  # round 6 absent
    clip = _ftd_clip(clips)
    windows = {w["round"]: w for w in clip.round_facts}
    assert windows[5]["round_end_tick"] == 28_000
    assert windows[6]["round_end_tick"] is None


def test_selection_keeps_unselected_neighbours_and_drops_legacy_windows():
    clip = _ftd_clip(_build({5: 28_000, 6: 58_000}, selected=(5,)))
    result = clip.to_dict()
    assert result["freeze_to_death_round_filter"] == [5]
    assert [r["round"] for r in result["round_facts"]] == [5, 6]
    for field in ("source_ticks", "source_rounds", "source_round_ends", "fixed_segment_pacing",
                  "kill_ticks", "death_tick", "clip_min_tick", "clip_max_tick", "freeze_to_death_round_windows"):
        assert field not in result
