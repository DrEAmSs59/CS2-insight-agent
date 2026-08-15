"""2D radar assets, replay payloads and replay request models."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ..databases import demo_db
from ..demo_paths import resolve_working_demo_path

router = APIRouter(tags=["demo-replay"])
logger = logging.getLogger(__name__)

# Identical cold-cache requests share one parser/materialization job.
_replay_jobs: dict[str, asyncio.Future] = {}
_replay_jobs_lock = asyncio.Lock()
_replay_binary_jobs: dict[str, asyncio.Future] = {}
_replay_binary_jobs_lock = asyncio.Lock()


class DemoReplayRequest(BaseModel):
    path: str = Field(..., min_length=1)
    map_name: str = "unknown"
    start_tick: int = Field(..., ge=0)
    end_tick: int = Field(..., gt=0)
    tick_rate: float = Field(64.0, gt=0, le=256)
    fps: float = Field(32.0, ge=1, le=64)
    pov_player_name: Optional[str] = None
    pov_steamid64: Optional[str] = None


class PlayerAnalysisReviewRequest(BaseModel):
    player: dict[str, Any]
    match: dict[str, Any] = Field(default_factory=dict)
    locale: str = "zh"


class PlayerClipReviewRequest(BaseModel):
    clips: list[dict[str, Any]] = Field(..., min_length=1, max_length=32)
    match_meta: dict[str, Any] = Field(default_factory=dict)
    locale: str = "zh"


@router.get("/api/demo/replay/cache")
async def get_demo_replay_cache():
    """Report the persistent 2D replay cache managed under application data."""
    from ..features.demo_analysis.replay_cache_storage import replay_cache_summary

    return await asyncio.to_thread(replay_cache_summary)


@router.delete("/api/demo/replay/cache")
async def delete_demo_replay_cache():
    """Release all generated 2D replay assets without touching source Demos."""
    from ..features.demo_analysis.replay_cache_storage import clear_replay_cache, replay_cache_summary

    removed = await asyncio.to_thread(clear_replay_cache)
    return {**removed, "cache": await asyncio.to_thread(replay_cache_summary)}


@router.get("/api/demo/radar-map/{map_name}")
async def get_demo_radar_map(map_name: str, layer: Optional[str] = None):
    """Serve the bundled Insight Agent overhead radar used by 2D replay."""
    map_key = str(map_name or "").strip().lower()
    if not map_key or len(map_key) > 64 or not map_key.replace("_", "").isalnum():
        raise HTTPException(400, "Invalid map name")
    if not map_key.startswith(("de_", "cs_", "ar_")):
        map_key = f"de_{map_key}"
    normalized_layer = str(layer or "upper").strip().lower()
    if normalized_layer not in {"upper", "lower"}:
        raise HTTPException(400, "Invalid radar layer")
    from ..radar.radar_map_assets import resolve_map_png_path
    try:
        map_path = resolve_map_png_path(map_key, layer=normalized_layer)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"No bundled radar map for {map_key}") from exc
    return FileResponse(str(map_path), media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/api/demo/utility-mask/{map_name}")
async def get_demo_utility_mask(map_name: str, layer: Optional[str] = None):
    """Serve radar-derived utility clip masks for 2D smoke/fire rendering."""
    map_key = str(map_name or "").strip().lower()
    if not map_key or len(map_key) > 64 or not map_key.replace("_", "").isalnum():
        raise HTTPException(400, "Invalid map name")
    if not map_key.startswith(("de_", "cs_", "ar_")):
        map_key = f"de_{map_key}"
    normalized_layer = str(layer or "upper").strip().lower()
    if normalized_layer not in {"upper", "lower"}:
        raise HTTPException(400, "Invalid radar layer")
    from ..radar.radar_derived_assets import resolve_utility_mask_path
    mask_path = resolve_utility_mask_path(map_key, layer=normalized_layer)
    if mask_path is None:
        raise HTTPException(404, f"No utility mask for {map_key}")
    return FileResponse(str(mask_path), media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.post("/api/demo/replay")
async def get_demo_replay(req: DemoReplayRequest):
    """Return one active-round 2D replay from the original Insight Agent parser."""
    if req.end_tick <= req.start_tick:
        raise HTTPException(422, "end_tick must be greater than start_tick")
    max_span = int(req.tick_rate * 10 * 60)
    if req.end_tick - req.start_tick > max_span:
        raise HTTPException(422, "Replay range cannot exceed 10 minutes")

    dem_path = await resolve_working_demo_path(req.path, demo_db=demo_db)
    duration_sec = (req.end_tick - req.start_tick) / req.tick_rate
    estimated_frame_count = int(duration_sec * req.fps) + 1
    if estimated_frame_count > 6000:
        raise HTTPException(
            422,
            f"Replay request would generate about {estimated_frame_count} frames; maximum is 6000",
        )
    from ..features.demo_analysis.replay_frames_cache import (
        REPLAY_FRAMES_CACHE_VERSION,
        demo_fingerprint,
        frames_cache_key,
        load_frames,
        save_frames,
    )
    from ..radar.radar_data_extractor import extract_radar_timeline
    from ..radar.radar_map_assets import lookup_map_data

    map_key = str(req.map_name or "unknown").strip().lower()
    if map_key not in {"unknown", ""} and not map_key.startswith(("de_", "cs_", "ar_")):
        map_key = f"de_{map_key}"

    fp_meta = demo_fingerprint(str(dem_path))
    transform: dict[str, Any] | None = None
    if map_key not in {"unknown", ""}:
        try:
            transform = lookup_map_data(map_key)
        except (KeyError, OSError):
            transform = None
    tv = int((transform or {}).get("transform_version") or 3)
    cache_key = frames_cache_key(
        str(dem_path),
        round_number=None,
        start_tick=int(req.start_tick),
        end_tick=int(req.end_tick),
        fps=float(req.fps),
        transform_version=tv,
    )

    def _payload_from_cache(cached: dict[str, Any], *, frames_source: str, shared_job: bool = False) -> dict[str, Any]:
        return {
            "frames": list(cached.get("frames") or []),
            "map_name": map_key or "unknown",
            "map_transform": cached.get("map_transform"),
            "tick_rate": req.tick_rate,
            "fps": cached.get("fps") or req.fps,
            "start_tick": req.start_tick,
            "end_tick": req.end_tick,
            "effect_tracks_version": int(cached.get("effect_tracks_version") or 1),
            "effect_capabilities": cached.get("effect_capabilities") or {
                "inferno_cells": False,
                "smoke_voxels": False,
                "smoke_mode": "legacy_circle",
            },
            "effect_tracks": list(cached.get("effect_tracks") or []),
            "effect_warnings": list(cached.get("effect_warnings") or []),
            "effect_parse_ms": cached.get("effect_parse_ms"),
            "effects_pending": False,
            "demo_fingerprint": cached.get("demo_fingerprint") or fp_meta,
            "replay_cache_version": REPLAY_FRAMES_CACHE_VERSION,
            "cache": {
                "frames": frames_source,
                "effects": (
                    "parquet_hit"
                    if frames_source == "parquet_hit" and cached.get("effect_tracks")
                    else "disk_hit"
                    if cached.get("effect_tracks")
                    else "miss"
                ),
                "parsed": False,
                "shared_job": shared_job,
                "read_ms": cached.get("read_ms"),
            },
            "parse_stage": "ready",
        }

    try:
        from ..features.demo_analysis.replay_match_cache import load_match_replay_round

        match_cached = await asyncio.to_thread(
            load_match_replay_round,
            str(dem_path),
            start_tick=int(req.start_tick),
            end_tick=int(req.end_tick),
            fps=float(req.fps),
            tick_rate=float(req.tick_rate),
        )
    except Exception as exc:  # noqa: BLE001 - legacy per-round cache remains available
        logger.warning("whole-match replay parquet load failed: %s", exc)
        match_cached = None
    if match_cached is not None:
        return _payload_from_cache(match_cached, frames_source="parquet_hit")

    if cache_key:
        cached = await asyncio.to_thread(load_frames, cache_key)
        if cached is not None:
            return _payload_from_cache(cached, frames_source="disk_hit")

    async def _build() -> dict[str, Any]:
        frames = await asyncio.to_thread(
            extract_radar_timeline,
            demo_path=str(dem_path),
            map_name=map_key,
            pov_player_name=req.pov_player_name,
            pov_steamid64=req.pov_steamid64,
            start_tick=req.start_tick,
            end_tick=req.end_tick,
            fps=req.fps,
            duration_sec=duration_sec,
            demo_tick_rate=req.tick_rate,
            include_all_players=True,
            include_effect_tracks=True,
        )
        effect_tracks: list = []
        effect_capabilities = {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        }
        effect_warnings: list = []
        effect_parse_ms = None
        effect_tracks_version = 1
        if isinstance(frames, dict):
            effect_tracks = list(frames.get("effect_tracks") or [])
            effect_capabilities = frames.get("effect_capabilities") or effect_capabilities
            effect_warnings = list(frames.get("effect_warnings") or [])
            effect_parse_ms = frames.get("effect_parse_ms")
            effect_tracks_version = int(frames.get("effect_tracks_version") or 1)
            frames = list(frames.get("frames") or [])

        if cache_key:
            await asyncio.to_thread(
                save_frames,
                cache_key,
                frames=frames,
                fps=float(req.fps),
                start_tick=int(req.start_tick),
                end_tick=int(req.end_tick),
                map_transform=transform,
                effect_tracks=effect_tracks,
                effect_capabilities=effect_capabilities,
                effect_warnings=effect_warnings,
                effect_parse_ms=effect_parse_ms,
                effect_tracks_version=effect_tracks_version,
                demo_fingerprint_meta=fp_meta,
            )

        return {
            "frames": frames,
            "map_name": map_key or "unknown",
            "map_transform": transform,
            "tick_rate": req.tick_rate,
            "fps": req.fps,
            "start_tick": req.start_tick,
            "end_tick": req.end_tick,
            "effect_tracks_version": effect_tracks_version,
            "effect_capabilities": effect_capabilities,
            "effect_tracks": effect_tracks,
            "effect_warnings": effect_warnings,
            "effect_parse_ms": effect_parse_ms,
            "effects_pending": False,
            "demo_fingerprint": fp_meta,
            "replay_cache_version": REPLAY_FRAMES_CACHE_VERSION,
            "cache": {
                "frames": "parsed",
                "effects": "parsed" if effect_tracks else "miss",
                "parsed": True,
                "shared_job": False,
            },
            "parse_stage": "ready",
        }

    job_key = cache_key or f"nocache|{dem_path}|{req.start_tick}|{req.end_tick}|{req.fps}"
    async with _replay_jobs_lock:
        existing = _replay_jobs.get(job_key)
        if existing is not None:
            shared = True
            future = existing
        else:
            shared = False
            future = asyncio.get_running_loop().create_future()
            _replay_jobs[job_key] = future

    if shared:
        result = await future
        out = dict(result)
        cache_meta = dict(out.get("cache") or {})
        cache_meta["shared_job"] = True
        if cache_meta.get("frames") == "parsed":
            cache_meta["frames"] = "shared_job"
        out["cache"] = cache_meta
        return out

    try:
        result = await _build()
        if not future.done():
            future.set_result(result)
        return result
    except Exception as exc:
        if not future.done():
            future.set_exception(exc)
        raise
    finally:
        async with _replay_jobs_lock:
            if _replay_jobs.get(job_key) is future:
                _replay_jobs.pop(job_key, None)


@router.post("/api/demo/replay/binary")
async def get_demo_replay_binary(req: DemoReplayRequest):
    """Return one Parquet row group as Rust-produced columnar bytes."""
    if req.end_tick <= req.start_tick:
        raise HTTPException(422, "end_tick must be greater than start_tick")
    max_span = int(req.tick_rate * 10 * 60)
    if req.end_tick - req.start_tick > max_span:
        raise HTTPException(422, "Replay range cannot exceed 10 minutes")
    duration_sec = (req.end_tick - req.start_tick) / req.tick_rate
    estimated_frame_count = int(duration_sec * req.fps) + 1
    if estimated_frame_count > 40_000:
        raise HTTPException(
            422,
            f"Binary replay request would generate about {estimated_frame_count} frames; maximum is 40000",
        )

    dem_path = await resolve_working_demo_path(req.path, demo_db=demo_db)
    from ..features.demo_analysis.replay_match_cache import load_match_replay_round_binary

    async def _load_packet() -> bytes | None:
        return await asyncio.to_thread(
            load_match_replay_round_binary,
            str(dem_path),
            start_tick=int(req.start_tick),
            end_tick=int(req.end_tick),
            fps=float(req.fps),
            tick_rate=float(req.tick_rate),
        )

    try:
        packet = await _load_packet()
    except Exception as exc:  # noqa: BLE001 - report native/cache failures explicitly
        logger.warning("whole-match binary replay load failed: %s", exc)
        raise HTTPException(503, f"Binary replay unavailable: {type(exc).__name__}") from exc

    if packet is None:
        job_key = f"{dem_path}|{float(req.fps):.6f}|{float(req.tick_rate):.6f}"
        async with _replay_binary_jobs_lock:
            existing = _replay_binary_jobs.get(job_key)
            if existing is not None:
                shared = True
                future = existing
            else:
                shared = False
                future = asyncio.get_running_loop().create_future()
                future.add_done_callback(
                    lambda completed: (
                        completed.exception() if not completed.cancelled() else None
                    )
                )
                _replay_binary_jobs[job_key] = future

        if shared:
            try:
                packet = await future
            except Exception as exc:  # noqa: BLE001 - mirror the leader's repair failure
                raise HTTPException(
                    503,
                    f"Binary replay cache repair failed: {type(exc).__name__}",
                ) from exc
        else:
            try:
                # match_results is keyed by the library's original path, while
                # replay I/O normally runs against its cached working copy.
                # Keep those identities separate so a cold desktop cache can
                # rebuild from the persisted analysis workspace.
                persisted = await demo_db.get_result(str(req.path))
                if persisted is None and str(req.path) != str(dem_path):
                    persisted = await demo_db.get_result(str(dem_path))
                workspace = (
                    persisted.get("analysis_workspace")
                    if isinstance(persisted, dict)
                    else None
                )
                if not isinstance(workspace, dict) or not workspace.get("rounds"):
                    packet = None
                else:
                    from ..demo_parse_isolation import (
                        materialize_match_replay_parquet_isolated,
                    )

                    materialized = await asyncio.to_thread(
                        materialize_match_replay_parquet_isolated,
                        str(dem_path),
                        workspace,
                        fps=float(req.fps),
                    )
                    logger.info(
                        "Cold replay Parquet cache repair: path=%s status=%s",
                        dem_path,
                        materialized.get("status"),
                    )
                    packet = await _load_packet()
                if not future.done():
                    future.set_result(packet)
            except Exception as exc:  # noqa: BLE001 - native worker failure is explicit
                if not future.done():
                    future.set_exception(exc)
                logger.warning("whole-match binary replay cold repair failed: %s", exc)
                raise HTTPException(
                    503,
                    f"Binary replay cache repair failed: {type(exc).__name__}",
                ) from exc
            finally:
                async with _replay_binary_jobs_lock:
                    if _replay_binary_jobs.get(job_key) is future:
                        _replay_binary_jobs.pop(job_key, None)

    if packet is None:
        raise HTTPException(
            409,
            "Binary replay cache is missing and no persisted analysis workspace can rebuild it; "
            "analyze the demo again",
        )
    return Response(
        content=packet,
        media_type="application/vnd.cs2-insight.replay-v1",
        headers={
            "Cache-Control": "no-store",
            "X-CS2-Replay-Protocol": "1",
        },
    )


@router.post("/api/demo/replay/effects")
async def get_demo_replay_effects(req: DemoReplayRequest):
    """Compatibility sidecar for older replay packets without embedded effects."""
    if req.end_tick <= req.start_tick:
        raise HTTPException(422, "end_tick must be greater than start_tick")
    max_span = int(req.tick_rate * 10 * 60)
    if req.end_tick - req.start_tick > max_span:
        raise HTTPException(422, "Replay range cannot exceed 10 minutes")

    dem_path = await resolve_working_demo_path(req.path, demo_db=demo_db)
    from ..radar.radar_data_extractor import extract_replay_effects

    map_key = str(req.map_name or "unknown").strip().lower()
    if map_key not in {"unknown", ""} and not map_key.startswith(("de_", "cs_", "ar_")):
        map_key = f"de_{map_key}"

    try:
        payload = await asyncio.to_thread(
            extract_replay_effects,
            demo_path=str(dem_path),
            map_name=map_key,
            start_tick=req.start_tick,
            end_tick=req.end_tick,
            demo_tick_rate=req.tick_rate,
        )
    except Exception as exc:  # noqa: BLE001 — never fail the round once frames are playable
        return {
            "map_name": map_key or "unknown",
            "start_tick": req.start_tick,
            "end_tick": req.end_tick,
            "effect_tracks_version": 1,
            "effect_capabilities": {
                "inferno_cells": False,
                "smoke_voxels": False,
                "smoke_mode": "legacy_circle",
            },
            "effect_tracks": [],
            "effect_warnings": [f"{type(exc).__name__}: {exc}"],
            "effects_pending": False,
        }

    return {
        "map_name": map_key or "unknown",
        "start_tick": req.start_tick,
        "end_tick": req.end_tick,
        "effect_tracks_version": int(payload.get("effect_tracks_version") or 1),
        "effect_capabilities": payload.get("effect_capabilities") or {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        },
        "effect_tracks": payload.get("effect_tracks") or [],
        "effect_warnings": payload.get("effect_warnings") or [],
        "effect_parse_ms": payload.get("effect_parse_ms"),
        "effects_pending": False,
    }
