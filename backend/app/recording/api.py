import asyncio
import dataclasses
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .models import RecordingRequestDTO, RecordingPlan, RequestType, RecordingOptions
from .plan_builder import build_plan
from .normalizer import NormalizationError, normalize
from .ai_director import (
    suggest_recording_outline,
    outline_to_preview_lines,
    victim_pov_omitted_kills,
    count_available_victim_pov,
)
from .planners.ai_directed_planner import plan_from_ai_outline
from ..env_utils import OBSConfig, AppConfig, load_config, ensure_cs2_path, resolve_config_path
from .executor.obs_client import OBSClient, OBSConnectionError
from .executor.recording_executor import RecordingExecutor, ExecutionResult
from .executor.obs_fade_controller import OBSFadeController, FadeConfig
from .services.result_writer import write_result
from ..montage_db import MontageDB
from ..api_errors import error_detail

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/recording", tags=["recording"])

_KILL_FX_SOURCE = "CS2 Kill FX Overlay"

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
    """Merge per-request RecordingOptions fade overrides with AppConfig global defaults.

    Opt-in semantics for obs_transition_enabled:
      - True  → fade enabled for this recording session
      - False → fade disabled
      - None  → fade disabled (not "inherit from config")

    The AppConfig value is intentionally NOT used as a fallback for enabled: if the
    request didn't explicitly set it to True, the session runs without fade.  This
    prevents a globally-enabled config from silently activating fade when the frontend
    sends null (the default for "user did not toggle this setting").

    transition_name and duration_ms still fall back to config so users don't need to
    re-enter those values every time — they only matter when enabled=True anyway.
    """
    return FadeConfig(
        enabled=bool(options.obs_transition_enabled),  # None / False → disabled
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
    source_ref = dto.source_ref
    if request_type == "kill_compilation" and source_ref and source_ref.group_id == "weapon_kills":
        # The request type selects the existing kill-compilation planner, while
        # group_id preserves this new UI subtype for the material pool.
        compilation_kind = "weapon_kills"

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
        "context_tags": list(source_ref.context_tags) if (source_ref and source_ref.context_tags) else (result.get("context_tags") or []),
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
        return {"status": "ok"}
    return {"status": "idle"}


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


@router.post("/ai-director/preview", response_model=dict)
async def ai_director_preview(dto: RecordingRequestDTO) -> dict:
    """LLM 导播大纲预览（不执行录制）。"""
    try:
        req = normalize(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))

    outline, source, llm_error = await suggest_recording_outline(req)
    preview_lines = outline_to_preview_lines(outline, req)
    segments = plan_from_ai_outline(req, outline)
    victim_count = sum(1 for s in segments if str(getattr(s.perspective, "value", s.perspective)) == "victim")
    victim_blocks = sum(
        1 if b.type == "kill_with_victim" else len(b.kill_indices)
        for b in outline.blocks
        if b.type in {"kill_with_victim", "killer_merged_with_victims"}
    )
    omitted = victim_pov_omitted_kills(outline, req)
    victim_eligible = count_available_victim_pov(req.events)

    blocks_out = []
    for b in outline.blocks:
        row = {"type": b.type, "label": b.label or ""}
        if b.type in {"killer_merged", "killer_merged_with_victims"}:
            row["kill_indices"] = list(b.kill_indices)
        else:
            row["kill_index"] = b.kill_index
        blocks_out.append(row)

    return {
        "source": source,
        "llm_error": llm_error,
        "rationale": outline.rationale,
        "blocks": blocks_out,
        "preview_lines": preview_lines,
        "estimated_segments": len(segments),
        "victim_pov_count": victim_count,
        "victim_pov_blocks": victim_blocks,
        "victim_pov_eligible_count": victim_eligible,
        "victim_pov_cap": victim_eligible,
        "victim_pov_omitted": omitted,
        "kill_count": len(req.events),
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

    # kb_track: 为 overlay 填充逐 tick 按键状态（请求参数优先，否则读全局配置）
    _kb_overlay_req = dto.options.kb_overlay_enabled
    if _kb_overlay_req is None:
        _kb_overlay_req = load_config().kb_overlay_enabled
    if _kb_overlay_req:
        from ..parser.input_track import extract_input_track as _extract_kb
        _kb_off_req = dto.options.kb_overlay_tick_offset  # None → executor falls back to global config
        for _seg in plan.segments:
            _seg.metadata["kb_tick_offset"] = _kb_off_req
            try:
                _seg.metadata["kb_track"] = _extract_kb(
                    plan.demo_path,
                    steamid=_seg.target_steamid64,
                    player_name=_seg.target_player_name,
                    start_tick=_seg.start_tick,
                    end_tick=_seg.end_tick,
                )
            except Exception as _kb_e:
                logger.warning(
                    "kb_track extraction failed seg=%d: %s", _seg.segment_index, _kb_e,
                )
                _seg.metadata["kb_track"] = []

    # kill_track: 为击杀特效 overlay 填充窗口内的特殊击杀事件。
    _exec_cfg = load_config()
    _fx_req = dto.options.kill_fx_enabled
    if _fx_req is None:
        _fx_req = _exec_cfg.kill_fx_enabled
    if _fx_req:
        from ..parser.kill_track import extract_kill_track as _extract_fx
        _ctx_tags = list(dto.source_ref.context_tags or [])
        for _seg in plan.segments:
            # 受害者视角片段不展示目标玩家的击杀特效。
            if str(getattr(_seg.perspective, "value", _seg.perspective)) == "victim":
                continue
            _seg.metadata["kb_tick_offset"] = dto.options.kb_overlay_tick_offset
            _seg.metadata["kill_fx_tick_offset"] = dto.options.kill_fx_tick_offset
            try:
                _seg.metadata["kill_track"] = _extract_fx(
                    plan.demo_path,
                    steamid=_seg.target_steamid64,
                    player_name=_seg.target_player_name,
                    start_tick=_seg.start_tick,
                    end_tick=_seg.end_tick,
                    context_tags=_ctx_tags,
                    round_number=_seg.round,
                )
            except Exception as _fx_e:
                logger.warning(
                    "kill_track extraction failed seg=%d: %s", _seg.segment_index, _fx_e,
                )
                _seg.metadata["kill_track"] = []

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
    # 仅本次录制队列生效，不写入 cs2-insight.config.json
    cs2_extra_launch_args: Optional[str] = None
    record_inject_console_lines: Optional[str] = None


@router.get("/kb-prebuild-status")
def get_kb_prebuild_status() -> dict:
    """轮询虚拟键盘 kb_track 预构建进度，供前端 loading 状态展示。"""
    from .kb_prebuild_state import get as _kbp_get
    return _kbp_get()


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
            raise HTTPException(400, error_detail("RECORDING_DEMO_PATH_EMPTY"))
        cand = Path(raw)
        if cand.is_file():
            return cand.resolve()
        upload_dir = Path(tempfile.gettempdir()) / "cs2_insight_demos"
        dest = (upload_dir / cand.name).resolve()
        if dest.is_file():
            return dest
        raise HTTPException(404, error_detail("RECORDING_DEMO_NOT_FOUND", path=raw))

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
        raise HTTPException(400, error_detail("RECORDING_CS2_PATH_MISSING"))
    if is_cs2_running():
        raise HTTPException(409, error_detail("RECORDING_CS2_RUNNING"))
    if is_restore_required():
        raise HTTPException(409, error_detail("RECORDING_CONFIG_RESTORE_REQUIRED"))

    # Resolve OBS config (merge request-level obs override with saved config).
    obs_cfg_override = None
    if req.obs:
        try:
            obs_cfg_override = OBSConfig(**req.obs)
        except Exception:
            pass
    obs_cfg = _merge_obs(obs_cfg_override, cfg.obs)

    # Pre-recording OBS connection check — verify OBS is reachable before
    # launching CS2, so we fail fast rather than wasting ~60s on CS2 warmup
    # only to discover OBS is down.
    try:
        _pre_obs_client = OBSClient(obs_cfg)
        _pre_obs_client.connect()
        try:
            # Auto-setup requested overlay Browser Sources.
            _kb_overlay_requested = any(
                getattr(dto.options, "kb_overlay_enabled", False)
                for dto in req.requests
            )
            _kill_fx_requested = any(
                (getattr(dto.options, "kill_fx_enabled", None) is True)
                or (getattr(dto.options, "kill_fx_enabled", None) is None and cfg.kill_fx_enabled)
                for dto in req.requests
            )
            if _kb_overlay_requested or _kill_fx_requested:
                # 键盘 Overlay 必须建到录制专用场景（与 Game Capture 同场景），不能用
                # 当前 program 场景：玩家 OBS 此刻可能停在别的场景，那样源会被建到错误
                # 场景，录制时 OBS 切到专用场景就看不到键盘 Overlay。
                _scene = cfg.obs_game_scene_name
                # 专用场景此时可能尚未创建（fade controller 在录制阶段才创建），先幂等确保存在。
                try:
                    if _scene not in _pre_obs_client.get_scene_names():
                        _pre_obs_client.create_scene(_scene)
                except Exception as _sc_e:
                    logger.warning(
                        "[RecordingV3] kb overlay: ensure scene %r failed (non-fatal): %s",
                        _scene, _sc_e,
                    )
                import os as _os
                _port = int(_os.environ.get("CS2_INSIGHT_PORT") or _os.environ.get("PORT") or 8000)
                if _kb_overlay_requested:
                    # 优先取第一个启用了 kb_overlay 的请求里的位置，否则读全局配置
                    _kb_pos = next(
                        (
                            getattr(dto.options, "kb_overlay_position", None)
                            for dto in req.requests
                            if getattr(dto.options, "kb_overlay_enabled", False)
                            and getattr(dto.options, "kb_overlay_position", None)
                        ),
                        None,
                    ) or load_config().kb_overlay_position or "bottom_center"
                    _overlay_url = f"http://127.0.0.1:{_port}/overlay/keyboard.html?pos={_kb_pos}"
                    ok = _pre_obs_client.ensure_kb_overlay_in_scene(_scene, _overlay_url)
                    logger.info("[RecordingV3] kb overlay auto-setup: scene=%r ok=%s", _scene, ok)
                if _kill_fx_requested:
                    # 查询参数用于让已有 OBS Browser Source 刷新到新版布局。
                    _fx_url = f"http://127.0.0.1:{_port}/overlay/killfx.html?v=overlay-offset-3"
                    ok_fx = _pre_obs_client.ensure_kb_overlay_in_scene(
                        _scene,
                        _fx_url,
                        source_name=_KILL_FX_SOURCE,
                        reroute_audio=True,
                    )
                    logger.info(
                        "[RecordingV3] kill fx overlay auto-setup: scene=%r ok=%s",
                        _scene, ok_fx,
                    )
        except Exception as _kb_e:
            logger.warning("[RecordingV3] overlay auto-setup failed (non-fatal): %s", _kb_e)
        try:
            _pre_obs_client.disconnect()
        except Exception:
            pass
        logger.info("[RecordingV3] OBS pre-check: connection OK")
    except OBSConnectionError as e:
        raise HTTPException(
            400,
            error_detail("RECORDING_OBS_CONNECT_FAIL", err=str(e)),
        )

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
            _warmup_dict = dict(req.warmup)
            # Backward compat: convert old boolean snd_voipvolume_mute → voice_filter
            if "snd_voipvolume_mute" in _warmup_dict and "voice_filter" not in _warmup_dict:
                _warmup_dict["voice_filter"] = "mute" if _warmup_dict["snd_voipvolume_mute"] else "team"
            _valid_keys = {f.name for f in dataclasses.fields(RecordingWarmupExtras)}
            _filtered = {k: v for k, v in _warmup_dict.items() if k in _valid_keys}
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
        raise HTTPException(409, error_detail("RECORDING_ALREADY_RUNNING"))

    abort_ev = asyncio.Event()
    _queue_abort_event = abort_ev

    # Build fade controller from the first request's options merged with AppConfig.
    first_options = resolved_requests[0].options if resolved_requests else RecordingOptions()
    fade_config = _resolve_fade_config(first_options, cfg)
    fade_ctrl = OBSFadeController(obs_cfg, fade_config)
    if not await fade_ctrl.setup():
        logger.warning("[RecordingV3] OBS fade transition setup failed or disabled; recording in hard-cut mode")

    launch_args = (
        req.cs2_extra_launch_args
        if req.cs2_extra_launch_args is not None
        else cfg.cs2_extra_launch_args
    )
    inject_lines = (
        req.record_inject_console_lines
        if req.record_inject_console_lines is not None
        else cfg.record_inject_console_lines
    )
    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        abort_event=abort_ev,
        cs2_extra_launch_args=launch_args,
        record_inject_console_lines=inject_lines,
        spec_player_verify=cfg.spec_player_verify,
    )

    try:
        results = await director.execute_plan_queue(resolved_requests, warmup=warmup_extras, fade_controller=fade_ctrl)
    except CS2AlreadyRunningError as e:
        raise HTTPException(409, error_detail("RECORDING_CS2_RUNNING")) from e
    except CS2NotReadyError as e:
        raise HTTPException(409, error_detail("RECORDING_GSI_NOT_READY")) from e
    except Exception as e:
        logger.exception("[RecordingV3] execute_plan_queue failed")
        raise HTTPException(500, error_detail("RECORDING_FAILED", err=str(e))) from e
    finally:
        _queue_abort_event = None

    # Persist successful recordings to recorded_clips for the montage workbench.
    try:
        await _persist_v3_results(resolved_requests, results)
    except Exception:
        logger.exception("[RecordingV3] _persist_v3_results failed (non-fatal)")

    return results
