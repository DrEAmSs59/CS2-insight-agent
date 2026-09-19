"""cs数据图 卡片存储 — JSON 索引 + PNG/头像文件。

目录结构（位于可写数据目录下）：
    data/cs_data_radar/
        cards.json           卡片元数据索引
        images/<card_id>.png 雷达图成品（供合辑导出使用）
        portraits/<file>     玩家上传的人物图片
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ...env_utils import get_data_dir as _env_get_data_dir
from .radar_model import derive_radar_stats
from .radar_renderer import render_radar_card

logger = logging.getLogger(__name__)

_RADAR_SUBDIR = "cs_data_radar"
_CARDS_FILENAME = "cards.json"
_LOCK = threading.Lock()


def get_data_dir() -> Path:
    return _env_get_data_dir() / _RADAR_SUBDIR


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_index() -> dict[str, Any]:
    index_path = get_data_dir() / _CARDS_FILENAME
    try:
        if index_path.is_file():
            data = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("cards"), list):
                return data
    except Exception:
        logger.exception("cs_data_radar index read failed; starting empty")
    return {"version": 1, "cards": []}


def _write_index(index: dict[str, Any]) -> None:
    index_path = get_data_dir() / _CARDS_FILENAME
    get_data_dir().mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(index_path)


def list_cards() -> list[dict[str, Any]]:
    with _LOCK:
        return [dict(card) for card in _read_index().get("cards", [])]


def get_card(card_id: str) -> Optional[dict[str, Any]]:
    with _LOCK:
        for card in _read_index().get("cards", []):
            if str(card.get("id")) == str(card_id):
                return dict(card)
    return None


def _card_public(card: dict[str, Any]) -> dict[str, Any]:
    out = dict(card)
    out["image_url"] = f"/api/cs-data-radar/images/{Path(str(out.get('image_file') or '')).name}"
    out["portrait_url"] = (
        f"/api/cs-data-radar/images/{Path(str(out['portrait_file'])).name}"
        if out.get("portrait_file")
        else None
    )
    out["team_logo_url"] = (
        f"/api/cs-data-radar/images/{Path(str(out['team_logo_file'])).name}"
        if out.get("team_logo_file")
        else None
    )
    out["video_url"] = (
        f"/api/cs-data-radar/videos/{Path(str(out['video_file'])).name}"
        if out.get("video_file")
        else None
    )
    # 绝对路径：合辑导出（montage radar_segments.image_path）直接使用
    abs_img = resolve_card_image_path(card)
    out["image_path"] = str(abs_img) if abs_img is not None else None
    out["video_path"] = None
    if out.get("video_file"):
        vp = get_data_dir() / str(out["video_file"])
        if vp.is_file():
            out["video_path"] = str(vp)
    return out


def list_cards_public() -> list[dict[str, Any]]:
    return [_card_public(card) for card in list_cards()]


def resolve_card_image_path(card: dict[str, Any]) -> Optional[Path]:
    """把卡片引用的 image_file 解析成磁盘绝对路径（供合辑导出使用）。"""
    raw = str(card.get("image_file") or "")
    if not raw:
        return None
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p if p.is_file() else None
    candidate = get_data_dir() / p
    return candidate if candidate.is_file() else None


def _card_payload(
    *,
    demo_id: Optional[int],
    demo_name: str,
    player: dict[str, Any],
) -> dict[str, Any]:
    radar = derive_radar_stats(player)
    card_id = str(uuid.uuid4())
    image_file = f"{card_id}.png"  # 成品图平铺在 cs_data_radar/ 根目录
    return {
        "id": card_id,
        "demo_id": int(demo_id) if demo_id is not None else None,
        "demo_name": str(demo_name or ""),
        "player_key": str(player.get("player_key") or player.get("key") or ""),
        "player_name": str(player.get("display_name") or player.get("name") or "Unknown"),
        "steam_id64": str(player.get("steam_id64") or player.get("steamid64") or "") or None,
        "team_key": str(player.get("team_key") or "") or None,
        "team_label": str(player.get("team_label") or "") or "",
        "kills": int(player.get("kills") or 0),
        "deaths": int(player.get("deaths") or 0),
        "assists": int(player.get("assists") or 0),
        "stats": dict(player),
        "radar": radar,
        "match_avg": None,  # 本场全部玩家的六维平均值（红色基准线），生成时填充
        "image_file": image_file,
        "video_file": None,  # 开场动画 MP4（按需生成），生成后供合辑作为动画视频段插入
        "portrait_file": None,
        "team_logo_file": None,  # 队伍标志（放大显示在头像后面）
        "created_at": _now_iso(),
    }


def create_cards_from_players(
    players: list[dict[str, Any]],
    *,
    demo_id: Optional[int] = None,
    demo_name: str = "",
) -> list[dict[str, Any]]:
    """为一场对局中的全部玩家自动生成雷达图卡片（自动录制全部人的雷达图）。"""
    from .radar_model import compute_match_avg_radar

    players_list = [p for p in (players or []) if isinstance(p, dict)]
    # 全场平均值基准线：本场所有玩家六维派生值的平均，作为红色参考六边形
    match_avg = compute_match_avg_radar(players_list)
    created: list[dict[str, Any]] = []
    with _LOCK:
        index = _read_index()
        for player in players_list:
            card = _card_payload(demo_id=demo_id, demo_name=demo_name, player=player)
            card["match_avg"] = dict(match_avg)
            image_path = get_data_dir() / str(card["image_file"])
            render_radar_card(
                player_name=card["player_name"],
                radar=card["radar"],
                out_path=image_path,
                team_key=card["team_key"],
                team_label=card["team_label"],
                match_avg_radar=match_avg,
            )
            index["cards"].append(card)
            created.append(card)
        _write_index(index)
    return [_card_public(card) for card in created]


def delete_card(card_id: str) -> bool:
    with _LOCK:
        index = _read_index()
        remaining: list[dict[str, Any]] = []
        removed: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                removed = card
            else:
                remaining.append(card)
        if removed is None:
            return False
        index["cards"] = remaining
        _write_index(index)
    # 清理磁盘文件（尽力而为）
    base = get_data_dir()
    for key in ("image_file", "video_file", "portrait_file", "team_logo_file"):
        raw = removed.get(key)
        if raw:
            try:
                p = base / str(raw)
                if p.is_file():
                    p.unlink(missing_ok=True)
            except OSError:
                logger.warning("cs_data_radar cleanup failed for %s", raw)
    return True


def _render_card(
    card: dict[str, Any],
    portrait_path: Optional[Path] = None,
    team_logo_path: Optional[Path] = None,
) -> None:
    """按卡片当前内容重渲染静态 PNG（头像 / 队标文件缺失时按卡片字段解析）。"""
    if portrait_path is None and card.get("portrait_file"):
        candidate = get_data_dir() / str(card["portrait_file"])
        if candidate.is_file():
            portrait_path = candidate
    if team_logo_path is None and card.get("team_logo_file"):
        candidate = get_data_dir() / str(card["team_logo_file"])
        if candidate.is_file():
            team_logo_path = candidate
    image_path = get_data_dir() / str(card["image_file"])
    render_radar_card(
        player_name=card["player_name"],
        radar=card["radar"],
        out_path=image_path,
        portrait_path=portrait_path,
        team_logo_path=team_logo_path,
        team_key=card["team_key"],
        team_label=card["team_label"],
        match_avg_radar=card.get("match_avg") or None,
    )


def set_card_portrait(card_id: str, data: bytes, suffix: str) -> Optional[dict[str, Any]]:
    """上传玩家人物图片并重渲染该玩家的雷达图卡片。"""
    suffix = (suffix or ".jpg").lower()
    if not suffix.startswith("."):
        suffix = "." + suffix
    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        portrait_dir = get_data_dir() / "portraits"
        portrait_dir.mkdir(parents=True, exist_ok=True)
        portrait_file = f"portraits/{card_id}{suffix}"
        portrait_path = portrait_dir / f"{card_id}{suffix}"
        portrait_path.write_bytes(data)
        target["portrait_file"] = portrait_file
        _render_card(target, portrait_path=portrait_path)
        _write_index(index)
        return _card_public(target)


def set_card_team_logo(card_id: str, data: bytes, suffix: str) -> Optional[dict[str, Any]]:
    """上传队伍标志，放大显示在人物头像后面（重渲染静态 PNG）。"""
    suffix = (suffix or ".png").lower()
    if not suffix.startswith("."):
        suffix = "." + suffix
    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        logo_dir = get_data_dir() / "team_logos"
        logo_dir.mkdir(parents=True, exist_ok=True)
        logo_file = f"team_logos/{card_id}{suffix}"
        logo_path = logo_dir / f"{card_id}{suffix}"
        logo_path.write_bytes(data)
        # 旧队标（后缀不同）清理
        old = target.get("team_logo_file")
        if old and str(old) != logo_file:
            try:
                old_path = get_data_dir() / str(old)
                if old_path.is_file():
                    old_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("cs_data_radar old team logo cleanup failed for %s", old)
        target["team_logo_file"] = logo_file
        _render_card(target, team_logo_path=logo_path)
        _write_index(index)
        return _card_public(target)


def clear_card_team_logo(card_id: str) -> Optional[dict[str, Any]]:
    """清除队伍标志并重渲染卡片。"""
    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        raw = target.get("team_logo_file")
        target["team_logo_file"] = None
        _render_card(target, team_logo_path=None)
        _write_index(index)
    if raw:
        try:
            p = get_data_dir() / str(raw)
            if p.is_file():
                p.unlink(missing_ok=True)
        except OSError:
            logger.warning("cs_data_radar team logo cleanup failed for %s", raw)
    return _card_public(get_card(card_id)) if get_card(card_id) else None


def replace_card_image(card_id: str, data: bytes) -> Optional[dict[str, Any]]:
    """用前端 Canvas 渲染的 PNG 替换卡片成品图（例如嵌入游戏内头像后）。"""
    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        image_path = get_data_dir() / str(target["image_file"])
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(data)
        _write_index(index)
        return _card_public(target)


def clear_card_video(card_id: str) -> Optional[dict[str, Any]]:
    """删除已生成的动画 MP4（头像变化后旧动画已过期，需重新生成）。"""
    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        raw = target.get("video_file")
        target["video_file"] = None
        _write_index(index)
    if raw:
        try:
            p = get_data_dir() / str(raw)
            if p.is_file():
                p.unlink(missing_ok=True)
        except OSError:
            logger.warning("cs_data_radar video cleanup failed for %s", raw)
    return _card_public(get_card(card_id)) if get_card(card_id) else None


def generate_card_animation(
    card_id: str,
    ffmpeg_bin: Path,
    workers: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    """按需生成该卡片的「开场动画」MP4（慢入→快出→定格），供合辑作为动画视频段插入。

    需要已配置的 FFmpeg；编码失败时保留静态图，卡片 video_file 维持为空。
    workers 控制帧渲染并行度（批量生成时可降低避免过载）。
    """
    from .radar_animation import generate_radar_animation

    with _LOCK:
        index = _read_index()
        target: Optional[dict[str, Any]] = None
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                target = card
                break
        if target is None:
            return None
        card = dict(target)  # 快照，渲染在锁外进行

    animations_dir = get_data_dir() / "animations"
    animations_dir.mkdir(parents=True, exist_ok=True)
    out_path = animations_dir / f"{card_id}.mp4"
    portrait = None
    if card.get("portrait_file"):
        candidate = get_data_dir() / str(card["portrait_file"])
        if candidate.is_file():
            portrait = candidate
    team_logo = None
    if card.get("team_logo_file"):
        candidate = get_data_dir() / str(card["team_logo_file"])
        if candidate.is_file():
            team_logo = candidate

    generate_radar_animation(
        player_name=card["player_name"],
        radar=card["radar"],
        match_avg_radar=card.get("match_avg") or None,
        portrait_path=portrait,
        team_logo_path=team_logo,
        team_key=card.get("team_key"),
        team_label=card.get("team_label") or "",
        ffmpeg_bin=ffmpeg_bin,
        out_path=out_path,
        workers=workers,
    )

    with _LOCK:
        index = _read_index()
        for card in index.get("cards", []):
            if str(card.get("id")) == str(card_id):
                card["video_file"] = f"animations/{card_id}.mp4"
                break
        _write_index(index)
    return _card_public(get_card(card_id)) if get_card(card_id) else None
