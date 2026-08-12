/** Build preset bodies from current editor state */

import { v1Clips } from "./timelineUtils.js";
import { AUDIO_MASTER_GAIN, clampAudioGain } from "../domain/audioContract.js";
import { TRANSITION_DURATION_DEFAULT, normalizeTransitionSpec } from "./transitionModel.js";
import { VISUAL_COLOR_DEFAULT, VISUAL_COLOR_MAX, VISUAL_COLOR_MIN } from "../domain/visualMaterial.js";
import {
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_FONT_SIZE_DEFAULT,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_FONT_WEIGHT_DEFAULT,
  TEXT_FONT_WEIGHT_MAX,
  TEXT_FONT_WEIGHT_MIN,
  TEXT_LINE_HEIGHT_DEFAULT,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
} from "../editor/textLayout.js";

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

export function colorGradeFromClip(clip) {
  const c = clip?.color || {};
  return {
    brightness: clamp(c.brightness, VISUAL_COLOR_MIN, VISUAL_COLOR_MAX, VISUAL_COLOR_DEFAULT),
    contrast: clamp(c.contrast, VISUAL_COLOR_MIN, VISUAL_COLOR_MAX, VISUAL_COLOR_DEFAULT),
    saturation: clamp(c.saturation, VISUAL_COLOR_MIN, VISUAL_COLOR_MAX, VISUAL_COLOR_DEFAULT),
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
  const tr = (body?.transitions || []).find((event) => event?.from?.kind === "clip" && event?.to?.kind === "clip")
    || { type: "fade", duration_sec: TRANSITION_DURATION_DEFAULT };
  const spec = normalizeTransitionSpec(tr.type, tr.duration_sec);
  return {
    default_type: spec.type,
    default_duration_sec: spec.duration_sec,
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
          font_family: text.font_family || TEXT_DEFAULT_FONT_FAMILY,
          font_file: text.font_file || null,
          font_size: clamp(text.font_size, TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX, TEXT_FONT_SIZE_DEFAULT),
          font_weight: clamp(text.font_weight, TEXT_FONT_WEIGHT_MIN, TEXT_FONT_WEIGHT_MAX, TEXT_FONT_WEIGHT_DEFAULT),
          line_height: clamp(text.line_height, TEXT_LINE_HEIGHT_MIN, TEXT_LINE_HEIGHT_MAX, TEXT_LINE_HEIGHT_DEFAULT),
          letter_spacing: 0,
          align: ["left", "center", "right"].includes(text.align) ? text.align : "center",
          fill_color: /^#[0-9a-f]{6}$/i.test(String(text.fill_color || "")) ? String(text.fill_color).toLowerCase() : null,
          content_template: text.content || "{{player_name}}",
        }]
      : [],
    audio_mix: {
      master_volume: clampAudioGain(body?.audio?.master_volume, AUDIO_MASTER_GAIN),
      bgm: bgm ? { ...bgm } : null,
    },
  };
}
