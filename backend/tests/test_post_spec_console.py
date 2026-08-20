"""spec 切人后补注入：统一白名单过滤 + 执行器参数存储。"""

import pytest

from app.obs_director import (
    OBSDirector,
    RecordingWarmupExtras,
    _filter_post_spec_console_lines,
)
from app.env_utils import OBSConfig


def test_filter_picks_cl_demo_predict():
    lines = ["fps_max 0", "cl_demo_predict 1", "cl_trueview_show_status 2"]
    assert _filter_post_spec_console_lines(lines) == ["cl_demo_predict 1"]


@pytest.mark.parametrize(
    "line",
    [
        'cl_crosshair_drawoutline "0";',
        'cl_crosshair_dynamic_maxdist_splitratio "0.3";',
        'cl_crosshair_dynamic_splitalpha_innermod "1";',
        'cl_crosshair_dynamic_splitalpha_outermod "0.5";',
        'cl_crosshair_dynamic_splitdist "7";',
        'cl_crosshair_outlinethickness "1";',
        'cl_crosshair_t "0";',
        'cl_crosshairalpha "255";',
        'cl_crosshaircolor "5";',
        'cl_crosshaircolor_b "125";',
        'cl_crosshaircolor_g "255";',
        'cl_crosshaircolor_r "255";',
        'cl_crosshairdot "0";',
        'cl_crosshairgap "-4";',
        'cl_crosshairgap_useweaponvalue "0";',
        'cl_crosshairsize "1";',
        'cl_crosshairstyle "4";',
        'cl_crosshairthickness "1";',
        'cl_crosshairusealpha "1";',
        'cl_fixedcrosshairgap "3";',
        'cl_crosshair_recoil "0";',
        'cl_crosshair_sniper_width "2";',
        'cl_ironsight_dot_scale "1";',
        'cl_ironsight_usecrosshaircolor "1";',
        'cl_grenadecrosshair_smoke "0";',
        'cl_grenadecrosshairdelay_flash "1.5";',
        'viewmodel_fov "68";',
        'viewmodel_offset_x "2.5";',
        'viewmodel_offset_y "0";',
        'viewmodel_offset_z "-1.5";',
        'viewmodel_presetpos "2";',
        'cl_prefer_lefthanded "1";',
        "switchhandsleft;",
        "switchhandsright;",
        'hud_showtargetid "0";',
        'cl_showloadout "0";',
        'cl_teamid_overhead_mode "3";',
        'cl_teamid_overhead_colors_show "1";',
        'cl_teamid_overhead_fade_near_crosshair "0";',
        'cl_teamid_overhead_maxdist "9999";',
        'cl_teamid_overhead_maxdist_spec "9999";',
        'cl_drawhud_force_teamid_overhead "1";',
        'mp_forcecamera "0";',
        "apply_crosshair_code CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
    ],
)
def test_filter_picks_player_slot_visual_commands(line):
    assert _filter_post_spec_console_lines([line]) == [line]


def test_filter_empty_when_no_match():
    assert _filter_post_spec_console_lines(["fps_max 0", "cl_trueview_show_status 2"]) == []


def test_filter_does_not_repeat_nondeterministic_hand_toggle():
    assert _filter_post_spec_console_lines(["switchhands"]) == []


def test_filter_case_and_whitespace_insensitive():
    assert _filter_post_spec_console_lines(["  CL_DEMO_PREDICT 1  "]) == ["CL_DEMO_PREDICT 1"]


def test_filter_skips_blank_lines():
    assert _filter_post_spec_console_lines(["", "   ", "cl_demo_predict 1"]) == ["cl_demo_predict 1"]


def test_builtin_recording_options_also_flow_through_post_spec_allowlist():
    director = OBSDirector(OBSConfig(), "", record_inject_console_lines="")
    warmup_lines = director._recording_warmup_console_lines(
        RecordingWarmupExtras(
            hud_showtargetid_hide=True,
            viewmodel_fov_68=True,
        )
    )

    assert _filter_post_spec_console_lines(warmup_lines) == [
        "hud_showtargetid 0",
        "viewmodel_fov 68",
    ]


from app.recording.executor.recording_executor import RecordingExecutor


def test_executor_stores_post_spec_lines():
    ex = RecordingExecutor(None, post_spec_console_lines=["cl_demo_predict 1"])
    assert ex._post_spec_console_lines == ["cl_demo_predict 1"]


def test_executor_defaults_post_spec_empty():
    ex = RecordingExecutor(None)
    assert ex._post_spec_console_lines == []
