"""Montage project composition, export execution and avatar routes."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..databases import montage_db
from ..env_utils import get_data_dir, load_config
from ..name_card_meta import (
    build_name_card_tags_and_result,
    resolve_name_card_category,
    resolve_name_card_eyebrow,
)
from ..player_names import normalize_player_key
from ..video_export_log import (
    export_event,
    set_video_export_database_id,
    video_export_endpoint,
)
from ..montage_export_runtime import (
    MontageExportJob,
    montage_export_job_snapshot,
    montage_export_jobs,
)

router = APIRouter(tags=["montage"])
logger = logging.getLogger(__name__)


# ─── Montage (V2) ─────────────────────────────────────────────


class PlayerAvatar(BaseModel):
    player_key: str
    steamid64: Optional[str] = None
    player_name: str = ""
    avatar_path: Optional[str] = None
    enabled: bool = True


class RadarSegment(BaseModel):
    """旧版：插入到指定录像片段之前。新时间线用 radar_items + timeline_ids。"""

    before_clip_id: int
    image_path: str
    duration: float = 4.0


class MontageProjectBody(BaseModel):
    project_id: Optional[int] = None
    name: str = ""
    recorded_clip_ids: list[int] = Field(default_factory=list)
    bgm_path: Optional[str] = None
    bgm_volume: Optional[float] = None
    bgm_start_sec: Optional[float] = None
    intro_path: Optional[str] = None
    intro_image_duration: Optional[float] = None
    outro_path: Optional[str] = None
    outro_image_duration: Optional[float] = None
    output_filename: str = Field(default="montage_export.mp4", max_length=240)
    transitions: Optional[dict[str, Any]] = None
    theme_id: Optional[str] = Field(default=None, max_length=64)
    player_avatars: list[PlayerAvatar] = Field(default_factory=list)
    name_cards_enabled: bool = False
    framemeld_enabled: bool = False
    radar_segments: list[RadarSegment] = Field(default_factory=list)
    timeline_ids: list[str] = Field(default_factory=list)
    radar_enabled: bool = True
    radar_items: dict[str, Any] = Field(default_factory=dict)
    radar_candidate_state: dict[str, Any] = Field(default_factory=dict)


class MontageMediaFpsProbeBody(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=2)


@router.post("/api/montage/media-fps")
async def probe_montage_media_fps(body: MontageMediaFpsProbeBody):
    """Probe optional intro/outro videos for the project-level FrameMeld gate."""
    from ..video_composer import (
        _is_image_path,
        probe_video_audio_summary,
        resolve_ffmpeg_binary,
        resolve_ffprobe_binary,
    )

    cfg = load_config()
    ffmpeg_bin = resolve_ffmpeg_binary(getattr(cfg, "ffmpeg_path", None))
    ffprobe_bin = resolve_ffprobe_binary(ffmpeg_bin)
    items: list[dict[str, Any]] = []
    for raw_path in body.paths:
        normalized = str(raw_path or "").strip()
        if not normalized:
            continue
        media_path = Path(normalized).expanduser()
        if _is_image_path(media_path):
            items.append({"path": normalized, "kind": "image", "fps": None, "status": "ok"})
            continue
        if not media_path.is_file():
            items.append({"path": normalized, "kind": "video", "fps": None, "status": "missing"})
            continue
        try:
            summary = await asyncio.to_thread(probe_video_audio_summary, media_path, ffprobe_bin)
            fps = float(summary.get("fps") or 0.0)
            items.append({
                "path": normalized,
                "kind": "video",
                "fps": fps if fps >= 1.0 else None,
                "status": "ok" if fps >= 1.0 else "unknown",
            })
        except Exception:
            logger.warning("failed to probe montage media fps path=%s", media_path, exc_info=True)
            items.append({"path": normalized, "kind": "video", "fps": None, "status": "error"})
    return {"items": items}




@router.post("/api/montage/projects")
async def save_montage_project(body: MontageProjectBody):
    proj_body = {
        "recorded_clip_ids": list(body.recorded_clip_ids),
        "bgm_path": body.bgm_path,
        "intro_path": body.intro_path,
        "outro_path": body.outro_path,
        "output_filename": (body.output_filename or "montage_export.mp4").strip() or "montage_export.mp4",
    }
    if body.transitions is not None:
        proj_body["transitions"] = body.transitions
    proj_body["player_avatars"] = [pa.model_dump() for pa in body.player_avatars]
    proj_body["name_cards_enabled"] = body.name_cards_enabled
    proj_body["framemeld_enabled"] = body.framemeld_enabled
    if body.radar_segments:
        proj_body["radar_segments"] = [rs.model_dump() for rs in body.radar_segments]
    proj_body["timeline_ids"] = [str(x) for x in (body.timeline_ids or [])]
    proj_body["radar_enabled"] = bool(body.radar_enabled)
    proj_body["radar_items"] = dict(body.radar_items or {})
    proj_body["radar_candidate_state"] = dict(body.radar_candidate_state or {})
    if body.theme_id is not None:
        tid = str(body.theme_id).strip()
        if tid:
            proj_body["theme_id"] = tid
    if body.bgm_volume is not None:
        try:
            proj_body["bgm_volume"] = max(0.0, min(2.0, float(body.bgm_volume)))
        except (TypeError, ValueError):
            pass
    if body.bgm_start_sec is not None:
        try:
            proj_body["bgm_start_sec"] = max(0.0, float(body.bgm_start_sec))
        except (TypeError, ValueError):
            pass
    if body.intro_image_duration is not None:
        try:
            proj_body["intro_image_duration"] = max(1.0, float(body.intro_image_duration))
        except (TypeError, ValueError):
            pass
    if body.outro_image_duration is not None:
        try:
            proj_body["outro_image_duration"] = max(1.0, float(body.outro_image_duration))
        except (TypeError, ValueError):
            pass
    try:
        pid = await montage_db.save_project(name=body.name.strip() or None, body=proj_body, project_id=body.project_id)
    except ValueError as e:
        from ..api_errors import error_detail

        if str(e) == "project not found":
            raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND")) from e
        raise HTTPException(400, error_detail("MONTAGE_EXPORT_FAILED")) from e
    item = await montage_db.get_project(pid)
    if not item:
        from ..api_errors import error_detail

        raise HTTPException(500, error_detail("MONTAGE_EXPORT_FAILED"))
    return item


@router.get("/api/montage/projects")
async def list_montage_projects(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    items, total = await montage_db.list_projects(limit=limit, offset=offset)
    return {"items": items, "total": total}


@router.get("/api/montage/projects/{project_id}")
async def get_montage_project(project_id: int):
    item = await montage_db.get_project(project_id)
    if not item:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND"))
    return item


@router.delete("/api/montage/projects/{project_id}")
async def delete_montage_project(project_id: int):
    deleted = await montage_db.delete_project(project_id)
    if not deleted:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND"))
    return {"status": "ok", "id": project_id}


class MontageExportBody(BaseModel):
    project_id: Optional[int] = None
    recorded_clip_ids: Optional[list[int]] = None
    ordered_ids: Optional[list[str]] = None
    bgm_path: Optional[str] = None
    bgm_volume: Optional[float] = None
    bgm_start_sec: Optional[float] = None
    intro_path: Optional[str] = None
    intro_image_duration: Optional[float] = None
    outro_path: Optional[str] = None
    outro_image_duration: Optional[float] = None
    output_path: str = Field(..., min_length=1, max_length=2048)
    theme_id: Optional[str] = Field(default=None, max_length=64)
    transitions: Optional[dict[str, Any]] = None
    player_avatars: list[PlayerAvatar] = Field(default_factory=list)
    name_cards_enabled: Optional[bool] = None  # None = inherit from project extras
    framemeld_enabled: Optional[bool] = None
    radar_segments: list[RadarSegment] = Field(default_factory=list)
    radar_enabled: Optional[bool] = None
    radar_items: Optional[dict[str, Any]] = None
    radar_candidate_state: Optional[dict[str, Any]] = None
    timeline_ids: Optional[list[str]] = None


async def _run_montage_export_job(job: MontageExportJob, prepared: dict[str, Any]) -> None:
    from ..montage_errors import montage_detail_from_exception
    from ..video_composer import MontageComposerError, compose_montage
    from ..features.cs_data_radar.export_bake import RadarBakeError

    async def finish_cancelled() -> None:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.error = ""
        await montage_db.update_export(
            job.export_id,
            status="cancelled",
            error_msg="",
            output_path=job.output_path,
        )
        export_event("pipeline_cancelled", status="cancelled")
        logger.info(
            "video export summary feature=montage export_id=%s status=cancelled",
            job.export_id,
        )

    if job.cancel_event.is_set():
        await finish_cancelled()
        return

    job.status = "running"
    job.stage = "starting"
    job.progress = 0.01
    job.started_at_monotonic = time.monotonic()
    job.stage_started_at_monotonic = job.started_at_monotonic
    await montage_db.update_export(job.export_id, status="running", output_path=job.output_path)

    def on_progress(progress: float, stage: str, detail: dict[str, Any] | None = None) -> None:
        if job.cancel_event.is_set():
            raise MontageComposerError("MONTAGE_EXPORT_CANCELLED")
        next_progress = max(0.0, min(1.0, float(progress or 0.0)))
        next_stage = str(stage or job.stage or "running")
        if next_stage != job.stage:
            job.stage_started_at_monotonic = time.monotonic()
            job.stage_progress = None
        if next_stage.startswith("fallback_"):
            job.progress = next_progress
        else:
            job.progress = max(job.progress, next_progress)
        job.stage = next_stage
        if isinstance(detail, dict):
            raw_encoder_warning = detail.get("encoder_warning")
            if (
                isinstance(raw_encoder_warning, dict)
                and raw_encoder_warning.get("code") == "NVIDIA_DRIVER_TOO_OLD"
            ):
                job.encoder_warning = dict(raw_encoder_warning)
            if detail.get("stage_progress") is not None:
                job.stage_progress = max(0.0, min(1.0, float(detail["stage_progress"])))

    bake_dir: Optional[Path] = None
    try:
        radar_spec = prepared.pop("radar_spec", None)
        clip_path_by_id = prepared.pop("clip_path_by_id", None) or {}
        name_cards_by_clip_id = prepared.pop("name_cards_by_clip_id", None)
        if radar_spec and radar_spec.get("use_new"):
            from ..features.cs_data_radar.export_bake import (
                bake_candidate_videos,
                collect_portraits_for_keys,
                fit_instance_videos,
            )
            from ..video_composer import probe_video_audio_summary, resolve_ffprobe_binary

            segments = list(radar_spec.get("segments") or [])
            if not any(seg.get("kind") == "clip" for seg in segments):
                raise MontageComposerError("MONTAGE_NO_CLIPS")
            used_keys = list(radar_spec.get("used_keys") or [])
            first_clip_id = next(int(seg["clip_id"]) for seg in segments if seg.get("kind") == "clip")
            first_path = Path(clip_path_by_id[first_clip_id])
            fitted: dict[str, Path] = {}
            baked: dict[str, Path] = {}
            if used_keys:
                job.stage = "radar_bake"
                job.progress = max(job.progress, 0.04)
                ffprobe = resolve_ffprobe_binary(prepared["ffmpeg_bin"])
                info = await asyncio.to_thread(probe_video_audio_summary, first_path, ffprobe)
                fps = max(1, int(round(float(info.get("fps") or 24))))
                width = int(info.get("width") or 1920)
                height = int(info.get("height") or 1080)
                bake_dir = Path(job.output_path).parent / f".radar_bake_{job.export_id}"
                portraits = await collect_portraits_for_keys(
                    used_keys=used_keys,
                    candidates_by_key=radar_spec.get("candidates_by_key") or {},
                    candidate_state=radar_spec.get("candidate_state") or {},
                    dest_dir=bake_dir / "portraits",
                )

                def _bake() -> tuple[dict[str, Path], dict[str, Path]]:
                    baked_videos = bake_candidate_videos(
                        ffmpeg_bin=prepared["ffmpeg_bin"],
                        used_keys=used_keys,
                        candidates_by_key=radar_spec.get("candidates_by_key") or {},
                        candidate_state=radar_spec.get("candidate_state") or {},
                        portraits=portraits,
                        out_dir=bake_dir,
                        fps=fps,
                        width=width,
                        height=height,
                    )
                    fitted_videos = fit_instance_videos(
                        ffmpeg_bin=prepared["ffmpeg_bin"],
                        segments=segments,
                        baked_by_key=baked_videos,
                        out_dir=bake_dir / "fit",
                        fps=float(fps),
                    )
                    return baked_videos, fitted_videos

                baked, fitted = await asyncio.to_thread(_bake)

            clip_paths: list[Path] = []
            clip_row_ids: list[Any] = []
            name_cards_list: list[Optional[dict]] = []
            for seg in segments:
                if seg.get("kind") == "radar":
                    row_id = str(seg.get("row_id") or "")
                    video = fitted.get(row_id) or baked.get(str(seg.get("candidate_key") or ""))
                    if video is None or not Path(video).is_file():
                        raise RadarBakeError("MONTAGE_RADAR_BAKE_FAILED", name=str(seg.get("candidate_key") or row_id))
                    clip_paths.append(Path(video))
                    clip_row_ids.append(row_id)
                    name_cards_list.append(None)
                    continue
                cid = int(seg["clip_id"])
                clip_paths.append(Path(clip_path_by_id[cid]))
                clip_row_ids.append(cid)
                if name_cards_by_clip_id is not None:
                    name_cards_list.append(name_cards_by_clip_id.get(cid))
            prepared["clip_paths"] = clip_paths
            prepared["clip_row_ids"] = clip_row_ids
            prepared["radar_segments"] = []
            if name_cards_by_clip_id is not None:
                prepared["name_cards"] = name_cards_list if any(x is not None for x in name_cards_list) else None

        await asyncio.to_thread(
            compose_montage,
            **prepared,
            progress_callback=on_progress,
            cancel_event=job.cancel_event,
        )
    except RadarBakeError as e:
        error_code = str(e.code or "MONTAGE_RADAR_BAKE_FAILED")
        job.status = "error"
        job.stage = "error"
        job.error = error_code
        await montage_db.update_export(
            job.export_id,
            status="error",
            error_msg=error_code,
        )
        export_event(
            "pipeline_failed",
            level=logging.ERROR,
            status="error",
            error_code=error_code,
        )
        logger.error(
            "video export summary feature=montage export_id=%s status=error code=%s",
            job.export_id,
            error_code,
        )
        return
    except MontageComposerError as e:
        if e.code == "MONTAGE_EXPORT_CANCELLED" or job.cancel_event.is_set():
            await finish_cancelled()
            return
        detail = montage_detail_from_exception(e)
        error_code = str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        job.status = "error"
        job.stage = "error"
        job.error = error_code
        await montage_db.update_export(
            job.export_id,
            status="error",
            error_msg=error_code,
        )
        export_event(
            "pipeline_failed",
            level=logging.ERROR,
            status="error",
            error_code=error_code,
            failure_domain=detail.get("failure_domain"),
            encoder=detail.get("encoder"),
            branch=detail.get("branch"),
        )
        logger.error(
            "video export summary feature=montage export_id=%s status=error code=%s",
            job.export_id,
            error_code,
        )
        return
    except Exception:
        logger.exception("montage background export failed export_id=%s", job.export_id)
        job.status = "error"
        job.stage = "error"
        job.error = "MONTAGE_EXPORT_FAILED"
        await montage_db.update_export(
            job.export_id,
            status="error",
            error_msg=job.error,
        )
        return
    finally:
        if bake_dir is not None:
            import shutil

            shutil.rmtree(bake_dir, ignore_errors=True)

    job.status = "done"
    job.stage = "done"
    job.progress = 1.0
    job.stage_progress = 1.0
    job.error = ""
    await montage_db.update_export(
        job.export_id,
        status="done",
        error_msg="",
        output_path=job.output_path,
    )
    export_event(
        "pipeline_completed",
        status="done",
        database_export_id=job.export_id,
        output_name=Path(job.output_path).name,
    )
    logger.info(
        "video export summary feature=montage export_id=%s status=done output=%s",
        job.export_id,
        Path(job.output_path).name,
    )


@router.post("/api/montage/export")
@video_export_endpoint("montage")
async def montage_export(body: MontageExportBody):
    cfg = load_config()
    try:
        from ..video_composer import MontageComposerError, resolve_ffmpeg_binary

        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as e:
        from ..montage_errors import montage_detail_from_exception

        raise HTTPException(400, montage_detail_from_exception(e)) from e

    extras: dict[str, Any] = {}
    if body.project_id is not None:
        proj = await montage_db.get_project(int(body.project_id))
        if not proj:
            from ..api_errors import error_detail

            raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND"))
        extras = proj.get("body") if isinstance(proj.get("body"), dict) else {}

    clip_ids = list(body.recorded_clip_ids) if body.recorded_clip_ids is not None else list(extras.get("recorded_clip_ids") or [])
    timeline_raw = body.timeline_ids if body.timeline_ids is not None else (
        body.ordered_ids if body.ordered_ids is not None else (
            extras.get("timeline_ids") if extras.get("timeline_ids") is not None else extras.get("ordered_ids")
        )
    )
    radar_enabled_eff = (
        bool(body.radar_enabled)
        if body.radar_enabled is not None
        else (bool(extras.get("radar_enabled")) if extras.get("radar_enabled") is not None else True)
    )
    radar_items_eff = body.radar_items if body.radar_items is not None else (extras.get("radar_items") or {})
    radar_candidate_state_eff = (
        body.radar_candidate_state
        if body.radar_candidate_state is not None
        else (extras.get("radar_candidate_state") or {})
    )
    if not clip_ids and not timeline_raw:
        from ..api_errors import error_detail

        raise HTTPException(400, error_detail("MONTAGE_NO_CLIPS"))

    def _coalesce(req_val: Optional[str], key: str) -> Optional[str]:
        if req_val is not None:
            s = str(req_val).strip()
            return s or None
        v = extras.get(key)
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    bgm_s = _coalesce(body.bgm_path, "bgm_path")
    intro_s = _coalesce(body.intro_path, "intro_path")
    outro_s = _coalesce(body.outro_path, "outro_path")

    def _coalesce_volume(req_val: Optional[float], key: str) -> Optional[float]:
        if req_val is not None:
            try:
                return max(0.0, min(2.0, float(req_val)))
            except (TypeError, ValueError):
                return None
        if not isinstance(extras, dict):
            return None
        v = extras.get(key)
        if v is None:
            return None
        try:
            return max(0.0, min(2.0, float(v)))
        except (TypeError, ValueError):
            return None

    bgm_volume_eff = _coalesce_volume(body.bgm_volume, "bgm_volume")

    def _coalesce_float(req_val: Optional[float], key: str, lo: float = 0.0, hi: float = 1e9) -> Optional[float]:
        v = req_val if req_val is not None else (extras.get(key) if isinstance(extras, dict) else None)
        if v is None:
            return None
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return None

    bgm_start_eff = _coalesce_float(body.bgm_start_sec, "bgm_start_sec", lo=0.0)
    intro_img_dur_eff = _coalesce_float(body.intro_image_duration, "intro_image_duration", lo=1.0, hi=60.0)
    outro_img_dur_eff = _coalesce_float(body.outro_image_duration, "outro_image_duration", lo=1.0, hi=60.0)

    transitions_eff: Any = body.transitions
    if transitions_eff is None and isinstance(extras, dict):
        transitions_eff = extras.get("transitions")

    # player_avatars / name_cards_enabled — coalesce from request or project extras
    player_avatars_eff: list[PlayerAvatar]
    if body.player_avatars:
        player_avatars_eff = body.player_avatars
    else:
        raw_pas = extras.get("player_avatars") if isinstance(extras, dict) else None
        if isinstance(raw_pas, list):
            player_avatars_eff = [PlayerAvatar(**pa) for pa in raw_pas if isinstance(pa, dict)]
        else:
            player_avatars_eff = []

    name_cards_enabled_eff: bool
    if body.name_cards_enabled is not None:
        name_cards_enabled_eff = bool(body.name_cards_enabled)
    else:
        name_cards_enabled_eff = bool(extras.get("name_cards_enabled")) if isinstance(extras, dict) else False

    framemeld_enabled_eff = (
        bool(body.framemeld_enabled)
        if body.framemeld_enabled is not None
        else bool(extras.get("framemeld_enabled")) if isinstance(extras, dict) else False
    )

    # cs数据图：统一时间线（新）或旧版 before_clip 段
    radar_segments_eff: list[RadarSegment]
    if body.radar_segments:
        radar_segments_eff = body.radar_segments
    else:
        raw_rs = extras.get("radar_segments") if isinstance(extras, dict) else None
        if isinstance(raw_rs, list):
            radar_segments_eff = [RadarSegment(**rs) for rs in raw_rs if isinstance(rs, dict)]
        else:
            radar_segments_eff = []

    from ..features.cs_data_radar.export_bake import RadarBakeError
    from ..features.cs_data_radar.montage_export import resolve_radar_timeline, validate_radar_parse_data
    from ..features.cs_data_radar.timeline import clip_ids_from_timeline

    radar_plan = resolve_radar_timeline(
        recorded_clip_ids=[int(x) for x in clip_ids] if clip_ids else [],
        ordered_ids=list(timeline_raw) if timeline_raw is not None else None,
        radar_items=radar_items_eff,
        radar_segments=[rs.model_dump() for rs in radar_segments_eff],
        radar_enabled=radar_enabled_eff,
    )
    clip_ids = clip_ids_from_timeline(radar_plan["ordered_ids"]) or [int(x) for x in clip_ids]
    if not clip_ids:
        from ..api_errors import error_detail

        raise HTTPException(400, error_detail("MONTAGE_NO_CLIPS"))

    radar_segments_prepared: list[dict[str, Any]] = []
    if not radar_plan["use_new"]:
        clip_id_index: dict[int, int] = {int(cid): i for i, cid in enumerate(clip_ids)}
        for rs in radar_segments_eff:
            image_raw = str(rs.image_path or "").strip()
            if not image_raw:
                continue
            radar_path = Path(image_raw).expanduser()
            if not radar_path.is_file():
                from ..api_errors import error_detail as _ed

                raise HTTPException(400, _ed("RADAR_IMAGE_MISSING", name=radar_path.name))
            before_index = clip_id_index.get(int(rs.before_clip_id), 0)
            radar_segments_prepared.append(
                {
                    "before_clip_index": max(0, min(before_index, max(0, len(clip_ids) - 1))),
                    "image_path": str(radar_path),
                    "duration": max(1.0, min(60.0, float(rs.duration) if rs.duration else 4.0)),
                }
            )

    try:
        from ..video_composer import MontageComposerError, validate_output_path

        out = validate_output_path(body.output_path)
    except MontageComposerError as e:
        from ..montage_errors import montage_detail_from_exception

        raise HTTPException(400, montage_detail_from_exception(e)) from e

    rows = await montage_db.get_recorded_clips_by_ids([int(x) for x in clip_ids])
    clip_paths: list[Path] = []
    clip_path_by_id: dict[int, Path] = {}
    for cid in clip_ids:
        row = rows.get(int(cid))
        if not row:
            from ..api_errors import error_detail

            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(cid)))
        path = Path(str(row["output_path"]))
        clip_paths.append(path)
        clip_path_by_id[int(cid)] = path

    radar_candidates_by_key: dict[str, dict[str, Any]] = {}
    if radar_plan["use_new"] and radar_plan["used_keys"]:
        from ..databases import demo_db

        try:
            radar_candidates_by_key = await validate_radar_parse_data(
                clips=[rows[int(cid)] for cid in clip_ids if int(cid) in rows],
                used_keys=list(radar_plan["used_keys"]),
                candidate_state=radar_candidate_state_eff if isinstance(radar_candidate_state_eff, dict) else {},
                demo_db=demo_db,
                radar_items=radar_plan.get("radar_items") or {},
            )
        except RadarBakeError as e:
            from ..api_errors import error_detail as _ed

            raise HTTPException(400, _ed(e.code, **e.params)) from e

    intro_p = Path(intro_s).expanduser() if intro_s else None
    outro_p = Path(outro_s).expanduser() if outro_s else None
    bgm_p = Path(bgm_s).expanduser() if bgm_s else None

    # Build name_cards list parallel to clip_paths
    # Build a lookup from player_key → PlayerAvatar for fast matching
    _pa_lookup: dict[str, PlayerAvatar] = {pa.player_key: pa for pa in player_avatars_eff}

    name_cards_list: list[Optional[dict]] = []
    name_cards_by_clip_id: dict[int, Optional[dict]] = {}
    for cid in clip_ids:
        row = rows.get(int(cid))
        if row is None:
            name_cards_list.append(None)
            name_cards_by_clip_id[int(cid)] = None
            continue
        # Determine player_key for this clip row (steamid takes priority)
        steamid_val = (
            row.get("target_steamid64")
            or row.get("target_steam_id")
            or row.get("steamid")
        )
        if steamid_val:
            pk = "sid:" + str(steamid_val)
        else:
            pk = "name:" + normalize_player_key(str(row.get("player_name") or ""))

        matched_pa = _pa_lookup.get(pk)
        if matched_pa is None or not matched_pa.enabled:
            name_cards_list.append(None)
            name_cards_by_clip_id[int(cid)] = None
        else:
            display_name = matched_pa.player_name or str(row.get("player_name") or "")
            category = resolve_name_card_category(row)
            eyebrow = resolve_name_card_eyebrow(row, category)
            tags, result_tag = build_name_card_tags_and_result(row, category)
            card = {
                "avatar_path": matched_pa.avatar_path,
                "display_name": display_name,
                "category": category,
                "eyebrow": eyebrow,
                "result": result_tag,
                "tags": tags,
                "enabled": True,
            }
            name_cards_list.append(card)
            name_cards_by_clip_id[int(cid)] = card

    name_cards_arg = name_cards_list if name_cards_enabled_eff else None

    snap = {
        "recorded_clip_ids": clip_ids,
        "bgm_path": bgm_s,
        "intro_path": intro_s,
        "outro_path": outro_s,
        "output_path": str(out),
    }
    if isinstance(transitions_eff, dict):
        snap["transitions"] = transitions_eff
    if body.ordered_ids is not None:
        snap["ordered_ids"] = list(body.ordered_ids)
    if body.theme_id is not None:
        tid = str(body.theme_id).strip()
        if tid:
            snap["theme_id"] = tid
    if bgm_volume_eff is not None:
        snap["bgm_volume"] = bgm_volume_eff
    if bgm_start_eff is not None:
        snap["bgm_start_sec"] = bgm_start_eff
    if intro_img_dur_eff is not None:
        snap["intro_image_duration"] = intro_img_dur_eff
    if outro_img_dur_eff is not None:
        snap["outro_image_duration"] = outro_img_dur_eff
    snap["player_avatars"] = [pa.model_dump() for pa in player_avatars_eff]
    snap["name_cards_enabled"] = name_cards_enabled_eff
    snap["framemeld_enabled"] = framemeld_enabled_eff
    snap["radar_segments"] = radar_segments_prepared
    snap["timeline_ids"] = [str(x) for x in radar_plan["ordered_ids"]]
    snap["radar_enabled"] = radar_enabled_eff
    snap["radar_items"] = radar_plan.get("radar_items") or {}
    snap["radar_candidate_state"] = radar_candidate_state_eff if isinstance(radar_candidate_state_eff, dict) else {}
    export_id = await montage_db.create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=snap,
        status="queued",
        output_path=str(out),
    )
    set_video_export_database_id(export_id)
    export_event(
        "background_job_queued",
        status="queued",
        database_export_id=export_id,
        project_id=body.project_id,
        output_name=out.name,
        clip_count=len(clip_paths),
        requested_encoder=cfg.montage_encoder or "auto",
        framemeld_enabled=framemeld_enabled_eff,
    )

    job = MontageExportJob(
        export_id=export_id,
        project_id=int(body.project_id) if body.project_id is not None else None,
        output_path=str(out),
    )
    montage_export_jobs[export_id] = job
    prepared = {
        "ffmpeg_bin": ffmpeg_bin,
        "clip_paths": clip_paths,
        "intro_path": intro_p,
        "outro_path": outro_p,
        "bgm_path": bgm_p,
        "output_path": out,
        "transitions": transitions_eff if isinstance(transitions_eff, dict) else None,
        "clip_row_ids": [int(x) for x in clip_ids],
        "bgm_volume": bgm_volume_eff,
        "bgm_start_sec": bgm_start_eff,
        "intro_image_duration": intro_img_dur_eff,
        "outro_image_duration": outro_img_dur_eff,
        "montage_encoder": cfg.montage_encoder or "auto",
        "name_cards": name_cards_arg,
        "framemeld_enabled": framemeld_enabled_eff,
        "radar_segments": radar_segments_prepared,
        "radar_spec": {
            **radar_plan,
            "candidates_by_key": radar_candidates_by_key,
            "candidate_state": radar_candidate_state_eff if isinstance(radar_candidate_state_eff, dict) else {},
        },
        "clip_path_by_id": clip_path_by_id,
        "name_cards_by_clip_id": name_cards_by_clip_id if name_cards_enabled_eff else None,
    }
    job.task = asyncio.create_task(_run_montage_export_job(job, prepared))
    return montage_export_job_snapshot(job)


_AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Subtitle label displayed under the player name in the burned-in name card
_CATEGORY_SUBTITLE: dict[str, str] = {
    "highlight": "高光",
    "fail": "下饭",
    "meme_death": "梗死亡",
    "compilation": "合集",
}

_CATEGORY_EYEBROW: dict[str, str] = {
    "highlight":   "HIGHLIGHT · 高光",
    "fail":        "LOWLIGHT · 下饭",
    "meme_death":  "MEME · 梗死亡",
    "compilation": "ROUND · 合集",
}

# 高光片段 RESULT 块显示的杀数 tag 集合
_KILL_COUNT_TAGS: frozenset[str] = frozenset({
    "五杀 (ACE)", "四杀", "三杀", "双杀",
})


@router.post("/api/montage/avatars")
async def upload_montage_avatar(file: UploadFile = File(...)):
    """接收玩家头像图片上传，存储到 data/montage_avatars/，返回绝对路径。"""
    content_type = file.content_type or ""
    if content_type not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(400, "仅支持 JPEG / PNG / WebP / GIF 格式图片")

    data = await file.read()
    if len(data) > _AVATAR_MAX_BYTES:
        raise HTTPException(400, "图片文件大小不能超过 5MB")

    avatars_dir = get_data_dir() / "montage_avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)

    original_name = file.filename or ""
    suffix = Path(original_name).suffix if original_name else ""
    if not suffix:
        suffix = ".jpg"
    dest = avatars_dir / (str(uuid.uuid4()) + suffix)

    def _write(p: Path, d: bytes) -> None:
        p.write_bytes(d)

    await asyncio.to_thread(_write, dest, data)
    return {"path": str(dest), "url": f"/api/montage/avatars/{dest.name}"}


@router.get("/api/montage/avatars/{filename}")
async def serve_montage_avatar(filename: str):
    import re
    # Reject path traversal attempts
    if not re.fullmatch(r"[a-zA-Z0-9_\-\.]+", filename):
        raise HTTPException(400, "Invalid filename")
    avatar_dir = get_data_dir() / "montage_avatars"
    file_path = avatar_dir / filename
    if not file_path.is_file() or not str(file_path.resolve()).startswith(str(avatar_dir.resolve())):
        raise HTTPException(404, "Avatar not found")
    return FileResponse(str(file_path))
