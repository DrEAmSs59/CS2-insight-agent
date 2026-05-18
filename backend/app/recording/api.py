import asyncio
import dataclasses
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .models import RecordingRequestDTO, RecordingPlan, RequestType, RecordingOptions
from .plan_builder import build_plan
from .normalizer import NormalizationError
from ..env_utils import OBSConfig, AppConfig, load_config, ensure_cs2_path, resolve_config_path
from .executor.obs_client import OBSClient, OBSConnectionError
from .executor.recording_executor import RecordingExecutor, ExecutionResult
from .executor.obs_fade_controller import OBSFadeController, FadeConfig
from .services.result_writer import write_result
from ..montage_db import MontageDB

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/recording", tags=["recording"])

# ── Lazy singleton for the shared cs2-insight.db ────────────────────────────
_montage_db: Optional[MontageDB] = None


def _get_montage_db() -> MontageDB:
    global _montage_db
    if _montage_db is None:
        db_path = resolve_config_path().parent / "cs2-insight.db"
        _montage_db = MontageDB(db_path)
    return _montage_db


def _enum_value(v) -> str:
    """Return the plain string value of an enum member, or str(v) for plain strings."""
    return v.value if hasattr(v, "value") else str(v)


# All mapping dicts use plain string keys so they remain correct regardless of
# how Python serialises str-Enum members (behaviour changed in Python 3.11).
_REQUEST_TYPE_TO_CATEGORY: dict[str, str] = {
    "highlight": "highlight",
    "fail": "fail",
    "timeline_kill": "timeline",
    "timeline_death": "timeline",
    "kill_compilation": "compilation",
    "death_compilation": "compilation",
    "round_compilation": "compilation",
    "timeline_round": "timeline_round",
}

_REQUEST_TYPE_TO_TIMELINE_RECORD_KIND: dict[str, str] = {
    "timeline_kill": "kill",
    "timeline_death": "death",
    "timeline_round": "round",
}

_REQUEST_TYPE_TO_COMPILATION_KIND: dict[str, str] = {
    "kill_compilation": "all_kills",
    "death_compilation": "all_deaths",
    "round_compilation": "rounds",
}


def _resolve_fade_config(options: RecordingOptions, cfg: AppConfig) -> FadeConfig:
    """Merge per-request RecordingOptions fade overrides with AppConfig global defaults."""
    return FadeConfig(
        enabled=(
            options.obs_transition_enabled
            if options.obs_transition_enabled is not None
            else cfg.obs_transition_enabled
        ),
        transition_name=(
            options.obs_transition_name
            if options.obs_transition_name is not None
            else cfg.obs_transition_name
        ),
        duration_ms=(
            options.obs_transition_duration_ms
            if options.obs_transition_duration_ms is not None
            else cfg.obs_transition_duration_ms
        ),
        game_scene_name=cfg.obs_game_scene_name,
        black_scene_name=cfg.obs_black_scene_name,
    )


def build_v3_recorded_clip_meta(
    dto: RecordingRequestDTO,
    plan: "Optional[RecordingPlan]",
    result: dict,
) -> dict:
    """Build clip_meta for recorded_clips from a V3 DTO + plan + execution result."""
    request_type = _enum_value(dto.request_type) if dto.request_type else ""
    source_type = _enum_value(dto.source_type) if dto.source_type else ""
    category = _REQUEST_TYPE_TO_CATEGORY.get(request_type, "highlight")
    timeline_record_kind = _REQUEST_TYPE_TO_TIMELINE_RECORD_KIND.get(request_type)
    compilation_kind = _REQUEST_TYPE_TO_COMPILATION_KIND.get(request_type)

    events = dto.events or []
    # For round-based request types, source_rounds come from dto.rounds (events is empty).
    # For event-based types, derive from the events list.
    if dto.rounds:
        source_rounds = sorted(r.round for r in dto.rounds if r.round is not None)
    else:
        source_rounds = sorted({e.round for e in events if e.round})
    first_round = source_rounds[0] if source_rounds else None

    kill_events = [e for e in events if str(getattr(e.event_type, "value", e.event_type)) == "kill"]
    death_events = [e for e in events if str(getattr(e.event_type, "value", e.event_type)) == "death"]
    kill_count = len(kill_events)
    kill_ticks = [e.tick for e in kill_events]
    death_tick = death_events[0].tick if death_events else None

    victims = list({e.victim.name for e in kill_events if e.victim and e.victim.name})
    killers = list({e.killer.name for e in events if e.killer and e.killer.name})

    killer_name: Optional[str] = None
    if request_type in ("fail", "timeline_death"):
        killer_name = killers[0] if killers else None

    target_player_name = (dto.target_player.name if dto.target_player else None)
    target_steamid64 = (dto.target_player.steamid64 if dto.target_player else None)

    source_ref = dto.source_ref
    timeline_event_id = (source_ref.timeline_event_id if source_ref else None) or None
    # Always set timeline_source for timeline request types regardless of timeline_event_id
    if timeline_record_kind:
        timeline_source: Optional[str] = "round_timeline_event"
    elif timeline_event_id:
        timeline_source = "round_timeline_event"
    else:
        timeline_source = None

    # planned_segments: prefer live plan object, fall back to pre-serialized data in result dict
    if plan is not None:
        planned_segments: list = [
            {
                "segment_index": s.segment_index,
                "kind": str(s.source_type.value if hasattr(s.source_type, "value") else s.source_type),
                "source_type": str(s.source_type.value if hasattr(s.source_type, "value") else s.source_type),
                "perspective": str(s.perspective.value if hasattr(s.perspective, "value") else s.perspective),
                "demo_start_tick": s.start_tick,
                "demo_end_tick": s.end_tick,
                "target_player_name": s.target_player_name,
                "target_steamid64": s.target_steamid64,
                "round": s.round,
                "anchor_ticks": s.anchor_ticks,
            }
            for s in plan.segments
        ]
    else:
        planned_segments = result.get("planned_segments") or []

    meta: dict = {
        "recording_origin": "recording_v3",
        "recording_request_type": request_type,
        "recording_source_type": source_type,
        "workbench_clip_kind": request_type,
        "category": category,
        "request_type": request_type,
        "map_name": dto.demo.map_name if dto.demo else "unknown",
        "round": first_round,
        "source_rounds": source_rounds,
        "kill_count": kill_count,
        "kill_ticks": kill_ticks,
        "context_tags": [],
        "victims": victims,
        "killers": killers,
        "killer_name": killer_name,
        "target_player": target_player_name,
        "target_steam_id": target_steamid64,
        "steamid": target_steamid64,
        "demo_path": dto.demo.demo_path if dto.demo else None,
        "timeline_event_id": timeline_event_id,
        "timeline_source": timeline_source,
        "timeline_record_kind": timeline_record_kind,
        "compilation_kind": compilation_kind,
        "planned_segments": planned_segments,
        # Execution summary
        "segment_results": result.get("segment_results", []),
        "warnings": result.get("warnings", []),
        # Display fields for the montage workbench material pool
        "pov_hud_enabled": result.get("pov_hud_enabled", False),
        "recording_perspective": result.get("recording_perspective"),
        "victim_pov_segments": result.get("victim_pov_segments", []),
    }
    if death_tick is not None:
        meta["death_tick"] = death_tick
    return {k: v for k, v in meta.items() if v is not None}


async def _persist_v3_results(
    resolved_requests: list[RecordingRequestDTO],
    results: list[dict],
) -> None:
    """Persist successful V3 recording results into recorded_clips for the montage workbench."""
    db = _get_montage_db()
    # Ensure the schema exists (noop if already initialized by main.py's MontageDB instance).
    await db.init_tables()

    dto_by_id = {dto.request_id: dto for dto in resolved_requests}

    for r in results:
        if not isinstance(r, dict):
            continue
        if not r.get("success"):
            continue
        output_path = (r.get("output_path") or "").strip()
        if not output_path:
            continue

        dto = dto_by_id.get(r.get("request_id") or "")
        if dto is None:
            logger.warning("[RecordingV3] persist: no DTO found for request_id=%s", r.get("request_id"))
            continue

        demo_path = (dto.demo.demo_path if dto.demo else "") or ""
        if not demo_path:
            continue

        clip_id = (
            (dto.source_ref.original_clip_id if dto.source_ref else None)
            or dto.request_id
            or ""
        )
        demo_filename = (dto.demo.demo_filename if dto.demo else None) or None
        player_name = (dto.target_player.name if dto.target_player else None) or None

        # Compute duration from timing fields when available.
        dur_f: Optional[float] = None
        started = r.get("recording_started_at")
        stopped = r.get("recording_stopped_at")
        if started is not None and stopped is not None:
            try:
                dur_f = float(stopped) - float(started)
                if dur_f <= 0:
                    dur_f = None
            except (TypeError, ValueError):
                dur_f = None

        # plan is None here — planned_segments arrive pre-serialized in result dict from execute_plan_queue
        clip_meta = build_v3_recorded_clip_meta(dto, None, r)

        try:
            await db.insert_recorded_clip(
                clip_id=clip_id,
                demo_path=demo_path,
                demo_filename=demo_filename,
                player_name=player_name,
                output_path=output_path,
                duration_sec=dur_f,
                status="ready",
                clip_meta=clip_meta,
            )
            logger.info(
                "[RecordingV3][DB] persisted clip_id=%s output=%s",
                clip_id, output_path,
            )
            logger.info(
                "[RecordingV3][DB] meta request_type=%s workbench_clip_kind=%s category=%s "
                "planned_segments=%d source_rounds=%s",
                clip_meta.get("recording_request_type", ""),
                clip_meta.get("workbench_clip_kind", ""),
                clip_meta.get("category", ""),
                len(clip_meta.get("planned_segments") or []),
                clip_meta.get("source_rounds", []),
            )
        except Exception:
            logger.exception(
                "[RecordingV3] recorded_clips insert failed clip_id=%s path=%s",
                clip_id, output_path,
            )

# Module-level abort event for the V3 queue; set when a queue is running, cleared in finally.
_queue_abort_event: Optional[asyncio.Event] = None


def get_queue_abort_event() -> Optional[asyncio.Event]:
    """Return the current V3 queue abort event, or None if idle."""
    return _queue_abort_event


@router.post("/abort", response_model=dict)
def recording_abort():
    """请求中止当前进行中的 V3 录制队列（异步收尾，接口立即返回）。"""
    qev = get_queue_abort_event()
    if qev is not None:
        qev.set()
        return {"status": "ok", "message": "已请求中止，正在收尾…"}
    return {"status": "idle", "message": "当前没有进行中的录制"}


@router.post("/plan", response_model=dict)
async def create_recording_plan(dto: RecordingRequestDTO) -> dict:
    try:
        plan = build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Compute per-segment debug metadata for UI display
    def _seg_debug(s):
        meta: dict = dict(s.metadata)
        meta["anchor_preserved"] = (
            s.is_final_round
            and bool(s.anchor_ticks)
            and any("guard_skipped" in w or "anchor_preserved" in w for w in plan.warnings
                    if f"segment {s.segment_index}:" in w)
        )
        meta["demo_exit_guard_applied"] = (
            s.is_final_round and s.safe_end_tick is not None
        )
        meta["target_steamid64_missing"] = not bool(s.target_steamid64)
        return {
            "segment_index": s.segment_index,
            "source_type": s.source_type,
            "perspective": s.perspective,
            "start_tick": s.start_tick,
            "end_tick": s.end_tick,
            "anchor_ticks": s.anchor_ticks,
            "safe_seek_tick": s.safe_seek_tick,
            "safe_end_tick": s.safe_end_tick,
            "round": s.round,
            "is_final_round": s.is_final_round,
            "target_player_name": s.target_player_name,
            "target_steamid64": s.target_steamid64,
            "disabled": s.disabled,
            "disabled_reason": s.disabled_reason,
            **meta,
        }

    return {
        "request_id": plan.request_id,
        "request_type": plan.request_type,
        "demo_path": plan.demo_path,
        "tick_rate": plan.tick_rate,
        "estimated_duration_sec": plan.estimated_duration_sec,
        "warnings": plan.warnings,
        "active_segments": [_seg_debug(s) for s in plan.segments],
        "disabled_segments": [_seg_debug(s) for s in plan.disabled_segments],
        "summary": {
            "active_count": len(plan.segments),
            "disabled_count": len(plan.disabled_segments),
            "final_round_segments": sum(1 for s in plan.segments if s.is_final_round),
            "victim_segments_disabled_no_steamid": sum(
                1 for s in plan.disabled_segments
                if s.disabled_reason == "missing_victim_steamid64"
            ),
            "guard_skipped_warnings": sum(
                1 for w in plan.warnings if "guard_skipped" in w
            ),
        },
    }


@router.post("/execute", response_model=dict)
async def execute_recording(dto: RecordingRequestDTO) -> dict:
    """
    Build a RecordingPlan and execute it using OBS + CS2.
    Returns execution result summary.
    """
    try:
        plan = build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    config = load_config()
    obs_cfg = config.obs if hasattr(config, "obs") else OBSConfig()
    obs_client = OBSClient(obs_cfg)

    try:
        obs_client.connect()
    except OBSConnectionError as e:
        raise HTTPException(status_code=503, detail=f"OBS connection failed: {e}")

    fade_config = _resolve_fade_config(dto.options, config)
    fade_ctrl = OBSFadeController(obs_cfg, fade_config)
    if not await fade_ctrl.setup():
        logger.warning("OBS fade transition setup failed or disabled; recording in hard-cut mode")

    executor = RecordingExecutor(obs_client, fade_controller=fade_ctrl)
    result = await executor.execute(plan)

    try:
        write_result(result)
    except Exception as e:
        logging.getLogger(__name__).warning("Failed to write result: %s", e)

    return {
        "success": result.success,
        "request_id": result.request_id,
        "output_path": result.output_path,
        "warnings": result.warnings,
        "error": result.error,
        "segments": [
            {
                "segment_index": s.segment_index,
                "status": s.status,
                "error": s.error,
            }
            for s in result.segment_results
        ],
    }


class QueueRecordingRequest(BaseModel):
    requests: list[RecordingRequestDTO]
    warmup: Optional[dict] = None
    obs: Optional[dict] = None
    pov_hud: Optional[dict] = None  # {enabled: bool, radar_mode: int, teamcounter_numeric: bool}


@router.post("/queue", response_model=list[dict])
async def execute_recording_queue(req: QueueRecordingRequest) -> list[dict]:
    """
    [RecordingV3] Execute a batch of RecordingRequestDTOs through the new
    build_plan → RecordingExecutor pipeline.

    Groups requests by demo path (one CS2 session per unique demo), launches
    CS2 via OBSDirector infrastructure, then records each plan segment using
    the new RecordingExecutor.
    """
    import tempfile
    from pathlib import Path
    from ..obs_director import OBSDirector, CS2AlreadyRunningError, CS2NotReadyError, RecordingWarmupExtras
    from ..cs2_config_backup import is_cs2_running, is_restore_required

    def _resolve_demo_path(p: str) -> Path:
        raw = (p or "").strip()
        if not raw:
            raise HTTPException(400, "Demo 路径为空")
        cand = Path(raw)
        if cand.is_file():
            return cand.resolve()
        upload_dir = Path(tempfile.gettempdir()) / "cs2_insight_demos"
        dest = (upload_dir / cand.name).resolve()
        if dest.is_file():
            return dest
        raise HTTPException(404, f"未找到 Demo 文件: {raw}")

    def _merge_obs(payload: Optional[OBSConfig], saved: OBSConfig) -> OBSConfig:
        if payload is None:
            return saved
        host = (payload.host or "").strip() or saved.host
        try:
            port = int(payload.port)
        except (TypeError, ValueError):
            port = int(saved.port) if isinstance(saved.port, int) else saved.port
        raw_pw = (payload.password or "").strip()
        if raw_pw.startswith("****"):
            raw_pw = ""
        password = raw_pw if raw_pw else saved.password
        return OBSConfig(host=host, port=port, password=password)

    logger.info("[RecordingV3] /queue received %d requests", len(req.requests))

    if not req.requests:
        return []

    cfg = load_config()
    cfg = ensure_cs2_path(cfg)

    if not cfg.cs2_path:
        raise HTTPException(
            400,
            "未配置 CS2 路径且自动探测失败。请在左侧「CS2 路径」中填写 cs2.exe 完整路径，或点击「自动探测」。",
        )
    if is_cs2_running():
        raise HTTPException(409, "CS2 正在运行，请先关闭 CS2 再开始录制。")
    if is_restore_required():
        raise HTTPException(
            409,
            "检测到上次录制可能异常退出，玩家配置尚未恢复。请先点击「一键恢复玩家配置」，恢复完成后再开始新的录制。",
        )

    # Resolve OBS config (merge request-level obs override with saved config).
    obs_cfg_override = None
    if req.obs:
        try:
            obs_cfg_override = OBSConfig(**req.obs)
        except Exception:
            pass
    obs_cfg = _merge_obs(obs_cfg_override, cfg.obs)

    # Resolve demo paths: replace filename/relative refs with absolute paths.
    resolved_requests = []
    for dto in req.requests:
        try:
            abs_path = _resolve_demo_path(dto.demo.demo_path or dto.demo.demo_filename)
        except HTTPException as e:
            logger.warning("[RecordingV3] demo not found for request %s: %s", dto.request_id, e.detail)
            resolved_requests.append(dto)  # keep as-is; executor will fail gracefully
            continue
        # Replace demo_path with resolved absolute path
        updated_demo = dto.demo.model_copy(update={"demo_path": str(abs_path)})
        resolved_requests.append(dto.model_copy(update={"demo": updated_demo}))

    # Build warmup extras from request warmup dict.
    # Merge pov_hud fields into warmup_extras so execute_plan_queue sees them.
    warmup_extras = None
    if req.warmup:
        try:
            _valid_keys = {f.name for f in dataclasses.fields(RecordingWarmupExtras)}
            _filtered = {k: v for k, v in req.warmup.items() if k in _valid_keys}
            warmup_extras = RecordingWarmupExtras(**_filtered)
        except Exception as e:
            logger.warning("[RecordingV3] warmup parse failed: %s", e)

    if req.pov_hud and req.pov_hud.get("enabled"):
        pov_hud_cfg = req.pov_hud
        if warmup_extras is None:
            warmup_extras = RecordingWarmupExtras()
        # Patch warmup extras with POV HUD settings
        warmup_extras = dataclasses.replace(
            warmup_extras,
            pov_hud_enabled=True,
            pov_radar_mode=int(pov_hud_cfg.get("radar_mode", 0)),
            pov_teamcounter_numeric=bool(pov_hud_cfg.get("teamcounter_numeric", False)),
        )
        logger.info("[RecordingV3] POV HUD enabled: radar_mode=%s, teamcounter_numeric=%s",
                    warmup_extras.pov_radar_mode, warmup_extras.pov_teamcounter_numeric)

    global _queue_abort_event
    if _queue_abort_event is not None:
        raise HTTPException(409, "已有录制任务进行中，请先中止或等待结束。")

    abort_ev = asyncio.Event()
    _queue_abort_event = abort_ev

    # Build fade controller from the first request's options merged with AppConfig.
    first_options = resolved_requests[0].options if resolved_requests else RecordingOptions()
    fade_config = _resolve_fade_config(first_options, cfg)
    fade_ctrl = OBSFadeController(obs_cfg, fade_config)
    if not await fade_ctrl.setup():
        logger.warning("[RecordingV3] OBS fade transition setup failed or disabled; recording in hard-cut mode")

    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        abort_event=abort_ev,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )

    try:
        results = await director.execute_plan_queue(resolved_requests, warmup=warmup_extras, fade_controller=fade_ctrl)
    except CS2AlreadyRunningError as e:
        raise HTTPException(409, str(e)) from e
    except CS2NotReadyError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:
        logger.exception("[RecordingV3] execute_plan_queue failed")
        raise HTTPException(500, f"录制失败: {e}") from e
    finally:
        _queue_abort_event = None

    # Persist successful recordings to recorded_clips for the montage workbench.
    try:
        await _persist_v3_results(resolved_requests, results)
    except Exception:
        logger.exception("[RecordingV3] _persist_v3_results failed (non-fatal)")

    return results
