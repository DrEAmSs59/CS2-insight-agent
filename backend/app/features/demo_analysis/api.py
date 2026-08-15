"""HTTP boundary for opening, parsing, and reviewing demos."""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated, Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ...api.demo_replay import PlayerAnalysisReviewRequest, PlayerClipReviewRequest
from ...api_errors import error_detail
from ...databases import demo_db
from ...demo_compat_service import ensure_demo_compatible
from ...demo_library_hub import demo_library_hub
from ...demo_paths import UPLOAD_DIR
from ...env_utils import (
    llm_api_key_configured,
    llm_base_url_is_local_host,
    load_config,
)
from ..demo_library.ingestion import infer_demo_source
from .inspection import (
    analyze_demo_sync,
    demo_failure_code,
    demo_failure_item,
    demo_inspect_concurrency,
    resolve_uploaded_demo_path_async,
    safe_upload_demo_meta,
)
from .uploads import (
    decode_upload_source_paths,
    save_uploaded_demo,
    upload_source_scope,
    verified_upload_source_path,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["demo-analysis"])

class ParseRequest(BaseModel):
    target_player: str
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


async def _ensure_analysis_demo_row(path: Path) -> int:
    """Give every successfully opened analysis demo a stable library id.

    Cosmetics rewrites are persisted and resolved through ``demo_files``.  The
    direct-analysis upload path used to skip that registration, leaving a fully
    parsed demo without the id required by the custom-skin API.
    """
    resolved = path.resolve(strict=True)
    demo_path = str(resolved)
    existing = await demo_db.get_demo_by_path(demo_path)
    if existing:
        return int(existing["id"])

    stat = await asyncio.to_thread(resolved.stat)
    demo_id, inserted = await demo_db.add_demo(
        demo_path,
        file_size=stat.st_size,
        source=infer_demo_source(resolved.name),
        status="pending",
    )
    if inserted:
        await demo_library_hub.notify("enqueue")
    return int(demo_id)


@router.post("/api/demo/upload")
async def upload_demo(
    file: UploadFile = File(...),
    source_path: Annotated[Optional[str], Form()] = None,
):
    if not file.filename or not str(file.filename).lower().endswith(".dem"):
        raise HTTPException(400, error_detail("DEMO_INVALID_EXTENSION"))

    filename = Path(file.filename).name
    dest = UPLOAD_DIR / filename
    uploaded_md5 = await asyncio.to_thread(save_uploaded_demo, file, dest)
    persistent_path = await asyncio.to_thread(
        verified_upload_source_path,
        source_path,
        dest,
        uploaded_md5,
    )
    compat = await asyncio.to_thread(
        ensure_demo_compatible,
        persistent_path,
        allow_truncated_packet_tail=True,
    )

    players, match_meta, inspection_error = await safe_upload_demo_meta(persistent_path)
    demo_id = await _ensure_analysis_demo_row(persistent_path)
    return {
        "id": demo_id,
        "filename": filename,
        "path": str(persistent_path),
        "uploaded_path": str(dest),
        "source_scope": upload_source_scope(persistent_path, dest),
        "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
        "players": players,
        "match_meta": match_meta,
        "inspection_error": {"code": inspection_error} if inspection_error else None,
    }


@router.post("/api/demo/upload-multiple")
async def upload_demos(
    files: Annotated[list[UploadFile], File()],
    source_paths_json: Annotated[Optional[str], Form()] = None,
):
    """一次上传多个 .dem，返回与单文件 upload 相同结构的数组。"""
    if not files:
        raise HTTPException(400, "请至少选择一个文件")
    source_paths = decode_upload_source_paths(source_paths_json, len(files))
    saved: list[tuple[str, Path, Path, Any]] = []
    failed: list[dict] = []
    for file, source_path in zip(files, source_paths):
        filename = Path(str(file.filename or "Demo")).name
        try:
            if not file.filename or not str(file.filename).lower().endswith(".dem"):
                raise ValueError("not a .dem file")
            dest = UPLOAD_DIR / filename
            uploaded_md5 = await asyncio.to_thread(save_uploaded_demo, file, dest)
            persistent_path = await asyncio.to_thread(
                verified_upload_source_path,
                source_path,
                dest,
                uploaded_md5,
            )
            compat = await asyncio.to_thread(
                ensure_demo_compatible,
                persistent_path,
                allow_truncated_packet_tail=True,
            )
            saved.append((filename, dest, persistent_path, compat))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Demo preparation failed for %s", filename)
            failed.append(demo_failure_item(filename, exc, "prepare"))

    inspect_sem = asyncio.Semaphore(demo_inspect_concurrency())

    async def _inspect_one(dest: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await safe_upload_demo_meta(dest)

    inspected = await asyncio.gather(
        *(_inspect_one(persistent_path) for _, _, persistent_path, _ in saved)
    )
    out: list[dict] = []
    for (filename, dest, persistent_path, compat), (players, match_meta, inspection_error) in zip(saved, inspected):
        if inspection_error:
            failed.append({"filename": filename, "code": inspection_error})
            continue
        demo_id = await _ensure_analysis_demo_row(persistent_path)
        out.append(
            {
                "id": demo_id,
                "filename": filename,
                "path": str(persistent_path),
                "uploaded_path": str(dest),
                "source_scope": upload_source_scope(persistent_path, dest),
                "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
                "players": players,
                "match_meta": match_meta,
            },
        )
    return {"uploads": out, "failed": failed}

class OpenLocalDemosBody(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=100)


@router.post("/api/demo/open-local")
async def open_local_demos(body: OpenLocalDemosBody):
    """Open Electron-selected demos by absolute path and repair each source once."""

    opened: list[tuple[Path, Any]] = []
    failed: list[dict] = []
    for raw_path in body.paths:
        try:
            path = Path(raw_path).resolve(strict=True)
            if not path.is_file() or path.suffix.lower() != ".dem":
                raise ValueError("not a .dem file")
            compat = await asyncio.to_thread(ensure_demo_compatible, path)
            opened.append((path, compat))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Could not prepare local Demo: %s", raw_path)
            failed.append(
                demo_failure_item(Path(str(raw_path)).name or str(raw_path), exc, "prepare")
            )

    inspect_sem = asyncio.Semaphore(demo_inspect_concurrency())

    async def _inspect_local(path: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await safe_upload_demo_meta(path)

    inspected = await asyncio.gather(*(_inspect_local(path) for path, _ in opened))
    uploads: list[dict] = []
    for (path, compat), (players, match_meta, inspection_error) in zip(opened, inspected):
        if inspection_error:
            failed.append({"filename": path.name, "code": inspection_error})
            continue
        demo_id = await _ensure_analysis_demo_row(path)
        uploads.append(
            {
                "id": demo_id,
                "filename": path.name,
                "path": str(path),
                "uploaded_path": None,
                "source_scope": "original",
                "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
                "players": players,
                "match_meta": match_meta,
            }
        )
    return {"uploads": uploads, "failed": failed}


@router.post("/api/demo/parse")
async def parse_demo(req: ParseRequest, filename: str):
    from ...demo_parse_isolation import IsolatedParseError

    dem_path = UPLOAD_DIR / filename
    if not dem_path.exists():
        raise HTTPException(404, error_detail("DEMO_FILE_NOT_FOUND"))

    try:
        result = await asyncio.to_thread(
            analyze_demo_sync,
            str(dem_path),
            req.target_player,
            req.freeze_to_death_rounds,
        )
    except IsolatedParseError as e:
        logger.error("Demo parse failed filename=%s: %s", filename, e)
        raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

    cfg = load_config()
    if cfg.ai_mode and cfg.llm.api_key:
        try:
            from ...ai_reviewer import enrich_clips_dicts_with_reviewer

            result["clips"] = await enrich_clips_dicts_with_reviewer(
                result.get("clips") or [],
                result.get("match_meta") or {},
                cfg.llm,
                locale=req.locale,
            )
        except Exception as e:
            logging.error("AI review failed: %s", e)

    return result

class ParseMultiRequest(BaseModel):
    target_players: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@router.post("/api/demo/parse-multi")
async def parse_demo_multi(
    req: ParseMultiRequest,
    filename: str,
    path: Optional[str] = None,
):
    """多玩家解析：共享同一次 Demo 扫描，返回 { players: { name: result } }。"""
    from ...demo_parse_isolation import IsolatedParseError, analyze_multi_isolated

    try:
        dem_path = await resolve_uploaded_demo_path_async(path or filename)
        results_by_player = await asyncio.to_thread(
            analyze_multi_isolated,
            str(dem_path),
            req.target_players,
            req.freeze_to_death_rounds,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, error_detail("DEMO_FILE_NOT_FOUND")) from e
    except HTTPException as e:
        code = "DEMO_FILE_NOT_FOUND" if e.status_code == 404 else "DEMO_PREPARE_FAILED"
        raise HTTPException(e.status_code, error_detail(code)) from e
    except IsolatedParseError as e:
        logger.error("Multi-player Demo parse failed filename=%s path=%s: %s", filename, path, e)
        raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

    analysis_workspace = results_by_player.pop("__analysis_workspace__", None)
    has_player_keyboard_input = results_by_player.pop(
        "__has_player_keyboard_input__",
        None,
    )
    players_out = {
        player: result
        for player, result in results_by_player.items()
        if isinstance(result, dict)
    }
    if not players_out:
        logger.error("Multi-player Demo parse returned no player results filename=%s", filename)
        raise HTTPException(500, error_detail("DEMO_ANALYSIS_EMPTY"))

    return {
        "players": players_out,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
        "has_player_keyboard_input": has_player_keyboard_input,
    }


class BatchParseRequest(BaseModel):
    target_player: str
    paths: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@router.post("/api/demo/parse-batch")
async def parse_demo_batch(req: BatchParseRequest):
    """
    批量解析：``paths`` 为上传后返回的绝对路径或 ``UPLOAD_DIR`` 下的文件名。
    使用线程池并行调用 ``DemoAnalyzer.analyze``，顺序与 ``paths`` 一致。
    """
    from ...demo_parse_isolation import IsolatedParseError

    resolved: list[Path] = []
    for p in req.paths:
        resolved.append(await resolve_uploaded_demo_path_async(p))

    target = (req.target_player or "").strip()
    if not target:
        raise HTTPException(400, "target_player 不能为空")

    workers = min(8, max(1, len(resolved)))
    loop = asyncio.get_running_loop()

    def run_one(path_str: str) -> dict:
        return analyze_demo_sync(path_str, target, req.freeze_to_death_rounds)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        tasks = [loop.run_in_executor(pool, run_one, str(p)) for p in resolved]
        try:
            raw_matches: list[dict] = await asyncio.gather(*tasks)
        except IsolatedParseError as e:
            logger.error("Batch Demo parse failed: %s", e)
            raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

    cfg = load_config()
    matches_out: list[dict] = []
    for dem_path, response in zip(resolved, raw_matches):
        response = dict(response)
        response["demo_path"] = str(dem_path)
        response["demo_filename"] = dem_path.name
        if cfg.ai_mode and cfg.llm.api_key:
            try:
                from ...ai_reviewer import enrich_clips_dicts_with_reviewer

                response["clips"] = await enrich_clips_dicts_with_reviewer(
                    response["clips"],
                    response["match_meta"],
                    cfg.llm,
                    locale=req.locale,
                )
            except Exception as e:
                logging.error("AI review failed for %s: %s", dem_path.name, e)
        matches_out.append(response)

    return {"matches": matches_out}

@router.post("/api/demo/player-review")
async def review_demo_player(req: PlayerAnalysisReviewRequest):
    """Generate a player-level review from the current Insight Agent parse."""
    cfg = load_config()
    if not (
        llm_api_key_configured(cfg.llm.api_key)
        or llm_base_url_is_local_host(cfg.llm.base_url)
    ):
        raise HTTPException(400, "请先在设置中配置 AI 服务")
    try:
        from ...ai_reviewer import review_player_stats_with_reviewer

        commentary = await review_player_stats_with_reviewer(
            req.player,
            req.match,
            cfg.llm,
            locale=req.locale,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logging.getLogger(__name__).warning("Player review failed: %s", exc)
        raise HTTPException(502, f"AI 点评生成失败：{exc}") from exc
    return {"commentary": commentary}


@router.post("/api/demo/review-clips")
async def review_demo_player_clips(req: PlayerClipReviewRequest):
    """Review one selected player's existing clips without re-parsing the Demo."""
    cfg = load_config()
    if not cfg.ai_mode:
        raise HTTPException(409, "AI 洞察模式未开启")
    if not (
        llm_api_key_configured(cfg.llm.api_key)
        or llm_base_url_is_local_host(cfg.llm.base_url)
    ):
        raise HTTPException(400, "请先在设置中配置 AI 服务")
    try:
        from ...ai_reviewer import enrich_clips_dicts_with_reviewer

        clips = await enrich_clips_dicts_with_reviewer(
            req.clips,
            req.match_meta,
            cfg.llm,
            locale=req.locale,
        )
    except Exception as exc:
        logging.getLogger(__name__).warning("Selected-player clip review failed: %s", exc)
        raise HTTPException(502, f"AI 锐评生成失败：{exc}") from exc
    return {"clips": clips, "reviewed": True}
