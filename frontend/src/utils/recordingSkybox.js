export const DEFAULT_RECORDING_SKYBOX = "default";
export const RECORDING_SKYBOX_RESET_EVENT = "cs2-insight:recording-skybox-reset";

export const RECORDING_SKYBOX_OPTIONS = Object.freeze([
  { value: DEFAULT_RECORDING_SKYBOX, labelKey: "record.skyboxDefault" },
  { value: "cartoon3", labelKey: "record.skyboxCartoon3" },
  { value: "xuejing", labelKey: "record.skyboxXuejing" },
  { value: "yinhezhanjian", labelKey: "record.skyboxYinhezhanjian" },
]);

const RECORDING_SKYBOX_IDS = new Set(RECORDING_SKYBOX_OPTIONS.map(({ value }) => value));
const CUSTOM_RECORDING_SKYBOX_ID = /^custom:[0-9a-f]{32}$/;

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
