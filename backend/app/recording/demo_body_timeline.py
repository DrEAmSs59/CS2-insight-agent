"""Offline Demo body identities shared by the separate capture executors.

The helper reads DEM files only; it neither loads a game DLL nor launches CS2.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def read_takeover_entities(demo: Path, start: int, end: int) -> dict:
    root = Path(__file__).resolve().parents[3]
    name = "demo-native-targets" + (".exe" if sys.platform == "win32" else "")
    candidates = [root / "tools" / name,
                  root / "tools/demo-cosmetic-rewriter/target/release" / name,
                  Path(sys.executable).resolve().parent.parent / "tools" / name]
    binary = next((p for p in candidates if p.is_file()), None)
    if binary is None:
        raise ValueError("Demo 接管 BOT 实体读取器缺失，请更新客户端")
    with tempfile.TemporaryDirectory(prefix="insight-native-targets-") as directory:
        output = Path(directory) / "targets.json"
        result = subprocess.run([str(binary), "--input", str(Path(demo).resolve()),
                                 "--output", str(output), "--start", str(start), "--end", str(end)],
                                capture_output=True, text=True, encoding="utf-8", errors="replace",
                                timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise ValueError("Demo 接管 BOT 实体核验失败: " + result.stderr[-500:])
        report = json.loads(output.read_text(encoding="utf-8"))
    if report.get("version") != 1 or report.get("start") != start or report.get("end") != end:
        raise ValueError("Demo 接管 BOT 实体报告范围不匹配")
    return report


def takeover_timeline(report, segment, seek_tick, *, strict_identity=False):
    """Keep only changes; dead intervals retain CS2's normal death camera."""
    current = {}
    changes = {}
    for row in report["rows"]:
        changes.setdefault(int(row["tick"]), []).append(row)
    points = sorted(set(changes) | {seek_tick, segment.start_tick, segment.end_tick})
    timeline = []
    for tick in points:
        for row in changes.get(tick, []):
            current[int(row["slot"])] = row
        if not seek_tick <= tick <= segment.end_tick:
            continue
        name = segment.label.strip().casefold()
        matches = [r for r in current.values() if not name or str(r.get("name") or "").strip().casefold() == name]
        if strict_identity and segment.target_xuid:
            matches = [r for r in current.values() if str(r.get("steamid") or "") == segment.target_xuid]
        elif len(matches) != 1 and segment.target_xuid:
            matches = [r for r in matches if str(r.get("steamid") or "") == segment.target_xuid]
        row = matches[0] if len(matches) == 1 and (name or segment.target_xuid) else None
        if strict_identity and (row is None or not row.get("bodyKnown") or (row.get("alive") and not row.get("valid"))):
            raise ValueError(f"OBS tick {tick} 玩家身份或 BOT 身体无法验证")
        valid = bool(row and row.get("valid") and row.get("alive"))
        if valid:
            slot, pawn = int(row["slot"]), int(row["pawn"])
            handle, reverse = row.get("controllerHandle"), row.get("reverseHandle")
            pawn_handle = row.get("pawnHandle")
            if not (1 <= slot <= 64 and 0 < pawn < 0x4000 and handle == reverse
                    and handle not in (None, 0xffffff, 0xffffffff)
                    and int(handle) & 0x3fff == slot and pawn_handle is not None
                    and int(pawn_handle) & 0x3fff == pawn):
                raise ValueError(f"Demo tick {tick} 接管 BOT 控制关系不一致")
        elif row and row.get("takeover") and (row.get("alive") or not row.get("bodyKnown")):
            raise ValueError(f"Demo tick {tick} 接管 BOT 身体无法验证")
        item = {"tick": tick, "slot": int(row["slot"]) if row else 0,
                "pawn": int(row["pawn"]) if valid else 0,
                "takeover": bool(row and row.get("takeover"))}
        if not timeline or {k:v for k,v in item.items() if k != "tick"} != {
                k:v for k,v in timeline[-1].items() if k != "tick"}:
            timeline.append(item)
    return timeline
