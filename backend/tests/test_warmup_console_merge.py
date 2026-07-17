"""录制预热控制台注入：固定 cvar 已迁出硬编码，仅由 record_inject_console_lines 提供。"""

from types import SimpleNamespace

from app.env_utils import OBSConfig
from app.obs_director import (
    OBSDirector,
    RecordingWarmupExtras,
    _apply_voice_filter_to_plan,
)
from app.recording.platform_utils import VOICE_LISTEN_MASK_ALL

FIXED_CVARS = (
    "cl_hud_telemetry_frametime_show 0",
    "engine_no_focus_sleep 0",
    "cl_demo_predict 0",
    "fps_max 0",
    "cl_trueview_show_status 0",
)


def _director(inject_lines: str) -> OBSDirector:
    return OBSDirector(OBSConfig(), "", record_inject_console_lines=inject_lines)


def test_no_fixed_cvars_when_inject_lines_empty():
    director = _director("")
    lines = director._recording_warmup_console_lines(RecordingWarmupExtras())
    for cvar in FIXED_CVARS:
        assert cvar not in lines


def test_fixed_cvars_injected_from_config():
    director = _director("\n".join(FIXED_CVARS))
    lines = director._recording_warmup_console_lines(RecordingWarmupExtras())
    for cvar in FIXED_CVARS:
        assert cvar in lines


def test_keybind_reset_still_forced():
    # 安全闸门不受影响：解绑 + toggleconsole 始终注入
    director = _director("")
    lines = director._recording_warmup_console_lines(RecordingWarmupExtras())
    assert "unbindall" in lines
    assert any("toggleconsole" in l for l in lines)


def test_third_person_camera_injects_the_configured_camera_commands():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(third_person_camera=True)
    )

    third_person_commands = [
        "cam_command 1",
        "cam_idealdist 30",
        "cam_idealyaw 0",
        "cam_idealpitch 0",
        "c_thirdpersonshoulder 1",
        "c_thirdpersonshoulderaimdist 300",
        "c_thirdpersonshoulderdist 40",
        "c_thirdpersonshoulderheight 2",
        "c_thirdpersonshoulderoffset 20",
    ]
    start = lines.index("cam_command 1")
    assert lines[start : start + len(third_person_commands)] == third_person_commands


def test_team_and_enemy_warmup_start_fail_closed():
    director = _director("")

    for mode in ("team", "enemy"):
        lines = director._recording_warmup_console_lines(
            RecordingWarmupExtras(voice_filter=mode)
        )
        assert lines[-4:] == [
            "tv_listen_voice_indices 0",
            "tv_listen_voice_indices_h 0",
            "voice_modenable 1",
            "snd_voipvolume 1",
        ]
        assert "tv_listen_voice_indices -1" not in lines
        assert "tv_listen_voice_indices_h -1" not in lines


def test_mute_does_not_depend_on_snd_voipvolume():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(voice_filter="mute")
    )

    assert lines[-4:] == [
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
        "voice_modenable 0",
        "snd_voipvolume 0",
    ]


def test_open_sets_both_mask_halves_to_all_players():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(voice_filter="open")
    )

    assert lines[-4:] == [
        "voice_modenable 1",
        "snd_voipvolume 1",
        "tv_listen_voice_indices -1",
        "tv_listen_voice_indices_h -1",
    ]


def test_off_leaves_voice_unmanaged():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(voice_filter="off")
    )

    assert not any(line.split()[0] in {
        "voice_modenable",
        "snd_voipvolume",
        "tv_listen_voice_indices",
        "tv_listen_voice_indices_h",
    } for line in lines)


def test_stale_client_voice_commands_cannot_override_team_policy():
    director = _director("tv_listen_voice_indices -1\ntv_listen_voice_indices_h -1")
    lines = director._recording_warmup_console_lines(RecordingWarmupExtras(
        voice_filter="team",
        console_cmds=(
            "cl_draw_only_deathnotices true",
            "snd_voipvolume 1",
            "tv_listen_voice_indices -1",
            "tv_listen_voice_indices_h -1",
        ),
    ))

    assert "cl_draw_only_deathnotices true" in lines
    assert lines[-4:] == [
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
        "voice_modenable 1",
        "snd_voipvolume 1",
    ]


def test_plan_modes_resolve_masks_explicitly():
    segment = SimpleNamespace(
        segment_index=0,
        target_steamid64="76561198000000001",
        voice_listen_mask=3,
        voice_listen_mask_enemy=12,
    )
    plan = SimpleNamespace(segments=[segment], warnings=[])

    assert _apply_voice_filter_to_plan(plan, "open") == "open"
    assert segment.voice_listen_mask == VOICE_LISTEN_MASK_ALL

    segment.voice_listen_mask = 0
    assert _apply_voice_filter_to_plan(plan, "team") == "team"
    assert segment.voice_listen_mask == 0
    assert "muted fail-closed" in plan.warnings[-1]

    assert _apply_voice_filter_to_plan(plan, "off") == "off"
    assert segment.voice_listen_mask is None
