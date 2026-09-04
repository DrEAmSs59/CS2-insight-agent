import { isRecordingSkyboxId } from "./recordingSkybox.js";
import {
  DEFAULT_RECORDING_MAP_MATERIAL,
  isRecordingMapMaterialId,
  normalizeRecordingMapMaterialId,
  RAIN_PUDDLES_MAP_MATERIAL,
} from "./recordingMapMaterial.js";
import {
  DEFAULT_RECORDING_WEATHER_EFFECT,
  isRecordingWeatherEffectId,
  normalizeRecordingWeatherEffectId,
  RAIN_RECORDING_WEATHER_EFFECT,
} from "./recordingWeatherEffect.js";
import { isPovVoiceMode, normalizePovVoiceMode } from "./povVoiceMode.js";

export const RECORDING_PRESET_FORMAT = "cs2-insight-recording-preset";
export const RECORDING_PRESET_VERSION = 7;
export const RECORDING_PRESET_MAX_BYTES = 256 * 1024;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const PACING_NUMBER_RANGES = {
  pre_first_sec: [0, 20],
  post_last_sec: [0, 10],
  max_gap_sec: [2, 70],
  victim_pov_pre_sec: [0, 5],
  victim_pov_post_sec: [0, 5],
  killer_pov_pre_sec: [0, 5],
  killer_pov_post_sec: [0, 5],
};
const PACING_BOOLEAN_KEYS = [
  "default_victim_pov",
  "default_killer_pov",
  "default_pov_interleaved",
];

function invalid(field, reason = "invalid") {
  const error = new Error(reason);
  error.field = field;
  throw error;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") invalid(field, "type");
  return value;
}

function requireNumber(value, field, min, max, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "type");
  if ((integer && !Number.isInteger(value)) || value < min || value > max) invalid(field, "range");
  return value;
}

function requireString(value, field, maxLength = 8192) {
  if (typeof value !== "string") invalid(field, "type");
  if (value.length > maxLength) invalid(field, "range");
  return value;
}

function parsePacing(value) {
  if (!isObject(value)) invalid("recording_global_pacing", "type");
  const result = {};
  for (const [key, [min, max]] of Object.entries(PACING_NUMBER_RANGES)) {
    if (Object.hasOwn(value, key)) result[key] = requireNumber(value[key], `recording_global_pacing.${key}`, min, max);
  }
  for (const key of PACING_BOOLEAN_KEYS) {
    if (Object.hasOwn(value, key)) result[key] = requireBoolean(value[key], `recording_global_pacing.${key}`);
  }
  return result;
}

function parseWarmup(value, defaults) {
  if (!isObject(value)) invalid("default_record_warmup", "type");
  const legacyVoiceDisabled = Object.hasOwn(value, "pov_voice_disabled")
    ? requireBoolean(value.pov_voice_disabled, "default_record_warmup.pov_voice_disabled")
    : false;
  const result = { ...defaults };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!Object.hasOwn(value, key)) continue;
    const field = `default_record_warmup.${key}`;
    if (typeof defaultValue === "boolean") result[key] = requireBoolean(value[key], field);
    else if (key === "fov_cs_debug") result[key] = requireNumber(value[key], field, 60, 120);
    else if (key === "spectator_flashbang_opacity") result[key] = requireNumber(value[key], field, 0.2, 1);
    else if (key === "pov_radar_mode") {
      const n = requireNumber(value[key], field, -1, 0, true);
      if (n !== -1 && n !== 0) invalid(field, "range");
      result[key] = n;
    } else if (key === "pov_voice_mode") {
      const text = requireString(value[key], field, 16);
      if (!isPovVoiceMode(text)) invalid(field, "range");
      result[key] = text;
    } else if (key === "input_hud_display_mode") {
      const text = requireString(value[key], field, 16);
      if (!["hybrid", "always", "active"].includes(text)) invalid(field, "range");
      result[key] = "hybrid";
    } else if (key === "aspect_ratio") {
      const text = requireString(value[key], field, 8);
      if (!["", "4:3", "16:9", "16:10"].includes(text)) invalid(field, "range");
      result[key] = text;
    } else if (key === "resolution_width" || key === "resolution_height") {
      const text = requireString(value[key], field, 8);
      if (text !== "" && (!/^\d+$/.test(text) || Number(text) <= 0 || Number(text) > 16384)) invalid(field, "range");
      result[key] = text;
    }
  }
  result.pov_voice_mode = normalizePovVoiceMode(
    Object.hasOwn(value, "pov_voice_mode") ? result.pov_voice_mode : undefined,
    legacyVoiceDisabled,
  );
  result.pov_radar_mode = 0;
  return result;
}

export function buildRecordingPresetFile(preset, exportedAt = new Date().toISOString()) {
  return {
    format: RECORDING_PRESET_FORMAT,
    version: RECORDING_PRESET_VERSION,
    exported_at: exportedAt,
    preset,
  };
}

/** Validate an imported share file and return only fields supported by this client. */
export function parseRecordingPresetFile(value, warmupDefaults) {
  if (!isObject(value)) invalid("root", "type");
  if (value.format !== RECORDING_PRESET_FORMAT) invalid("format", "format");
  if (![1, 2, 3, 4, 5, 6, RECORDING_PRESET_VERSION].includes(value.version)) invalid("version", "version");
  if (!isObject(value.preset)) invalid("preset", "type");

  const p = value.preset;
  const result = {
    recording_global_pacing: parsePacing(p.recording_global_pacing),
    default_record_warmup: parseWarmup(p.default_record_warmup, warmupDefaults),
    cs2_extra_launch_args: requireString(p.cs2_extra_launch_args, "cs2_extra_launch_args"),
    record_inject_console_lines: requireString(p.record_inject_console_lines, "record_inject_console_lines", 32768),
    obs_transition_enabled: requireBoolean(p.obs_transition_enabled, "obs_transition_enabled"),
    obs_transition_name: requireString(p.obs_transition_name, "obs_transition_name", 128),
    obs_transition_duration_ms: requireNumber(p.obs_transition_duration_ms, "obs_transition_duration_ms", 0, 10000, true),
    experimental_pov_enabled: requireBoolean(p.experimental_pov_enabled, "experimental_pov_enabled"),
    recording_skybox: Object.hasOwn(p, "recording_skybox")
      ? requireString(p.recording_skybox, "recording_skybox", 64)
      : "default",
    recording_map_material: Object.hasOwn(p, "recording_map_material")
      ? requireString(p.recording_map_material, "recording_map_material", 64)
      : "default",
    recording_weather_effect: Object.hasOwn(p, "recording_weather_effect")
      ? requireString(p.recording_weather_effect, "recording_weather_effect", 64)
      : DEFAULT_RECORDING_WEATHER_EFFECT,
  };
  if (!isRecordingSkyboxId(result.recording_skybox)) {
    invalid("recording_skybox", "range");
  }
  const legacyRainMaterial = result.recording_map_material.trim().toLowerCase()
    === RAIN_PUDDLES_MAP_MATERIAL;
  if (legacyRainMaterial) {
    result.recording_map_material = DEFAULT_RECORDING_MAP_MATERIAL;
    result.recording_weather_effect = RAIN_RECORDING_WEATHER_EFFECT;
  }
  if (!isRecordingMapMaterialId(result.recording_map_material)) {
    invalid("recording_map_material", "range");
  }
  if (!isRecordingWeatherEffectId(result.recording_weather_effect)) {
    invalid("recording_weather_effect", "range");
  }
  result.recording_map_material = normalizeRecordingMapMaterialId(
    result.recording_map_material,
  );
  result.recording_weather_effect = normalizeRecordingWeatherEffectId(
    result.recording_weather_effect,
  );
  if (
    result.recording_map_material !== DEFAULT_RECORDING_MAP_MATERIAL
    && result.recording_weather_effect !== DEFAULT_RECORDING_WEATHER_EFFECT
  ) {
    invalid("recording_weather_effect", "conflict");
  }
  return result;
}
