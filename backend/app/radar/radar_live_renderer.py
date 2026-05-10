"""Fast per-frame PIL radar rendering using a pre-rendered background."""
from __future__ import annotations

import logging
from typing import Any, Optional

from PIL import Image, ImageDraw

from app.radar.radar_background import RadarTransform
from app.radar.radar_renderer import _circle_mask, _SLOT_COLORS_HEX, _DEAD_COLOR_HEX

logger = logging.getLogger(__name__)

_DOT_RADIUS_POV   = 6
_DOT_RADIUS_ALIVE = 5
_DOT_RADIUS_DEAD  = 3

_SS = 3   # 超采样倍率（3× 在 300px 画布上已非常平滑）


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


def _hex_to_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r, g, b, alpha


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
    """在超采样坐标系中绘制一个平滑的实心圆（无描边）。"""
    scx = cx * ss
    scy = cy * ss
    sr = radius * ss

    draw.ellipse(
        (scx - sr, scy - sr, scx + sr, scy + sr),
        fill=fill,
    )

    if pov_ring:
        ring = sr + 3 * ss
        draw.ellipse(
            (scx - ring, scy - ring, scx + ring, scy + ring),
            outline=(255, 255, 255, 220),
            width=max(1, ss),
        )


def render_live_frame(
    background: Image.Image,
    gsi_allplayers: dict[str, Any],
    transform: RadarTransform,
    *,
    pov_steamid: Optional[str] = None,
    pov_team: Optional[str] = None,
    color_map: Optional[dict[str, int]] = None,
    circle_mask: Optional[Image.Image] = None,
) -> Image.Image:
    """
    Draw player dots on a copy of the pre-rendered background.
    Only draws POV's teammates; enemies are filtered out.

    pov_team: pass a pre-determined stable team ("CT" / "T") to avoid
              per-frame instability when the POV player is missing from
              a snapshot.  If None, it is derived from gsi_allplayers.

    Returns canvas_size×canvas_size RGBA image.
    """
    size = transform.canvas_size
    if circle_mask is None:
        circle_mask = _circle_mask(size, padding=1)

    # ── 确定 POV 所在队伍，用于过滤敌方 ──
    # 优先使用调用方传入的稳定值；仅在未提供时才从快照推断
    if pov_team is None:
        if pov_steamid and pov_steamid in gsi_allplayers:
            pov_team = str(gsi_allplayers[pov_steamid].get("team") or "").strip().upper() or None
        if pov_team is None:
            # 找不到 POV → 回退：取第一个有效玩家的队伍
            for _sid, _pdata in gsi_allplayers.items():
                if not isinstance(_pdata, dict):
                    continue
                t = str(_pdata.get("team") or "").strip().upper()
                if t in ("CT", "T"):
                    pov_team = t
                    break

    # ── 超采样画布 ──
    big = size * _SS
    dot_layer_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(dot_layer_big)

    # Sort: non-POV first, POV last (on top)
    entries = sorted(
        gsi_allplayers.items(),
        key=lambda kv: (1 if kv[0] == pov_steamid else 0),
    )

    for steamid, pdata in entries:
        if not isinstance(pdata, dict):
            continue

        # 过滤敌方
        p_team = str(pdata.get("team") or "").strip().upper()
        if pov_team and p_team and p_team != pov_team:
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

        # 颜色：color_map 由调用方从 demo 文件精确解析后传入
        #       key = steamid (str), value = player_color index 0-4
        #       0=蓝 1=绿 2=黄 3=橙 4=紫
        if is_alive:
            idx = (color_map or {}).get(str(steamid), 0)
            hex_color = _SLOT_COLORS_HEX[idx % len(_SLOT_COLORS_HEX)]
        else:
            hex_color = _DEAD_COLOR_HEX

        alpha = 255 if is_alive else 90

        cx, cy = transform.world_to_canvas(wx, wy)

        radius = _DOT_RADIUS_POV if is_pov else (_DOT_RADIUS_ALIVE if is_alive else _DOT_RADIUS_DEAD)
        fill = _hex_to_rgba(hex_color, alpha)

        _draw_dot_ss(draw, cx, cy, radius, fill, ss=_SS, pov_ring=(is_pov and is_alive))

    # ── 超采样缩回原始尺寸（LANCZOS 自带 AA）──
    try:
        dot_layer = dot_layer_big.resize((size, size), Image.Resampling.LANCZOS)
    except AttributeError:
        dot_layer = dot_layer_big.resize((size, size), Image.LANCZOS)  # type: ignore

    # ── 裁掉超出地图圆边界的玩家点，合成到背景 ──
    clipped_dots = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped_dots.paste(dot_layer, (0, 0), circle_mask)

    result = background.copy()
    result.alpha_composite(clipped_dots, (0, 0))
    return result
