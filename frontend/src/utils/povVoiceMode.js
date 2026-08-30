export const DEFAULT_POV_VOICE_MODE = "team";

export const POV_VOICE_MODES = Object.freeze(["all", "team", "enemy", "mute"]);

const POV_VOICE_MODE_SET = new Set(POV_VOICE_MODES);

export function isPovVoiceMode(value) {
  return typeof value === "string" && POV_VOICE_MODE_SET.has(value);
}

export function normalizePovVoiceMode(value, legacyVoiceDisabled = false) {
  if (isPovVoiceMode(value)) return value;
  return legacyVoiceDisabled ? "mute" : DEFAULT_POV_VOICE_MODE;
}
