/** 旧版合辑导出技术文案 → code（与 backend montage_errors.py 对齐） */

export function montageDetailFromLegacy(message) {
  const s = String(message || "").trim();
  if (!s) return { code: "MONTAGE_EXPORT_FAILED", params: {} };

  if (s.includes("recorded_clip_ids") || s.includes("不能为空")) {
    return { code: "MONTAGE_NO_CLIPS", params: {} };
  }
  if (s.includes("合辑项目不存在")) {
    return { code: "MONTAGE_PROJECT_NOT_FOUND", params: {} };
  }
  const clipId = s.match(/recorded_clip id:\s*(\d+)/i);
  if (clipId && (s.includes("未知") || s.includes("unknown"))) {
    return { code: "MONTAGE_CLIP_NOT_FOUND", params: { id: clipId[1] } };
  }

  if (s.includes("归一化") || /normaliz/i.test(s)) {
    const name = _parenName(s) || _basename(s) || "?";
    return { code: "MONTAGE_CLIP_NORMALIZE_FAILED", params: { name } };
  }
  if (s.includes("转场") && (s.includes("过长") || /offset/i.test(s))) {
    return { code: "MONTAGE_TRANSITION_TOO_LONG", params: {} };
  }
  if (s.includes("转场拼接") || /xfade/i.test(s)) {
    return { code: "MONTAGE_TRANSITION_FAILED", params: {} };
  }
  if (s.includes("拼接失败") || /concat/i.test(s)) {
    return { code: "MONTAGE_CONCAT_FAILED", params: {} };
  }
  if (s.includes("BGM") && (s.includes("混音") || /mix/i.test(s))) {
    return { code: "MONTAGE_BGM_MIX_FAILED", params: {} };
  }
  if (s.includes("成片封装") || s.includes("播放器兼容")) {
    return { code: "MONTAGE_FINALIZE_FAILED", params: {} };
  }
  if (s.includes("图片转视频")) {
    return { code: "MONTAGE_IMAGE_TO_VIDEO_FAILED", params: { name: _parenName(s) || "?" } };
  }
  if (s.includes("片段文件不存在")) {
    return { code: "MONTAGE_CLIP_FILE_MISSING", params: { name: _basename(s) || s } };
  }
  if (s.includes("片头") && s.includes("不存在")) {
    return { code: "MONTAGE_INTRO_MISSING", params: {} };
  }
  if (s.includes("片尾") && s.includes("不存在")) {
    return { code: "MONTAGE_OUTRO_MISSING", params: {} };
  }
  if (s.includes("BGM") && s.includes("不存在")) {
    return { code: "MONTAGE_BGM_MISSING", params: {} };
  }
  if (s.includes("片段列表为空")) {
    return { code: "MONTAGE_CLIPS_EMPTY", params: {} };
  }
  if (/ffmpeg/i.test(s)) {
    if (s.includes("不存在") || s.includes("不可执行") || /not found/i.test(s)) {
      return { code: "MONTAGE_FFMPEG_NOT_FOUND", params: {} };
    }
    if (s.includes("未找到 FFmpeg") || s.includes("PATH")) {
      return { code: "MONTAGE_FFMPEG_PATH_MISSING", params: {} };
    }
  }
  if (/ffprobe/i.test(s)) {
    return { code: "MONTAGE_FFPROBE_FAILED", params: {} };
  }
  if (s.includes("无法读取首段")) {
    return { code: "MONTAGE_FIRST_CLIP_NO_RESOLUTION", params: {} };
  }

  return { code: "MONTAGE_EXPORT_FAILED", params: {} };
}

function _parenName(s) {
  const m = s.match(/\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

function _basename(s) {
  const m = s.match(/[:：]\s*([^\s:]+(?:\.[a-zA-Z0-9]+)?)/);
  return m ? m[1].trim() : null;
}
