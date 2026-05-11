from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

# CS2 5 槽位颜色（与游戏内 player_color 0-4 对应）
_SLOT_COLORS_HEX = [
    "#569CFF",  # 0: 蓝
    "#58D68D",  # 1: 绿
    "#FFDD57",  # 2: 黄
    "#FF912D",  # 3: 橙
    "#B878FF",  # 4: 紫
]
_DEAD_COLOR_HEX = "#808080"
CIRCLE_BORDER_COLOR = (80, 230, 120, 230)

_DOT_RADIUS_POV   = 6
_DOT_RADIUS_ALIVE = 5
_DOT_RADIUS_DEAD  = 3

_SS = 3  # 超采样倍率（抗锯齿）


# ---------------------------------------------------------------------------
# 内置雷达资源（backend/assets/bundled_radar_maps，随仓库分发）
# ---------------------------------------------------------------------------

def _warn_if_bundled_radar_missing() -> None:
    from app.radar.radar_map_assets import warn_if_bundle_incomplete

    warn_if_bundle_incomplete()


# ---------------------------------------------------------------------------
# 圆形遮罩 / 圆形边框（PIL，保留高质量 AA）
# ---------------------------------------------------------------------------

def _circle_mask(size: int, padding: int = 0) -> Image.Image:
    """4× 超采样生成无锯齿圆形遮罩。"""
    ss = 4
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    p = padding * ss
    draw.ellipse((p, p, big - p - 1, big - p - 1), fill=255)
    try:
        return mask.resize((size, size), Image.Resampling.LANCZOS)
    except AttributeError:
        return mask.resize((size, size), Image.LANCZOS)  # type: ignore[attr-defined]


def _apply_circular_radar_frame(
    radar: Image.Image,
    *,
    size: int,
    border_color: tuple[int, int, int, int] = CIRCLE_BORDER_COLOR,
    border_width: int = 2,
    background_color: tuple[int, int, int, int] = (0, 0, 0, 140),
) -> Image.Image:
    radar = radar.convert("RGBA")
    if radar.size != (size, size):
        try:
            radar = radar.resize((size, size), Image.Resampling.BILINEAR)
        except AttributeError:
            radar = radar.resize((size, size), Image.BILINEAR)  # type: ignore[attr-defined]

    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 背景圆
    bg_mask = _circle_mask(size, padding=0)
    bg_fill = Image.new("RGBA", (size, size), background_color)
    output.paste(bg_fill, (0, 0), bg_mask)

    # 地图内容（带内边距圆形裁剪）
    inner_mask = _circle_mask(size, padding=border_width + 1)
    clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped.paste(radar, (0, 0), inner_mask)
    output.alpha_composite(clipped, (0, 0))

    # 绿色边框（4× 超采样）
    ss = 4
    big = size * ss
    bw = max(ss, border_width * ss)
    half_bw = bw // 2
    border_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border_big)
    try:
        bd.ellipse(
            (half_bw, half_bw, big - 1 - half_bw, big - 1 - half_bw),
            outline=border_color,
            width=bw,
        )
    except TypeError:
        for i in range(bw):
            bd.ellipse((i, i, big - 1 - i, big - 1 - i), outline=border_color)
    try:
        border_small = border_big.resize((size, size), Image.Resampling.LANCZOS)
    except AttributeError:
        border_small = border_big.resize((size, size), Image.LANCZOS)  # type: ignore[attr-defined]
    output.alpha_composite(border_small, (0, 0))

    return output


# ---------------------------------------------------------------------------
# 颜色工具
# ---------------------------------------------------------------------------

def _hex_to_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r, g, b, alpha


def _player_color_hex(player: dict[str, Any], color_index: int) -> str:
    slot = player.get("slot_color_index", -1)
    if isinstance(slot, int) and 0 <= slot < len(_SLOT_COLORS_HEX):
        return _SLOT_COLORS_HEX[slot]
    return _SLOT_COLORS_HEX[color_index % len(_SLOT_COLORS_HEX)]


def _radar_player_palette_key(player: dict[str, Any]) -> str:
    """稳定区分「不同玩家」，避免人机/缺 steamid 时全部落到同一 fallback 色。"""
    raw_sid = str(player.get("steamid64") or player.get("steamid") or "").strip()
    name = str(player.get("name") or "").strip()
    # Demo 里人机常见 steamid=0；多个人机若只按 id 建表会共用 color index 0。
    if raw_sid and raw_sid != "0":
        return f"sid:{raw_sid}"
    if name:
        return f"name:{name.casefold()}"
    if raw_sid:
        return f"sid:{raw_sid}"
    return "anon"


def _build_color_indices(players: list[dict[str, Any]]) -> dict[str, int]:
    ids: list[str] = []
    for p in players:
        key = _radar_player_palette_key(p)
        if key != "anon" and key not in ids:
            ids.append(key)
    return {key: idx for idx, key in enumerate(ids)}


# ---------------------------------------------------------------------------
# PIL 单帧渲染（快速，无 matplotlib）
# ---------------------------------------------------------------------------

def _draw_dot_ss(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    radius: int,
    fill: tuple[int, int, int, int],
    *,
    ss: int,
    pov_ring: bool = False,
) -> None:
    """在超采样坐标系中绘制平滑实心圆（无描边）。"""
    scx = cx * ss
    scy = cy * ss
    sr = radius * ss
    draw.ellipse((scx - sr, scy - sr, scx + sr, scy + sr), fill=fill)
    if pov_ring:
        ring = sr + 3 * ss
        draw.ellipse(
            (scx - ring, scy - ring, scx + ring, scy + ring),
            outline=(255, 255, 255, 220),
            width=max(1, ss),
        )


def _render_frame_pil(
    background: Image.Image,
    players: list[dict[str, Any]],
    transform: Any,                        # RadarTransform
    color_idx_by_id: dict[str, int],
    circle_mask: Image.Image,
) -> Image.Image:
    """在预渲染背景上用 PIL 绘制玩家点（3× 超采样抗锯齿，无黑框）。

    background 已经是带圆形边框的 RGBA 画布（来自 prerender_map_background）。
    玩家点绘制到透明图层，用 circle_mask 裁掉边界溢出部分，再合成到背景上，
    这样背景的圆形边框像素永远不会被破坏。
    """
    size = transform.canvas_size

    # 超采样画布
    big = size * _SS
    dot_layer_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(dot_layer_big)

    for player in players:
        try:
            wx = float(player["x"])
            wy = float(player["y"])
        except (KeyError, TypeError, ValueError):
            continue

        is_alive = bool(player.get("is_alive", True))
        is_pov   = bool(player.get("is_pov", False))

        pkey = _radar_player_palette_key(player)
        ci = color_idx_by_id.get(pkey, 0) if pkey != "anon" else 0
        hex_color = _player_color_hex(player, ci) if is_alive else _DEAD_COLOR_HEX
        alpha     = 255 if is_alive else 90

        cx, cy = transform.world_to_canvas(wx, wy)
        radius = _DOT_RADIUS_POV if is_pov else (_DOT_RADIUS_ALIVE if is_alive else _DOT_RADIUS_DEAD)
        fill   = _hex_to_rgba(hex_color, alpha)

        _draw_dot_ss(draw, cx, cy, radius, fill, ss=_SS, pov_ring=(is_pov and is_alive))

    # 超采样缩回原始尺寸（LANCZOS 自带 AA）
    try:
        dot_layer = dot_layer_big.resize((size, size), Image.Resampling.LANCZOS)
    except AttributeError:
        dot_layer = dot_layer_big.resize((size, size), Image.LANCZOS)  # type: ignore

    # 用 circle_mask 裁掉边界溢出的玩家点
    clipped_dots = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped_dots.paste(dot_layer, (0, 0), circle_mask)

    # 合成：background（含完整圆形边框）+ 裁剪后的玩家点图层
    result = background.copy()
    result.alpha_composite(clipped_dots, (0, 0))
    return result


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def render_radar_frames(
    *,
    timeline: list[dict[str, Any]],
    map_name: str,
    output_dir: Path,
    size: int = 300,
    clip_id: str | int | None = None,
    pov_rotate: bool = False,       # 保留兼容，暂不使用
    pov_zoom: float = 0.0,          # 保留兼容，暂不使用
    center_y_ratio: float = 0.5,    # 保留兼容，暂不使用
    circular_frame: bool = True,
) -> list[Path]:
    from app.radar.radar_background import prerender_map_background

    output_dir.mkdir(parents=True, exist_ok=True)
    _warn_if_bundled_radar_missing()

    # 地图名格式（与 bundled map-data.json 键一致：小写，带前缀）
    map_key = map_name.lower().strip()
    if not map_key.startswith(("de_", "cs_", "ar_", "gg_", "dm_", "mm_")):
        map_key = "de_" + map_key

    # 预渲染背景（含圆形边框），失败则用纯黑圆
    try:
        background, transform = prerender_map_background(
            map_name=map_key,
            canvas_size=size,
        )
    except Exception as exc:
        logger.error("雷达背景预渲染失败 [map=%s]: %s", map_key, exc)
        if isinstance(exc, (KeyError, FileNotFoundError)):
            raise RuntimeError(
                f"缺少内置雷达底图: {map_key}。请确认 backend/assets/bundled_radar_maps 含 "
                f"map-data.json 与 PNG；开发机可运行 backend/scripts/vendor_bundled_radar_maps.py 更新。"
            ) from exc
        background = Image.new("RGBA", (size, size), (0, 0, 0, 200))
        if circular_frame:
            background = _apply_circular_radar_frame(background, size=size)
        transform = None

    # 预生成圆形遮罩（只建一次，复用于所有帧）
    circle_mask = _circle_mask(size, padding=1)

    # 颜色索引一次性从整条时间线所有玩家里建好
    all_players: list[dict[str, Any]] = []
    for frame in timeline:
        all_players.extend(frame.get("players", []))
    color_idx_by_id = _build_color_indices(all_players)

    outputs: list[Path] = []
    last_img: Image.Image | None = None

    for frame_idx, frame in enumerate(timeline):
        players = list(frame.get("players", []))
        # POV 最后绘制（在最上层）
        players.sort(key=lambda p: (1 if p.get("is_pov") else 0))

        if transform is not None and players:
            try:
                img = _render_frame_pil(
                    background=background,
                    players=players,
                    transform=transform,
                    color_idx_by_id=color_idx_by_id,
                    circle_mask=circle_mask,
                )
            except Exception as exc:
                logger.debug("雷达帧 %d 渲染错误: %s", frame_idx, exc)
                img = None
        else:
            img = None

        if img is None:
            # 无玩家或渲染失败：复用上一帧；若无上一帧，用纯背景
            img = last_img if last_img is not None else background.copy()

        last_img = img
        serial = frame_idx + 1
        out = output_dir / f"radar_{serial:06d}.png"
        img.save(out)
        outputs.append(out)

        if frame_idx % 30 == 0:
            logger.debug("雷达帧进度: %d / %d", frame_idx + 1, len(timeline))

    return outputs
