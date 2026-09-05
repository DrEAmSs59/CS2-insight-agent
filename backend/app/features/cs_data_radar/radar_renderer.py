"""cs数据图 雷达图渲染器 — 用 Pillow 复刻 Rock-Radar-main 的绘制设计。

设计要点（对齐 Rock-Radar-main/index.html）：
- 1600×1600 画布，深色渐变背景 + 主题色粒子（确定性伪随机）；
- 5 圈六边形网格 + 6 条轴线，最外层网格线加强；
- 雷达多边形：主题色填充 + 多层霓虹描边（辉光）；
- 每个维度显示名称 + 数值（Rajdhani 字体），支持百分数格式化；
- 右侧信息面板：玩家名、头像/占位、标题「CS数据图」；
- 新增需求：雷达中心绘制**小的红色六边形**，半径 = 六维归一化平均值，
  内部标注 AVG 均值；底部展示六维数据构成。
"""

from __future__ import annotations

import hashlib
import math
import random
from pathlib import Path
from typing import Any, Optional

from PIL import Image, ImageDraw, ImageFilter, ImageFont  # type: ignore[import]

from .radar_model import (
    RADAR_DIMENSIONS,
    average_radar_value,
    format_radar_value,
    normalize_radar_values,
)

# ─── 画布与字体常量（16:9 左右分割构图）────────────────────────────
CANVAS_W = 2560
CANVAS_H = 1440
RADAR_CENTER = (640, 730)  # 雷达：左半部正中央
MAX_R = 400  # 蓝色外圈（最高刻度）半径；溢出上限 1.6 → 640px 仍留在画布内
GRID_LEVELS = 5
GRID_LINE_WIDTH = 3
GRID_LINE_OPACITY = 0.2
VERTEX_COUNT = 6
LABEL_MARGIN = 54
LABEL_FONT_SIZE = 46
SCORE_FONT_SIZE = 40

# 右半部人物肖像
PORTRAIT_CENTER = (1890, 600)
PORTRAIT_SIZE = 640

GOLD = (255, 201, 92)
GOLD_STRONG = (255, 214, 120)

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent.parent  # backend/
_FONTS_DIR = _BACKEND_DIR / "assets" / "fonts"
_RAJDHANI_BOLD = _FONTS_DIR / "Rajdhani-Bold.ttf"
_RAJDHANI_SEMI = _FONTS_DIR / "Rajdhani-SemiBold.ttf"
_NOTO_MEDIUM = _FONTS_DIR / "NotoSansSC-Medium.ttf"

# Rock-Radar-main 的 20 套主题色 (color, bg1, bg2)
COLOR_PRESETS: list[tuple[str, str, str]] = [
    ("#00ffff", "#001a1a", "#000d0d"),
    ("#ff00ff", "#1a001a", "#0d000d"),
    ("#ffff00", "#1a1a00", "#0d0d00"),
    ("#00ff00", "#001a00", "#000d00"),
    ("#ff4500", "#1a0700", "#0d0300"),
    ("#1e90ff", "#000f1a", "#00070d"),
    ("#ff0040", "#1a0006", "#0d0003"),
    ("#7cfc00", "#0c1a00", "#060d00"),
    ("#ba55d3", "#13091a", "#09040d"),
    ("#40e0d0", "#061a18", "#030d0c"),
    ("#f08080", "#1a0e0e", "#0d0707"),
    ("#00fa9a", "#001a10", "#000d08"),
    ("#ff8c00", "#1a0e00", "#0d0700"),
    ("#9370db", "#0f0b1a", "#07050d"),
    ("#00ced1", "#00151a", "#000a0d"),
    ("#ff1493", "#1a0210", "#0d0108"),
    ("#adff2f", "#111a03", "#080d01"),
    ("#b0c4de", "#12141a", "#090a0d"),
    ("#eea2ad", "#1a1112", "#0d0809"),
    ("#00bfff", "#00131a", "#00090d"),
]

RED_HEX_COLOR = "#ff3b3b"  # 全场平均线（红色六边形）
BLUE_OUTER_COLOR = "#3ea6ff"  # 最外圈最高刻度（发亮蓝色描线）
GRID_GRAY = (150, 160, 175)  # 内圈等级区间（灰色线条）


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _hex_to_rgba(hex_color: str, alpha: float) -> tuple[int, int, int, int]:
    r, g, b = _hex_to_rgb(hex_color)
    return (r, g, b, int(round(255 * max(0.0, min(1.0, alpha)))))


def _lerp_color(c1: str, c2: str, t: float) -> str:
    a = _hex_to_rgb(c1)
    b = _hex_to_rgb(c2)
    rgb = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _theme_for_player(player_name: str, team_key: Any = None) -> tuple[str, str, str]:
    """按队伍或名字哈希确定性选择主题色。"""
    if team_key is not None:
        team = str(team_key).strip().lower()
        if team in {"2", "t", "terrorist", "terrorists"}:
            return COLOR_PRESETS[12]  # 深橙
        if team in {"3", "ct", "counter_terrorist", "counter-terrorists"}:
            return COLOR_PRESETS[15]  # 深粉
    digest = hashlib.md5(str(player_name or "player").encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % len(COLOR_PRESETS)
    return COLOR_PRESETS[idx]


def _load_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(str(path), size)
    except Exception:
        try:
            return ImageFont.truetype(str(_RAJDHANI_BOLD), size)
        except Exception:
            return ImageFont.load_default()


def _font_latin(size: int) -> ImageFont.FreeTypeFont:
    return _load_font(_RAJDHANI_BOLD, size)


def _font_latin_semi(size: int) -> ImageFont.FreeTypeFont:
    return _load_font(_RAJDHANI_SEMI, size)


def _font_cjk(size: int) -> ImageFont.FreeTypeFont:
    return _load_font(_NOTO_MEDIUM, size)


def _text_size(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int]:
    try:
        bbox = font.getbbox(text)
        return (max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1]))
    except Exception:
        return (len(text) * 8, font.size or 16)


def _hex_vertices(cx: float, cy: float, radius: float, rotation_deg: float = -90.0) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in range(VERTEX_COUNT):
        angle = (i * (360.0 / VERTEX_COUNT) + rotation_deg) * math.pi / 180.0
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return pts


def _draw_gradient_bg(canvas: Image.Image, color: str, bg1: str, bg2: str) -> None:
    """垂直渐变背景（与 Rock-Radar 的 linear-gradient(135deg…) 近似）。"""
    w, h = canvas.size
    top = _hex_to_rgb(bg1)
    bottom = _hex_to_rgb(bg2)
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw = ImageDraw.Draw(canvas)
        draw.line([(0, y), (w, y)], fill=(r, g, b))


def _build_ambient_layer(color: str) -> Image.Image:
    """一次性构建「氛围层」：径向暗角 + 主题色中心霓虹 + 斜向光束 + 扫描线。

    静态卡与动画帧共用，避免每帧重复构建；让画面有明确的纵深、
    光感与「广播级」质感。按 16:9 画布构建（暗角呈椭圆状）。
    """
    small = 256
    rgb = _hex_to_rgb(color)
    w, h = CANVAS_W, CANVAS_H

    # 1) 径向暗角：中心通透 → 四角明显加深（拉伸到 16:9 后呈椭圆暗角）
    mask = Image.new("L", (small, small), 0)
    md = ImageDraw.Draw(mask)
    steps = 72
    for i in range(steps):
        r = (small // 2) * ((i + 1) / steps)
        alpha = int(235 * (i / steps) ** 1.35)
        md.ellipse([small // 2 - r, small // 2 - r, small // 2 + r, small // 2 + r], fill=alpha)
    mask = mask.resize((w, h), Image.BILINEAR)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    layer.putalpha(mask)

    # 2) 主题色中心霓虹（更亮、范围更大）
    glow = Image.new("RGBA", (small, small), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    steps = 56
    for i in range(steps):
        r = (small // 2) * (0.86 * (1 - i / steps))
        a = int(100 * ((steps - i) / steps) ** 1.7)
        gd.ellipse([small // 2 - r, small // 2 - r, small // 2 + r, small // 2 + r], fill=(*rgb, a))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=small * 0.07))
    glow = glow.resize((w, h), Image.BILINEAR)
    layer.alpha_composite(glow)

    # 3) 斜向暖光光束（左上角光漏，低透明度）
    beam = Image.new("L", (small, small), 0)
    bd = ImageDraw.Draw(beam)
    for i in range(small):
        alpha = int(66 * (1 - i / small) ** 1.5)
        bd.line([(0, i), (small, i)], fill=alpha)
    beam = beam.resize((w, h), Image.BILINEAR).rotate(16, resample=Image.BILINEAR)
    light = Image.new("RGBA", (w, h), (255, 246, 224, 0))
    light.putalpha(beam)
    layer.alpha_composite(light)

    # 4) 极淡扫描线纹理（CRT 质感）
    scan = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scan)
    for y in range(0, h, 6):
        sd.line([(0, y), (w, y)], fill=(255, 255, 255, 5), width=1)
    layer.alpha_composite(scan)

    return layer


def _build_starfield_web() -> Image.Image:
    """「立体星空」几何网 + 发光几何牢笼边框（金色节点与射线，一次性构建）。

    深灰偏黑背景之上：正交网格的金色发光节点 + 射线连接成网，
    四边构成发光牢笼（边框线 + 角节点 + 刻度点）。
    """
    w, h = CANVAS_W, CANVAS_H
    rng = random.Random(hashlib.md5("cs2-starfield".encode("utf-8")).hexdigest())
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # 网格节点（间距 ~200），节点间细金线连接成网
    gap = 200
    nodes: list[tuple[int, int]] = []
    for gy in range(gap // 2, h, gap):
        for gx in range(gap // 2, w, gap):
            jitter_x = int(rng.uniform(-14, 14))
            jitter_y = int(rng.uniform(-14, 14))
            nodes.append((min(w - 8, max(8, gx + jitter_x)), min(h - 8, max(8, gy + jitter_y))))
    for i, (ax, ay) in enumerate(nodes):
        for j in range(i + 1, len(nodes)):
            bx, by = nodes[j]
            if abs(ax - bx) <= gap + 30 and abs(ay - by) <= gap + 30 and (ax != bx or ay != by):
                a = int(rng.uniform(12, 26))
                draw.line([(ax, ay), (bx, by)], fill=(*GOLD, a), width=1)
    # 节点光点
    for (nx, ny) in nodes:
        r0 = rng.uniform(1.2, 3.0)
        a0 = rng.uniform(0.25, 0.8)
        draw.ellipse([nx - r0 * 3, ny - r0 * 3, nx + r0 * 3, ny + r0 * 3], fill=(*GOLD, int(round(60 * a0))))
        draw.ellipse([nx - r0, ny - r0, nx + r0, ny + r0], fill=(255, 255, 255, int(round(220 * a0))))

    # 发光几何牢笼边框：四边线 + 角节点 + 边缘刻度点
    m = 22
    draw.rectangle([m, m, w - m, h - m], outline=(*GOLD, 120), width=2)
    tick = 110
    for x in range(m + tick, w - m, tick):
        for (x0, y0, x1, y1) in ((x, m - 6, x, m + 6), (x, h - m - 6, x, h - m + 6)):
            draw.line([(x0, y0), (x1, y1)], fill=(*GOLD, 90), width=2)
    for y in range(m + tick, h - m, tick):
        for (x0, y0, x1, y1) in ((m - 6, y, m + 6, y), (w - m - 6, y, w - m + 6, y)):
            draw.line([(x0, y0), (x1, y1)], fill=(*GOLD, 90), width=2)
    for (cx0, cy0) in ((m, m), (w - m, m), (m, h - m), (w - m, h - m)):
        draw.ellipse([cx0 - 7, cy0 - 7, cx0 + 7, cy0 + 7], outline=(*GOLD, 200), width=2)
        draw.ellipse([cx0 - 2, cy0 - 2, cx0 + 2, cy0 + 2], fill=(255, 255, 255, 200))

    # 边框辉光
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rectangle([m, m, w - m, h - m], outline=(*GOLD, 130), width=5)
    canvas_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas_layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=18)))
    canvas_layer.alpha_composite(layer)
    return canvas_layer


def _draw_cncs_watermark(canvas: Image.Image) -> None:
    """雷达背后：巨大的半透明暗色 CNCS 背景水印。"""
    f = _font_latin(520)
    text = "CNCS"
    tw, th = _text_size(f, text)
    cx, cy = RADAR_CENTER
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.text((cx - tw // 2, cy - th // 2), text, font=f, fill=(46, 48, 62, 150), anchor="mm" if False else None)
    # 上面用 bbox 定位，直接 center 锚点更稳
    draw.text((cx, cy), text, font=f, fill=(46, 48, 62, 150), anchor="mm")


def _draw_connection_line(canvas: Image.Image, color: str) -> None:
    """左右分割的连接：雷达右侧边缘 → 人物肖像左侧的暗金色线条。"""
    draw = ImageDraw.Draw(canvas, "RGBA")
    y = 730
    x0, x1 = RADAR_CENTER[0] + MAX_R + 70, PORTRAIT_CENTER[0] - PORTRAIT_SIZE // 2 - 40
    draw.line([(x0, y), (x1, y)], fill=(*GOLD, 34), width=2)
    draw.line([(x0, y - 1), (x1, y - 1)], fill=(255, 255, 255, 12), width=1)
    mx = (x0 + x1) // 2
    draw.ellipse([mx - 5, y - 5, mx + 5, y + 5], outline=(*GOLD, 130), width=2)
    draw.ellipse([mx - 1, y - 1, mx + 1, y + 1], fill=(255, 255, 255, 160))


def _draw_particles(canvas: Image.Image, color: str, seed_text: str) -> None:
    """静态粒子点缀：与 Rock-Radar 粒子层视觉一致的确定性伪随机分布。"""
    rng = random.Random(hashlib.md5(f"cs-data-radar:{seed_text}".encode("utf-8")).hexdigest())
    w, h = canvas.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for _ in range(42):
        x = rng.uniform(0, w)
        y = rng.uniform(0, h)
        size = rng.uniform(1.0, 2.6)
        alpha = rng.uniform(0.08, 0.4)
        grad = rng.uniform(18, 46)
        draw.ellipse(
            [x - grad, y - grad, x + grad, y + grad],
            fill=_hex_to_rgba(color, alpha * 0.35),
        )
        draw.ellipse(
            [x - size, y - size, x + size, y + size],
            fill=(255, 255, 255, int(round(255 * alpha))),
        )
    layer = layer.filter(ImageFilter.GaussianBlur(radius=2))
    canvas.alpha_composite(layer)


def _draw_grid_and_axes(canvas: Image.Image, color: str) -> None:
    """网格：最外圈 = 最高刻度（发亮蓝色描线），内圈灰色线条 = 等级区间。"""
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx, cy = RADAR_CENTER
    for layer in range(1, GRID_LEVELS + 1):
        r = (layer / GRID_LEVELS) * MAX_R
        pts = _hex_vertices(cx, cy, r)
        if layer == GRID_LEVELS:
            # 蓝色辉光描边（最高刻度）
            glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            gdraw = ImageDraw.Draw(glow)
            gdraw.line([*pts, pts[0]], fill=_hex_to_rgba(BLUE_OUTER_COLOR, 1.0), width=5, joint="curve")
            canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=14)))
            canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=6)))
            draw.line([*pts, pts[0]], fill=_hex_to_rgba(BLUE_OUTER_COLOR, 1.0), width=3, joint="curve")
        else:
            # 内层灰色等级区间线
            draw.line(
                [*pts, pts[0]],
                fill=(*GRID_GRAY, int(round(255 * GRID_LINE_OPACITY * 1.3))),
                width=GRID_LINE_WIDTH,
                joint="curve",
            )
    for i in range(VERTEX_COUNT):
        x1, y1 = _hex_vertices(cx, cy, MAX_R)[i]
        draw.line([(cx, cy), (x1, y1)], fill=(*GRID_GRAY, int(round(255 * GRID_LINE_OPACITY))), width=2)


def _glow_polygon(canvas: Image.Image, color: str, values: list[float]) -> None:
    """玩家实际数据多边形：主题色（青蓝=CT / 橙红=T）填充 + 多层霓虹辉光描边。"""
    cx, cy = RADAR_CENTER
    pts: list[tuple[float, float]] = []
    for i, norm in enumerate(values):
        # 超过满分刻度的顶点允许溢出到蓝色外圈之外（上限 1.6）
        r = max(0.0, min(1.6, norm)) * MAX_R
        pts.append(_hex_vertices(cx, cy, r)[i])

    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # 基础填充
    draw.polygon(pts, fill=_hex_to_rgba(color, 0.25))

    # 辉光描边：独立图层画线再模糊叠加
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.line([*pts, pts[0]], fill=_hex_to_rgba(color, 0.95), width=6, joint="curve")
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=22)))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=9)))

    # 主体描边：主题色 → 白色高能射线
    draw.line([*pts, pts[0]], fill=_hex_to_rgba(color, 1.0), width=4, joint="curve")
    canvas.alpha_composite(layer)
    core = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(core)
    cdraw.line([*pts, pts[0]], fill=(255, 255, 255, 235), width=2, joint="curve")
    canvas.alpha_composite(core)


def _format_max_value(dim: dict[str, Any]) -> str:
    """蓝色外圈（最高刻度）满分数值的展示文本。"""
    if dim["percentage"]:
        return f"{int(round(float(dim['max_score']) * 100))}%"
    key = str(dim["key"])
    digits = 2 if key in {"kpr", "rating"} else (1 if key == "adr" else 0)
    return f"{float(dim['max_score']):.{digits}f}"


def _draw_labels(canvas: Image.Image, color: str, radar: dict[str, Any]) -> None:
    """每个维度显示：名称 + 玩家数值（主题色），并在最外圈标注满分数值（最高刻度）。"""
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx, cy = RADAR_CENTER
    f_name = _font_latin(LABEL_FONT_SIZE)
    f_score = _font_latin_semi(SCORE_FONT_SIZE)
    f_max = _font_cjk(26)  # 「满分」为中文，必须用 CJK 字体（Rajdhani 无中文字形）
    for i, dim in enumerate(RADAR_DIMENSIONS):
        angle = (i * (360.0 / VERTEX_COUNT) - 90.0) * math.pi / 180.0
        cos_a = math.cos(angle)
        x = cx + (MAX_R + LABEL_MARGIN) * cos_a
        y = cy + (MAX_R + LABEL_MARGIN) * math.sin(angle)
        if abs(cos_a) < 0.1:
            anchor_x = "mm"
        elif cos_a > 0:
            anchor_x = "lm"
        else:
            anchor_x = "rm"
        name = dim["name"]
        value = format_radar_value(dim["key"], radar.get(dim["key"], 0.0))
        # 名称
        nw, nh = _text_size(f_name, name)
        draw.text((x, y - 16), name, font=f_name, fill=(255, 255, 255, 235), anchor=anchor_x)
        # 玩家数值（主题色，与数据多边形呼应）
        vw, vh = _text_size(f_score, value)
        draw.text((x, y + 16), value, font=f_score, fill=_hex_to_rgba(color, 0.95), anchor=anchor_x)
        # 蓝色外圈满分数值（最高刻度标注）
        max_text = f"满分 {_format_max_value(dim)}"
        draw.text((x, y + 40), max_text, font=f_max, fill=(210, 220, 235, 150), anchor=anchor_x)


def _draw_match_avg_reference(
    canvas: Image.Image,
    radar: dict[str, Any],
    match_avg_radar: Optional[dict[str, Any]] = None,
    alpha: float = 1.0,
) -> None:
    """全场平均线：红色六边形（每个顶点 = 该维度全场平均值）。

    - 有全场均值（match_avg_radar）时：按维度绘制不规则红色六边形；
    - 无全场均值（单卡兜底）时：以小六边形展示该玩家六维归一化平均值。
    内部标注 AVG 数值与「全场均值」说明。alpha∈[0,1] 控制整体淡入。
    """
    a = max(0.0, min(1.0, float(alpha)))
    if a <= 0.01:
        return
    cx, cy = RADAR_CENTER
    if match_avg_radar:
        values = normalize_radar_values(match_avg_radar)
        pts: list[tuple[float, float]] = []
        for i, norm in enumerate(values):
            r = max(0.0, min(1.6, norm)) * MAX_R
            pts.append(_hex_vertices(cx, cy, r)[i])
        avg = round(sum(values) / max(1, len(values)), 3)
    else:
        avg = average_radar_value(radar)
        radius = max(46.0, avg * MAX_R * 0.55)
        pts = _hex_vertices(cx, cy, radius)

    # 红色描线 + 辉光（无填充），按 alpha 淡入
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.line([*pts, pts[0]], fill=_hex_to_rgba(RED_HEX_COLOR, 0.9 * a), width=4, joint="curve")
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=12)))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.line([*pts, pts[0]], fill=_hex_to_rgba(RED_HEX_COLOR, 1.0 * a), width=3, joint="curve")
    canvas.alpha_composite(layer)
    canvas.alpha_composite(glow)

    # 内部文字：AVG 数值（白色） + 「全场均值」说明（红色）
    f_avg = _font_latin(40)
    f_tag = _font_cjk(24)
    draw = ImageDraw.Draw(canvas, "RGBA")
    avg_text = f"{avg:.2f}"
    draw.text((cx, cy - 10), avg_text, font=f_avg, fill=(255, 255, 255, int(round(235 * a))), anchor="mm")
    tag = "全场均值" if match_avg_radar else "AVG"
    draw.text((cx, cy + 26), tag, font=f_tag, fill=_hex_to_rgba(RED_HEX_COLOR, 0.95 * a), anchor="mm")


def _draw_team_logo_backdrop(canvas: Image.Image, logo_path: Path, cx: float, cy: float) -> None:
    """把队伍标志放大显示在头像后面：圆形裁切 + 径向羽化 + 模糊 + 半透明。

    - 直径约为头像的 1.8 倍，营造「队徽衬底」效果；
    - 边缘径向羽化（中心清晰 → 边缘淡出），叠加高斯模糊，避免生硬边界；
    - 整体低透明度，不抢头像主体。
    """
    try:
        source = Image.open(str(logo_path)).convert("RGBA")
    except Exception:
        return
    diameter = int(PORTRAIT_SIZE * 1.8)
    source = source.resize((diameter, diameter), Image.LANCZOS)

    # 径向羽化蒙版：中心 255 → 边缘 0（带一点柔边）
    mask = Image.new("L", (diameter, diameter), 0)
    md = ImageDraw.Draw(mask)
    r = diameter // 2
    steps = 80
    for i in range(steps):
        radius = r * (1 - i / steps) * 0.995
        alpha = int(255 * ((steps - i) / steps) ** 0.55)
        md.ellipse([r - radius, r - radius, r + radius, r + radius], fill=alpha)

    backdrop = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    backdrop.paste(source, (int(cx) - r, int(cy) - r), mask)
    backdrop = backdrop.filter(ImageFilter.GaussianBlur(radius=7))
    # 整体透明度 ~0.4（带轻微发光感）
    backdrop.putalpha(backdrop.getchannel("A").point(lambda a: int(a * 0.4)))
    canvas.alpha_composite(backdrop)


def _draw_portrait(
    canvas: Image.Image,
    portrait_path: Optional[Path],
    player_name: str,
    color: str,
    team_logo_path: Optional[Path] = None,
) -> None:
    """右半部大肖像：上传图片 → 圆形裁剪（金圈）；否则昵称首字占位。

    队伍标志（team_logo_path）会放大显示在头像后面：圆形裁切 + 径向羽化 +
    轻微模糊 + 半透明，作为衬托在头像背后浮现。
    """
    cx, cy = PORTRAIT_CENTER
    size = PORTRAIT_SIZE
    box = (cx - size // 2, cy - size // 2, cx + size // 2, cy + size // 2)

    if team_logo_path is not None and Path(team_logo_path).is_file():
        _draw_team_logo_backdrop(canvas, team_logo_path, cx, cy)

    avatar = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([0, 0, size - 1, size - 1], fill=255)

    source: Image.Image
    if portrait_path is not None and Path(portrait_path).is_file():
        try:
            source = Image.open(str(portrait_path)).convert("RGBA")
            source = source.resize((size, size), Image.LANCZOS)
        except Exception:
            source = None
    else:
        source = None

    if source is not None:
        avatar.paste(source, box, mask)
    else:
        initial = (str(player_name or "?").strip()[:1] or "?").upper()
        draw = ImageDraw.Draw(avatar)
        draw.ellipse(box, fill=_hex_to_rgba(color, 0.16))
        draw.ellipse(box, outline=_hex_to_rgba(color, 0.85), width=8)
        f_initial = _font_latin(300)
        draw.text((cx, cy), initial, font=f_initial, fill=(255, 255, 255, 235), anchor="mm")
    canvas.alpha_composite(avatar)

    # 金色光环
    ring = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    radius = size // 2 + 12
    rd.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=(*GOLD, 150), width=3)
    canvas.alpha_composite(ring.filter(ImageFilter.GaussianBlur(radius=6)))
    canvas.alpha_composite(ring)


def _draw_right_info(
    canvas: Image.Image,
    *,
    color: str,
    player_name: str,
    radar: dict[str, Any],
    team_label: str,
) -> None:
    """右半部信息：标题「CS数据图」、玩家名、队伍、六维构成（肖像下方）。"""
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx = PORTRAIT_CENTER[0]
    left = PORTRAIT_CENTER[0] - PORTRAIT_SIZE // 2 - 60

    # 标题「CS数据图」
    f_title = _font_cjk(64)
    draw.text((cx, 110), "CS数据图", font=f_title, fill=(255, 255, 255, 200), anchor="mm")

    # 玩家名（主题色，带辉光）
    f_name = _font_latin(96)
    name_y = PORTRAIT_CENTER[1] + PORTRAIT_SIZE // 2 + 80
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.text((cx, name_y), player_name, font=f_name, fill=_hex_to_rgba(color, 0.9), anchor="mm")
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=16)))
    draw.text((cx, name_y), player_name, font=f_name, fill=_hex_to_rgba(color, 1.0), anchor="mm")

    # 队伍标签
    if team_label:
        f_team = _font_cjk(40)
        draw.text((cx, name_y + 78), team_label, font=f_team, fill=(255, 255, 255, 150), anchor="mm")

    # 六维构成（右半部底部横条）
    f_stat = _font_latin_semi(40)
    stat_parts: list[str] = []
    for dim in RADAR_DIMENSIONS:
        stat_parts.append(f"{dim['name']} {format_radar_value(dim['key'], radar.get(dim['key'], 0.0))}")
    stat_line = "   ·   ".join(stat_parts)
    max_w = CANVAS_W - left - 40
    lines: list[str] = []
    current = ""
    for token in stat_line.split("  ·  "):
        candidate = (current + "  ·  " + token).strip() if current else token
        cw, _ = _text_size(f_stat, candidate)
        if cw > max_w and current:
            lines.append(current)
            current = token
        else:
            current = candidate
    if current:
        lines.append(current)
    line_h = 52
    stat_y = CANVAS_H - 96 - (len(lines) - 1) * line_h
    for line in lines:
        draw.text((cx, stat_y), line, font=f_stat, fill=(255, 255, 255, 205), anchor="mm")
        stat_y += line_h


def render_radar_card(
    *,
    player_name: str,
    radar: dict[str, Any],
    out_path: Path,
    portrait_path: Optional[Path] = None,
    team_logo_path: Optional[Path] = None,
    team_key: Any = None,
    team_label: str = "",
    theme_color: Optional[str] = None,
    theme_bg1: Optional[str] = None,
    theme_bg2: Optional[str] = None,
    match_avg_radar: Optional[dict[str, Any]] = None,
) -> Path:
    """渲染一张 2560×1440（16:9）的 cs数据图 雷达卡片 PNG。

    构图（左右分割式）：左半部 = 雷达数据面板（雷达正中央 + 背后 CNCS 水印），
    右半部 = 人物大肖像（垂直中线偏右）；深灰偏黑底 + 金色节点射线「立体星空」网，
    四边发光几何牢笼，左右以暗金色线条连接。队伍标志放大显示在头像后面。
    """
    color, bg1, bg2 = (
        (theme_color, theme_bg1, theme_bg2)
        if theme_color and theme_bg1 and theme_bg2
        else _theme_for_player(player_name, team_key)
    )

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 255))
    # 深灰偏黑基础色调（16:9）
    for y in range(CANVAS_H):
        t = y / max(1, CANVAS_H - 1)
        v = int(17 + (8 - 17) * t)
        ImageDraw.Draw(canvas).line([(0, y), (CANVAS_W, y)], fill=(v, v, v + 4))
    canvas.alpha_composite(_build_ambient_layer(color))
    canvas.alpha_composite(_build_starfield_web())
    _draw_cncs_watermark(canvas)
    _draw_connection_line(canvas, color)
    _draw_grid_and_axes(canvas, color)
    values = normalize_radar_values(radar)
    _glow_polygon(canvas, color, values)
    _draw_labels(canvas, color, radar)
    _draw_match_avg_reference(canvas, radar, match_avg_radar)
    _draw_portrait(canvas, portrait_path, player_name, color, team_logo_path=team_logo_path)
    _draw_right_info(
        canvas,
        color=color,
        player_name=player_name,
        radar=radar,
        team_label=team_label,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    rgb = canvas.convert("RGB")
    rgb.save(str(out_path), format="PNG")
    return out_path
