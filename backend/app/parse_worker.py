"""Child-process entry point for isolated demo parsing."""

from __future__ import annotations

import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional, TypeVar

_T = TypeVar("_T")

if __package__:
    from .parse_worker_ipc import dump_message, load_message
    from .demo_parser import DemoAnalyzer, get_demo_match_summary, get_player_list, inspect_demo
    from .features.demo_analysis.input_track import detect_player_keyboard_input
    from .radar.radar_data_extractor import extract_radar_timeline_impl, extract_replay_effects_impl
else:
    backend_dir = Path(__file__).resolve().parents[1]
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    from app.parse_worker_ipc import dump_message, load_message
    from app.demo_parser import DemoAnalyzer, get_demo_match_summary, get_player_list, inspect_demo
    from app.features.demo_analysis.input_track import detect_player_keyboard_input
    from app.radar.radar_data_extractor import extract_radar_timeline_impl, extract_replay_effects_impl


def _analyze_with_keyboard_probe(dem_path: str, analyze: Callable[[], _T]) -> tuple[_T, bool | None]:
    """Run the cheap input-carrier probe beside analysis so wall-clock stays analyze-bound."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        probe = pool.submit(detect_player_keyboard_input, demo_path=dem_path)
        result = analyze()
        return result, probe.result()


def _run(payload: dict) -> object:
    action = str(payload.get("action") or "")
    if action == "radar_timeline":
        args = {k: v for k, v in payload.items() if k != "action"}
        return extract_radar_timeline_impl(**args)
    if action == "replay_effects":
        args = {k: v for k, v in payload.items() if k != "action"}
        return extract_replay_effects_impl(**args)
    dem_path = str(payload.get("dem_path") or "")
    if not dem_path:
        raise ValueError("dem_path is required")
    if action == "materialize_replay":
        workspace = payload.get("workspace")
        if not isinstance(workspace, dict):
            raise ValueError("workspace must be an object")
        from app.features.demo_analysis.replay_match_cache import materialize_match_replay_parquet_impl

        return materialize_match_replay_parquet_impl(
            demo_path=dem_path,
            workspace=workspace,
            fps=float(payload.get("fps") or 32.0),
        )
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

        def run_analyze():
            analyzer = DemoAnalyzer(dem_path)
            return analyzer.analyze(target, freeze_to_death_rounds=ftd_list).to_dict()

        result, has_keyboard_input = _analyze_with_keyboard_probe(dem_path, run_analyze)
        result["has_player_keyboard_input"] = has_keyboard_input
        return result
    if action == "analyze_batch":
        raw_players = payload.get("target_players") or []
        if not isinstance(raw_players, list) or not raw_players:
            raise ValueError("target_players must be a non-empty list")
        target_players = [str(p).strip() for p in raw_players if str(p).strip()]
        if not target_players:
            raise ValueError("target_players contains no valid player names")
        ftd_raw = payload.get("freeze_to_death_rounds")
        ftd_list: Optional[list[int]] = None
        if ftd_raw is not None:
            if not isinstance(ftd_raw, list):
                raise ValueError("freeze_to_death_rounds must be a list of integers or null")
            ftd_list = [int(x) for x in ftd_raw]
        analyzer_holder: dict[str, DemoAnalyzer] = {}

        def run_analyze_batch():
            analyzer = DemoAnalyzer(dem_path)
            analyzer_holder["analyzer"] = analyzer
            return analyzer.analyze_multi_players(
                target_players, freeze_to_death_rounds=ftd_list
            )

        results, has_keyboard_input = _analyze_with_keyboard_probe(
            dem_path,
            run_analyze_batch,
        )
        analyzer = analyzer_holder["analyzer"]
        analysis_workspace = analyzer.analysis_workspace
        if isinstance(analysis_workspace, dict) and analysis_workspace.get("rounds"):
            analysis_workspace = dict(analysis_workspace)
            analysis_workspace["replay_cache"] = {
                "status": "deferred",
                "reason": "materialized on first 2D replay open",
            }
        return {
            "__analysis_workspace__": analysis_workspace,
            "__has_player_keyboard_input__": has_keyboard_input,
            **{player: result.to_dict() for player, result in results.items()},
        }
    if action == "players":
        return get_player_list(dem_path)
    if action == "summary":
        return get_demo_match_summary(dem_path)
    if action == "inspect":
        return inspect_demo(dem_path)
    raise ValueError(f"unknown parse worker action: {action!r}")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python -m app.parse_worker <request.pkl> <output.pkl>", file=sys.stderr)
        return 2
    req_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    try:
        payload = load_message(req_path)
        result = _run(payload)
        dump_message(out_path, {"ok": True, "result": result})
        return 0
    except BaseException as e:  # noqa: BLE001 - worker must serialize all failures.
        traceback.print_exc(file=sys.stderr)
        try:
            dump_message(out_path, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
