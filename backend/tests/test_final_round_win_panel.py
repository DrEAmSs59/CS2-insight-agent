import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.round_timeline import _timeline_round_record_end_tick

TICK_RATE = 64.0


def _evs(*kill_ticks):
    return [{"type": "kill", "tick": t} for t in kill_ticks]


def test_final_round_uses_win_panel_ceiling_when_available():
    # final round = no next freeze; last kill 19936, win_panel ceiling 19968
    out = _timeline_round_record_end_tick(
        rn=20,
        raw_round_end=19_990,
        tick_rate=TICK_RATE,
        round_freeze_end_ticks={20: 15_000},  # no round 21 → final round
        evs=_evs(19_500, 19_936),
        win_panel_ceiling=19_968,
    )
    assert out == 19_968, out


def test_final_round_falls_back_when_no_win_panel():
    # ceiling None → legacy last_kill + 2.5s tail
    out = _timeline_round_record_end_tick(
        rn=20,
        raw_round_end=19_990,
        tick_rate=TICK_RATE,
        round_freeze_end_ticks={20: 15_000},
        evs=_evs(19_500, 19_936),
        win_panel_ceiling=None,
    )
    assert out == 19_936 + int(2.5 * TICK_RATE), out


def test_final_round_ceiling_ignored_when_at_or_before_last_kill():
    # abnormal: ceiling <= last kill → fall back to legacy tail
    out = _timeline_round_record_end_tick(
        rn=20,
        raw_round_end=19_990,
        tick_rate=TICK_RATE,
        round_freeze_end_ticks={20: 15_000},
        evs=_evs(19_500, 19_936),
        win_panel_ceiling=19_900,
    )
    assert out == 19_936 + int(2.5 * TICK_RATE), out


def test_non_final_round_unaffected_by_win_panel():
    # round 5 has round 6 freeze → mid-round branch, ceiling must be ignored
    out = _timeline_round_record_end_tick(
        rn=5,
        raw_round_end=10_000,
        tick_rate=TICK_RATE,
        round_freeze_end_ticks={5: 5_000, 6: 11_000},
        evs=_evs(9_800),
        win_panel_ceiling=9_000,
    )
    assert out == min(11_000, 10_000 + int(3.0 * TICK_RATE)) or out == 11_000, out
