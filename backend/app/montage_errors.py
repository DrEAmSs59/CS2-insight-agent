"""合辑导出错误码 → HTTP detail（前端 i18n 映射）。"""

from __future__ import annotations

import re
from typing import Any

from .api_errors import error_detail


def montage_detail_from_exception(exc: BaseException) -> dict[str, Any]:
    from .video_composer import MontageComposerError

    if isinstance(exc, MontageComposerError):
        return error_detail(exc.code, **exc.params)
    return montage_detail_from_legacy(str(exc))


def montage_detail_from_legacy(message: str) -> dict[str, Any]:
    s = (message or "").strip()
    if not s:
        return error_detail("MONTAGE_EXPORT_FAILED")

    if "recorded_clip_ids" in s or "不能为空" in s:
        return error_detail("MONTAGE_NO_CLIPS")
    if "合辑项目不存在" in s or "project" in s.lower() and "not found" in s.lower():
        return error_detail("MONTAGE_PROJECT_NOT_FOUND")
    m = re.search(r"未知的 recorded_clip id:\s*(\d+)", s)
    if m:
        return error_detail("MONTAGE_CLIP_NOT_FOUND", id=m.group(1))
    m = re.search(r"recorded_clip id:\s*(\d+)", s, re.I)
    if m and "未知" in s:
        return error_detail("MONTAGE_CLIP_NOT_FOUND", id=m.group(1))

    if "归一化" in s or "normaliz" in s.lower():
        name = _extract_paren_name(s) or _extract_basename(s)
        return error_detail("MONTAGE_CLIP_NORMALIZE_FAILED", name=name or "?")

    if "转场" in s and ("过长" in s or "offset" in s.lower()):
        return error_detail("MONTAGE_TRANSITION_TOO_LONG")
    if "转场拼接" in s or "xfade" in s.lower():
        return error_detail("MONTAGE_TRANSITION_FAILED")
    if "拼接失败" in s or "concat" in s.lower():
        return error_detail("MONTAGE_CONCAT_FAILED")
    if "BGM" in s and ("混音" in s or "mix" in s.lower()):
        return error_detail("MONTAGE_BGM_MIX_FAILED")
    if "成片封装" in s or "播放器兼容" in s:
        return error_detail("MONTAGE_FINALIZE_FAILED")
    if "图片转视频" in s:
        name = _extract_paren_name(s) or "?"
        return error_detail("MONTAGE_IMAGE_TO_VIDEO_FAILED", name=name)

    if "片段文件不存在" in s or "clip" in s.lower() and "not exist" in s.lower():
        name = _extract_basename(s) or s
        return error_detail("MONTAGE_CLIP_FILE_MISSING", name=name)
    if "片头" in s and "不存在" in s:
        return error_detail("MONTAGE_INTRO_MISSING")
    if "片尾" in s and "不存在" in s:
        return error_detail("MONTAGE_OUTRO_MISSING")
    if "BGM" in s and "不存在" in s:
        return error_detail("MONTAGE_BGM_MISSING")
    if "片段列表为空" in s or "empty" in s.lower() and "clip" in s.lower():
        return error_detail("MONTAGE_CLIPS_EMPTY")

    if "FFmpeg" in s or "ffmpeg" in s:
        if "不存在" in s or "not found" in s.lower() or "不可执行" in s:
            return error_detail("MONTAGE_FFMPEG_NOT_FOUND")
        if "未找到 FFmpeg" in s or "PATH" in s:
            return error_detail("MONTAGE_FFMPEG_PATH_MISSING")
    if "ffprobe" in s.lower():
        return error_detail("MONTAGE_FFPROBE_FAILED")

    if "输出路径为空" in s:
        return error_detail("MONTAGE_OUTPUT_PATH_EMPTY")
    if "绝对路径" in s:
        return error_detail("MONTAGE_OUTPUT_PATH_NOT_ABSOLUTE")
    if ".mp4" in s.lower() and ("必须" in s or "must" in s.lower()):
        return error_detail("MONTAGE_OUTPUT_NOT_MP4")
    if "无法创建输出目录" in s:
        return error_detail("MONTAGE_OUTPUT_PARENT_CREATE_FAILED")
    if "不是文件夹" in s:
        return error_detail("MONTAGE_OUTPUT_DIR_NOT_FOLDER")

    if "无法读取首段" in s or "resolution" in s.lower():
        return error_detail("MONTAGE_FIRST_CLIP_NO_RESOLUTION")

    return error_detail("MONTAGE_EXPORT_FAILED")


def _extract_paren_name(s: str) -> str | None:
    m = re.search(r"\(([^)]+)\)", s)
    return m.group(1).strip() if m else None


def _extract_basename(s: str) -> str | None:
    m = re.search(r"[:：]\s*([^\s:]+(?:\.[a-zA-Z0-9]+)?)", s)
    if m:
        return m.group(1).strip()
    return None
