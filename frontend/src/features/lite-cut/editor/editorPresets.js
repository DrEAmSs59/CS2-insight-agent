/** LiteCut editor presets. */

import effectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_effect_contract.json";
import { textPresetCardStyle } from "./textLayout.js";

const FILTER_THUMBNAIL_BACKGROUNDS = {
  none: "linear-gradient(135deg, #52525b 0%, #27272a 100%)",
  esports: "linear-gradient(135deg, #047857 0%, #18181b 100%)",
  cold: "linear-gradient(135deg, #155e75 0%, #0f172a 100%)",
  warm: "linear-gradient(135deg, #92400e 0%, #1c1917 100%)",
  vintage: "linear-gradient(135deg, #78350f 0%, #0c0a09 100%)",
  highcon: "linear-gradient(135deg, #404040 0%, #000000 100%)",
  fade: "linear-gradient(135deg, #78716c 0%, #292524 100%)",
  night: "linear-gradient(135deg, #172554 0%, #000000 100%)",
};

export const FILTER_PRESETS = effectContract.filter_presets.map((preset) => ({
  id: preset.id,
  label: preset.label_zh,
  filter: preset.css,
  ffmpeg: preset.ffmpeg,
  thumb: preset.thumb,
  thumbnailBackground: FILTER_THUMBNAIL_BACKGROUNDS[preset.id] || FILTER_THUMBNAIL_BACKGROUNDS.none,
}));

export function filterStyleFromColor({ brightness = 0, contrast = 0, saturation = 0, preset = "none" } = {}) {
  const presetFilter = FILTER_PRESETS.find((item) => item.id === preset)?.filter;
  const brightnessScale = 1 + (Number(brightness) || 0) / 100;
  const contrastScale = 1 + (Number(contrast) || 0) / 100;
  const saturationScale = 1 + (Number(saturation) || 0) / 100;
  return {
    filter: [
      presetFilter,
      `brightness(${brightnessScale})`,
      `contrast(${contrastScale})`,
      `saturate(${saturationScale})`,
    ]
      .filter((value) => value && value !== "none")
      .join(" "),
  };
}

/** Text presets only expose effects supported by the shared preview/export contract. */
export const TEXT_STYLE_CARDS = effectContract.text_style_presets.map((preset) => ({
  id: preset.id,
  group: preset.group,
  label: preset.label_zh,
  preview: preset.preview,
  sample: preset.sample,
  className: "font-bold",
  previewStyle: textPresetCardStyle(preset.id),
  cardClass: "",
  cardStyle: { background: preset.card_background },
}));

export const FONT_OPTIONS = effectContract.text_fonts.map((font) => font.family);
export const CANVAS_PRESETS = effectContract.canvas_presets.map((preset) => ({ ...preset }));

export const TRANSITION_OPTIONS = effectContract.transition_model.types.map((transition) => ({
  id: transition.id,
  label: transition.label_zh,
  icon: transition.icon,
  builtin: true,
}));

export const TRANSITION_DURATION_MIN = Number(effectContract.transition_model.limits.duration_min) || 0.05;
export const TRANSITION_DURATION_MAX = Number(effectContract.transition_model.limits.duration_max) || 10;
export const TRANSITION_DURATION_DEFAULT = Number(effectContract.transition_model.limits.duration_default) || 0.4;
