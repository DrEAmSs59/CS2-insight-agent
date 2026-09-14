"""cs数据图 雷达图开场动画 — 慢入→快出→定格，逐帧渲染 + ffmpeg 合成 MP4。

动画节奏（用户确定版）：
- 慢入（Ease-in，0→30%）：个人数据多边形从最小刻度缓速积蓄，金色网格呼吸、
  KPR/Rating 数据点冷白微光、头像金圈脉动、左侧 CNCS 水印金光微闪；
- 快出（Ease-out，30%→60%）：多边形快速扩张到位，各维度数据闪电般从中心
  射向边缘（放射闪光）；
- 定格（60%→100%）：多边形锁定在最终位置（无过冲、无回弹），网格归位，
  红色全场平均线全程可见，数值微光静止。

帧渲染直接复用 radar_renderer 的绘制原语，仅新增动画专属层（金色网格、
闪光、光晕等）。输出 MP4 后由合辑工作台作为动画视频段插入成片。
"""

from __future__ import annotations

import hashlib
import math
import random
import shutil
from pathlib import Path
from typing import Any, Optional

from PIL import Image, ImageDraw, ImageFilter  # type: ignore[import]

from .radar_model import format_radar_value, normalize_radar_values
from .radar_renderer import (
    CANVAS_H,
    CANVAS_W,
    GRID_LINE_OPACITY,
    GRID_LINE_WIDTH,
    GRID_LEVELS,
    LABEL_MARGIN,
    MAX_R,
    PORTRAIT_CENTER,
    PORTRAIT_SIZE,
    RADAR_CENTER,
    VERTEX_COUNT,
    _build_ambient_layer,
    _build_starfield_web,
    _draw_connection_line,
    _draw_cncs_watermark,
    _draw_gradient_bg,
    _draw_match_avg_reference,
    _draw_portrait,
    _draw_right_info,
    _font_cjk,
    _font_latin,
    _font_latin_semi,
    _hex_to_rgba,
    _hex_vertices,
    _text_size,
    _theme_for_player,
)

# ─── 动画参数 ──────────────────────────────────────────────────────
FPS = 24
DURATION = 4.0  # 秒
OUT_WIDTH = 1920  # 输出视频宽度（16:9，2560×1440 渲染后缩放到 1920×1080）

P1_END = 0.30  # 慢入阶段占比（0–1.2s）
P2_END = 0.60  # 快出阶段占比（1.2–2.4s），拍点 = P1_END；之后直接定格（无第三阶段）

GOLD = (255, 201, 92)
GOLD_STRONG = (255, 214, 120)


# ─── 缓动曲线 ─────────────────────────────────────────────────────
def _ease_in(t: float, p: float = 2.5) -> float:
    return t ** p


def _ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def _scale_at(tt: float) -> float:
    """多边形整体缩放系数：慢入 0.30→0.55 → 快出 0.55→1.00 → 定格（无第三阶段/无慢到位）。

    全程单调递增、绝不超过 1.0、无回弹无振荡；快出结束即锁定在数据应有位置上。
    """
    if tt < P1_END:
        p = tt / P1_END
        return 0.30 + 0.25 * _ease_in(p, 2.5)  # 慢入（斜率小）
    if tt < P2_END:
        p = (tt - P1_END) / (P2_END - P1_END)
        return 0.55 + 0.45 * _ease_out_cubic(p)  # 快出（急加速 → 精确 1.00）
    return 1.0  # 定格


def _mesh_alpha(tt: float) -> float:
    """金色网格呼吸（第一阶段），爆发后淡出。"""
    if tt < P1_END:
        return 0.34 + 0.14 * math.sin(tt * 2 * math.pi * 1.6)
    if tt < P2_END:
        p = (tt - P1_END) / (P2_END - P1_END)
        return max(0.0, 0.5 * (1 - p))
    return 0.0


def _final_grid_alpha(tt: float) -> float:
    """最终灰色等级圈 + 蓝色外圈在爆发阶段淡入。"""
    if tt < P1_END:
        return 0.0
    if tt < P2_END:
        p = (tt - P1_END) / (P2_END - P1_END)
        return _ease_out_cubic(p)
    return 1.0


def _flash_energy(tt: float) -> float:
    """拍点（爆发开始）的放射闪光强度：拍点即峰值，随后指数衰减。"""
    if tt < P1_END or tt > P2_END:
        return 0.0
    p = (tt - P1_END) / (P2_END - P1_END)
    return math.exp(-p * 5.0)


def _glimmer(tt: float) -> float:
    """第一阶段核心数据点（KPR / Rating）冷白微光闪烁。"""
    if tt > P1_END:
        return 0.0
    return 0.5 + 0.5 * math.sin(tt * 2 * math.pi * 2.2)


def _avatar_gold(tt: float) -> float:
    """第一阶段右侧头像金色光晕脉动。"""
    if tt > P1_END:
        return 0.0
    return 0.22 + 0.18 * math.sin(tt * 2 * math.pi * 1.9)


def _tremor(tt: float, frame_index: int) -> tuple[float, float]:
    """（已省略第三阶段，无数值震颤）"""
    return (0.0, 0.0)


def _match_avg_alpha(tt: float) -> float:
    """红色全场平均线：全程完全可见（第一帧起即全亮，不淡入、不消失）。"""
    return 1.0


# ─── 动画专属绘制 ────────────────────────────────────────────────
def _draw_gold_mesh(canvas: Image.Image, alpha: float, color: str) -> None:
    """第一阶段的金色网状线：细金线呼吸脉动 + 中心金色柔光（更克制精致）。"""
    if alpha <= 0.01:
        return
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx, cy = RADAR_CENTER
    for layer in range(1, GRID_LEVELS + 1):
        r = (layer / GRID_LEVELS) * MAX_R
        pts = _hex_vertices(cx, cy, r)
        a = int(round(255 * alpha * (0.32 if layer < GRID_LEVELS else 0.48)))
        draw.line([*pts, pts[0]], fill=(*GOLD, a), width=2, joint="curve")
    for i in range(VERTEX_COUNT):
        x1, y1 = _hex_vertices(cx, cy, MAX_R)[i]
        draw.line([(cx, cy), (x1, y1)], fill=(*GOLD, int(round(255 * alpha * 0.22))), width=1)
    # 中心金色柔光（随呼吸脉动）
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - 320, cy - 320, cx + 320, cy + 320], fill=(*GOLD, int(round(55 * alpha))))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=80)))


def _build_corner_brackets() -> Image.Image:
    """广播风四角 HUD 角标（金色细线，静态层一次性构建）。"""
    w, h = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    length, margin, width, a = 120, 42, 3, 46
    corners = [
        (0, 0, 1, 0, 0, 1),
        (w - 1, 0, -1, 0, 0, 1),
        (0, h - 1, 1, 0, 0, -1),
        (w - 1, h - 1, -1, 0, 0, -1),
    ]
    for (bx, by, hx, hy, vx, vy) in corners:
        for t in range(width):
            draw.line([(bx + hx * margin, by + vy * t), (bx + hx * (margin + length), by + vy * t)], fill=(*GOLD_STRONG, a), width=1)
            draw.line([(bx + hx * t, by + vy * margin), (bx + hx * t, by + vy * (margin + length))], fill=(*GOLD_STRONG, a), width=1)
    return layer


def _draw_dust(canvas: Image.Image, tt: float, seed_text: str, color: str, count: int = 34) -> None:
    """缓慢上漂的尘埃粒子（确定性伪随机），增强空间纵深。"""
    rng = random.Random(hashlib.md5(f"anim-dust:{seed_text}".encode("utf-8")).hexdigest())
    w, h = CANVAS_W, CANVAS_H
    draw = ImageDraw.Draw(canvas, "RGBA")
    for i in range(count):
        bx = rng.uniform(0, w)
        by = rng.uniform(0, h)
        speed = rng.uniform(0.05, 0.16)
        radius = rng.uniform(0.9, 2.3)
        alpha = rng.uniform(0.16, 0.38)
        y = (by - tt * speed * h * 0.35) % h
        x = bx + math.sin(tt * math.pi * 2 + i * 1.7) * 14
        draw.ellipse([x - radius * 4, y - radius * 4, x + radius * 4, y + radius * 4], fill=_hex_to_rgba(color, alpha * 0.25))
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=(255, 255, 255, int(round(255 * alpha))))


def _draw_final_grid(canvas: Image.Image, color: str, alpha: float) -> None:
    """最终网格（灰色等级圈 + 发亮蓝色外圈），按 alpha 淡入。"""
    if alpha <= 0.01:
        return
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx, cy = RADAR_CENTER
    for layer in range(1, GRID_LEVELS + 1):
        r = (layer / GRID_LEVELS) * MAX_R
        pts = _hex_vertices(cx, cy, r)
        if layer == GRID_LEVELS:
            a = int(round(255 * alpha))
            glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            gdraw = ImageDraw.Draw(glow)
            gdraw.line([*pts, pts[0]], fill=_hex_to_rgba("#3ea6ff", alpha), width=5, joint="curve")
            canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=14)))
            draw.line([*pts, pts[0]], fill=_hex_to_rgba("#3ea6ff", alpha), width=3, joint="curve")
        else:
            a = int(round(255 * GRID_LINE_OPACITY * 1.3 * alpha))
            draw.line([*pts, pts[0]], fill=(150, 160, 175, a), width=GRID_LINE_WIDTH, joint="curve")
    for i in range(VERTEX_COUNT):
        x1, y1 = _hex_vertices(cx, cy, MAX_R)[i]
        draw.line([(cx, cy), (x1, y1)], fill=(150, 160, 175, int(round(255 * GRID_LINE_OPACITY * alpha))), width=2)


def _draw_animated_polygon(
    canvas: Image.Image,
    color: str,
    values: list[float],
    scale: float,
    energy: float,
) -> list[tuple[float, float]]:
    """主题色数据多边形：按 scale 缩放（爆发过冲/回弹），energy 增强辉光。"""
    cx, cy = RADAR_CENTER
    pts: list[tuple[float, float]] = []
    for i, norm in enumerate(values):
        r = max(0.0, min(1.6, norm)) * MAX_R * max(0.02, scale)
        pts.append(_hex_vertices(cx, cy, r)[i])

    glow_r = int(round(14 + 26 * energy))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.polygon(pts, fill=_hex_to_rgba(color, 0.25))
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.line([*pts, pts[0]], fill=_hex_to_rgba(color, 0.95), width=6, joint="curve")
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=glow_r)))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=max(6, glow_r // 2))))
    draw.line([*pts, pts[0]], fill=_hex_to_rgba(color, 1.0), width=4, joint="curve")
    canvas.alpha_composite(layer)
    core = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(core)
    cdraw.line([*pts, pts[0]], fill=(255, 255, 255, 235), width=2, joint="curve")
    canvas.alpha_composite(core)
    return pts


def _draw_flash_streaks(canvas: Image.Image, color: str, energy: float) -> None:
    """爆发阶段：各维度数据如闪电般从中心射向边缘。"""
    if energy <= 0.01:
        return
    cx, cy = RADAR_CENTER
    draw = ImageDraw.Draw(canvas, "RGBA")
    a = int(round(255 * min(1.0, energy)))
    for i in range(VERTEX_COUNT):
        x1, y1 = _hex_vertices(cx, cy, MAX_R * 1.25)[i]
        # 两段式闪电：中心 → 中段 → 顶点（略带折角）
        mx = cx + (x1 - cx) * 0.55 + (y1 - cy) * 0.06
        my = cy + (y1 - cy) * 0.55 - (x1 - cx) * 0.06
        draw.line([(cx, cy), (mx, my), (x1, y1)], fill=(255, 255, 255, a), width=2)
        draw.line([(cx, cy), (mx, my), (x1, y1)], fill=(*GOLD_STRONG, a), width=5)
    # 中心放射光
    g = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    gd.ellipse([cx - 260, cy - 260, cx + 260, cy + 260], fill=_hex_to_rgba(color, 0.35 * min(1.0, energy)))
    canvas.alpha_composite(g.filter(ImageFilter.GaussianBlur(radius=90)))


def _draw_glimmer_points(canvas: Image.Image, values: list[float], alpha: float) -> None:
    """第一阶段：KPR（顶部）与 Rating（左上）核心数据点冷白微光。"""
    if alpha <= 0.01:
        return
    cx, cy = RADAR_CENTER
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for i in (0, 5):
        norm = values[i]
        r = max(0.0, min(1.6, norm)) * MAX_R
        x, y = _hex_vertices(cx, cy, r)[i]
        draw.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(255, 255, 255, int(round(255 * alpha))))
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius=4)))
    canvas.alpha_composite(layer)


def _draw_avatar_gold_ring(canvas: Image.Image, alpha: float) -> None:
    """第一阶段：右半部人物肖像的金色光晕脉动。"""
    if alpha <= 0.01:
        return
    cx, cy = PORTRAIT_CENTER
    radius = PORTRAIT_SIZE // 2 + 14
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=(*GOLD, int(round(255 * alpha))), width=4)
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius=10)))
    canvas.alpha_composite(layer)


def _draw_watermark(canvas: Image.Image, alpha: float = 1.0) -> None:
    """左侧 CNCS 金色水印（微弱金光）。"""
    f = _font_latin(34)
    draw = ImageDraw.Draw(canvas, "RGBA")
    a = int(round(255 * 0.5 * alpha))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.text((44, 44), "CNCS", font=f, fill=(*GOLD_STRONG, a), anchor="lm")
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius=6)))
    draw.text((44, 44), "CNCS", font=f, fill=(*GOLD_STRONG, a), anchor="lm")


def _draw_animated_labels(
    canvas: Image.Image,
    color: str,
    radar: dict[str, Any],
    tremor: tuple[float, float],
    alpha: float = 1.0,
) -> None:
    """维度名称 + 玩家数值 + 满分数值（第三阶段数值轻微震颤）。"""
    if alpha <= 0.01:
        return
    draw = ImageDraw.Draw(canvas, "RGBA")
    cx, cy = RADAR_CENTER
    f_name = _font_latin(44)
    f_score = _font_latin_semi(38)
    f_max = _font_cjk(28)  # 「满分」为中文，必须用 CJK 字体（Rajdhani 无中文字形）
    tx, ty = tremor
    for i, dim in enumerate(_labels_dims()):
        angle = (i * (360.0 / VERTEX_COUNT) - 90.0) * math.pi / 180.0
        cos_a = math.cos(angle)
        x = cx + (MAX_R + LABEL_MARGIN) * cos_a
        y = cy + (MAX_R + LABEL_MARGIN) * math.sin(angle)
        anchor_x = "mm" if abs(cos_a) < 0.1 else ("lm" if cos_a > 0 else "rm")
        name = str(dim["name"])
        value = format_radar_value(str(dim["key"]), radar.get(str(dim["key"]), 0.0))
        draw.text((x, y - 16), name, font=f_name, fill=(255, 255, 255, int(round(235 * alpha))), anchor=anchor_x)
        draw.text((x + tx, y + 16 + ty), value, font=f_score, fill=_hex_to_rgba(color, 0.95 * alpha), anchor=anchor_x)
        draw.text((x, y + 40), f"满分 {_max_label(dim)}", font=f_max, fill=(210, 220, 235, int(round(150 * alpha))), anchor=anchor_x)


def _labels_dims() -> list[dict[str, Any]]:
    from .radar_model import RADAR_DIMENSIONS

    return RADAR_DIMENSIONS


def _max_label(dim: dict[str, Any]) -> str:
    if dim.get("percentage"):
        return f"{int(round(float(dim['max_score']) * 100))}%"
    key = str(dim.get("key", ""))
    digits = 2 if key in {"kpr", "rating"} else (1 if key == "adr" else 0)
    return f"{float(dim['max_score']):.{digits}f}"


# ─── 帧状态与渲染 ────────────────────────────────────────────────
def compute_frame_state(tt: float, frame_index: int) -> dict[str, Any]:
    return {
        "scale": _scale_at(tt),
        "mesh": _mesh_alpha(tt),
        "final_grid": _final_grid_alpha(tt),
        "flash": _flash_energy(tt),
        "glimmer": _glimmer(tt),
        "avatar_gold": _avatar_gold(tt),
        "tremor": _tremor(tt, frame_index),
        "match_avg": _match_avg_alpha(tt),
        "tt": tt,
    }


def render_animation_frames(
    *,
    player_name: str,
    radar: dict[str, Any],
    match_avg_radar: Optional[dict[str, Any]],
    portrait_path: Optional[Path],
    team_key: Any,
    team_label: str,
    team_logo_path: Optional[Path] = None,
    out_dir: Path,
    fps: int = FPS,
    duration: float = DURATION,
    workers: Optional[int] = None,
) -> list[Path]:
    """渲染动画帧序列（frame_0000.png …），返回帧文件列表。

    workers>1 时用多进程并行渲染各帧区间（帧之间完全独立），显著提速。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    n = max(8, int(round(fps * duration)))
    if workers and workers > 1 and n >= 8:
        from concurrent.futures import ProcessPoolExecutor

        chunks = min(workers, n)
        per = math.ceil(n / chunks)
        payload = {
            "player_name": player_name,
            "radar": radar,
            "match_avg_radar": match_avg_radar,
            "portrait_path": str(portrait_path) if portrait_path else None,
            "team_logo_path": str(team_logo_path) if team_logo_path else None,
            "team_key": team_key,
            "team_label": team_label,
            "out_dir": str(out_dir),
            "fps": fps,
            "duration": duration,
            "n": n,
        }
        with ProcessPoolExecutor(max_workers=chunks) as ex:
            futures = [
                ex.submit(_render_frames_worker, payload, start, min(start + per, n))
                for start in range(0, n, per)
            ]
            for f in futures:
                f.result()
    else:
        _render_frames_worker(
            {
                "player_name": player_name,
                "radar": radar,
                "match_avg_radar": match_avg_radar,
                "portrait_path": str(portrait_path) if portrait_path else None,
                "team_logo_path": str(team_logo_path) if team_logo_path else None,
                "team_key": team_key,
                "team_label": team_label,
                "out_dir": str(out_dir),
                "fps": fps,
                "duration": duration,
                "n": n,
            },
            0,
            n,
        )
    return [out_dir / f"frame_{fi:04d}.png" for fi in range(n)]


def _render_frames_worker(payload: dict[str, Any], start: int, end: int) -> None:
    """渲染 [start, end) 帧区间（多进程 worker；帧之间无共享状态）。"""
    from pathlib import Path as _Path

    player_name = str(payload["player_name"])
    radar = payload["radar"]
    match_avg_radar = payload["match_avg_radar"]
    portrait_path = _Path(payload["portrait_path"]) if payload.get("portrait_path") else None
    team_logo_path = _Path(payload["team_logo_path"]) if payload.get("team_logo_path") else None
    team_key = payload["team_key"]
    team_label = str(payload["team_label"] or "")
    out_dir = _Path(payload["out_dir"])
    fps = int(payload["fps"])
    duration = float(payload["duration"])
    n = int(payload["n"])

    color, bg1, bg2 = _theme_for_player(player_name, team_key)
    values = normalize_radar_values(radar)
    ambient = _build_ambient_layer(color)
    starfield = _build_starfield_web()
    brackets = _build_corner_brackets()
    for fi in range(start, end):
        tt = fi / max(1, n - 1)
        st = compute_frame_state(tt, fi)
        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 255))
        _draw_gradient_bg(canvas, color, bg1, bg2)
        canvas.alpha_composite(ambient)
        canvas.alpha_composite(starfield)
        canvas.alpha_composite(brackets)
        _draw_cncs_watermark(canvas)
        _draw_connection_line(canvas, color)
        _draw_watermark(canvas, alpha=min(1.0, tt / 0.2))
        _draw_dust(canvas, tt, player_name, color)
        if st["mesh"] > 0:
            _draw_gold_mesh(canvas, st["mesh"], color)
        if st["final_grid"] > 0:
            _draw_final_grid(canvas, color, st["final_grid"])

        # 主题色个人数据多边形：从第一帧起按 scale（慢入→快出→定格）累计出现
        _draw_animated_polygon(canvas, color, values, st["scale"], st["flash"])
        _draw_flash_streaks(canvas, color, st["flash"])
        _draw_glimmer_points(canvas, values, st["glimmer"])
        _draw_animated_labels(canvas, color, radar, st["tremor"], alpha=min(1.0, tt / 0.25))
        # 红色全场平均线：全程完全可见
        if match_avg_radar:
            _draw_match_avg_reference(canvas, radar, match_avg_radar, alpha=st["match_avg"])
        _draw_portrait(canvas, portrait_path, player_name, color, team_logo_path=team_logo_path)
        _draw_avatar_gold_ring(canvas, st["avatar_gold"])
        _draw_right_info(
            canvas,
            color=color,
            player_name=player_name,
            radar=radar,
            team_label=team_label,
        )

        path = out_dir / f"frame_{fi:04d}.png"
        canvas.convert("RGB").save(str(path), format="PNG")
    return None


def encode_animation(frames_dir: Path, out_path: Path, ffmpeg_bin: Path, fps: int = FPS) -> Path:
    """把帧序列编码为 MP4（1600 渲染 → 缩放到 OUT_WIDTH）。"""
    from ...ffmpeg_process import run_process_capture

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(fps),
        "-i",
        str(frames_dir / "frame_%04d.png"),
        "-vf",
        "scale=1920:1080",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    run_process_capture(cmd, timeout=900, cancel_event=None)
    return out_path


def generate_radar_animation(
    *,
    player_name: str,
    radar: dict[str, Any],
    match_avg_radar: Optional[dict[str, Any]],
    portrait_path: Optional[Path],
    team_key: Any,
    team_label: str,
    team_logo_path: Optional[Path] = None,
    ffmpeg_bin: Path,
    out_path: Path,
    fps: int = FPS,
    duration: float = DURATION,
    workers: Optional[int] = None,
) -> Path:
    """渲染动画帧并编码为 MP4（完成后清理临时帧目录）。"""
    frames_dir = out_path.parent / f"frames_{out_path.stem}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    try:
        render_animation_frames(
            player_name=player_name,
            radar=radar,
            match_avg_radar=match_avg_radar,
            portrait_path=portrait_path,
            team_logo_path=team_logo_path,
            team_key=team_key,
            team_label=team_label,
            out_dir=frames_dir,
            fps=fps,
            duration=duration,
            workers=workers,
        )
        encode_animation(frames_dir, out_path, ffmpeg_bin, fps=fps)
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)
    return out_path
