"""App-owned killfeed: exact DEM data and shared session-only VPK composition."""
import json
from pathlib import Path
import re
from .demo_voice_hud import VOICE_SCRIPT_PATH, VOICE_DATA_BEGIN, VOICE_DATA_END, read_inline_vpk, write_inline_vpk
from .panorama_resource import rewrite_panorama_data

KILLFEED_TEMPLATE_MARKER = b"/* INSIGHT_PANORAMA_KILLFEED_V1 */"
RUNTIME_BEGIN = b"/*__CS2_INSIGHT_SHARED_KILLFEED_BEGIN__*/"
RUNTIME_END = b"/*__CS2_INSIGHT_SHARED_KILLFEED_END__*/"
DATA_BEGIN = b"/*__CS2_INSIGHT_SHARED_KILLFEED_DATA_BEGIN__*/"
DATA_END = b"/*__CS2_INSIGHT_SHARED_KILLFEED_DATA_END__*/"


def killfeed_only_template(vpk: bytes) -> bytes:
    """Keep the stock controller and a minimal context; enable no other HUD layer."""
    entries = read_inline_vpk(vpk)
    def edit(data):
        marker = b"/*__CS2_INSIGHT_INJECTION_BEGIN__*/"
        if data.count(marker) != 1:
            raise ValueError("击杀常驻模板缺少共享脚本边界")
        context = b'''
/*__CS2_INSIGHT_INJECTION_BEGIN__*/
;(function CS2InsightPersistentKillfeed() {
    const packed = /*__CS2_INSIGHT_VOICE_DATA_BEGIN__*/[]/*__CS2_INSIGHT_VOICE_DATA_END__*/;
    const controller = $.GetContextPanel();
    function currentPovXuid(state) {
        let xuid = String(GameStateAPI.GetHudPlayerXuid() || "");
        if ((!xuid || xuid === "0") && state && state.nSpectatingPlayerId >= 0) {
            xuid = String(GameStateAPI.GetPlayerXuidStringFromPlayerSlot(state.nSpectatingPlayerId) || "");
        }
        return xuid === "0" ? "" : xuid;
    }
    function findHudTraverse(id) {
        let panel = controller;
        for (let depth = 0; panel && panel.IsValid() && depth < 40; depth += 1) {
            const found = panel.FindChildTraverse(id);
            if (found && found.IsValid()) return found;
            panel = panel.GetParent();
        }
        return null;
    }
})();'''
        return data.split(marker)[0].rstrip() + context
    return write_inline_vpk({VOICE_SCRIPT_PATH: rewrite_panorama_data(entries[VOICE_SCRIPT_PATH], edit)})


def build_killfeed_events(demo_path, *, parser=None):
    if parser is None:
        from demoparser2 import DemoParser
        parser = DemoParser(str(demo_path))
    table = parser.parse_event("player_death", player=["team_num", "clan_name"])
    if hasattr(table, "to_dict"):
        table = table.to_dict(orient="list")
    required = ["tick", "attacker_name", "attacker_steamid", "user_name", "user_steamid", "weapon"]
    if not isinstance(table, dict) or any(key not in table for key in required):
        raise ValueError("击杀常驻无法读取完整 Demo 击杀事件")
    count = len(table["tick"])
    if any(len(column) != count for column in table.values()):
        raise ValueError("击杀常驻事件列长度不一致")
    def person(row, prefix):
        return {"xuid": str(row.get(prefix + "_steamid") or ""), "name": str(row.get(prefix + "_name") or ""),
                "clan": str(row.get(prefix + "_clan_name") or ""), "team": int(row.get(prefix + "_team_num") or 0)}
    result = []
    for index in range(count):
        row = {key: values[index] for key, values in table.items()}
        tick = int(row["tick"])
        victim, attacker, assister = [person(row, prefix) for prefix in ("user", "attacker", "assister")]
        weapon = str(row["weapon"] or "world").removeprefix("weapon_")
        if not re.fullmatch(r"[a-z0-9_]+", weapon):
            raise ValueError("击杀常驻武器标识无效")
        classes = [name for field, name in (
            ("headshot", "DeathNoticeHeadShot"), ("penetrated", "DeathNoticePenetrate"),
            ("revenge", "DeathNoticeRevenge"), ("dominated", "DeathNoticeDomination"),
            ("assistedflash", "DeathNoticeFlashbang"), ("noscope", "noscope"),
            ("thrusmoke", "through-smoke"), ("attackerblind", "attacker-blind"),
            ("attackerinair", "attackerinair"), ("wipe", "DeathNoticeWipe")) if row.get(field)]
        if assister["xuid"]:
            classes.append("DeathNoticeAssist")
        if not attacker["xuid"] or attacker["xuid"] == victim["xuid"]:
            classes.append("DeathNoticeSuicide")
        result.append({"id": f"{tick}:{index}", "tick": tick, "attacker": attacker, "victim": victim,
                       "assister": assister, "weapon": weapon, "classes": classes})
    return sorted(result, key=lambda event: event["tick"])


def bind_persistent_killfeed(vpk: bytes, *, enabled: bool,
                            demo_path=None, segments=None, target_xuid: str = "",
                            hide_clan_tags: bool = True, parser=None, assets_dir=None) -> bytes:
    """Compose the app-owned overlay into a temporary recording VPK."""
    setting = {"version": 1, "enabled": bool(enabled)}
    if enabled:
        target_xuid = str(target_xuid)
        if not re.fullmatch(r"[1-9][0-9]{0,19}", str(target_xuid)):
            raise ValueError("击杀常驻缺少录制主角的 SteamID，请重新创建录制任务")
        if demo_path is None or not segments:
            raise ValueError("击杀常驻缺少 Demo 或录制片段范围")
        ranges = [[int(segment["start_tick"]), int(segment["end_tick"])] for segment in segments]
        if any(start < 0 or end <= start for start, end in ranges):
            raise ValueError("击杀常驻录制片段范围无效")
        events = [event for event in build_killfeed_events(demo_path, parser=parser)
                  if event["attacker"]["xuid"] == target_xuid and event["victim"]["xuid"] != target_xuid]
        setting.update(events=events, segments=ranges, target_xuid=target_xuid,
                       hide_clan_tags=bool(hide_clan_tags))
    runtime = b""
    if enabled:
        if assets_dir is None:
            from .pov_hud_manager import find_project_root
            assets_dir = find_project_root() / "pov"
        assets_dir = Path(assets_dir)
        # These are trusted application resources, never user-supplied scripts.
        runtime = b"\n".join((assets_dir / name).read_bytes().replace(b"\r\n", b"\n")
                             for name in ("persistent_killfeed.js", "persistent_killfeed_runtime.js"))

    entries = read_inline_vpk(vpk)
    def edit(data):
        if data.count(RUNTIME_BEGIN) != data.count(RUNTIME_END) or data.count(RUNTIME_BEGIN) > 1:
            raise ValueError("击杀常驻共享脚本边界无效")
        if RUNTIME_BEGIN in data:
            start, end = data.index(RUNTIME_BEGIN), data.index(RUNTIME_END)
            if end < start:
                raise ValueError("击杀常驻共享脚本边界无效")
            data = data[:start] + data[end + len(RUNTIME_END):]
        if data.count(VOICE_DATA_BEGIN) != 1 or data.count(VOICE_DATA_END) != 1:
            raise ValueError("击杀常驻缺少共享 HUD 数据边界")
        if not enabled:
            return data
        # Reuse the shared controller context without modifying stock game code.
        anchor = data.rfind(b"\n})();")
        if anchor < 0 or data[anchor:].strip() != b"})();":
            raise ValueError("击杀常驻共享 HUD 上下文边界无效")
        payload = json.dumps(setting, ensure_ascii=True, separators=(",", ":")).encode("ascii").replace(b"/", b"\\u002f")
        addon = (RUNTIME_BEGIN + b"\nconst sharedKillfeedSettings = " + DATA_BEGIN + payload + DATA_END
                 + b";\n" + runtime + b"\n" + RUNTIME_END)
        return data[:anchor] + addon + data[anchor:]
    entries[VOICE_SCRIPT_PATH] = rewrite_panorama_data(entries[VOICE_SCRIPT_PATH], edit)
    return write_inline_vpk(entries)
