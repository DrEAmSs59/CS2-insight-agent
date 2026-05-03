"""POV 实验性 HUD 的常量与纯函数（无 obs_director 依赖，避免循环导入）。"""

from __future__ import annotations


def pov_tail_commands(*, teamcounter_numeric: bool, radar_mode: int) -> list[str]:
    """POV 末尾追加：局内玩家显示方式 + 雷达（值由录制前观战选项决定）。"""
    rm = int(radar_mode)
    if rm not in (-1, 0):
        rm = -1
    return [
        f"cl_teamcounter_playercount_instead_of_avatars {'true' if teamcounter_numeric else 'false'}",
        f"cl_drawhud_force_radar {rm}",
    ]


# 与 POV 同时注入、不因 UI 改变的固定项（末尾再由 pov_tail_commands 追加雷达与头像栏）
POV_CORE_FORCED_COMMANDS: list[str] = [
    "cl_draw_only_deathnotices false",
    "cl_trueview_show_status 0",
    "cl_spec_show_bindings 0",
]

# 兼容旧引用（测试或外部导入）
POV_FORCED_COMMANDS: list[str] = [*POV_CORE_FORCED_COMMANDS]

POV_CONFLICT_CVAR_NAMES: frozenset[str] = frozenset(
    {
        "cl_draw_only_deathnotices",
        "cl_trueview_show_status",
        "cl_spec_show_bindings",
        "cl_teamcounter_playercount_instead_of_avatars",
        "cl_drawhud_force_radar",
    },
)


def command_conflicts_with_pov(command: str) -> bool:
    s = str(command).strip().lower()
    if not s or s.startswith("//"):
        return False
    return any(c in s for c in POV_CONFLICT_CVAR_NAMES)
