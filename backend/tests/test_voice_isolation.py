import asyncio

import pytest

from app.recording.executor import recording_executor as executor_module
from app.recording.executor.recording_executor import (
    VoiceIsolationError,
    _inject_voice_listen_mask,
)
from app.recording.models import (
    DemoContext,
    EventInfo,
    EventType,
    Perspective,
    RecordingOptions,
    RecordingRequestDTO,
    RequestType,
    SourceType,
    TargetPlayer,
)
from app.recording.plan_builder import build_plan
from app.recording.platform_utils import (
    VOICE_LISTEN_MASK_ALL,
    compute_voice_listen_mask,
    compute_voice_listen_mask_enemy,
    select_voice_listen_mask,
    split_voice_listen_mask,
    voice_listen_mask_console_commands,
)


def _roster() -> list[dict]:
    # Names are deliberately non-unique: only SteamID may decide voice identity.
    return [
        {
            "name": "duplicate",
            "steamid64": str(100 + slot),
            "spec_slot": slot,
            "team_num": 3,
        }
        for slot in range(1, 6)
    ] + [
        {
            "name": "duplicate",
            "steamid64": str(200 + slot),
            "spec_slot": slot,
            "team_num": 2,
        }
        for slot in range(6, 11)
    ]


def _highlight_request(*, interleave: bool) -> RecordingRequestDTO:
    killer = TargetPlayer(name="duplicate", steamid64="206", spec_slot=6)
    victim = TargetPlayer(name="duplicate", steamid64="101", spec_slot=1)
    event = EventInfo(
        event_type=EventType.kill,
        tick=1_000,
        round=1,
        killer=killer,
        victim=victim,
        target_player=killer,
        perspective=Perspective.killer,
    )
    return RecordingRequestDTO(
        request_id=f"voice-{interleave}",
        request_type=RequestType.highlight,
        source_type=SourceType.kill,
        demo=DemoContext(
            demo_path="match.dem",
            demo_filename="match.dem",
            map_name="de_mirage",
            tick_rate=64,
            first_tick=0,
            demo_end_tick=10_000,
            final_round=2,
            final_round_start_tick=8_000,
            final_round_end_tick=9_000,
            all_players=_roster(),
        ),
        target_player=killer,
        events=[event],
        options=RecordingOptions(
            enable_victim_pov=True,
            interleave_pov_pairs=interleave,
        ),
    )


@pytest.mark.parametrize("interleave", [False, True])
def test_final_segments_follow_each_pov_steamid(interleave):
    plan = build_plan(_highlight_request(interleave=interleave))

    assert [segment.target_steamid64 for segment in plan.segments] == ["206", "101"]
    assert [segment.voice_listen_mask for segment in plan.segments] == [992, 31]
    assert [segment.voice_listen_mask_enemy for segment in plan.segments] == [31, 992]


def test_voice_mask_uses_exact_steamid_and_skips_unidentified_rows():
    roster = _roster()
    roster.append({"name": "duplicate", "steamid64": "", "spec_slot": 11, "team_num": 2})

    assert compute_voice_listen_mask(roster, 206, 0) == 992
    assert compute_voice_listen_mask_enemy(roster, "206", 0) == 31
    assert compute_voice_listen_mask(roster, "missing", 0) == 0


def test_conflicting_target_team_fails_closed():
    roster = _roster()
    roster.append({"name": "duplicate", "steamid64": "206", "spec_slot": 12, "team_num": 3})

    assert compute_voice_listen_mask(roster, "206", 0) == 0
    assert compute_voice_listen_mask_enemy(roster, "206", 0) == 0


def test_platform_offset_and_invalid_slots_stay_in_64_bits():
    roster = [
        {"steamid64": "target", "spec_slot": 32, "team_num": 2},
        {"steamid64": "overflow", "spec_slot": 64, "team_num": 2},
    ]

    assert compute_voice_listen_mask(roster, "target", 1) == 1 << 32


@pytest.mark.parametrize(
    ("mask", "expected"),
    [
        (0, (0, 0)),
        (1 << 31, (-2_147_483_648, 0)),
        (1 << 32, (0, 1)),
        (1 << 63, (0, -2_147_483_648)),
        (VOICE_LISTEN_MASK_ALL, (-1, -1)),
    ],
)
def test_split_voice_mask_covers_low_and_high_words(mask, expected):
    assert split_voice_listen_mask(mask) == expected


def test_restrictive_mask_commands_reset_both_halves_without_opening_all():
    commands = voice_listen_mask_console_commands((1 << 32) | 1)

    assert commands == [
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
        "tv_listen_voice_indices 1",
        "tv_listen_voice_indices_h 1",
    ]
    assert all(not command.endswith(" -1") for command in commands)


def test_zero_mask_still_clears_both_halves():
    assert voice_listen_mask_console_commands(0) == [
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
    ]


def test_voice_filter_modes_are_explicit_and_fail_closed():
    assert select_voice_listen_mask("off", 3, 12) is None
    assert select_voice_listen_mask("open", 3, 12) == VOICE_LISTEN_MASK_ALL
    assert select_voice_listen_mask("team", 3, 12) == 3
    assert select_voice_listen_mask("enemy", 3, 12) == 12
    assert select_voice_listen_mask("team", 0, 12) == 0
    assert select_voice_listen_mask("mute", 3, 12) == 0
    assert select_voice_listen_mask("all", 3, 12) == 0
    assert select_voice_listen_mask("unexpected", 3, 12) == 0


def test_executor_voice_injection_checks_boolean_result(monkeypatch):
    captured = []

    def inject(commands):
        captured.append(commands)
        return True

    monkeypatch.setattr(executor_module, "inject_console_sequence", inject)
    asyncio.run(_inject_voice_listen_mask(3))
    assert captured == [[
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
        "tv_listen_voice_indices 3",
        "tv_listen_voice_indices_h 0",
    ]]

    monkeypatch.setattr(executor_module, "inject_console_sequence", lambda _commands: False)
    with pytest.raises(VoiceIsolationError, match="returned false"):
        asyncio.run(_inject_voice_listen_mask(3))


def test_executor_voice_injection_wraps_exceptions(monkeypatch):
    def inject(_commands):
        raise RuntimeError("console unavailable")

    monkeypatch.setattr(executor_module, "inject_console_sequence", inject)
    with pytest.raises(VoiceIsolationError, match="console unavailable"):
        asyncio.run(_inject_voice_listen_mask(3))
