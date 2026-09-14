"""cs数据图 HTTP 接口 — 雷达图卡片的生成 / 查询 / 图片与头像上传。

- POST /api/cs-data-radar/cards     为对局解析后的全部玩家生成雷达图（自动录制）
- GET  /api/cs-data-radar/cards     列出全部卡片（合辑工作台素材池）
- DELETE /api/cs-data-radar/cards/{id}
- POST /api/cs-data-radar/cards/{id}/portrait  上传人物图片并重渲染
- PUT  /api/cs-data-radar/cards/{id}/image     用前端渲染的 PNG 替换成品
- GET  /api/cs-data-radar/images/{filename}    静态图片服务
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Annotated, Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from ...api_errors import error_detail
from .store import (
    clear_card_team_logo,
    clear_card_video,
    delete_card,
    generate_card_animation,
    get_card,
    get_data_dir,
    list_cards_public,
    replace_card_image,
    set_card_portrait,
    set_card_team_logo,
    create_cards_from_players,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["cs-data-radar"])


class RadarPlayerStats(BaseModel):
    """对局解析后单个玩家的数据（字段与 match_workspace 的 players 行对齐）。

    extra="allow"：保留 one/two/three/four/five_kill_rounds 等派生统计字段，
    供 Multi-kill（多杀回合）等维度自动读取。
    """

    model_config = ConfigDict(extra="allow")

    player_key: str = ""
    key: Optional[str] = None
    name: str = ""
    display_name: str = ""
    steam_id64: Optional[str] = None
    team_key: Optional[str] = None
    team_label: str = ""
    kills: int = 0
    deaths: int = 0
    assists: int = 0
    kd: float = 0.0
    kpr: float = 0.0
    dpr: float = 0.0
    adr: float = 0.0
    kast: float = 0.0
    survival_rate: float = 0.0
    headshots: int = 0
    first_kills: int = 0
    first_deaths: int = 0
    trade_kills: int = 0
    trade_deaths: int = 0
    opening_duel_win_rate: float = 0.0
    trade_kill_rate: float = 0.0
    clutch_attempts: int = 0
    clutch_wins: int = 0
    awp_kills: int = 0
    utility_damage: int = 0
    rounds: Optional[int] = None
    extra: Optional[dict[str, Any]] = None

    def to_radar_dict(self) -> dict[str, Any]:
        data = self.model_dump()
        extra = data.pop("extra", None) or {}
        data.pop("key", None)
        merged = {**data, **extra}
        merged.setdefault("name", merged.get("display_name") or "Unknown")
        return merged


class CreateRadarCardsBody(BaseModel):
    demo_id: Optional[int] = None
    demo_name: str = ""
    players: list[RadarPlayerStats] = Field(default_factory=list, max_length=64)


@router.post("/api/cs-data-radar/cards")
async def create_radar_cards(body: CreateRadarCardsBody):
    """为一场对局解析后的全部玩家生成雷达图卡片（自动录制全部人的雷达图）。"""
    if not body.players:
        raise HTTPException(400, error_detail("RADAR_NO_PLAYERS"))
    players = [player.to_radar_dict() for player in body.players]
    cards = await _create_cards_async(
        players,
        demo_id=body.demo_id,
        demo_name=body.demo_name,
    )
    return {"cards": cards, "count": len(cards)}


@router.post("/api/cs-data-radar/generate")
async def generate_radar_cards(body: CreateRadarCardsBody):
    """「自动录制全部人的雷达图」语义化别名。"""
    return await create_radar_cards(body)


async def _create_cards_async(
    players: list[dict[str, Any]],
    *,
    demo_id: Optional[int],
    demo_name: str,
) -> list[dict[str, Any]]:
    import asyncio

    return await asyncio.to_thread(
        create_cards_from_players,
        players,
        demo_id=demo_id,
        demo_name=demo_name,
    )


@router.get("/api/cs-data-radar/cards")
async def get_radar_cards():
    """列出全部已生成的雷达图卡片，供合辑工作台「cs数据图」专栏使用。"""
    cards = list_cards_public()
    return {"cards": cards, "count": len(cards)}


@router.delete("/api/cs-data-radar/cards/{card_id}")
async def remove_radar_card(card_id: str):
    if not delete_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    return {"ok": True, "id": card_id}


_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB


def _suffix_for(content_type: str, filename: str) -> str:
    if content_type == "image/png":
        return ".png"
    if content_type == "image/webp":
        return ".webp"
    if content_type == "image/gif":
        return ".gif"
    if content_type == "image/jpeg":
        return ".jpg"
    name = (filename or "").lower()
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        if name.endswith(ext):
            return ext if ext != ".jpeg" else ".jpg"
    return ".jpg"


@router.post("/api/cs-data-radar/cards/{card_id}/portrait")
async def upload_radar_portrait(
    card_id: str,
    file: UploadFile = File(...),
    player_name: Annotated[Optional[str], Form()] = None,
):
    """前端接口：上传人物图片，自动重渲染雷达图卡片。

    若该卡片原本已生成「开场动画」，旧动画里烘焙的是旧头像，会一并失效：
    - 配置了 FFmpeg → 用新头像自动重新生成动画（约 40-60s，前端保持忙碌态）；
    - 未配置 FFmpeg → 删除旧动画，卡片回退为静态图段。
    """
    if not get_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    content_type = file.content_type or ""
    if content_type and content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "仅支持 JPEG / PNG / WebP / GIF 格式图片")
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(400, "图片文件大小不能超过 8MB")
    import asyncio

    updated = await asyncio.to_thread(
        set_card_portrait,
        card_id,
        data,
        _suffix_for(content_type, file.filename or ""),
    )
    if updated is None:
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    if updated.get("video_file"):
        # 头像已变化：旧开场动画过期，用新头像重新生成（或删除回退静态图）
        updated = await _regenerate_or_clear_video(card_id)
    return updated


async def _regenerate_or_clear_video(card_id: str) -> dict[str, Any]:
    """头像/队标等外观变化后：有 FFmpeg 则重新生成动画，否则清掉旧动画。"""
    import asyncio

    from ...env_utils import load_config

    cfg = load_config()
    ffmpeg_bin = await asyncio.to_thread(_resolve_ffmpeg_or_none, cfg)
    if ffmpeg_bin is None:
        return await asyncio.to_thread(clear_card_video, card_id) or {}
    try:
        regenerated = await asyncio.to_thread(generate_card_animation, card_id, ffmpeg_bin)
        return regenerated or {}
    except Exception:
        logger.exception("radar animation regen failed after portrait card_id=%s", card_id)
        return await asyncio.to_thread(clear_card_video, card_id) or {}


@router.post("/api/cs-data-radar/cards/{card_id}/team-logo")
async def upload_radar_team_logo(card_id: str, file: UploadFile = File(...)):
    """上传队伍标志，放大显示在人物头像后面（重渲染卡片）。

    若该卡片原本已生成「开场动画」，旧动画烘焙的是旧队标，会用新队标
    自动重新生成（或删除旧动画回退静态图）。
    """
    if not get_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    content_type = file.content_type or ""
    if content_type and content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "仅支持 JPEG / PNG / WebP / GIF 格式图片")
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(400, "图片文件大小不能超过 8MB")
    import asyncio

    updated = await asyncio.to_thread(
        set_card_team_logo,
        card_id,
        data,
        _suffix_for(content_type, file.filename or ""),
    )
    if updated is None:
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    if updated.get("video_file"):
        # 队标已变化：旧开场动画过期，用新队标重新生成（或删除回退静态图）
        updated = await _regenerate_or_clear_video(card_id)
    return updated


@router.delete("/api/cs-data-radar/cards/{card_id}/team-logo")
async def clear_radar_team_logo(card_id: str):
    """清除队伍标志并重渲染卡片；已有动画时同样重新生成。"""
    if not get_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    import asyncio

    updated = await asyncio.to_thread(clear_card_team_logo, card_id)
    if updated is None:
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    if updated.get("video_file"):
        updated = await _regenerate_or_clear_video(card_id)
    return updated


@router.put("/api/cs-data-radar/cards/{card_id}/image")
async def replace_radar_card_image(card_id: str, file: UploadFile = File(...)):
    """用前端 Canvas 渲染的 PNG 替换雷达图成品（用于嵌入游戏内头像后的再渲染）。"""
    if not get_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(400, "图片文件大小不能超过 8MB")
    if not data[:8].startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(400, "仅支持 PNG 图片")
    import asyncio

    updated = await asyncio.to_thread(replace_card_image, card_id, data)
    if updated is None:
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    return updated


@router.post("/api/cs-data-radar/cards/{card_id}/animation")
async def generate_radar_card_animation(card_id: str):
    """按需生成该卡片的「开场动画」MP4（慢入→快出→定格），供合辑作为动画视频段插入。

    需要已配置的 FFmpeg；未配置或编码失败时返回静态卡片（video_url 为空）。
    """
    if not get_card(card_id):
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    import asyncio

    from ...env_utils import load_config

    cfg = load_config()
    ffmpeg_bin = await asyncio.to_thread(_resolve_ffmpeg_or_none, cfg)
    if ffmpeg_bin is None:
        # 未配置 FFmpeg：无法生成动画，返回静态卡（前端降级为静态图段）
        return _card_with_video_or_none(card_id)

    try:
        updated = await asyncio.to_thread(generate_card_animation, card_id, ffmpeg_bin)
    except Exception:
        logger.exception("radar animation generation failed card_id=%s", card_id)
        updated = get_card(card_id)
    if updated is None:
        raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))
    return updated


class BatchAnimationBody(BaseModel):
    card_ids: list[str] = Field(..., min_length=1, max_length=24)


@router.post("/api/cs-data-radar/cards/batch-animation")
async def batch_generate_radar_animations(body: BatchAnimationBody):
    """并发批量生成多张卡片的开场动画。

    帧渲染多进程并行（每张卡按 CPU 核数分片），多张卡之间并发执行，
    并按批量大小自动降低每卡的进程数，避免进程过载。
    """
    import asyncio
    import os

    from ...env_utils import load_config

    for cid in body.card_ids:
        if not get_card(cid):
            raise HTTPException(404, error_detail("RADAR_CARD_NOT_FOUND"))

    cfg = load_config()
    ffmpeg_bin = await asyncio.to_thread(_resolve_ffmpeg_or_none, cfg)
    if ffmpeg_bin is None:
        # 未配置 FFmpeg → 全部返回静态卡
        return {"cards": [_card_with_video_or_none(cid) for cid in body.card_ids], "count": 0}

    cpus = os.cpu_count() or 4
    workers = max(1, cpus // max(1, len(body.card_ids)))

    async def _gen(cid: str):
        try:
            return await asyncio.to_thread(generate_card_animation, cid, ffmpeg_bin, workers)
        except Exception:
            logger.exception("batch radar animation failed card_id=%s", cid)
            return get_card(cid)

    cards = await asyncio.gather(*(_gen(cid) for cid in body.card_ids))
    done = [c for c in cards if c is not None and c.get("video_url")]
    return {"cards": [c for c in cards if c is not None], "count": len(done)}


def _card_with_video_or_none(card_id: str):
    from .store import _card_public

    card = get_card(card_id)
    return _card_public(card) if card is not None else None


def _resolve_ffmpeg_or_none(cfg: Any):
    """解析合辑使用的 FFmpeg 可执行文件；不可用返回 None。"""
    try:
        from ...video_composer import resolve_ffmpeg_binary

        return resolve_ffmpeg_binary(getattr(cfg, "ffmpeg_path", None))
    except Exception:
        return None


_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-\.]+$")


@router.get("/api/cs-data-radar/images/{filename}")
async def serve_radar_image(filename: str):
    if not _FILENAME_RE.fullmatch(filename):
        raise HTTPException(400, "Invalid filename")
    base = get_data_dir()
    # 成品图平铺在根目录；头像在 portraits/；队标在 team_logos/；兼容早期 images/ 子目录布局
    candidates = [
        base / filename,
        base / "images" / filename,
        base / "portraits" / filename,
        base / "team_logos" / filename,
    ]
    for file_path in candidates:
        if file_path.is_file() and str(file_path.resolve()).startswith(str(base.resolve())):
            return FileResponse(str(file_path))
    raise HTTPException(404, "Image not found")


@router.get("/api/cs-data-radar/videos/{filename}")
async def serve_radar_video(filename: str):
    if not _FILENAME_RE.fullmatch(filename):
        raise HTTPException(400, "Invalid filename")
    base = get_data_dir()
    file_path = base / "animations" / filename
    if not file_path.is_file() or not str(file_path.resolve()).startswith(str(base.resolve())):
        raise HTTPException(404, "Video not found")
    return FileResponse(str(file_path), media_type="video/mp4")
