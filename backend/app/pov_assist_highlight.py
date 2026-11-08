"""Bind ordinary POV assist borders to stock notices without replacing their lifetime."""
from __future__ import annotations

import json
from pathlib import Path
import re

from .demo_voice_hud import VOICE_SCRIPT_PATH, read_inline_vpk, write_inline_vpk
from .panorama_resource import rewrite_panorama_data

BEGIN = b"/*__CS2_INSIGHT_POV_ASSIST_BEGIN__*/"
END = b"/*__CS2_INSIGHT_POV_ASSIST_END__*/"
DATA_BEGIN = b"/*__CS2_INSIGHT_POV_ASSIST_DATA_BEGIN__*/"
DATA_END = b"/*__CS2_INSIGHT_POV_ASSIST_DATA_END__*/"


def build_assist_events(demo_path, *, parser=None):
    try:
        if parser is None:
            from demoparser2 import DemoParser
            parser = DemoParser(str(demo_path))
        rows = parser.parse_event("player_death", player=["clan_name"])
    except Exception as exc:
        raise ValueError(f"Could not read POV assist events: {exc}") from exc
    if hasattr(rows, "to_dict"):
        rows = rows.to_dict(orient="list")
    required = ["tick", "attacker_name", "assister_name", "user_name", "assister_steamid"]
    if isinstance(rows, dict) and not rows.get("tick"):
        return []
    if not isinstance(rows, dict) or any(key not in rows for key in required):
        raise ValueError("POV assist highlights require exact player_death identities")
    count = len(rows["tick"])
    if any(len(column) != count for column in rows.values()):
        raise ValueError("POV assist event columns have inconsistent lengths")

    def name(row, prefix):
        return [str(row.get(prefix + "_name") or ""), str(row.get(prefix + "_clan_name") or "")]

    events = []
    for index in range(count):
        row = {key: values[index] for key, values in rows.items()}
        xuid = row["assister_steamid"]
        # A float SteamID64 has already lost precision; never guess its identity.
        if isinstance(xuid, float) or not re.fullmatch(r"[1-9][0-9]{0,19}", str(xuid)):
            continue
        tick = row["tick"]
        if not isinstance(tick, int) or tick < 0:
            continue
        people = [name(row, prefix) for prefix in ("attacker", "assister", "user")]
        if not all(person[0] for person in people):
            continue
        # Ordinary damage and flash assists share the same authoritative assister.
        events.append({"tick": tick, "xuid": str(xuid), "people": people})
    return sorted(events, key=lambda event: event["tick"])


def bind_pov_assist_highlight(vpk: bytes, demo_path, *, parser=None, assets_dir=None) -> bytes:
    events = build_assist_events(demo_path, parser=parser)
    return compose_pov_assist_highlight(vpk, events, assets_dir=assets_dir)


def compose_pov_assist_highlight(vpk: bytes, events: list, *, assets_dir=None) -> bytes:
    """Bind exact demo identities into the shared POV HUD once per session."""
    if assets_dir is None:
        from .pov_hud_manager import find_project_root
        assets_dir = find_project_root() / "pov"
    runtime = b"\n".join((Path(assets_dir) / name).read_bytes().replace(b"\r\n", b"\n")
                         for name in ("pov_assist_highlight.js", "pov_assist_highlight_runtime.js"))
    payload = json.dumps(events, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    payload = payload.replace(b"/", b"\\u002f")

    def edit(data):
        if data.count(BEGIN) != data.count(END) or data.count(BEGIN) > 1:
            raise ValueError("Invalid POV assist module boundary")
        if BEGIN in data:
            start, end = data.index(BEGIN), data.index(END)
            if end < start:
                raise ValueError("Invalid POV assist module boundary")
            data = data[:start] + data[end + len(END):]
        anchor = data.rfind(b"\n})();")
        if anchor < 0 or data[anchor:].strip() != b"})();":
            raise ValueError("Missing shared POV controller context")
        addon = (BEGIN + b"\nconst povAssistEvents = " + DATA_BEGIN + payload + DATA_END
                 + b";\n" + runtime + b"\n" + END)
        return data[:anchor] + addon + data[anchor:]

    entries = read_inline_vpk(vpk)
    entries[VOICE_SCRIPT_PATH] = rewrite_panorama_data(entries[VOICE_SCRIPT_PATH], edit)
    return write_inline_vpk(entries)
