"""RadarLiveSession — collects real-time CS2 GSI player-position data during recording.

Usage by obs_director.py:
  session = RadarLiveSession(map_name, pov_steamid, output_dir)
  session.notify_record_start()         # just before OBS StartRecord
  session.notify_demo_resume()          # after demo_resume injection
  # GSI endpoint calls push_gsi_snapshot() on each payload
  session.flush_to_disk()               # after StopRecord

Usage by radar_composer.py:
  RadarLiveSession.render_frames_from_cache(cache_dir, fps, duration_sec, output_dir)
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Module-level singleton so GSI endpoint can reach the active session
_active_session: Optional["RadarLiveSession"] = None


def get_active_session() -> Optional["RadarLiveSession"]:
    return _active_session


def set_active_session(session: Optional["RadarLiveSession"]) -> None:
    global _active_session
    _active_session = session


class RadarLiveSession:
    """Thread-safe live radar recording session."""

    @staticmethod
    def _normalize_map_name(raw: str) -> str:
        """Normalize to bundled map-data key: lowercase, add de_ prefix if missing."""
        key = raw.lower().strip()
        if key and not key.startswith(("de_", "cs_", "ar_", "gg_", "dm_", "mm_")):
            key = "de_" + key
        return key

    def __init__(
        self,
        map_name: str,
        pov_steamid: Optional[str],
        output_dir: Path,
        canvas_size: int = 300,
    ) -> None:
        self.map_name = self._normalize_map_name(map_name)
        self.pov_steamid = str(pov_steamid) if pov_steamid else None
        self.output_dir = output_dir
        self.canvas_size = canvas_size

        self._lock = threading.Lock()
        self._snapshots: list[dict[str, Any]] = []  # [{t, allplayers}]
        self._color_map: dict[str, int] = {}
        self._color_map_built = False
        self._record_start_wall: Optional[float] = None
        self._demo_resume_wall: Optional[float] = None
        self._finalized = False

        # Pre-render background eagerly（内置 PNG + map-data）
        output_dir.mkdir(parents=True, exist_ok=True)
        self._bg_path = output_dir / "radar_bg.png"
        self._transform = None
        try:
            from app.radar.radar_background import prerender_map_background
            _bg, self._transform = prerender_map_background(
                map_name=self.map_name,
                canvas_size=canvas_size,
                output_path=self._bg_path,
            )
            logger.info("Live radar background pre-rendered: map=%s", map_name)
        except Exception as exc:
            logger.error("Live radar background pre-render failed: %s", exc)
            # Save a placeholder so composer knows bg failed
            self._bg_path = None

    def notify_record_start(self, wall_time: Optional[float] = None) -> None:
        with self._lock:
            self._record_start_wall = wall_time if wall_time is not None else time.monotonic()

    def notify_demo_resume(self, wall_time: Optional[float] = None) -> None:
        with self._lock:
            self._demo_resume_wall = wall_time if wall_time is not None else time.monotonic()

    def push_gsi_snapshot(self, payload: dict[str, Any], wall_time: Optional[float] = None) -> None:
        """Buffer a GSI snapshot during recording."""
        if self._finalized:
            return
        allplayers = payload.get("allplayers")
        if not isinstance(allplayers, dict) or not allplayers:
            return
        t = wall_time if wall_time is not None else time.monotonic()

        with self._lock:
            if not self._color_map_built:
                # 优先从 player_color 字段建立（CS2 GSI 发送 0-4 整数）
                cm: dict[str, int] = {}
                for sid, pd in allplayers.items():
                    if not isinstance(pd, dict):
                        continue
                    try:
                        pc = pd.get("player_color")
                        if pc is not None:
                            cm[str(sid)] = int(pc) % 5
                    except (TypeError, ValueError):
                        pass
                if cm:
                    self._color_map = cm
                else:
                    # player_color 字段不存在时退回顺序分配
                    from app.radar.radar_live_renderer import build_session_color_map
                    self._color_map = build_session_color_map(list(allplayers.keys()))
                self._color_map_built = True
            self._snapshots.append({"t": t, "allplayers": allplayers})

    def flush_to_disk(self) -> None:
        """Write buffered snapshots + session metadata to disk (call after StopRecord)."""
        with self._lock:
            self._finalized = True
            snapshots = list(self._snapshots)
            record_start = self._record_start_wall
            demo_resume = self._demo_resume_wall
            color_map = dict(self._color_map)
            transform_data = None
            if self._transform is not None:
                transform_data = {
                    "pos_x": self._transform.pos_x,
                    "pos_y": self._transform.pos_y,
                    "scale": self._transform.scale,
                    "render_scale": self._transform.render_scale,
                    "off_x": self._transform.off_x,
                    "off_y": self._transform.off_y,
                    "canvas_size": self._transform.canvas_size,
                }

        self.output_dir.mkdir(parents=True, exist_ok=True)

        meta = {
            "map_name": self.map_name,
            "pov_steamid": self.pov_steamid,
            "canvas_size": self.canvas_size,
            "record_start_wall": record_start,
            "demo_resume_wall": demo_resume,
            "color_map": color_map,
            "transform": transform_data,
            "snapshot_count": len(snapshots),
        }
        (self.output_dir / "session_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )
        (self.output_dir / "gsi_snapshots.json").write_text(
            json.dumps(snapshots, ensure_ascii=False), encoding="utf-8"
        )
        logger.info(
            "Radar live session flushed: %d snapshots → %s",
            len(snapshots), self.output_dir,
        )

    # ------------------------------------------------------------------
    # 快照插值辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_pos_str(pos_str: str) -> Optional[tuple[float, float, float]]:
        """Parse CS2 GSI 'x, y, z' position string → (x, y, z)."""
        try:
            parts = [p.strip() for p in str(pos_str).split(",")]
            if len(parts) >= 2:
                return (
                    float(parts[0]),
                    float(parts[1]),
                    float(parts[2]) if len(parts) > 2 else 0.0,
                )
        except (ValueError, AttributeError):
            pass
        return None

    @staticmethod
    def _interpolate_allplayers(
        a: dict[str, Any],
        b: dict[str, Any],
        alpha: float,
    ) -> dict[str, Any]:
        """
        Linearly interpolate player *positions* between two GSI allplayers dicts.
        All other fields (team, hp, observer_slot …) are taken from `a`.
        Players present in `a` but missing in `b` keep their `a` position.
        """
        if alpha <= 0.0:
            return a
        result: dict[str, Any] = {}
        for sid, pdata_a in a.items():
            if not isinstance(pdata_a, dict):
                result[sid] = pdata_a
                continue
            pdata_b = b.get(sid) if isinstance(b.get(sid), dict) else None
            if pdata_b is None:
                result[sid] = pdata_a
                continue
            pos_a = RadarLiveSession._parse_pos_str(str(pdata_a.get("position") or ""))
            pos_b = RadarLiveSession._parse_pos_str(str(pdata_b.get("position") or ""))
            if pos_a and pos_b:
                ix = pos_a[0] + (pos_b[0] - pos_a[0]) * alpha
                iy = pos_a[1] + (pos_b[1] - pos_a[1]) * alpha
                iz = pos_a[2] + (pos_b[2] - pos_a[2]) * alpha
                pdata = dict(pdata_a)
                pdata["position"] = f"{ix:.2f}, {iy:.2f}, {iz:.2f}"
                result[sid] = pdata
            else:
                result[sid] = pdata_a
        return result

    @staticmethod
    def render_frames_from_cache(
        cache_dir: Path,
        fps: float,
        duration_sec: float,
        output_dir: Path,
        player_color_map: Optional[dict[str, int]] = None,
    ) -> list[Path]:
        """
        Render radar frame PNG sequence from cached GSI snapshots.
        Called by radar_composer.py instead of the slower disk-cache pipeline.

        Player positions are linearly interpolated between adjacent GSI
        snapshots so there is no visible stepping/flickering at the GSI
        update boundary.

        Returns list of written frame paths (radar_000001.png, ...).
        """
        import bisect
        import math as _math
        from PIL import Image
        from app.radar.radar_background import RadarTransform
        from app.radar.radar_live_renderer import render_live_frame
        from app.radar.radar_renderer import _circle_mask

        meta_path = cache_dir / "session_meta.json"
        snaps_path = cache_dir / "gsi_snapshots.json"
        bg_path = cache_dir / "radar_bg.png"

        if not meta_path.exists() or not snaps_path.exists():
            raise FileNotFoundError(f"Live radar cache incomplete at {cache_dir}")

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        snapshots: list[dict] = json.loads(snaps_path.read_text(encoding="utf-8"))

        record_start = meta.get("record_start_wall")
        pov_steamid = meta.get("pov_steamid")
        color_map: dict[str, int] = meta.get("color_map") or {}
        # demo 解析的颜色优先级最高（GSI 不发 player_color 字段）
        if player_color_map:
            color_map = {**color_map, **player_color_map}
        canvas_size = int(meta.get("canvas_size") or 300)

        transform: Optional[RadarTransform] = None
        td = meta.get("transform")
        if td:
            try:
                transform = RadarTransform(
                    pos_x=float(td["pos_x"]),
                    pos_y=float(td["pos_y"]),
                    scale=float(td["scale"]),
                    render_scale=float(td["render_scale"]),
                    off_x=int(td["off_x"]),
                    off_y=int(td["off_y"]),
                    canvas_size=int(td["canvas_size"]),
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("Could not restore RadarTransform from cache: %s", exc)

        # Load background
        if bg_path.exists() and transform is not None:
            background = Image.open(bg_path).convert("RGBA")
        else:
            background = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 200))
            transform = None

        circle_mask = _circle_mask(canvas_size, padding=1)

        # Pre-build sorted timestamp list for O(log n) bisect lookup
        snap_times: list[float] = [float(s.get("t") or 0.0) for s in snapshots]

        # ── 提前确定稳定的 pov_team，避免每帧从快照中重新推断时因
        #    POV 数据缺失而导致渲染队伍来回切换（视觉闪烁）──
        stable_pov_team: Optional[str] = None
        if pov_steamid:
            for _snap in snapshots:
                _ap = _snap.get("allplayers") or {}
                _pd = _ap.get(str(pov_steamid))
                if isinstance(_pd, dict):
                    _t = str(_pd.get("team") or "").strip().upper()
                    if _t in ("CT", "T"):
                        stable_pov_team = _t
                        break
        if stable_pov_team is None and snapshots:
            # POV 找不到 → 取第一个有效玩家的队伍作为兜底
            for _sid, _pd2 in (snapshots[0].get("allplayers") or {}).items():
                if not isinstance(_pd2, dict):
                    continue
                _t2 = str(_pd2.get("team") or "").strip().upper()
                if _t2 in ("CT", "T"):
                    stable_pov_team = _t2
                    break
        logger.debug("Stable pov_team determined: %s (pov_steamid=%s)", stable_pov_team, pov_steamid)

        n_frames = max(1, int(_math.ceil(duration_sec * fps)))
        output_dir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        last_allplayers: Optional[dict] = None

        for frame_idx in range(n_frames):
            frame_t = (record_start or 0.0) + (frame_idx / fps)

            # bisect_right gives the insertion point after all equal timestamps
            idx = bisect.bisect_right(snap_times, frame_t) - 1

            if idx < 0:
                # All snapshots are in the future — use first snapshot
                allplayers_cur: Optional[dict] = (
                    snapshots[0].get("allplayers") if snapshots else None
                )
            else:
                snap_a = snapshots[idx]
                ap_a: dict = snap_a.get("allplayers") or {}

                # Interpolate towards next snapshot when available
                if idx + 1 < len(snapshots):
                    snap_b = snapshots[idx + 1]
                    ap_b: dict = snap_b.get("allplayers") or {}
                    t_a = float(snap_a.get("t") or frame_t)
                    t_b = float(snap_b.get("t") or frame_t)
                    if t_b > t_a:
                        alpha = (frame_t - t_a) / (t_b - t_a)
                        alpha = max(0.0, min(1.0, alpha))
                        allplayers_cur = RadarLiveSession._interpolate_allplayers(
                            ap_a, ap_b, alpha
                        )
                    else:
                        allplayers_cur = ap_a
                else:
                    allplayers_cur = ap_a

            if allplayers_cur:
                last_allplayers = allplayers_cur

            if last_allplayers is None or transform is None:
                img = background.copy()
            else:
                try:
                    img = render_live_frame(
                        background=background,
                        gsi_allplayers=last_allplayers,
                        transform=transform,
                        pov_steamid=pov_steamid,
                        pov_team=stable_pov_team,
                        color_map=color_map,
                        circle_mask=circle_mask,
                    )
                except Exception as exc:
                    logger.debug("render_live_frame error frame %d: %s", frame_idx, exc)
                    img = background.copy()

            out_path = output_dir / f"radar_{frame_idx + 1:06d}.png"
            try:
                img.save(str(out_path))
                written.append(out_path)
            except Exception as exc:
                logger.warning("Save radar frame %d failed: %s", frame_idx + 1, exc)

            if frame_idx % 60 == 0:
                logger.debug("Live radar render: %d/%d frames", frame_idx + 1, n_frames)

        logger.info("Live radar rendered %d frames to %s", len(written), output_dir)
        return written
