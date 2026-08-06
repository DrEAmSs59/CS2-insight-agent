"""Montage project composition, export execution and avatar routes."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
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

router = APIRouter(tags=["montage"])


# ─── Montage (V2) ─────────────────────────────────────────────


class PlayerAvatar(BaseModel):
    player_key: str
    steamid64: Optional[str] = None
    player_name: str = ""
    avatar_path: Optional[str] = None
    enabled: bool = True


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


@router.post("/api/montage/export")
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
    if not clip_ids:
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

    try:
        from ..video_composer import MontageComposerError, validate_output_path

        out = validate_output_path(body.output_path)
    except MontageComposerError as e:
        from ..montage_errors import montage_detail_from_exception

        raise HTTPException(400, montage_detail_from_exception(e)) from e

    rows = await montage_db.get_recorded_clips_by_ids([int(x) for x in clip_ids])
    clip_paths: list[Path] = []
    for cid in clip_ids:
        row = rows.get(int(cid))
        if not row:
            from ..api_errors import error_detail

            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(cid)))
        clip_paths.append(Path(str(row["output_path"])))

    intro_p = Path(intro_s).expanduser() if intro_s else None
    outro_p = Path(outro_s).expanduser() if outro_s else None
    bgm_p = Path(bgm_s).expanduser() if bgm_s else None

    # Build name_cards list parallel to clip_paths
    # Build a lookup from player_key → PlayerAvatar for fast matching
    _pa_lookup: dict[str, PlayerAvatar] = {pa.player_key: pa for pa in player_avatars_eff}

    name_cards_list: list[Optional[dict]] = []
    for cid in clip_ids:
        row = rows.get(int(cid))
        if row is None:
            name_cards_list.append(None)
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
        else:
            display_name = matched_pa.player_name or str(row.get("player_name") or "")
            category = resolve_name_card_category(row)
            eyebrow = resolve_name_card_eyebrow(row, category)
            tags, result_tag = build_name_card_tags_and_result(row, category)
            name_cards_list.append(
                {
                    "avatar_path": matched_pa.avatar_path,
                    "display_name": display_name,
                    "category": category,
                    "eyebrow": eyebrow,
                    "result": result_tag,
                    "tags": tags,
                    "enabled": True,
                }
            )

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
    export_id = await montage_db.create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=snap,
        status="running",
    )

    try:
        from ..video_composer import MontageComposerError, compose_montage

        await asyncio.to_thread(
            compose_montage,
            ffmpeg_bin=ffmpeg_bin,
            clip_paths=clip_paths,
            intro_path=intro_p,
            outro_path=outro_p,
            bgm_path=bgm_p,
            output_path=out,
            transitions=transitions_eff if isinstance(transitions_eff, dict) else None,
            clip_row_ids=[int(x) for x in clip_ids],
            bgm_volume=bgm_volume_eff,
            bgm_start_sec=bgm_start_eff,
            intro_image_duration=intro_img_dur_eff,
            outro_image_duration=outro_img_dur_eff,
            montage_encoder=cfg.montage_encoder or "auto",
            name_cards=name_cards_arg,
            framemeld_enabled=framemeld_enabled_eff,
        )
    except MontageComposerError as e:
        from ..montage_errors import montage_detail_from_exception

        detail = montage_detail_from_exception(e)
        await montage_db.update_export(
            export_id, status="error", error_msg=str(detail.get("code") or "MONTAGE_EXPORT_FAILED"), output_path=None,
        )
        raise HTTPException(400, detail) from e

    await montage_db.update_export(export_id, status="done", error_msg="", output_path=str(out))
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


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
