"""Pre-render the static map background and compute world→canvas coordinate transform."""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import NamedTuple, Optional

from PIL import Image

from app.radar.radar_map_assets import lookup_map_data, resolve_map_png_path
from app.radar.radar_renderer import _apply_circular_radar_frame

logger = logging.getLogger(__name__)


class RadarTransform(NamedTuple):
    """Immutable world→canvas pixel transform."""
    pos_x: float
    pos_y: float
    scale: float
    render_scale: float
    off_x: int
    off_y: int
    canvas_size: int

    def world_to_canvas(self, wx: float, wy: float) -> tuple[float, float]:
        """Convert CS2 world coordinates to canvas pixel coordinates."""
        map_px = (wx - self.pos_x) / self.scale
        map_py = (self.pos_y - wy) / self.scale
        cx = map_px * self.render_scale + self.off_x
        cy = map_py * self.render_scale + self.off_y
        return cx, cy


def prerender_map_background(
    map_name: str,
    canvas_size: int = 300,
    margin: int = 8,
    output_path: Optional[Path] = None,
) -> tuple[Image.Image, RadarTransform]:
    """
    Pre-render the circular map background (no players) and return coordinate transform.

    Returns:
        (background_rgba, transform): background is canvas_size×canvas_size RGBA;
        transform converts world→canvas pixel coordinates for PIL dot drawing.
    """
    map_data = lookup_map_data(map_name)
    pos_x = float(map_data["pos_x"])
    pos_y = float(map_data["pos_y"])
    scale = float(map_data["scale"])

    map_img = Image.open(resolve_map_png_path(map_name)).convert("RGBA")
    map_w, map_h = map_img.size

    # Diagonal-fit: all 4 corners inside circle
    effective_d = canvas_size - 2 * margin
    diagonal = math.sqrt(map_w * map_w + map_h * map_h)
    render_scale = effective_d / diagonal

    new_w = max(1, int(round(map_w * render_scale)))
    new_h = max(1, int(round(map_h * render_scale)))

    try:
        scaled = map_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    except AttributeError:
        scaled = map_img.resize((new_w, new_h), Image.LANCZOS)  # type: ignore

    off_x = (canvas_size - new_w) // 2
    off_y = (canvas_size - new_h) // 2

    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(scaled, (off_x, off_y), scaled)

    bg = _apply_circular_radar_frame(canvas, size=canvas_size)

    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        bg.save(str(output_path))
        logger.info("Radar background saved: %s", output_path)

    return bg, RadarTransform(
        pos_x=pos_x,
        pos_y=pos_y,
        scale=scale,
        render_scale=render_scale,
        off_x=off_x,
        off_y=off_y,
        canvas_size=canvas_size,
    )
