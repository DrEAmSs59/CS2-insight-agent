export const DEFAULT_RECORDING_WEATHER_EFFECT = "default";
export const SNOW_RECORDING_WEATHER_EFFECT = "snow";
export const RAIN_RECORDING_WEATHER_EFFECT = "rain";

export const RECORDING_WEATHER_EFFECT_OPTIONS = Object.freeze([
  DEFAULT_RECORDING_WEATHER_EFFECT,
  RAIN_RECORDING_WEATHER_EFFECT,
]);

const RECORDING_WEATHER_EFFECT_SET = new Set(RECORDING_WEATHER_EFFECT_OPTIONS);

export function isRecordingWeatherEffectId(value) {
  return typeof value === "string" && RECORDING_WEATHER_EFFECT_SET.has(value);
}

export function normalizeRecordingWeatherEffectId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isRecordingWeatherEffectId(normalized)
    ? normalized
    : DEFAULT_RECORDING_WEATHER_EFFECT;
}
