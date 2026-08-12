import effectContract from "../../../../../data/lite_cut_effect_contract.json";

const materialContract = effectContract.visual_material || {};
const capabilityMap = materialContract.capabilities || {};
const fitValues = new Set(materialContract.content_fit_values || ["inherit", "fill", "contain", "cover", "blur"]);
export const VISUAL_MATERIAL_LIMITS = Object.freeze({ ...(materialContract.limits || {}) });
export const VISUAL_MATERIAL_DEFAULTS = Object.freeze({ ...(materialContract.defaults || {}) });
export const VISUAL_CROP_DEFAULTS = Object.freeze({ ...(VISUAL_MATERIAL_DEFAULTS.crop || {}) });
export const VISUAL_CROP_POSITION_MIN = Number(VISUAL_MATERIAL_LIMITS.crop_position_min) || 0;
export const VISUAL_CROP_POSITION_MAX = Number(VISUAL_MATERIAL_LIMITS.crop_position_max) || 1;
export const VISUAL_CROP_SIZE_MIN = Number(VISUAL_MATERIAL_LIMITS.crop_size_min) || 0.05;
export const VISUAL_CROP_SIZE_MAX = Number(VISUAL_MATERIAL_LIMITS.crop_size_max) || 1;
export const VISUAL_SPEED_DEFAULT = Number(VISUAL_MATERIAL_DEFAULTS.speed) || 1;
export const VISUAL_SPEED_MIN = Number(VISUAL_MATERIAL_LIMITS.speed_min) || 0.25;
export const VISUAL_SPEED_MAX = Number(VISUAL_MATERIAL_LIMITS.speed_max) || 4;
export const VISUAL_FREEZE_DEFAULT_SEC = Number(VISUAL_MATERIAL_DEFAULTS.freeze_frame_sec) || 0;
export const VISUAL_FREEZE_MIN_SEC = Number(VISUAL_MATERIAL_LIMITS.freeze_min_sec) || 0;
export const VISUAL_FREEZE_MAX_SEC = Number(VISUAL_MATERIAL_LIMITS.freeze_max_sec) || 30;
export const VISUAL_COLOR_DEFAULT = Number(VISUAL_MATERIAL_DEFAULTS.color_adjustment) || 0;
export const VISUAL_COLOR_MIN = Number(VISUAL_MATERIAL_LIMITS.color_adjustment_min) || -100;
export const VISUAL_COLOR_MAX = Number(VISUAL_MATERIAL_LIMITS.color_adjustment_max) || 100;

export const VISUAL_CONTENT_FIT_VALUES = [...fitValues];

export function visualMaterialKind(node, { timelineClip = false } = {}) {
  if (timelineClip) return "video_clip";
  if (String(node?.type || "").toLowerCase() === "text") return "text_overlay";
  const kind = String(node?.meta?.kind || node?.type || "").toLowerCase();
  const animated = Boolean(node?.meta?.is_looping_animation) || ["video", "webm", "gif", "animated_webp"].includes(kind);
  return animated ? "animated_overlay" : "image_overlay";
}

export function visualMaterialCapabilities(node, options = {}) {
  return new Set(capabilityMap[visualMaterialKind(node, options)] || []);
}

export function visualMaterialSupports(node, capability, options = {}) {
  return visualMaterialCapabilities(node, options).has(String(capability));
}

export function visualContentFit(node, fallback = "contain") {
  const raw = String(node?.content_fit || "").toLowerCase();
  if (raw !== "inherit" && fitValues.has(raw)) return raw;
  const inherited = String(fallback || "contain").toLowerCase();
  return fitValues.has(inherited) && inherited !== "inherit" ? inherited : "contain";
}

export function normalizeVisualCrop(crop) {
  const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : Number(fallback);
  };
  const width = Math.max(VISUAL_CROP_SIZE_MIN, Math.min(VISUAL_CROP_SIZE_MAX, finite(crop?.width, VISUAL_CROP_DEFAULTS.width)));
  const height = Math.max(VISUAL_CROP_SIZE_MIN, Math.min(VISUAL_CROP_SIZE_MAX, finite(crop?.height, VISUAL_CROP_DEFAULTS.height)));
  return {
    x: Math.max(VISUAL_CROP_POSITION_MIN, Math.min(VISUAL_CROP_POSITION_MAX - width, finite(crop?.x, VISUAL_CROP_DEFAULTS.x))),
    y: Math.max(VISUAL_CROP_POSITION_MIN, Math.min(VISUAL_CROP_POSITION_MAX - height, finite(crop?.y, VISUAL_CROP_DEFAULTS.y))),
    width,
    height,
  };
}

export function normalizeVisualMaterialFields(body) {
  let changed = false;
  const nodes = [
    ...(body?.tracks || []).filter((track) => track?.type === "video").flatMap((track) => track.clips || []),
    ...(body?.overlays || []),
  ];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (node.crop && typeof node.crop === "object") {
      const normalized = normalizeVisualCrop(node.crop);
      if (["x", "y", "width", "height"].some((field) => Number(node.crop[field] ?? (field === "width" || field === "height" ? 1 : 0)) !== normalized[field])) {
        node.crop = normalized;
        changed = true;
      }
    }
  }
  return changed;
}
