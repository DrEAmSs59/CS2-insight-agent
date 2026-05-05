"""Child-process entry point for isolated demo parsing."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any, Optional

if __package__:
    from .demo_parser import DemoAnalyzer, get_demo_match_summary, get_player_list
    from .radar.radar_data_extractor import extract_radar_timeline_impl
else:
    backend_dir = Path(__file__).resolve().parents[1]
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    from app.demo_parser import DemoAnalyzer, get_demo_match_summary, get_player_list
    from app.radar.radar_data_extractor import extract_radar_timeline_impl


def _run(payload: dict) -> object:
    action = str(payload.get("action") or "")
    if action == "radar_timeline":
        args = {k: v for k, v in payload.items() if k != "action"}
        return extract_radar_timeline_impl(**args)
    dem_path = str(payload.get("dem_path") or "")
    if not dem_path:
        raise ValueError("dem_path is required")
    if action == "analyze":
        target = str(payload.get("target_player") or "").strip()
        if not target:
            raise ValueError("target_player is required")
        ftd_raw = payload.get("freeze_to_death_rounds")
        ftd_list: Optional[list[int]] = None
        if ftd_raw is not None:
            if not isinstance(ftd_raw, list):
                raise ValueError("freeze_to_death_rounds must be a list of integers or null")
            out_ftd: list[int] = []
            for x in ftd_raw:
                try:
                    out_ftd.append(int(x))
                except (TypeError, ValueError) as e:
                    raise ValueError(f"freeze_to_death_rounds must be integers: {x!r}") from e
            ftd_list = out_ftd
        return DemoAnalyzer(dem_path).analyze(target, freeze_to_death_rounds=ftd_list).to_dict()
    if action == "players":
        return get_player_list(dem_path)
    if action == "summary":
        return get_demo_match_summary(dem_path)
    raise ValueError(f"unknown parse worker action: {action!r}")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python -m app.parse_worker <request.json> <output.json>", file=sys.stderr)
        return 2
    req_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    try:
        payload = json.loads(req_path.read_text(encoding="utf-8-sig"))
        result = _run(payload)
        out_path.write_text(json.dumps({"ok": True, "result": result}, ensure_ascii=False), encoding="utf-8")
        return 0
    except BaseException as e:  # noqa: BLE001 - worker must serialize all failures.
        traceback.print_exc(file=sys.stderr)
        try:
            out_path.write_text(
                json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
