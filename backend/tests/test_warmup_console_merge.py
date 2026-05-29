"""录制预热 console_cmds 与固定 cvar 合并逻辑。"""

from app.obs_director import (
    _WARMUP_FIXED_CONSOLE_LINES,
    _merge_recording_warmup_console_cmds,
)


def test_merge_recording_warmup_console_cmds_adds_missing_fixed_lines():
    # 模拟前端 buildWarmupConsoleCommands：仅含旧版 4 条固定行 + 一条观战 cvar
    user = [
        "cl_hud_telemetry_frametime_show 0",
        "engine_no_focus_sleep 0",
        "cl_demo_predict 0",
        "fps_max 0",
        "cl_draw_only_deathnotices true",
    ]
    merged = _merge_recording_warmup_console_cmds(user)
    assert "cl_trueview_show_status 0" in merged
    assert merged[: len(_WARMUP_FIXED_CONSOLE_LINES)] == list(_WARMUP_FIXED_CONSOLE_LINES)
    assert "cl_draw_only_deathnotices true" in merged
