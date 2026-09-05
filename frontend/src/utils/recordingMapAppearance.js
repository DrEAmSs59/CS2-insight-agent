import {
  DEFAULT_RECORDING_MAP_MATERIAL,
  normalizeRecordingMapMaterialId,
  WAXED_REFLECTION_MAP_MATERIAL,
} from "./recordingMapMaterial.js";
import {
  DEFAULT_RECORDING_WEATHER_EFFECT,
  normalizeRecordingWeatherEffectId,
  RAIN_RECORDING_WEATHER_EFFECT,
} from "./recordingWeatherEffect.js";

export const DEFAULT_RECORDING_MAP_APPEARANCE = "default";
export const WAXED_RECORDING_MAP_APPEARANCE = "waxed_reflection";
export const RAIN_RECORDING_MAP_APPEARANCE = "rain";

export const RECORDING_MAP_APPEARANCE_OPTIONS = Object.freeze([
  DEFAULT_RECORDING_MAP_APPEARANCE,
  WAXED_RECORDING_MAP_APPEARANCE,
  RAIN_RECORDING_MAP_APPEARANCE,
]);

export function recordingMapAppearanceId(mapMaterial, weatherEffect) {
  if (normalizeRecordingWeatherEffectId(weatherEffect) === RAIN_RECORDING_WEATHER_EFFECT) {
    return RAIN_RECORDING_MAP_APPEARANCE;
  }
  const material = normalizeRecordingMapMaterialId(mapMaterial);
  return material === WAXED_REFLECTION_MAP_MATERIAL
    ? WAXED_RECORDING_MAP_APPEARANCE
    : DEFAULT_RECORDING_MAP_APPEARANCE;
}

export function splitRecordingMapAppearance(value) {
  if (value === RAIN_RECORDING_MAP_APPEARANCE) {
    return {
      mapMaterial: DEFAULT_RECORDING_MAP_MATERIAL,
      weatherEffect: RAIN_RECORDING_WEATHER_EFFECT,
    };
  }
  if (value === WAXED_RECORDING_MAP_APPEARANCE) {
    return {
      mapMaterial: WAXED_REFLECTION_MAP_MATERIAL,
      weatherEffect: DEFAULT_RECORDING_WEATHER_EFFECT,
    };
  }
  return {
    mapMaterial: DEFAULT_RECORDING_MAP_MATERIAL,
    weatherEffect: DEFAULT_RECORDING_WEATHER_EFFECT,
  };
}
