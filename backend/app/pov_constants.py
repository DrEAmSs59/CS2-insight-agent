"""POV 实验性 HUD 的常量与纯函数（无 obs_director 依赖，避免循环导入）。"""

from __future__ import annotations


def pov_tail_commands(
    *,
    teamcounter_numeric: bool,
    radar_mode: int,
    voice_disabled: bool = False,
) -> list[str]:
    """POV 末尾追加：局内玩家显示方式 + 雷达（值由录制前观战选项决定）。"""
    rm = int(radar_mode)
    if rm not in (-1, 0):
        rm = -1
    commands = [
        f"cl_teamcounter_playercount_instead_of_avatars {'true' if teamcounter_numeric else 'false'}",
        f"cl_drawhud_force_radar {rm}",
    ]
    # This is deliberately last: POV_CORE_FORCED_COMMANDS first enables the
    # native demo voice path, then the per-session switch can mute its volume.
    if voice_disabled:
        commands.append("snd_voipvolume 0")
    return commands


# 与 POV 同时注入、不因 UI 改变的固定项（末尾再由 pov_tail_commands 追加雷达与头像栏）
POV_CORE_FORCED_COMMANDS: list[str] = [
    # POV owns voice selection dynamically through the Panorama audience mask.
    # Keep the native demo voice path enabled; the script handles per-player
    # unmute/volume and current-POV team filtering.
    "voice_modenable 1",
    "snd_voipvolume 1",
    "cl_draw_only_deathnotices false",
    # GOTV demos keep the local controller on spectator team. mp_forcecamera=1
    # makes native TeamID reject the observed POV's teammates as non-local;
    # zero lets CCSGO_HudReticle follow the observed player's relationship.
    "mp_forcecamera 0",
    "cl_trueview_show_status 0",
    "cl_spec_show_bindings 0",
    "r_spectator_flashbang_opacity 1",
    "cl_radar_always_centered 1",
    "cl_radar_square_always false",
    "cl_radar_rotate true",
    "cl_radar_square_when_spectating 0",
    "cl_radar_scale 0.4",
    # Keep CS2's own footstep/sound visualization authoritative. Panorama must
    # never synthesize replacement circles when the demo has no native event.
    "snd_disable_radar_visualize 0",
    # 0=team color, 12=teammate/player color (HP/ammo accents follow slot colors).
    "cl_hud_color 12",
    # Native CCSGO_HudReticle owns the world-to-screen placement and pooled
    # `.playerid` panels. Mode 3 keeps its name and equipment children alive;
    # the injected demo controller fills the native centered economy line.
    # Force=1 bypasses cl_draw_only_deathnotices and stale user HUD state.
    "cl_drawhud_force_teamid_overhead 1",
    "cl_teamid_overhead_mode 3",
    "cl_teamid_overhead_colors_show 1",
    "cl_teamid_overhead_fade_near_crosshair 0",
    "cl_teamid_overhead_maxdist 9999",
    "cl_teamid_overhead_maxdist_spec 9999",
]
