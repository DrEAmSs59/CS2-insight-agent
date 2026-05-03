"""实验性 POV HUD：强制控制台指令与用户参数过滤（录制预热阶段）。"""

from __future__ import annotations

from dataclasses import replace
from typing import Optional

from .obs_director import RecordingWarmupExtras
from .pov_constants import command_conflicts_with_pov
def merge_warmup_extras_for_pov(w: Optional[RecordingWarmupExtras]) -> RecordingWarmupExtras:
    """
    POV 开启时：去掉会与 POV 强制指令冲突的用户 console 行，并强制 cl_draw_only_deathnotices=false。
    若 warmup 为 None，构造一份仅关闭「仅死亡通知」的默认用于预热注入。
    """
    if w is None:
        base = RecordingWarmupExtras(cl_draw_only_deathnotices=False)
    else:
        base = replace(w, cl_draw_only_deathnotices=False)
        cc = base.console_cmds
        if cc:
            filt = tuple(x for x in cc if not command_conflicts_with_pov(x))
            base = replace(base, console_cmds=filt if filt else None)
    return base
