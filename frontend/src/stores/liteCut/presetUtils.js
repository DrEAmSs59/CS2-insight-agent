/** Build preset bodies from current editor state */

import { v1Clips } from "./timelineUtils.js";

export function colorGradeFromClip(clip) {
  const c = clip?.color || {};
  return {
    brightness: Number(c.brightness) || 0,
    contrast: Number(c.contrast) || 0,
    saturation: Number(c.saturation) || 0,
    filter_preset: c.filter_preset || null,
    apply_to: "v1_main",
  };
}

export function colorGradeFromBody(body) {
  const clips = v1Clips(body);
  const first = clips.find((c) => c.color) || clips[0];
  return colorGradeFromClip(first);
}

export function transitionRhythmFromBody(body) {
  const clips = v1Clips(body);
  const first = clips.find((c) => c.transition_out) || clips[0];
  const tr = first?.transition_out || { type: "fade", duration_sec: 0.4 };
  return {
    default_type: tr.type || "fade",
    default_duration_sec: Number(tr.duration_sec) || 0.4,
    flash_every_n: null,
    flash_type: "flash",
  };
}

export function packagingBundleFromBody(body) {
  const textOverlay = (body?.overlays || []).find((overlay) => overlay?.type === "text" && overlay?.text);
  const text = textOverlay?.text || null;
  const bgm = body?.audio?.bgm && typeof body.audio.bgm === "object" ? body.audio.bgm : null;
  return {
    color_grade: colorGradeFromBody(body),
    transition_rhythm: transitionRhythmFromBody(body),
    text_styles: text
      ? [{
          preset_id: text.preset_id || null,
          font_family: text.font_family || "sans-serif",
          font_file: text.font_file || null,
          font_size: Math.max(12, Number(text.font_size) || 48),
          anim_in: text.anim_in || null,
          anim_out: text.anim_out || null,
          content_template: text.content || "{{player_name}}",
        }]
      : [],
    bgm: bgm ? { ...bgm } : null,
  };
}

export const PRESET_KIND_LABELS = {
  color_grade: "调色",
  transition_rhythm: "转场节奏",
  text_style: "文字样式",
  packaging_bundle: "组合包装",
};
