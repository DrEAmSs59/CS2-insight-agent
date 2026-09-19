export const INPUT_HUD_POSITIONS = Object.freeze([
  "bottom_center",
  "minimap_below",
  "weapon_right",
]);

export const INPUT_HUD_PLACEMENTS = Object.freeze([
  "hidden",
  ...INPUT_HUD_POSITIONS,
]);

export const DEFAULT_INPUT_HUD_POSITION = "bottom_center";

export function isInputHudPosition(value) {
  return INPUT_HUD_POSITIONS.includes(value);
}

export function normalizeInputHudPosition(value, fallback = DEFAULT_INPUT_HUD_POSITION) {
  const text = String(value || "").trim().toLowerCase();
  return isInputHudPosition(text) ? text : fallback;
}

export function inputHudPlacementFromState(enabled, position) {
  if (enabled === false) return "hidden";
  return normalizeInputHudPosition(position);
}

export function inputHudStateFromPlacement(placement) {
  const text = String(placement || "").trim().toLowerCase();
  if (text === "hidden") {
    return { enabled: false, position: DEFAULT_INPUT_HUD_POSITION };
  }
  return {
    enabled: true,
    position: normalizeInputHudPosition(text),
  };
}
