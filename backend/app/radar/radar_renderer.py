from __future__ import annotations

import logging
import math
import os
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance

from app.radar.map_calibration import RadarMapError, get_map_calibration, world_to_radar_xy
from app.radar.radar_debug import write_radar_debug_points

logger = logging.getLogger(__name__)

RADAR_PLAYER_COLORS: list[tuple[int, int, int, int]] = [
    (86, 156, 255, 255),
    (88, 214, 141, 255),
    (255, 221, 87, 255),
    (255, 145, 45, 255),
    (184, 120, 255, 255),
]

DEFAULT_POV_COLOR = (255, 145, 45, 255)
DEAD_COLOR = (150, 150, 150, 110)

CIRCLE_BORDER_COLOR = (255, 120, 190, 150)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str) -> bool:
    return (os.environ.get(name) or "").strip() in ("1", "true", "yes", "on")


def _validate_map_image(map_img: Image.Image, map_name: str, image_path: str) -> None:
    w, h = map_img.size

    if w < 256 or h < 256:
        raise RadarMapError(f"雷达底图尺寸异常: {map_name} {w}x{h}, path={image_path}")

    rgba = map_img.convert("RGBA")

    alpha = rgba.getchannel("A")
    alpha_bbox = alpha.getbbox()

    if alpha_bbox is None:
        raise RadarMapError(f"雷达底图全透明: {map_name}, path={image_path}")

    sample = rgba.resize((64, 64))
    pixels = list(sample.getdata())

    visible_pixels = [p for p in pixels if p[3] > 16]

    if not visible_pixels:
        raise RadarMapError(f"雷达底图没有可见像素: {map_name}, path={image_path}")

    avg_brightness = sum((r + g + b) / 3 for r, g, b, a in visible_pixels) / len(visible_pixels)

    if avg_brightness < 8:
        raise RadarMapError(
            f"雷达底图过暗，疑似黑图或占位图: "
            f"{map_name}, brightness={avg_brightness:.2f}, path={image_path}"
        )


def _radar_pixel_to_canvas(
    rx: float,
    ry: float,
    *,
    size: int,
    source_w: int,
    source_h: int,
) -> tuple[float, float]:
    px = rx * float(size) / float(source_w)
    py = ry * float(size) / float(source_h)
    return px, py


def _rotate_point(x: float, y: float, angle_rad: float) -> tuple[float, float]:
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)


def _pov_relative_canvas_xy(
    *,
    player_rx: float,
    player_ry: float,
    pov_rx: float,
    pov_ry: float,
    pov_yaw: float,
    size: int,
    source_w: int,
    source_h: int,
    yaw_offset_deg: float = 0.0,
    center_y_ratio: float = 0.58,
    zoom: float = 1.0,
) -> tuple[float, float]:
    dx = player_rx - pov_rx
    dy = player_ry - pov_ry

    sx = float(size) / float(source_w)
    sy = float(size) / float(source_h)

    dx *= sx * float(zoom)
    dy *= sy * float(zoom)

    angle = math.radians(float(pov_yaw) + float(yaw_offset_deg))

    rdx, rdy = _rotate_point(dx, dy, angle)

    center_x = size * 0.5
    center_y = size * float(center_y_ratio)

    return center_x + rdx, center_y + rdy


def _make_pov_rotated_map_layer(
    *,
    map_img: Image.Image,
    pov_rx: float,
    pov_ry: float,
    pov_yaw: float,
    size: int,
    yaw_offset_deg: float = 0.0,
    center_y_ratio: float = 0.58,
    zoom: float = 1.0,
) -> Image.Image:
    source_w, source_h = map_img.size

    try:
        resample = Image.Resampling.LANCZOS
        resample_bicubic = Image.Resampling.BICUBIC
    except AttributeError:
        resample = Image.LANCZOS  # type: ignore[attr-defined]
        resample_bicubic = Image.BICUBIC  # type: ignore[attr-defined]

    work_size = int(size * 3)
    work = Image.new("RGBA", (work_size, work_size), (0, 0, 0, 0))

    base_scale = float(size) / float(max(source_w, source_h))
    scale = base_scale * float(zoom)

    scaled_w = max(1, int(round(source_w * scale)))
    scaled_h = max(1, int(round(source_h * scale)))

    scaled = map_img.convert("RGBA").resize((scaled_w, scaled_h), resample)

    pov_sx = float(pov_rx) * scale
    pov_sy = float(pov_ry) * scale

    target_x = work_size * 0.5
    target_y = work_size * float(center_y_ratio)

    paste_x = int(round(target_x - pov_sx))
    paste_y = int(round(target_y - pov_sy))

    work.alpha_composite(scaled, (paste_x, paste_y))

    rotate_deg = -(float(pov_yaw) + float(yaw_offset_deg))

    try:
        rotated = work.rotate(
            rotate_deg,
            resample=resample_bicubic,
            center=(target_x, target_y),
            fillcolor=(0, 0, 0, 0),
        )
    except TypeError:
        rotated = work.rotate(rotate_deg, resample=resample_bicubic, fillcolor=(0, 0, 0, 0))

    left = int(round(target_x - size * 0.5))
    top = int(round(target_y - size * float(center_y_ratio)))

    return rotated.crop((left, top, left + size, top + size))


def _circle_mask(size: int, padding: int = 0) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(
        (padding, padding, size - padding - 1, size - padding - 1),
        fill=255,
    )
    return mask


def _apply_circular_radar_frame(
    radar: Image.Image,
    *,
    size: int,
    border_color: tuple[int, int, int, int] = CIRCLE_BORDER_COLOR,
    border_width: int = 2,
    background_color: tuple[int, int, int, int] = (0, 0, 0, 180),
) -> Image.Image:
    radar = radar.convert("RGBA").resize((size, size))

    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    bg_draw.ellipse((0, 0, size - 1, size - 1), fill=background_color)
    output.alpha_composite(bg, (0, 0))

    mask = _circle_mask(size, padding=border_width + 1)
    clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped.paste(radar, (0, 0), mask)
    output.alpha_composite(clipped, (0, 0))

    draw = ImageDraw.Draw(output)
    for i in range(border_width):
        draw.ellipse(
            (i, i, size - 1 - i, size - 1 - i),
            outline=border_color,
        )

    return output


def _enhanced_map_rgba(map_img: Image.Image, size: int) -> Image.Image:
    try:
        resample = Image.Resampling.LANCZOS
    except AttributeError:
        resample = Image.LANCZOS  # type: ignore[attr-defined]

    base = map_img.convert("RGBA").resize((size, size), resample)
    try:
        base = ImageEnhance.Brightness(base).enhance(1.22)
        base = ImageEnhance.Contrast(base).enhance(1.08)
    except Exception:
        pass
    return base


def _parse_rgba_color(value: object) -> tuple[int, int, int, int] | None:
    if value is None:
        return None

    if isinstance(value, str):
        raw = value.strip()
        if raw.startswith("#") and len(raw) == 7:
            try:
                r = int(raw[1:3], 16)
                g = int(raw[3:5], 16)
                b = int(raw[5:7], 16)
                return (r, g, b, 255)
            except ValueError:
                return None

    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            r = int(value[0])
            g = int(value[1])
            b = int(value[2])
            a = int(value[3]) if len(value) >= 4 else 255
            return (r, g, b, a)
        except (TypeError, ValueError):
            return None

    if isinstance(value, dict):
        try:
            r = int(value.get("r"))
            g = int(value.get("g"))
            b = int(value.get("b"))
            a = int(value.get("a", 255))
            return (r, g, b, a)
        except (TypeError, ValueError):
            return None

    return None


def _player_marker_color(
    player: dict[str, Any],
    *,
    is_pov: bool,
    color_index: int,
) -> tuple[int, int, int, int]:
    for key in ("player_color", "color", "team_color", "comp_color", "slot_color"):
        parsed = _parse_rgba_color(player.get(key))
        if parsed is not None:
            return parsed

    if is_pov:
        return DEFAULT_POV_COLOR

    return RADAR_PLAYER_COLORS[color_index % len(RADAR_PLAYER_COLORS)]


def _build_color_indices(players: list[dict[str, Any]]) -> dict[str, int]:
    ids: list[str] = []

    for p in players:
        sid = str(p.get("steamid64") or p.get("steamid") or p.get("name") or "")
        if sid and sid not in ids:
            ids.append(sid)

    return {sid: idx for idx, sid in enumerate(ids)}


def _draw_direction_tip(
    draw: ImageDraw.ImageDraw,
    *,
    cx: float,
    cy: float,
    yaw: float,
    color: tuple[int, int, int, int],
    length: float,
    width: int,
    yaw_offset_deg: float = 0.0,
) -> None:
    a = math.radians(float(yaw) + float(yaw_offset_deg))

    dx = math.cos(a)
    dy = -math.sin(a)

    x2 = cx + dx * length
    y2 = cy + dy * length

    draw.line((cx, cy, x2, y2), fill=color, width=width)


def _draw_round_player_marker(
    draw: ImageDraw.ImageDraw,
    *,
    cx: float,
    cy: float,
    yaw: float | None,
    fill: tuple[int, int, int, int],
    is_pov: bool,
    is_alive: bool,
    yaw_offset_deg: float = 0.0,
) -> None:
    if is_pov:
        radius = 5.8
        outline_width = 2.0
        direction_len = 13.0
        direction_width = 3
    else:
        radius = 4.4
        outline_width = 1.6
        direction_len = 10.0
        direction_width = 2

    outline = (0, 0, 0, 220)
    direction_color = (255, 255, 255, 235)

    if not is_alive:
        radius = 3.2
        outline = (0, 0, 0, 120)
        fill = DEAD_COLOR
        direction_color = (180, 180, 180, 90)

    draw.ellipse(
        (
            cx - radius - outline_width,
            cy - radius - outline_width,
            cx + radius + outline_width,
            cy + radius + outline_width,
        ),
        fill=outline,
    )

    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        fill=fill,
    )

    if yaw is not None and is_alive:
        _draw_direction_tip(
            draw,
            cx=cx,
            cy=cy,
            yaw=float(yaw),
            color=direction_color,
            length=direction_len,
            width=direction_width,
            yaw_offset_deg=yaw_offset_deg,
        )


def _find_pov_player(players: list[dict[str, Any]]) -> dict[str, Any] | None:
    for p in players:
        if p.get("is_pov"):
            return p
    return None


def render_radar_frames(
    *,
    timeline: list[dict[str, Any]],
    map_name: str,
    output_dir: Path,
    size: int = 300,
    clip_id: str | int | None = None,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        cfg = get_map_calibration(map_name)
    except RadarMapError:
        raise
    map_img = Image.open(cfg["image_path"]).convert("RGBA")
    ipath = str(cfg["image_path"])
    _validate_map_image(map_img, map_name, ipath)
    source_w, source_h = map_img.size
    logger.info(
        "加载雷达底图: map=%s path=%s size=%sx%s",
        map_name,
        ipath,
        source_w,
        source_h,
    )

    yaw_offset_deg = _env_float("CS2_INSIGHT_RADAR_YAW_OFFSET_DEG", 0.0)
    pov_rotate = _env_bool("CS2_INSIGHT_RADAR_POV_ROTATE")
    center_y_ratio = _env_float("CS2_INSIGHT_RADAR_POV_CENTER_Y_RATIO", 0.58)
    pov_zoom = _env_float("CS2_INSIGHT_RADAR_POV_SCALE", 1.0)

    debug_enabled = os.environ.get("CS2_INSIGHT_RADAR_DEBUG") == "1"
    debug_dir = output_dir / "_radar_debug"

    outputs: list[Path] = []

    for frame_idx, frame in enumerate(timeline):
        players = list(frame.get("players", []))
        players.sort(key=lambda p: (1 if p.get("is_pov") else 0,))
        color_idx_by_id = _build_color_indices(players)

        pov_pr = _find_pov_player(players) if pov_rotate else None
        pov_rx = pov_ry = pov_yaw = 0.0
        if pov_pr is not None:
            try:
                pov_rx, pov_ry = world_to_radar_xy(float(pov_pr["x"]), float(pov_pr["y"]), cfg)
                pov_yaw = float(pov_pr.get("yaw") or 0.0)
                base_layer = _make_pov_rotated_map_layer(
                    map_img=map_img,
                    pov_rx=pov_rx,
                    pov_ry=pov_ry,
                    pov_yaw=pov_yaw,
                    size=size,
                    yaw_offset_deg=yaw_offset_deg,
                    center_y_ratio=center_y_ratio,
                    zoom=pov_zoom,
                )
            except Exception:
                pov_pr = None
                base_layer = _enhanced_map_rgba(map_img, size)
        else:
            base_layer = _enhanced_map_rgba(map_img, size)

        img = _apply_circular_radar_frame(base_layer, size=size)
        draw = ImageDraw.Draw(img)

        debug_points: list[dict[str, Any]] = []

        for player in players:
            try:
                rx, ry = world_to_radar_xy(float(player["x"]), float(player["y"]), cfg)
                if pov_rotate and pov_pr is not None:
                    px, py = _pov_relative_canvas_xy(
                        player_rx=rx,
                        player_ry=ry,
                        pov_rx=pov_rx,
                        pov_ry=pov_ry,
                        pov_yaw=pov_yaw,
                        size=size,
                        source_w=source_w,
                        source_h=source_h,
                        yaw_offset_deg=yaw_offset_deg,
                        center_y_ratio=center_y_ratio,
                        zoom=pov_zoom,
                    )
                else:
                    px, py = _radar_pixel_to_canvas(
                        rx,
                        ry,
                        size=size,
                        source_w=source_w,
                        source_h=source_h,
                    )
            except Exception:
                continue

            if px < -40 or py < -40 or px > size + 40 or py > size + 40:
                continue

            is_alive = bool(player.get("is_alive", True))
            is_pov = bool(player.get("is_pov"))
            yaw_raw = player.get("yaw")
            yaw_v: float | None
            try:
                yaw_v = float(yaw_raw) if yaw_raw is not None else None
            except (TypeError, ValueError):
                yaw_v = None

            display_yaw = yaw_v
            if pov_rotate and pov_pr is not None and yaw_v is not None:
                display_yaw = float(yaw_v) - pov_yaw

            sid = str(player.get("steamid64") or player.get("steamid") or player.get("name") or "")
            ci = color_idx_by_id.get(sid, 0)
            fill = _player_marker_color(player, is_pov=is_pov, color_index=ci)

            _draw_round_player_marker(
                draw,
                cx=px,
                cy=py,
                yaw=display_yaw,
                fill=fill,
                is_pov=is_pov,
                is_alive=is_alive,
                yaw_offset_deg=yaw_offset_deg,
            )

            if debug_enabled and frame_idx % 30 == 0:
                debug_points.append(
                    {
                        "name": player.get("name"),
                        "steamid64": player.get("steamid64"),
                        "team": player.get("team"),
                        "is_pov": is_pov,
                        "alive": is_alive,
                        "world_x": player.get("x"),
                        "world_y": player.get("y"),
                        "yaw": yaw_v,
                        "radar_x": rx,
                        "radar_y": ry,
                        "canvas_x": px,
                        "canvas_y": py,
                    },
                )

        if debug_enabled and frame_idx % 30 == 0 and debug_points:
            write_radar_debug_points(
                output_dir=debug_dir,
                clip_id=clip_id,
                map_name=map_name,
                frame_index=frame_idx,
                video_time_sec=float(frame.get("time_sec") or 0.0),
                tick=int(frame.get("tick") or 0),
                source_w=source_w,
                source_h=source_h,
                points=debug_points,
            )

        serial = frame_idx + 1
        out = output_dir / f"radar_{serial:06d}.png"
        img.save(out)
        outputs.append(out)

    return outputs
