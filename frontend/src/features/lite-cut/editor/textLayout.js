import effectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_effect_contract.json";

export const TEXT_LAYOUT_CONTRACT = effectContract.text_layout;
export const TEXT_STYLE_PRESETS = effectContract.text_style_presets;
export const TEXT_FONT_CATALOG = effectContract.text_fonts;

export const TEXT_FONT_SIZE_MIN = Number(TEXT_LAYOUT_CONTRACT.font_size.min);
export const TEXT_FONT_SIZE_MAX = Number(TEXT_LAYOUT_CONTRACT.font_size.max);
export const TEXT_FONT_SIZE_DEFAULT = Number(TEXT_LAYOUT_CONTRACT.font_size.default);
export const TEXT_FONT_WEIGHT_MIN = Number(TEXT_LAYOUT_CONTRACT.font_weight.min);
export const TEXT_FONT_WEIGHT_MAX = Number(TEXT_LAYOUT_CONTRACT.font_weight.max);
export const TEXT_FONT_WEIGHT_DEFAULT = Number(TEXT_LAYOUT_CONTRACT.font_weight.default);
export const TEXT_LINE_HEIGHT_MIN = Number(TEXT_LAYOUT_CONTRACT.line_height.min);
export const TEXT_LINE_HEIGHT_MAX = Number(TEXT_LAYOUT_CONTRACT.line_height.max);
export const TEXT_LINE_HEIGHT_DEFAULT = Number(TEXT_LAYOUT_CONTRACT.line_height.default);
export const TEXT_DEFAULT_FONT_FAMILY = String(TEXT_LAYOUT_CONTRACT.default_font_family);
export const TEXT_DEFAULT_PRESET_ID = String(TEXT_LAYOUT_CONTRACT.default_preset_id);

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, safe));
}

export function normalizeTextFontSize(value) {
  return Math.round(clampNumber(value, TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX, TEXT_FONT_SIZE_DEFAULT));
}

export function normalizeTextFontWeight(value) {
  return Math.round(clampNumber(value, TEXT_FONT_WEIGHT_MIN, TEXT_FONT_WEIGHT_MAX, TEXT_FONT_WEIGHT_DEFAULT));
}

export function normalizeTextLineHeight(value) {
  return clampNumber(value, TEXT_LINE_HEIGHT_MIN, TEXT_LINE_HEIGHT_MAX, TEXT_LINE_HEIGHT_DEFAULT);
}

export function normalizeTextAlign(value) {
  const align = String(value || "center").trim().toLowerCase();
  return ["left", "center", "right"].includes(align) ? align : "center";
}

export function textStylePreset(presetId) {
  const requested = String(presetId || TEXT_DEFAULT_PRESET_ID).trim().toLowerCase();
  return TEXT_STYLE_PRESETS.find((item) => String(item.id).toLowerCase() === requested)
    || TEXT_STYLE_PRESETS.find((item) => item.id === TEXT_DEFAULT_PRESET_ID)
    || { id: TEXT_DEFAULT_PRESET_ID, fill_color: "#ffffff" };
}

function fontEntryForFamily(fontFamily) {
  const requested = String(fontFamily || TEXT_DEFAULT_FONT_FAMILY).trim().toLowerCase();
  return TEXT_FONT_CATALOG.find((entry) => (
    [entry.family, ...(entry.aliases || [])].some((name) => String(name || "").trim().toLowerCase() === requested)
  )) || TEXT_FONT_CATALOG.find((entry) => entry.family === TEXT_DEFAULT_FONT_FAMILY) || TEXT_FONT_CATALOG[0];
}

export function canonicalTextFontFamily(fontFamily) {
  return String(fontEntryForFamily(fontFamily)?.family || TEXT_DEFAULT_FONT_FAMILY);
}

export function resolveBuiltinTextFontFace(fontFamily, fontWeight) {
  const entry = fontEntryForFamily(fontFamily);
  const weight = normalizeTextFontWeight(fontWeight ?? entry?.default_weight);
  const faces = Array.isArray(entry?.faces) ? entry.faces : [];
  const face = faces.find((candidate) => (
    weight >= Number(candidate.weight_min) && weight <= Number(candidate.weight_max)
  )) || faces[0] || {};
  return { ...face, family: String(entry?.family || TEXT_DEFAULT_FONT_FAMILY), weight };
}

export function previewFontFamilyForFace(face) {
  const suffix = String(face?.file || face?.family || "default").replace(/[^a-zA-Z0-9_]/g, "_");
  return `LiteCutBuiltinFont_${suffix}`;
}

export function normalizeTextLayout(text = {}) {
  const source = text && typeof text === "object" && !Array.isArray(text) ? text : {};
  return {
    fontFamily: canonicalTextFontFamily(source.font_family),
    fontSize: normalizeTextFontSize(source.font_size),
    fontWeight: normalizeTextFontWeight(source.font_weight),
    lineHeight: normalizeTextLineHeight(source.line_height),
    letterSpacing: 0,
    align: normalizeTextAlign(source.align),
    presetId: String(source.preset_id || TEXT_DEFAULT_PRESET_ID),
    fillColor: /^#[0-9a-f]{6}$/i.test(String(source.fill_color || "")) ? String(source.fill_color).toLowerCase() : null,
  };
}

export function textOutlineCss(canvasHeight = 1080) {
  const outline = TEXT_LAYOUT_CONTRACT.outline;
  const widthCqh = (Number(outline.width_output_px) / Math.max(1, Number(canvasHeight) || 1080)) * 100;
  const hex = String(outline.color || "#000000").replace("#", "");
  const red = Number.parseInt(hex.slice(0, 2), 16) || 0;
  const green = Number.parseInt(hex.slice(2, 4), 16) || 0;
  const blue = Number.parseInt(hex.slice(4, 6), 16) || 0;
  const color = `rgba(${red}, ${green}, ${blue}, ${clampNumber(outline.opacity, 0, 1, 0.72)})`;
  return `${widthCqh}cqh ${color}`;
}

export function textBlockJustifyContent(align) {
  return { left: "flex-start", center: "center", right: "flex-end" }[normalizeTextAlign(align)];
}

export function textPresetCardStyle(presetId) {
  const preset = textStylePreset(presetId);
  return {
    color: preset.fill_color || "#ffffff",
    WebkitTextStroke: "1px rgba(0, 0, 0, 0.72)",
    paintOrder: "stroke fill",
  };
}
