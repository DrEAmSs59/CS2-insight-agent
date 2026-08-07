"""录制预热控制台注入：固定 cvar 已迁出硬编码，仅由 record_inject_console_lines 提供。"""

import sys
from types import SimpleNamespace

import pytest

from app import win_cs2_console
from app.env_utils import OBSConfig
from app.obs_director import (
    OBSDirector,
    RecordingWarmupExtras,
    _disable_backend_voice_masks,
)
from app.pov_constants import POV_CORE_FORCED_COMMANDS, pov_tail_commands

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


def _voice_lines(lines):
    return [
        line
        for line in lines
        if line.split()[0].lower() in {
            "voice_modenable",
            "snd_voipvolume",
            "tv_listen_voice_indices",
            "tv_listen_voice_indices_h",
        }
    ]


def test_non_pov_only_mutes_global_voice_volume():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(),
        pov_enabled=False,
    )

    assert _voice_lines(lines) == ["snd_voipvolume 0"]


def test_pov_warmup_leaves_voice_to_pov_pipeline():
    director = _director("")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(),
        pov_enabled=True,
    )

    assert _voice_lines(lines) == []
    assert POV_CORE_FORCED_COMMANDS[:2] == [
        "voice_modenable 1",
        "snd_voipvolume 1",
    ]


def test_pov_voice_disable_mutes_after_pov_voice_enablement():
    director = _director("")
    warmup = RecordingWarmupExtras(pov_voice_disabled=True)
    lines = director._recording_warmup_console_lines(warmup, pov_enabled=True)

    assert _voice_lines(lines) == ["snd_voipvolume 0"]
    commands = [
        *POV_CORE_FORCED_COMMANDS,
        *pov_tail_commands(
            teamcounter_numeric=False,
            radar_mode=0,
            voice_disabled=True,
        ),
    ]
    assert commands.index("snd_voipvolume 0") > commands.index("snd_voipvolume 1")


def test_stale_client_voice_commands_cannot_override_non_pov_policy():
    director = _director("voice_modenable 1\nsnd_voipvolume 1")
    lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(
            console_cmds=(
                "cl_draw_only_deathnotices true",
                "voice_modenable 1",
                "snd_voipvolume 1",
                "tv_listen_voice_indices -1",
                "tv_listen_voice_indices_h -1",
            ),
        ),
        pov_enabled=False,
    )

    assert "cl_draw_only_deathnotices true" in lines
    assert _voice_lines(lines) == ["snd_voipvolume 0"]


@pytest.mark.skipif(sys.platform != "win32", reason="CS2 console injection is Windows-only")
def test_demo_seek_commands_are_submitted_with_separate_enter_presses(monkeypatch):
    events: list[str | None] = []
    monkeypatch.setattr(win_cs2_console, "find_cs2_hwnd", lambda: 123)
    monkeypatch.setattr(win_cs2_console, "ensure_cs2_foreground", lambda _timeout: True)
    monkeypatch.setattr(
        win_cs2_console,
        "_post_char",
        lambda _hwnd, code: events.append(chr(code)),
    )
    monkeypatch.setattr(
        win_cs2_console,
        "_post_enter",
        lambda _hwnd: events.append(None),
    )
    monkeypatch.setattr(win_cs2_console.time, "sleep", lambda _seconds: None)

    assert win_cs2_console.inject_console_sequence(
        ["demo_pause", "demo_gototick 5745"],
        skip_console_toggle=True,
        close_console=False,
    )

    submitted: list[str] = []
    current: list[str] = []
    for event in events:
        if event is None:
            submitted.append("".join(current))
            current.clear()
        else:
            current.append(event)

    assert submitted == ["demo_pause", "demo_gototick 5745"]


def test_recording_disables_backend_segment_voice_masks():
    segment = SimpleNamespace(
        segment_index=0,
        target_steamid64="76561198000000001",
        voice_listen_mask=3,
        voice_listen_mask_enemy=12,
    )
    plan = SimpleNamespace(segments=[segment], warnings=[])

    _disable_backend_voice_masks(plan)
    assert segment.voice_listen_mask is None
