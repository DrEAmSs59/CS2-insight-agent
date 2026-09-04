export const DEFAULT_RECORDING_MAP_MATERIAL = "default";
export const WAXED_REFLECTION_MAP_MATERIAL = "waxed_reflection";
export const RAIN_PUDDLES_MAP_MATERIAL = "rain_puddles";

export const RECORDING_MAP_MATERIAL_OPTIONS = Object.freeze([
  DEFAULT_RECORDING_MAP_MATERIAL,
  WAXED_REFLECTION_MAP_MATERIAL,
]);

const RECORDING_MAP_MATERIAL_SET = new Set(RECORDING_MAP_MATERIAL_OPTIONS);

export function isRecordingMapMaterialId(value) {
  return typeof value === "string" && RECORDING_MAP_MATERIAL_SET.has(value);
}

export function normalizeRecordingMapMaterialId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isRecordingMapMaterialId(normalized)
    ? normalized
    : DEFAULT_RECORDING_MAP_MATERIAL;
}
