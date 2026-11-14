"""Recording-only stock win/MVP reset, composed into each temporary session VPK."""
import json
from pathlib import Path

from .demo_voice_hud import VOICE_SCRIPT_PATH, read_inline_vpk, write_inline_vpk
from .panorama_resource import rewrite_panorama_data

RUNTIME_BEGIN = b"/*__CS2_INSIGHT_ROUND_BANNER_BEGIN__*/"
RUNTIME_END = b"/*__CS2_INSIGHT_ROUND_BANNER_END__*/"


def bind_round_banner_reset(vpk: bytes, demo_path, *, parser=None, assets_dir=None) -> bytes:
    if parser is None:
        from demoparser2 import DemoParser
        parser = DemoParser(str(demo_path))
    def event_ticks(name):
        rows = parser.parse_event(name)
        if hasattr(rows, "to_dict"):
            rows = rows.to_dict(orient="list")
        # The lean parser returns [] for an event absent from this Demo.
        if isinstance(rows, (dict, list)) and not rows:
            return []
        ticks = rows.get("tick") if isinstance(rows, dict) else None
        if not isinstance(ticks, list) or any(type(tick) is not int or tick < 0 for tick in ticks):
            raise ValueError(f"录制回合状态清理无法读取 Demo {name} tick")
        return sorted(set(ticks))
    ticks = event_ticks("round_end")
    # The stock clock is hidden after planting / round_end, and shown again at
    # round_start. Preserve those states when a cut lands inside either phase.
    clock_transitions = sorted(
        [(tick, 0, False, False) for tick in ticks + event_ticks("bomb_planted")]
        + [(tick, 1, True, True) for tick in event_ticks("round_start")]
        + [(tick, 2, True, False) for tick in event_ticks("round_freeze_end")])
    clock_events = [[tick, visible, freezing] for tick, _, visible, freezing in clock_transitions]
    if assets_dir is None:
        from .pov_hud_manager import find_project_root
        assets_dir = find_project_root() / "pov"
    runtime = (Path(assets_dir) / "round_banner.js").read_bytes().replace(b"\r\n", b"\n")
    payload = json.dumps(sorted(set(ticks))).encode("ascii")
    addon = (RUNTIME_BEGIN + b"\nconst sharedRoundEndTicks = " + payload
             + b";\nconst sharedRoundClockEvents = " + json.dumps(clock_events).encode("ascii")
             + b";\n" + runtime + b"\n" + RUNTIME_END)
    entries = read_inline_vpk(vpk)

    def edit(data):
        if data.count(RUNTIME_BEGIN) != data.count(RUNTIME_END) or data.count(RUNTIME_BEGIN) > 1:
            raise ValueError("录制横幅脚本边界无效")
        if RUNTIME_BEGIN in data:
            start, end = data.index(RUNTIME_BEGIN), data.index(RUNTIME_END)
            if end < start:
                raise ValueError("录制横幅脚本边界无效")
            data = data[:start] + data[end + len(RUNTIME_END):]
        anchor = data.rfind(b"\n})();")
        if anchor < 0 or data[anchor:].strip() != b"})();":
            raise ValueError("录制横幅缺少共享 HUD 上下文")
        return data[:anchor] + addon + data[anchor:]

    entries[VOICE_SCRIPT_PATH] = rewrite_panorama_data(entries[VOICE_SCRIPT_PATH], edit)
    return write_inline_vpk(entries)
