"""Fast per-frame PIL radar rendering using a pre-rendered background."""
from __future__ import annotations

import logging
from typing import Any, Optional

from PIL import Image, ImageDraw

from app.radar.radar_background import RadarTransform
from app.radar.radar_renderer import _circle_mask, _SLOT_COLORS_HEX, _DEAD_COLOR_HEX

logger = logging.getLogger(__name__)

_DOT_RADIUS_POV = 6
_DOT_RADIUS_ALIVE = 5
_DOT_RADIUS_DEAD = 3


def _parse_position_string(pos_str: str) -> Optional[tuple[float, float, float]]:
    """Parse CS2 GSI 'x, y, z' string."""
    try:
        parts = [p.strip() for p in str(pos_str).split(",")]
        if len(parts) < 2:
            return None
        return float(parts[0]), float(parts[1]), float(parts[2]) if len(parts) > 2 else 0.0
    except (ValueError, AttributeError):
        return None


def build_session_color_map(steamids: list[str]) -> dict[str, int]:
    """Build stable steamid→color_index (0-4) map."""
    result: dict[str, int] = {}
    for sid in steamids:
        if sid not in result:
            result[sid] = len(result) % len(_SLOT_COLORS_HEX)
    return result


def render_live_frame(
    background: Image.Image,
    gsi_allplayers: dict[str, Any],
    transform: RadarTransform,
    *,
    pov_steamid: Optional[str] = None,
    color_map: Optional[dict[str, int]] = None,
    circle_mask: Optional[Image.Image] = None,
) -> Image.Image:
    """
    Draw player dots on a copy of the pre-rendered background.
    Returns canvas_size×canvas_size RGBA image.
    """
    size = transform.canvas_size
    if circle_mask is None:
        circle_mask = _circle_mask(size, padding=1)

    # Sort: non-POV first, POV last (on top)
    entries = sorted(
        gsi_allplayers.items(),
        key=lambda kv: (1 if kv[0] == pov_steamid else 0),
    )

    dot_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dot_draw = ImageDraw.Draw(dot_layer)

    for steamid, pdata in entries:
        if not isinstance(pdata, dict):
            continue
        pos_raw = pdata.get("position")
        if not pos_raw:
            continue
        pos = _parse_position_string(str(pos_raw))
        if pos is None:
            continue

        wx, wy, _ = pos
        state = pdata.get("state") or {}
        try:
            hp = int(state.get("health", 100) or 100)
        except (TypeError, ValueError):
            hp = 100
        is_alive = hp > 0
        is_pov = pov_steamid is not None and steamid == pov_steamid

        if is_alive:
            idx = (color_map or {}).get(str(steamid), 0)
            hex_color = _SLOT_COLORS_HEX[idx % len(_SLOT_COLORS_HEX)]
        else:
            hex_color = _DEAD_COLOR_HEX

        cx, cy = transform.world_to_canvas(wx, wy)
        cx, cy = int(round(cx)), int(round(cy))

        radius = _DOT_RADIUS_POV if is_pov else (_DOT_RADIUS_ALIVE if is_alive else _DOT_RADIUS_DEAD)
        alpha = 255 if is_alive else 90

        h = hex_color.lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

        # 外圈黑色描边
        outline_r = radius + 1
        dot_draw.ellipse(
            (cx - outline_r, cy - outline_r, cx + outline_r, cy + outline_r),
            fill=(0, 0, 0, min(alpha + 40, 255)),
        )
        # 内圈彩色填充
        dot_draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            fill=(r, g, b, alpha),
        )

        if is_pov and is_alive:
            ring = radius + 3
            dot_draw.ellipse(
                (cx - ring, cy - ring, cx + ring, cy + ring),
                outline=(255, 255, 255, 200),
                width=1,
            )

    # 裁掉超出地图圆边界的玩家点，然后合成到背景（保留背景圆形边框完整）
    clipped_dots = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped_dots.paste(dot_layer, (0, 0), circle_mask)

    result = background.copy()
    result.alpha_composite(clipped_dots, (0, 0))
    return result
