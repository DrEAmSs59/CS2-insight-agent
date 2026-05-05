from __future__ import annotations

import logging
from typing import Any

from app.demo_parse_isolation import extract_radar_timeline_isolated

logger = logging.getLogger(__name__)


def extract_radar_timeline(
    *,
    demo_path: str,
    map_name: str,
    pov_player_name: str | None,
    pov_steamid64: str | None,
    start_tick: int,
    end_tick: int,
    fps: float,
    duration_sec: float,
) -> list[dict[str, Any]]:
    """Wrap isolated worker (demoparser native crashes cannot kill FastAPI)."""
    try:
        result = extract_radar_timeline_isolated(
            demo_path=demo_path,
            map_name=map_name,
            pov_player_name=pov_player_name,
            pov_steamid64=pov_steamid64,
            start_tick=int(start_tick),
            end_tick=int(end_tick),
            fps=float(fps),
            duration_sec=float(duration_sec),
        )
    except Exception as e:
        logger.warning("radar timeline isolated parse failed: %s", e)
        raise
    if not isinstance(result, list):
        return []
    return result


def extract_radar_timeline_impl(
    *,
    demo_path: str,
    map_name: str,
    pov_player_name: str | None,
    pov_steamid64: str | None,
    start_tick: int,
    end_tick: int,
    fps: float,
    duration_sec: float,
) -> list[dict[str, Any]]:
    """
    Runs inside parse_worker child process.
    从 demo 中提取 start_tick ~ end_tick 的雷达时间线（与成片 fps / 时长对齐，每帧一条）。
    """
    del map_name

    import pandas as pd
    from demoparser2 import DemoParser

    from app.demo_parser import _to_pandas_df

    def _norm_sid(val: object) -> str:
        if val is None or (isinstance(val, float) and pd.isna(val)):
            return ""
        s = str(val).strip()
        if s.endswith(".0") and s[:-2].isdigit():
            s = s[:-2]
        return s

    def _team_side(team_num: float | int) -> str:
        try:
            t = int(float(team_num))
        except (TypeError, ValueError):
            return "?"
        if t == 3:
            return "CT"
        if t == 2:
            return "T"
        return str(t)

    parser = DemoParser(demo_path)

    probe_ticks = sorted(
        {int(start_tick), int(end_tick - 1), int(start_tick + max(0, end_tick - start_tick) // 2)},
    )
    probe_ticks = [t for t in probe_ticks if int(start_tick) <= t < int(end_tick)]
    if not probe_ticks:
        probe_ticks = [int(start_tick)]

    pov_sid = _norm_sid(pov_steamid64)
    pov_name_key = (pov_player_name or "").strip().lower()

    raw0 = parser.parse_ticks(["steamid", "name", "team_num", "is_alive"], ticks=[probe_ticks[0]])
    df0 = _to_pandas_df(raw0)
    pov_team: int | None = None
    pov_display_name = ""
    if not df0.empty and "team_num" in df0.columns:
        sid_col = "steamid" if "steamid" in df0.columns else None
        name_col = "name" if "name" in df0.columns else None
        if pov_sid and sid_col:
            hit = df0[df0[sid_col].apply(lambda x: _norm_sid(x) == pov_sid)]
            if not hit.empty:
                try:
                    pov_team = int(float(hit.iloc[0]["team_num"]))
                except (TypeError, ValueError):
                    pov_team = None
                if name_col:
                    pov_display_name = str(hit.iloc[0].get(name_col) or "").strip()
        if pov_team is None and pov_name_key and name_col:
            hit = df0[df0[name_col].astype(str).str.strip().str.lower() == pov_name_key]
            if not hit.empty:
                try:
                    pov_team = int(float(hit.iloc[0]["team_num"]))
                except (TypeError, ValueError):
                    pov_team = None
                pov_display_name = str(hit.iloc[0].get(name_col) or "").strip()

    if pov_team is None:
        return []

    n_frames = max(1, int(round(max(0.01, duration_sec) * max(0.01, fps))))
    span = max(1, int(end_tick) - int(start_tick))
    sample_ticks: list[int] = []
    for i in range(n_frames):
        if n_frames <= 1:
            t = int(start_tick)
        else:
            t = int(start_tick) + int(round((i / (n_frames - 1)) * (span - 1)))
        t = max(int(start_tick), min(t, int(end_tick) - 1))
        sample_ticks.append(t)

    fields = [
        "X",
        "Y",
        "Z",
        "yaw",
        "name",
        "steamid",
        "team_num",
        "is_alive",
        "health",
    ]

    snap_by_tick: dict[int, pd.DataFrame] = {}
    chunk = 160
    for i in range(0, len(sample_ticks), chunk):
        part = sample_ticks[i : i + chunk]
        uniq = sorted(set(part))
        try:
            raw = parser.parse_ticks(fields, ticks=uniq)
        except Exception:
            try:
                raw = parser.parse_ticks(
                    ["X", "Y", "Z", "yaw", "name", "steamid", "team_num", "is_alive"],
                    ticks=uniq,
                )
            except Exception:
                continue
        pdf = _to_pandas_df(raw)
        if pdf.empty or "tick" not in pdf.columns:
            continue
        for tick_val, grp in pdf.groupby("tick", sort=False):
            snap_by_tick[int(tick_val)] = grp

    timeline: list[dict[str, Any]] = []
    last_players: list[dict[str, Any]] = []

    for i, tick in enumerate(sample_ticks):
        grp = snap_by_tick.get(tick)
        players_out: list[dict[str, Any]] = []
        if grp is not None and not grp.empty and "team_num" in grp.columns:
            if "is_alive" in grp.columns:
                alive_df = grp[grp["is_alive"].astype(bool)]
                work = alive_df if not alive_df.empty else grp
            else:
                work = grp
            for _, r in work.iterrows():
                try:
                    tm = int(float(r.get("team_num")))
                except (TypeError, ValueError):
                    continue
                if tm != pov_team:
                    continue
                nm = str(r.get("name") or "").strip()
                sid_c = _norm_sid(r.get("steamid")) if "steamid" in work.columns else ""
                try:
                    hx = float(r.get("X"))
                    hy = float(r.get("Y"))
                    hz = float(r.get("Z")) if "Z" in work.columns else 0.0
                except (TypeError, ValueError):
                    continue
                yaw_v = 0.0
                if "yaw" in work.columns:
                    try:
                        yaw_v = float(r.get("yaw") or 0.0)
                    except (TypeError, ValueError):
                        yaw_v = 0.0
                alive = True
                if "is_alive" in work.columns:
                    try:
                        alive = bool(r.get("is_alive"))
                    except Exception:
                        alive = True
                is_pov = False
                if pov_sid and sid_c and sid_c == pov_sid:
                    is_pov = True
                elif pov_name_key and nm.strip().lower() == pov_name_key:
                    is_pov = True
                elif pov_display_name and nm.strip().lower() == pov_display_name.strip().lower():
                    is_pov = True

                players_out.append(
                    {
                        "steamid64": sid_c or None,
                        "name": nm,
                        "team": _team_side(tm),
                        "x": hx,
                        "y": hy,
                        "z": hz,
                        "yaw": yaw_v,
                        "is_alive": alive,
                        "is_pov": is_pov,
                        "is_teammate": True,
                    },
                )
            if players_out:
                last_players = players_out
        else:
            players_out = [dict(p) for p in last_players]

        time_sec = i / max(fps, 0.001)
        timeline.append(
            {
                "tick": int(tick),
                "time_sec": float(time_sec),
                "players": players_out,
            },
        )

    return timeline
