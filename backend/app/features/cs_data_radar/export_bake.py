"""合辑导出时按候选项烘焙数据雷达图动画（失败即中止）。"""

from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from typing import Any, Callable, Optional

from .radar_model import derive_radar_stats
from .timeline import ANIMATION_DURATION_SEC, radar_instance_duration_plan

logger = logging.getLogger(__name__)


class RadarBakeError(Exception):
    def __init__(self, code: str, **params: Any):
        super().__init__(code)
        self.code = code
        self.params = params


def require_parse_data(candidates_by_key: dict[str, dict[str, Any]], used_keys: list[str]) -> None:
    for key in used_keys:
        cand = candidates_by_key.get(key) if isinstance(candidates_by_key, dict) else None
        if not isinstance(cand, dict) or not cand.get("has_parse_data"):
            name = str((cand or {}).get("player_name") or key)
            raise RadarBakeError("MONTAGE_RADAR_PARSE_MISSING", name=name)


def resolve_local_portrait(state: Optional[dict[str, Any]]) -> Optional[Path]:
    raw = str((state or {}).get("portrait_path") or (state or {}).get("portraitPath") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_file() else None


async def collect_portraits_for_keys(
    *,
    used_keys: list[str],
    candidates_by_key: dict[str, dict[str, Any]],
    candidate_state: dict[str, Any],
    dest_dir: Path,
) -> dict[str, Optional[Path]]:
    """优先用候选项自己上传的肖像；否则尝试 Steam 头像；失败则交给渲染器画昵称首字。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out: dict[str, Optional[Path]] = {}
    for key in used_keys:
        state = candidate_state.get(key) if isinstance(candidate_state, dict) else None
        local = resolve_local_portrait(state if isinstance(state, dict) else None)
        if local is not None:
            out[key] = local
            continue
        cand = candidates_by_key.get(key) if isinstance(candidates_by_key, dict) else None
        steamid = str((cand or {}).get("steamid64") or "").strip()
        out[key] = await _download_steam_portrait(steamid, dest_dir) if steamid else None
    return out


async def _download_steam_portrait(steamid64: str, dest_dir: Path) -> Optional[Path]:
    try:
        from ...env_utils import load_config
        from ...steam_match_history import _official_steam_avatar_url, fetch_player_summaries

        cfg = load_config()
        api_key = str(getattr(cfg, "steam_api_key", "") or "").strip()
        if not api_key:
            return None
        players = await fetch_player_summaries(api_key, [steamid64])
        if not players:
            return None
        url = _official_steam_avatar_url(players[0].get("avatarfull"))
        if not url:
            return None
        import httpx

        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.content
        if not data:
            return None
        dest = dest_dir / f"steam_{steamid64}.jpg"
        dest.write_bytes(data)
        return dest if dest.is_file() else None
    except Exception:
        logger.warning("steam portrait download failed steamid=%s", steamid64, exc_info=True)
        return None


def _rating_from_state(state: Optional[dict[str, Any]], key: str = "rating") -> Any:
    if not isinstance(state, dict):
        return None
    if key not in state:
        return None
    value = state.get(key)
    if value is None or str(value).strip() == "":
        return None
    return value


def _avg_radar_from_candidate(cand: dict[str, Any], state: Optional[dict[str, Any]]) -> dict[str, Any]:
    avg = dict(cand.get("match_avg") or cand.get("match_median") or {})
    avg_rating = _rating_from_state(state, "avg_rating")
    if avg_rating is None:
        avg_rating = _rating_from_state(state, "median_rating")
    if avg_rating is None:
        avg.pop("rating", None)
        return avg
    try:
        avg["rating"] = round(float(avg_rating), 2)
    except (TypeError, ValueError):
        avg.pop("rating", None)
    return avg


def _safe_stem(key: str) -> str:
    digest = hashlib.sha1(str(key).encode("utf-8", errors="ignore")).hexdigest()[:16]
    return digest


def fit_radar_video_duration(
    *,
    ffmpeg_bin: Path,
    src: Path,
    dest: Path,
    output_duration: float,
    mode: str,
    fps: float,
) -> Path:
    """把 4s 源动画补齐或裁切到时间线实例时长。"""
    from ...ffmpeg_process import run_process_capture

    dest.parent.mkdir(parents=True, exist_ok=True)
    if mode == "exact" and src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
        return dest
    if mode == "exact":
        return src

    fps_s = f"{max(1.0, float(fps)):.4f}".rstrip("0").rstrip(".")
    vf = f"fps={fps_s},format=yuv420p"
    if mode == "pad":
        pad = max(0.0, float(output_duration) - ANIMATION_DURATION_SEC)
        vf = f"{vf},tpad=stop_mode=clone:stop_duration={pad:.4f}"
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-t",
        f"{max(0.1, float(output_duration)):.4f}",
        "-vf",
        vf,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    run_process_capture(cmd, timeout=180, cancel_event=None)
    if not dest.is_file():
        raise RadarBakeError("MONTAGE_RADAR_BAKE_FAILED", name=dest.name)
    return dest


def bake_candidate_videos(
    *,
    ffmpeg_bin: Path,
    used_keys: list[str],
    candidates_by_key: dict[str, dict[str, Any]],
    candidate_state: dict[str, Any],
    portraits: dict[str, Optional[Path]],
    out_dir: Path,
    fps: int,
    width: int,
    height: int,
    progress: Optional[Callable[[float], None]] = None,
) -> dict[str, Path]:
    from .radar_animation import FPS as RADAR_ANIM_FPS, generate_radar_animation

    require_parse_data(candidates_by_key, used_keys)
    out_dir.mkdir(parents=True, exist_ok=True)
    baked: dict[str, Path] = {}
    total = max(1, len(used_keys))
    for i, key in enumerate(used_keys):
        cand = candidates_by_key[key]
        state = candidate_state.get(key) if isinstance(candidate_state, dict) else {}
        if not isinstance(state, dict):
            state = {}
        stats = cand.get("stats") if isinstance(cand.get("stats"), dict) else {}
        radar = derive_radar_stats(stats, rating=_rating_from_state(state))
        avg = _avg_radar_from_candidate(cand, state)
        dest = out_dir / f"radar_{_safe_stem(key)}.mp4"
        try:
            generate_radar_animation(
                player_name=str(cand.get("player_name") or "Unknown"),
                radar=radar,
                match_avg_radar=avg,
                match_median_radar=avg,
                portrait_path=portraits.get(key),
                team_key=cand.get("team_key"),
                team_label=str(cand.get("team_label") or ""),
                team_logo_path=None,
                ffmpeg_bin=ffmpeg_bin,
                out_path=dest,
                fps=RADAR_ANIM_FPS,
                output_fps=max(1, int(fps)),
                duration=ANIMATION_DURATION_SEC,
                width=max(16, int(width)),
                height=max(16, int(height)),
                demo_source=str(cand.get("demo_source") or ""),
                map_name=str(cand.get("map_name") or ""),
                kda=str(cand.get("kda") or ""),
            )
        except RadarBakeError:
            raise
        except Exception as exc:
            logger.exception("radar bake failed key=%s", key)
            raise RadarBakeError("MONTAGE_RADAR_BAKE_FAILED", name=str(cand.get("player_name") or key)) from exc
        if not dest.is_file():
            raise RadarBakeError("MONTAGE_RADAR_BAKE_FAILED", name=str(cand.get("player_name") or key))
        baked[key] = dest
        if progress is not None:
            progress((i + 1) / total)
    return baked


def fit_instance_videos(
    *,
    ffmpeg_bin: Path,
    segments: list[dict[str, Any]],
    baked_by_key: dict[str, Path],
    out_dir: Path,
    fps: float,
) -> dict[str, Path]:
    """同一候选项可插入多次；按实例时长 pad/trim，返回 row_id → 视频路径。"""
    out: dict[str, Path] = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    for seg in segments:
        if seg.get("kind") != "radar":
            continue
        key = str(seg.get("candidate_key") or "")
        src = baked_by_key.get(key)
        if src is None or not Path(src).is_file():
            raise RadarBakeError("MONTAGE_RADAR_BAKE_FAILED", name=key or str(seg.get("row_id") or ""))
        plan = radar_instance_duration_plan(seg.get("duration"))
        row_id = str(seg.get("row_id") or "")
        if plan["mode"] == "exact":
            out[row_id] = Path(src)
            continue
        dest = out_dir / f"radar_fit_{_safe_stem(row_id)}.mp4"
        fit_radar_video_duration(
            ffmpeg_bin=ffmpeg_bin,
            src=Path(src),
            dest=dest,
            output_duration=float(plan["output_duration"]),
            mode=str(plan["mode"]),
            fps=fps,
        )
        out[row_id] = dest
    return out
