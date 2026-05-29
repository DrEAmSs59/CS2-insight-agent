"""本地合辑：FFmpeg 探测、片段归一化拼接、可选片头片尾与 BGM 混音。"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

from .montage_encoder import h264_encode_cli_args, resolve_h264_codec_name
from .env_utils import resolve_name_card_font

logger = logging.getLogger(__name__)


class MontageComposerError(Exception):
    """可映射为 HTTP 400/500 的合成错误。"""


def resolve_ffmpeg_binary(ffmpeg_path: str | None) -> Path:
    raw = (ffmpeg_path or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file():
            return p.resolve()
        raise MontageComposerError(f"配置的 FFmpeg 不存在或不可执行: {raw}")
    from .env_utils import get_data_dir

    bundled = get_data_dir().parent / "third_party" / "ffmpeg" / "ffmpeg.exe"
    if bundled.is_file():
        return bundled.resolve()
    found = shutil.which("ffmpeg")
    if not found:
        raise MontageComposerError(
            "未找到 FFmpeg。请在配置中填写 ffmpeg.exe 完整路径，或将其加入系统 PATH。",
        )
    return Path(found).resolve()


def resolve_ffprobe_binary(ffmpeg_bin: Path) -> Path:
    """与 ffmpeg 同目录的 ffprobe，否则 PATH。"""
    probe = ffmpeg_bin.parent / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if probe.is_file():
        return probe.resolve()
    w = shutil.which("ffprobe")
    if w:
        return Path(w).resolve()
    raise MontageComposerError("未找到 ffprobe（通常与 FFmpeg 一同安装）。")


def _run_json(cmd: list[str]) -> dict[str, Any]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise MontageComposerError(f"ffprobe 失败 (exit {proc.returncode}): {tail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise MontageComposerError(f"ffprobe 输出非 JSON: {e}") from e


def ffprobe_streams(path: Path, ffprobe: Path) -> dict[str, Any]:
    return _run_json(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,width,height,r_frame_rate,channels,sample_rate",
            "-of",
            "json",
            str(path),
        ],
    )


def parse_r_frame_rate(s: str) -> float:
    s = (s or "").strip()
    if not s or s == "0/0":
        return 60.0
    if "/" in s:
        a, b = s.split("/", 1)
        try:
            bf = float(b)
            return float(a) / bf if bf else 60.0
        except ValueError:
            return 60.0
    try:
        return float(s)
    except ValueError:
        return 60.0


def probe_video_audio_summary(path: Path, ffprobe: Path) -> dict[str, Any]:
    data = ffprobe_streams(path, ffprobe)
    fmt = data.get("format") or {}
    dur_s: Optional[float] = None
    try:
        d = float(fmt.get("duration") or 0)
        dur_s = d if d > 0 else None
    except (TypeError, ValueError):
        dur_s = None
    streams = data.get("streams") or []
    vw = vh = 1920, 1080
    fps = 60.0
    has_audio = False
    for st in streams:
        if not isinstance(st, dict):
            continue
        ct = str(st.get("codec_type") or "")
        if ct == "video":
            try:
                vw = int(st.get("width") or vw)
                vh = int(st.get("height") or vh)
            except (TypeError, ValueError):
                pass
            fps = parse_r_frame_rate(str(st.get("r_frame_rate") or ""))
        elif ct == "audio":
            has_audio = True
    return {"width": vw, "height": vh, "fps": fps, "has_audio": has_audio, "duration": dur_s}


def validate_output_path(path_str: str) -> Path:
    raw = (path_str or "").strip()
    if not raw:
        raise MontageComposerError("输出路径为空")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise MontageComposerError("输出路径必须是绝对路径")
    if p.suffix.lower() != ".mp4":
        raise MontageComposerError("输出文件必须是 .mp4")
    try:
        resolved = p.resolve()
    except OSError as e:
        raise MontageComposerError(f"输出路径无效: {e}") from e
    if ".." in p.parts:
        raise MontageComposerError("输出路径不能包含 '..' 段")
    parent = resolved.parent
    if not parent.exists():
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise MontageComposerError(f"无法创建输出目录: {e}") from e
    if parent.exists() and not parent.is_dir():
        raise MontageComposerError("输出目录路径不是文件夹")
    return resolved


def build_bgm_filter(
    video_duration_sec: float,
    bgm_input_label: str = "[1:a]",
    volume: float = 1.0,
    start_sec: float = 0.0,
) -> str:
    """
    生成将 BGM 对齐到成片时长的 filter 片段（不含 amix）。
    BGM 短于成片则循环；长于成片则裁剪。start_sec 指定从音频第几秒开始使用。
    """
    d = max(0.01, float(video_duration_sec))
    vol = max(0.0, min(2.0, float(volume)))
    s = max(0.0, float(start_sec))
    # 先裁掉起始段，重置 PTS，再循环，再裁到视频时长
    seek = f"atrim=start={s:.6f},asetpts=N/SR/TB," if s > 1e-6 else ""
    return (
        f"{bgm_input_label}{seek}aloop=loop=-1:size=2e+09,atrim=0:{d:.6f},asetpts=N/SR/TB,"
        f"volume={vol:.6f}[bgmtrim]"
    )


def _concat_file_line(p: Path) -> str:
    s = p.resolve().as_posix()
    s = s.replace("'", "'\\''")
    return f"file '{s}'"


def _finalize_mp4_for_common_players(
    ffmpeg_bin: Path,
    src: Path,
    dst: Path,
    video_encode_fast: list[str],
) -> None:
    """
    concat 直拷 .ts → .mp4 在部分播放器上不可靠（moov/时间基/流封装）。
    统一重编码为 H.264（Main/High 依编码器）+ AAC-LC，并写入 faststart 便于随机访问。
    """
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        *video_encode_fast,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        raise MontageComposerError(
            f"成片封装失败（播放器兼容）: {(r.stderr or r.stdout or '').strip()[-900:]}",
        )


_VALID_XFADE_TYPES = frozenset({"fade", "cut", "flash", "dip_black", "zoom", "none"})

_IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"})


def _is_image_path(p: Path) -> bool:
    return p.suffix.lower() in _IMAGE_EXTS


def _image_to_ts_with_fade(
    *,
    ffmpeg_bin: Path,
    image_path: Path,
    out_ts: Path,
    width: int,
    height: int,
    fps: float,
    video_encode_quality: list[str],
    duration: float = 3.0,
    fade_duration: float = 0.5,
) -> None:
    """Convert a static image to an mpegts clip with fade-in and fade-out."""
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    d = max(1.0, float(duration))
    fd = min(float(fade_duration), d / 3)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={fps_s},setsar=1,format=yuv420p,"
        f"fade=t=in:st=0:d={fd:.4f},"
        f"fade=t=out:st={d - fd:.4f}:d={fd:.4f}"
    )
    cmd = [
        str(ffmpeg_bin),
        "-y", "-hide_banner", "-loglevel", "error",
        "-loop", "1",
        "-framerate", fps_s,
        "-i", str(image_path),
        "-filter_complex",
        f"[0:v]{vf}[v];anullsrc=r=48000:cl=stereo,atrim=0:{d:.6f},asetpts=N/SR/TB[a]",
        "-map", "[v]",
        "-map", "[a]",
        *video_encode_quality,
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", str(d),
        str(out_ts),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise MontageComposerError(
            f"图片转视频失败 ({image_path.name}): {(r.stderr or r.stdout or '').strip()[-600:]}",
        )


def _xfade_transition_name(trans_type: str) -> str:
    """映射到 ffmpeg xfade 的 transition 名称。"""
    if trans_type == "flash":
        return "fadewhite"
    if trans_type == "dip_black":
        return "fadeblack"
    if trans_type == "zoom":
        return "zoomin"
    return "fade"


def _parse_transition_for_edge(transitions: dict[str, Any], clip_row_id: int) -> tuple[str, float]:
    raw = transitions.get(str(int(clip_row_id)))
    if not isinstance(raw, dict):
        return "cut", 0.25
    t = str(raw.get("type") or "cut").strip().lower()
    if t not in _VALID_XFADE_TYPES:
        t = "cut"
    try:
        d = float(raw.get("duration", 0.25))
    except (TypeError, ValueError):
        d = 0.25
    if t == "none":
        d = 0.0
    return t, max(0.0, d)


def _is_hard_cut(t_type: str, t_dur: float, fps: float = 60.0) -> bool:
    """低于 1 帧时长或 type=none → 硬切，调用方直接 concat 而不走 xfade。"""
    min_xfade = max(1.0 / max(fps, 24.0), 0.02)
    return t_dur < min_xfade or t_type == "none"


def _clamp_xfade_duration(
    trans_type: str,
    requested: float,
    dur_a: float,
    dur_b: float,
    fps: float,
) -> float:
    """保证 xfade offset>0 且 duration 不超过相邻片段（仅在非硬切时调用）。"""
    frame = max(1.0 / max(fps, 24.0), 0.02)
    cap = min(float(dur_a), float(dur_b)) * 0.48 - 1e-4
    if cap < frame:
        return frame
    return max(frame, min(requested, cap, 1.5))


def _montage_xfade_chain_to_ts(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    clip_ts_paths: list[Path],
    clip_row_ids: list[int],
    transitions: dict[str, Any],
    fps: float,
    out_ts: Path,
    video_encode_quality: list[str],
) -> None:
    """将已归一化的 .ts 片段链用 xfade + acrossfade 连成单路 mpegts（片段需同分辨率/帧率）。"""
    n = len(clip_ts_paths)
    if n < 2:
        raise MontageComposerError("xfade 链至少需要 2 个片段")
    if len(clip_row_ids) != n:
        raise MontageComposerError("clip_row_ids 与片段数量不一致")

    durs: list[float] = []
    for p in clip_ts_paths:
        info = probe_video_audio_summary(p, ffprobe)
        d = info.get("duration")
        if d is None or float(d) <= 0:
            d = 0.1
        durs.append(float(d))

    fc: list[str] = []
    v_in = "[0:v]"
    a_in = "[0:a]"
    out_len = durs[0]

    for i in range(1, n):
        tid = int(clip_row_ids[i - 1])
        t_type, t_req = _parse_transition_for_edge(transitions, tid)
        td = _clamp_xfade_duration(t_type, t_req, out_len, durs[i], fps)
        if t_type in ("cut", "fade"):
            xname = "fade"
        else:
            xname = _xfade_transition_name(t_type)
        off = out_len - td
        if off < 1e-6:
            raise MontageComposerError(
                "转场时长相对片段过长（offset 无效），请缩短转场时长或检查素材长度。",
            )
        last = i == n - 1
        v_tag = "vout" if last else f"vxf{i}"
        a_tag = "aout" if last else f"axf{i}"
        fc.append(f"{v_in}[{i}:v]xfade=transition={xname}:duration={td:.6f}:offset={off:.6f}[{v_tag}]")
        fc.append(f"{a_in}[{i}:a]acrossfade=d={td:.6f}[{a_tag}]")
        v_in = f"[{v_tag}]"
        a_in = f"[{a_tag}]"
        out_len = out_len + durs[i] - td

    cmd: list[str] = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error"]
    for p in clip_ts_paths:
        cmd += ["-i", str(p)]
    cmd += [
        "-filter_complex",
        ";".join(fc),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        *video_encode_quality,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(out_ts),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        raise MontageComposerError(
            f"片段转场拼接失败: {(r.stderr or r.stdout or '').strip()[-900:]}",
        )


_CATEGORY_ACCENT: dict[str, str] = {
    "highlight":   "0xF97316@0.85",   # orange
    "fail":        "0x6B7280@0.85",   # grey
    "meme_death":  "0xA855F7@0.85",   # purple
    "compilation": "0x3B82F6@0.85",   # blue
}
_DEFAULT_ACCENT = "0x222244@0.85"
# How many seconds the name card stays visible at the start of each clip
_NAME_CARD_DISPLAY_SECS: int = 4


def _make_name_card_png(
    display_name: str,
    subtitle: str,
    accent_hex: str,
    font_path: Optional[Path],
    avatar_path: Optional[Path],
    out_path: Path,
) -> bool:
    """使用 Pillow 渲染名牌 PNG，返回是否成功。

    用 Python/Pillow 生成图片，完全绕开 FFmpeg drawtext 在 Windows 上的
    filtergraph 解析 bug（textfile= / fontfile= 路径中的冒号导致 filterchain
    边界解析失败）。PNG 随后作为第二路 -i 输入叠加到视频。
    """
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import]
    except ImportError:
        return False

    has_av = bool(avatar_path and avatar_path.is_file())
    card_h = 100 if has_av else 70
    card_w = 240

    img = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 半透明黑底
    draw.rectangle([0, 0, card_w - 1, card_h - 1], fill=(0, 0, 0, 165))

    # 类别色竖条（左4px）
    try:
        hex_part = accent_hex.split("@")[0]   # e.g. "0xF97316"
        ar = int(hex_part[2:4], 16)
        ag = int(hex_part[4:6], 16)
        ab_val = int(hex_part[6:8], 16)
    except (ValueError, IndexError):
        ar, ag, ab_val = 0x22, 0x22, 0x44
    draw.rectangle([0, 0, 3, card_h - 1], fill=(ar, ag, ab_val, 220))

    # 头像
    text_x = 14
    if has_av:
        try:
            av_img = Image.open(str(avatar_path)).convert("RGBA").resize((80, 80))
            img.paste(av_img, (8, 10), av_img)
            text_x = 96
        except Exception:
            pass  # 头像加载失败时退化为无头像布局

    # 字体
    if font_path and font_path.is_file():
        try:
            fn = ImageFont.truetype(str(font_path), 20)
            fs = ImageFont.truetype(str(font_path), 14)
        except Exception:
            fn = fs = ImageFont.load_default()
    else:
        fn = fs = ImageFont.load_default()

    # 名字（第1行）
    name_y = 12 if card_h == 70 else 16
    draw.text((text_x, name_y), display_name, font=fn, fill=(255, 255, 255, 255))

    # 副标签（第2行）
    if subtitle:
        sub_y = 40 if card_h == 70 else 48
        draw.text((text_x, sub_y), subtitle, font=fs, fill=(204, 204, 204, 255))

    img.save(str(out_path), "PNG")
    return True


def _fg_escape_path(p: Path) -> str:
    """Wrap a path in single quotes for use in an FFmpeg filtergraph option value.

    Single-quote wrapping protects ':' in Windows drive letters (e.g. C:/) from
    being misinterpreted as an FFmpeg option separator.  Using \\: backslash
    escaping instead was found to cause filterchain parse failures in FFmpeg 8.1
    on Windows (the parser incorrectly merges subsequent filter chains).
    Any literal single quotes in the path are backslash-escaped before wrapping.
    """
    safe = str(p).replace('\\', '/').replace("'", "\\'")
    return f"'{safe}'"


def _fg_escape_text(s: str) -> str:
    """Escape text for FFmpeg drawtext text= option."""
    return s.replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'").replace('\n', ' ')


def compose_montage(
    *,
    ffmpeg_bin: Path,
    clip_paths: list[Path],
    intro_path: Optional[Path],
    outro_path: Optional[Path],
    bgm_path: Optional[Path],
    output_path: Path,
    transitions: Optional[dict[str, Any]] = None,
    clip_row_ids: Optional[list[int]] = None,
    bgm_volume: Optional[float] = None,
    bgm_start_sec: Optional[float] = None,
    intro_image_duration: Optional[float] = None,
    outro_image_duration: Optional[float] = None,
    montage_encoder: str = "auto",
    name_cards: Optional[list[dict | None]] = None,
) -> None:
    if not clip_paths:
        raise MontageComposerError("片段列表为空")
    for c in clip_paths:
        if not c.is_file():
            raise MontageComposerError(f"片段文件不存在: {c}")
    if intro_path is not None and not intro_path.is_file():
        raise MontageComposerError(f"片头文件不存在: {intro_path}")
    if outro_path is not None and not outro_path.is_file():
        raise MontageComposerError(f"片尾文件不存在: {outro_path}")
    if bgm_path is not None and not bgm_path.is_file():
        raise MontageComposerError(f"BGM 文件不存在: {bgm_path}")

    _codec = resolve_h264_codec_name(ffmpeg_bin, montage_encoder)
    video_encode_quality = h264_encode_cli_args(_codec, "quality")
    video_encode_fast = h264_encode_cli_args(_codec, "fast")

    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)

    _font_path = resolve_name_card_font()

    intro_n = 1 if intro_path is not None else 0
    n_clips = len(clip_paths)

    tmpdir = tempfile.mkdtemp(prefix="cs2_montage_", dir=str(output_path.parent))
    try:
        working_clip_paths = list(clip_paths)

        # 以首段为主分辨率 / 帧率
        ref = probe_video_audio_summary(working_clip_paths[0], ffprobe)
        w, h, fps = int(ref["width"]), int(ref["height"]), float(ref["fps"])
        if w <= 0 or h <= 0:
            raise MontageComposerError("无法读取首段视频分辨率")
        fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")

        segments: list[Path] = []
        if intro_path is not None:
            segments.append(intro_path)
        segments.extend(working_clip_paths)
        if outro_path is not None:
            segments.append(outro_path)

        _intro_img_dur = max(1.0, float(intro_image_duration)) if intro_image_duration is not None else 3.0
        _outro_img_dur = max(1.0, float(outro_image_duration)) if outro_image_duration is not None else 3.0
        _intro_idx = 0 if intro_path is not None else -1
        _outro_idx = len(segments) - 1 if outro_path is not None else -1

        normed: list[Path] = []
        for i, seg in enumerate(segments):
            out_ts = Path(tmpdir) / f"norm_{i:03d}.ts"
            if _is_image_path(seg):
                img_dur = _intro_img_dur if i == _intro_idx else _outro_img_dur
                _image_to_ts_with_fade(
                    ffmpeg_bin=ffmpeg_bin,
                    image_path=seg,
                    out_ts=out_ts,
                    width=w,
                    height=h,
                    fps=fps,
                    video_encode_quality=video_encode_quality,
                    duration=img_dur,
                )
                normed.append(out_ts)
                continue
            info = probe_video_audio_summary(seg, ffprobe)
            dur = info.get("duration")
            if dur is None or dur <= 0:
                dur = 0.1
            vf = (
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps_s},setsar=1,format=yuv420p"
            )

            # Determine whether this segment gets a name card overlay.
            # "有卡"（_use_card）只要有名字即可；"有头像"（_has_avatar）需头像文件存在。
            # 无头像时仍烧名字框，只是文字左移填满卡片。
            _clip_index = i - intro_n
            _is_clip_seg = (name_cards is not None and 0 <= _clip_index < len(name_cards))
            _card = name_cards[_clip_index] if _is_clip_seg else None
            _use_card = bool(
                _card is not None
                and isinstance(_card, dict)
                and _card.get("enabled")
                and str(_card.get("display_name") or "").strip()
            )
            _has_avatar = (
                _use_card
                and bool(_card.get("avatar_path"))
                and Path(str(_card["avatar_path"])).is_file()
            )

            # 名牌覆层：用 Pillow 预渲染 PNG，作为第二路 -i 输入叠加。
            # 完全避开 FFmpeg drawtext 在 Windows 8.1 构建上的 filtergraph 解析 bug
            # （textfile= / fontfile= 路径中的冒号导致 filterchain 边界解析失败）。
            card_png: Optional[Path] = None
            if _use_card:
                name_str     = str(_card.get("display_name") or "")
                sub_str      = str(_card.get("subtitle") or "")
                category_val = str(_card.get("category") or "")
                accent_color = _CATEGORY_ACCENT.get(category_val, _DEFAULT_ACCENT)
                av_path      = Path(str(_card["avatar_path"])) if _has_avatar else None
                card_png     = Path(tmpdir) / f"nc_card_{i:03d}.png"
                ok = _make_name_card_png(
                    display_name=name_str,
                    subtitle=sub_str,
                    accent_hex=accent_color,
                    font_path=_font_path,
                    avatar_path=av_path,
                    out_path=card_png,
                )
                if not ok:
                    card_png = None   # Pillow 不可用时退化为无卡

            card_h = 100 if _has_avatar else 70

            if card_png is not None:
                # 名牌 PNG 作为 input[1]，用 -loop 1 让单帧图持续供给整段时长。
                # filtergraph 里无路径字符串，彻底规避 Windows 路径冒号转义问题。
                if info["has_audio"]:
                    fc = (
                        f"[0:v]{vf}[_scaled];"
                        f"[_scaled][1:v]overlay=0:H-{card_h}[v];"
                        f"[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
                    )
                else:
                    fc = (
                        f"[0:v]{vf}[_scaled];"
                        f"[_scaled][1:v]overlay=0:H-{card_h}[v];"
                        f"anullsrc=r=48000:cl=stereo,atrim=0:{float(dur):.6f},asetpts=N/SR/TB[a]"
                    )
            else:
                if info["has_audio"]:
                    fc = f"[0:v]{vf}[v];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
                else:
                    fc = (
                        f"[0:v]{vf}[v];"
                        f"anullsrc=r=48000:cl=stereo,atrim=0:{float(dur):.6f},asetpts=N/SR/TB[a]"
                    )

            cmd = [
                str(ffmpeg_bin),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(seg),
            ]
            if card_png is not None:
                # -loop 1: 将单帧 PNG 循环成无限长流，匹配视频时长
                cmd += ["-loop", "1", "-i", str(card_png)]
            cmd += [
                "-filter_complex",
                fc,
                "-map",
                "[v]",
                "-map",
                "[a]",
                *video_encode_quality,
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                str(out_ts),
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if r.returncode != 0:
                raise MontageComposerError(
                    f"片段归一化失败 ({seg.name}): {(r.stderr or r.stdout or '').strip()[-600:]}",
                )
            normed.append(out_ts)

        has_transitions = bool(
            transitions is not None
            and isinstance(transitions, dict)
            and clip_row_ids is not None
            and len(clip_row_ids) == n_clips
            and n_clips >= 2
        )

        if has_transitions:
            # 按硬切边界（duration=0 或 type=none）拆成若干组；
            # 组内片段用 xfade 连接，组间直接 concat——这样 0s 转场就是真正的硬切。
            clip_norm = normed[intro_n : intro_n + n_clips]
            ids = [int(x) for x in clip_row_ids]

            grp_clips: list[Path] = [clip_norm[0]]
            grp_ids: list[int] = [ids[0]]
            groups: list[tuple[list[Path], list[int]]] = []

            for i in range(1, n_clips):
                t_type, t_dur = _parse_transition_for_edge(transitions, ids[i - 1])
                if _is_hard_cut(t_type, t_dur, fps):
                    groups.append((grp_clips, grp_ids))
                    grp_clips = [clip_norm[i]]
                    grp_ids = [ids[i]]
                else:
                    grp_clips.append(clip_norm[i])
                    grp_ids.append(ids[i])
            groups.append((grp_clips, grp_ids))

            processed: list[Path] = []
            for gi, (g_clips, g_ids) in enumerate(groups):
                if len(g_clips) == 1:
                    processed.append(g_clips[0])
                else:
                    grp_ts = Path(tmpdir) / f"clips_xfade_g{gi:03d}.ts"
                    _montage_xfade_chain_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        ffprobe=ffprobe,
                        clip_ts_paths=g_clips,
                        clip_row_ids=g_ids,
                        transitions=transitions,
                        fps=fps,
                        out_ts=grp_ts,
                        video_encode_quality=video_encode_quality,
                    )
                    processed.append(grp_ts)

            concat_paths: list[Path] = []
            if intro_path is not None:
                concat_paths.append(normed[0])
            concat_paths.extend(processed)
            if outro_path is not None:
                concat_paths.append(normed[-1])
        else:
            concat_paths = normed

        concat_list = Path(tmpdir) / "concat.txt"
        lines = [_concat_file_line(p) for p in concat_paths]
        concat_list.write_text("\n".join(lines) + "\n", encoding="utf-8")

        mid_mp4 = Path(tmpdir) / "mid.mp4"
        cmd_concat = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(mid_mp4),
        ]
        r2 = subprocess.run(cmd_concat, capture_output=True, text=True, timeout=3600)
        if r2.returncode != 0:
            raise MontageComposerError(
                f"拼接失败: {(r2.stderr or r2.stdout or '').strip()[-600:]}",
            )

        mid_playable = Path(tmpdir) / "mid_playable.mp4"
        _finalize_mp4_for_common_players(ffmpeg_bin, mid_mp4, mid_playable, video_encode_fast)

        mid_info = ffprobe_streams(mid_playable, ffprobe)
        try:
            vdur = float((mid_info.get("format") or {}).get("duration") or 0)
        except (TypeError, ValueError):
            vdur = 0.0
        if vdur <= 0:
            vdur = 0.01

        if bgm_path is None:
            shutil.move(str(mid_playable), str(output_path))
            return

        bgm_vol = 1.0 if bgm_volume is None else max(0.0, min(2.0, float(bgm_volume)))
        bgm_start = 0.0 if bgm_start_sec is None else max(0.0, float(bgm_start_sec))

        fc_mix = (
            f"[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[ga];"
            f"{build_bgm_filter(vdur, '[1:a]', volume=bgm_vol, start_sec=bgm_start)};"
            f"[ga][bgmtrim]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        cmd_mix = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(mid_playable),
            "-i",
            str(bgm_path),
            "-filter_complex",
            fc_mix,
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        r3 = subprocess.run(cmd_mix, capture_output=True, text=True, timeout=3600)
        if r3.returncode != 0:
            raise MontageComposerError(
                f"BGM 混音失败: {(r3.stderr or r3.stdout or '').strip()[-600:]}",
            )
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            logger.debug("montage temp cleanup failed", exc_info=True)
