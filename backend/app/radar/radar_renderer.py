from __future__ import annotations

import io
import logging
import os
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")  # 无头模式，必须在 pyplot import 之前
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

# CS2 5 槽位颜色（与游戏内 player_color 0-4 对应，matplotlib hex 格式）
_SLOT_COLORS_HEX = [
    "#569CFF",  # 0: 蓝
    "#58D68D",  # 1: 绿
    "#FFDD57",  # 2: 黄
    "#FF912D",  # 3: 橙
    "#B878FF",  # 4: 紫
]
_DEAD_COLOR_HEX = "#808080"
CIRCLE_BORDER_COLOR = (80, 230, 120, 230)


# ---------------------------------------------------------------------------
# 确保 awpy 地图资源存在
# ---------------------------------------------------------------------------

def _ensure_awpy_maps() -> None:
    """若 awpy 地图文件夹为空则自动触发下载。"""
    try:
        from awpy.data import MAPS_DIR
        if not MAPS_DIR.exists() or not any(MAPS_DIR.glob("*.png")):
            logger.info("awpy 地图资源不存在，正在下载…")
            import subprocess, sys
            subprocess.run(
                [sys.executable, "-m", "awpy", "get", "maps"],
                check=True,
                timeout=120,
            )
            logger.info("awpy 地图资源下载完成")
    except Exception as exc:
        logger.warning("awpy 地图资源检查/下载失败（首次使用请手动运行 `awpy get maps`）: %s", exc)


# ---------------------------------------------------------------------------
# 圆形边框工具（PIL 实现，保留高质量 AA）
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
    background_color: tuple[int, int, int, int] = (0, 0, 0, 200),
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

def _player_color_hex(player: dict[str, Any], color_index: int) -> str:
    slot = player.get("slot_color_index", -1)
    if isinstance(slot, int) and 0 <= slot < len(_SLOT_COLORS_HEX):
        return _SLOT_COLORS_HEX[slot]
    return _SLOT_COLORS_HEX[color_index % len(_SLOT_COLORS_HEX)]


def _build_color_indices(players: list[dict[str, Any]]) -> dict[str, int]:
    ids: list[str] = []
    for p in players:
        sid = str(p.get("steamid64") or p.get("steamid") or p.get("name") or "")
        if sid and sid not in ids:
            ids.append(sid)
    return {sid: idx for idx, sid in enumerate(ids)}


# ---------------------------------------------------------------------------
# awpy 单帧渲染 → PIL Image
# ---------------------------------------------------------------------------

def _render_frame_awpy(
    map_name: str,
    players: list[dict[str, Any]],
    color_idx_by_id: dict[str, int],
    output_size: int,
) -> Image.Image | None:
    from awpy.plot import plot as awpy_plot  # lazy import

    points: list[tuple[float, float, float]] = []
    point_settings: list[dict[str, Any]] = []

    for player in players:
        try:
            x = float(player["x"])
            y = float(player["y"])
            z = float(player.get("z", 0.0))
        except (KeyError, TypeError, ValueError):
            continue

        is_alive = bool(player.get("is_alive", True))
        is_pov = bool(player.get("is_pov", False))

        sid = str(player.get("steamid64") or player.get("steamid") or player.get("name") or "")
        ci = color_idx_by_id.get(sid, 0)
        color = _player_color_hex(player, ci) if is_alive else _DEAD_COLOR_HEX

        points.append((x, y, z))
        # 不传 hp/armor/direction —— 避免 awpy 内部 NoneType 崩溃，
        # 也避免显示 HP/armor 条（minimap 上不需要）。
        # direction=None 时 awpy 不会检查 hp，所以安全。
        point_settings.append(
            {
                "marker": "o",
                "color": color,
                "size": 10 if is_pov else 7,
                "alpha": 1.0 if is_alive else 0.35,
            }
        )

    if not points:
        return None

    try:
        fig, _ax = awpy_plot(
            map_name,
            points,
            point_settings=point_settings,
        )
    except FileNotFoundError:
        raise
    except Exception as exc:
        import traceback
        logger.warning("awpy plot error [map=%s points=%d]: %s\n%s",
                       map_name, len(points), exc, traceback.format_exc())
        plt.close("all")
        return None

    buf = io.BytesIO()
    try:
        fig.savefig(buf, format="png", facecolor="black", dpi=100)
    except Exception as exc:
        logger.warning("fig.savefig error: %s", exc)
        plt.close(fig)
        return None
    finally:
        plt.close(fig)

    buf.seek(0)
    img = Image.open(buf).copy()
    img = img.convert("RGBA")

    try:
        img = img.resize((output_size, output_size), Image.Resampling.LANCZOS)
    except AttributeError:
        img = img.resize((output_size, output_size), Image.LANCZOS)  # type: ignore[attr-defined]

    return img


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
    pov_rotate: bool = False,       # awpy 暂不支持旋转，参数保留兼容
    pov_zoom: float = 0.0,          # 同上
    center_y_ratio: float = 0.5,    # 同上
    circular_frame: bool = True,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    _ensure_awpy_maps()

    # awpy 地图名格式：de_dust2、cs_office 等（小写，带前缀）
    map_key = map_name.lower().strip()
    if not map_key.startswith(("de_", "cs_", "ar_", "gg_", "dm_", "mm_")):
        map_key = "de_" + map_key

    outputs: list[Path] = []
    last_img: Image.Image | None = None

    for frame_idx, frame in enumerate(timeline):
        players = list(frame.get("players", []))
        # POV 最后绘制（在最上层）
        players.sort(key=lambda p: (1 if p.get("is_pov") else 0))
        color_idx_by_id = _build_color_indices(players)

        img: Image.Image | None = None
        try:
            img = _render_frame_awpy(map_key, players, color_idx_by_id, size)
        except FileNotFoundError:
            logger.error(
                "awpy 找不到地图 %s 的雷达图，请先运行: awpy get maps", map_key
            )
            raise RuntimeError(
                f"缺少 awpy 雷达底图: {map_key}。请在后端环境中运行 `python -m awpy get maps`"
            )

        if img is None:
            # 没有玩家数据时复用上一帧
            img = last_img

        if img is None:
            # 彻底没有内容：生成纯黑圆
            img = Image.new("RGBA", (size, size), (0, 0, 0, 200))

        if circular_frame:
            img = _apply_circular_radar_frame(img, size=size)

        last_img = img
        serial = frame_idx + 1
        out = output_dir / f"radar_{serial:06d}.png"
        img.save(out)
        outputs.append(out)

        if frame_idx % 30 == 0:
            logger.debug("雷达帧进度: %d / %d", frame_idx + 1, len(timeline))

    return outputs
