import effectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_effect_contract.json";

export const AUDIO_MIX_CONTRACT = Object.freeze({ ...(effectContract.audio_mix || {}) });

function gainRange(kind, fallbackMaximum) {
  const raw = AUDIO_MIX_CONTRACT.gain_limits?.[kind];
  const rawDefault = Number(AUDIO_MIX_CONTRACT.gain_defaults?.[kind]);
  const minimum = Number(raw?.[0]);
  const maximum = Number(raw?.[1]);
  return Object.freeze({
    min: Number.isFinite(minimum) ? minimum : 0,
    max: Number.isFinite(maximum) ? maximum : fallbackMaximum,
    default: Number.isFinite(rawDefault) ? rawDefault : 1,
  });
}

export const AUDIO_CLIP_GAIN = gainRange("clip", 5);
export const AUDIO_TRACK_GAIN = gainRange("track", 2);
export const AUDIO_MASTER_GAIN = gainRange("master", 2);
export const AUDIO_BGM_GAIN = gainRange("bgm", 2);

const duckingGain = AUDIO_MIX_CONTRACT.ducking?.gain || {};
export const AUDIO_DUCKING_GAIN = Object.freeze({
  min: Number.isFinite(Number(duckingGain.min)) ? Number(duckingGain.min) : 0,
  max: Number.isFinite(Number(duckingGain.max)) ? Number(duckingGain.max) : 1,
  default: Number.isFinite(Number(duckingGain.default)) ? Number(duckingGain.default) : 0.35,
});

const fadeDuration = AUDIO_MIX_CONTRACT.fade_duration_sec || {};
export const AUDIO_FADE_DURATION = Object.freeze({
  min: Number.isFinite(Number(fadeDuration.min)) ? Number(fadeDuration.min) : 0,
  max: Number.isFinite(Number(fadeDuration.max)) ? Number(fadeDuration.max) : 86400,
  uiMax: Number.isFinite(Number(fadeDuration.ui_max)) ? Number(fadeDuration.ui_max) : 10,
  default: Number.isFinite(Number(fadeDuration.default)) ? Number(fadeDuration.default) : 0,
});

export function clampAudioGain(value, range, fallback = range?.default ?? 1) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(Number(range?.min) || 0, Math.min(Number(range?.max) || 0, safe));
}
