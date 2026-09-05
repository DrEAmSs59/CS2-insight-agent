export const DEFAULT_RECORDING_SKYBOX = "default";
export const RECORDING_SKYBOX_RESET_EVENT = "cs2-insight:recording-skybox-reset";

export const SOLID_COLOR_RECORDING_SKYBOX_IDS = Object.freeze([
  "chroma_blue",
  "chroma_green",
]);

export const BUILTIN_RECORDING_SKYBOX_IDS = Object.freeze([
  "chroma_green",
  "chroma_blue",
  "cartoon",
  "cartoon1",
  "cartoon2",
  "cartoon3",
  "cartoon4",
  "cartoon5",
  "cartoon6",
  "cartoon7",
  "cartoon8",
  "cartoon9",
  "cartoon10",
]);

const BUILTIN_LABEL_KEYS = Object.freeze({
  chroma_green: "record.skyboxChromaGreen",
  chroma_blue: "record.skyboxChromaBlue",
  cartoon3: "record.skyboxCartoon3",
});

export const RECORDING_SKYBOX_OPTIONS = Object.freeze([
  { value: DEFAULT_RECORDING_SKYBOX, labelKey: "record.skyboxDefault" },
  ...BUILTIN_RECORDING_SKYBOX_IDS.map((value) => ({
    value,
    labelKey: BUILTIN_LABEL_KEYS[value] || null,
  })),
]);

const RECORDING_SKYBOX_IDS = new Set(RECORDING_SKYBOX_OPTIONS.map(({ value }) => value));
const BUILTIN_RECORDING_SKYBOX_ORDER = new Map(
  BUILTIN_RECORDING_SKYBOX_IDS.map((value, index) => [value, index]),
);
const SOLID_COLOR_RECORDING_SKYBOX_ID_SET = new Set(SOLID_COLOR_RECORDING_SKYBOX_IDS);
const CUSTOM_RECORDING_SKYBOX_ID = /^custom:[0-9a-f]{32}$/;

export function sortBuiltinRecordingSkyboxes(resources) {
  if (!Array.isArray(resources)) return [];
  return [...resources].sort((left, right) => {
    const leftOrder = BUILTIN_RECORDING_SKYBOX_ORDER.get(left?.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = BUILTIN_RECORDING_SKYBOX_ORDER.get(right?.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left?.id || "").localeCompare(String(right?.id || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function partitionBuiltinRecordingSkyboxes(resources) {
  const sorted = sortBuiltinRecordingSkyboxes(resources);
  return {
    solidColor: SOLID_COLOR_RECORDING_SKYBOX_IDS.flatMap((skyboxId) => (
      sorted.filter((item) => item?.id === skyboxId)
    )),
    standard: sorted.filter((item) => !SOLID_COLOR_RECORDING_SKYBOX_ID_SET.has(item?.id)),
  };
}

export function isCustomRecordingSkyboxId(value) {
  return typeof value === "string" && CUSTOM_RECORDING_SKYBOX_ID.test(value);
}

export function isRecordingSkyboxId(value) {
  return typeof value === "string"
    && (RECORDING_SKYBOX_IDS.has(value) || isCustomRecordingSkyboxId(value));
}

export function normalizeRecordingSkyboxId(value) {
  return isRecordingSkyboxId(value) ? value : DEFAULT_RECORDING_SKYBOX;
}

export function recordingSkyboxPreviewUrl(value, resources = []) {
  const skyboxId = normalizeRecordingSkyboxId(value);
  const resource = Array.isArray(resources)
    ? resources.find((item) => item?.id === skyboxId)
    : null;
  if (typeof resource?.preview_url === "string" && resource.preview_url.trim()) {
    return resource.preview_url.trim();
  }
  return RECORDING_SKYBOX_IDS.has(skyboxId) && skyboxId !== DEFAULT_RECORDING_SKYBOX
    ? `/skyboxes/${skyboxId}.webp`
    : "";
}

export function recordingSkyboxDisplayName(value, fallback, t) {
  const skyboxId = String(value || "").trim();
  const labelKey = BUILTIN_LABEL_KEYS[skyboxId];
  if (labelKey && typeof t === "function") return t(labelKey);
  if (String(fallback || "").trim()) return String(fallback).trim();
  const cartoon = /^cartoon(\d*)$/.exec(skyboxId);
  if (cartoon) return `Cartoon ${cartoon[1]}`.trim();
  return skyboxId;
}
