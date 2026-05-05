from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance

from app.radar.map_calibration import RadarMapError, get_map_calibration, world_to_radar_xy


SELF_COLOR = (255, 180, 64, 255)
TEAMMATE_COLOR = (120, 190, 255, 255)
BORDER_COLOR = (255, 255, 255, 160)
SHADE_COLOR = (0, 0, 0, 22)

_INNER_PAD = 14.0


def _draw_triangle(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    yaw: float,
    size: float,
    fill: tuple[int, int, int, int],
) -> None:
    angle = math.radians(yaw - 90)
    points = []
    for offset, scale in [(0, 1.0), (140, 0.72), (-140, 0.72)]:
        a = angle + math.radians(offset)
        points.append((cx + math.cos(a) * size * scale, cy + math.sin(a) * size * scale))
    draw.polygon(points, fill=fill)


def _timeline_radar_bounds(timeline: list[dict[str, Any]], cfg: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """整段 timeline 在雷达平面上的包围盒 (min_rx, min_ry, span_x, span_y)，用于把点缩放进小画布。"""
    rxs: list[float] = []
    rys: list[float] = []
    for frame in timeline:
        for player in frame.get("players", []):
            if not player.get("is_alive", True):
                continue
            try:
                rx, ry = world_to_radar_xy(float(player["x"]), float(player["y"]), cfg)
            except Exception:
                continue
            rxs.append(rx)
            rys.append(ry)
    if not rxs:
        return None
    min_rx, max_rx = min(rxs), max(rxs)
    min_ry, max_ry = min(rys), max(rys)
    span_x = max(max_rx - min_rx, 1e-6)
    span_y = max(max_ry - min_ry, 1e-6)
    return (min_rx, min_ry, span_x, span_y)


def _map_rx_ry_to_canvas(
    rx: float,
    ry: float,
    bounds: tuple[float, float, float, float] | None,
    size: int,
    source_w: int,
    source_h: int,
) -> tuple[float, float]:
    """有 timeline 包围盒则自适应铺满画布；否则退回按底图像素比例映射。"""
    inner = float(size) - 2 * _INNER_PAD
    if bounds is None:
        px = rx * float(size) / float(source_w)
        py = ry * float(size) / float(source_h)
        return px, py
    min_rx, min_ry, span_x, span_y = bounds
    if span_x < 0.5:
        px = float(size) / 2.0
    else:
        px = _INNER_PAD + (rx - min_rx) / span_x * inner
    if span_y < 0.5:
        py = float(size) / 2.0
    else:
        py = _INNER_PAD + (ry - min_ry) / span_y * inner
    return px, py


def _frame_image(map_img: Image.Image, size: int) -> Image.Image:
    try:
        resample = Image.Resampling.LANCZOS
    except AttributeError:
        resample = Image.LANCZOS  # type: ignore[attr-defined]

    canvas = Image.new("RGBA", (size, size), (32, 34, 40, 255))
    base = map_img.convert("RGBA").resize((size, size), resample)
    try:
        base = ImageEnhance.Brightness(base).enhance(1.22)
        base = ImageEnhance.Contrast(base).enhance(1.08)
    except Exception:
        pass
    canvas.alpha_composite(base, (0, 0))

    shade = Image.new("RGBA", (size, size), SHADE_COLOR)
    canvas.alpha_composite(shade, (0, 0))

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((1, 1, size - 2, size - 2), radius=18, outline=BORDER_COLOR, width=2)
    return canvas


def render_radar_frames(
    *,
    timeline: list[dict[str, Any]],
    map_name: str,
    output_dir: Path,
    size: int = 300,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        cfg = get_map_calibration(map_name)
    except RadarMapError:
        raise
    map_img = Image.open(cfg["image_path"]).convert("RGBA")
    source_w, source_h = map_img.size

    bounds = _timeline_radar_bounds(timeline, cfg)

    outputs: list[Path] = []

    for frame_idx, frame in enumerate(timeline, start=1):
        img = _frame_image(map_img, size)
        draw = ImageDraw.Draw(img)

        for player in frame.get("players", []):
            if not player.get("is_alive", True):
                continue
            try:
                rx, ry = world_to_radar_xy(float(player["x"]), float(player["y"]), cfg)
                px, py = _map_rx_ry_to_canvas(rx, ry, bounds, size, source_w, source_h)
            except Exception:
                continue

            if px < -30 or py < -30 or px > size + 30 or py > size + 30:
                continue

            yaw = float(player.get("yaw") or 0.0)

            if player.get("is_pov"):
                _draw_triangle(draw, px, py, yaw, 14, SELF_COLOR)
            else:
                draw.ellipse((px - 6, py - 6, px + 6, py + 6), fill=TEAMMATE_COLOR)

        out = output_dir / f"radar_{frame_idx:06d}.png"
        img.save(out)
        outputs.append(out)

    return outputs
