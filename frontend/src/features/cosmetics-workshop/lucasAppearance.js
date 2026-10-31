import { useSyncExternalStore } from "react";
import { backgrounds } from "./lucasBackgrounds.js";

export const LUCAS_BACKGROUND_KEY = "cs2-insight:lucas-background:v1";
export const LUCAS_SETTINGS_KEY = "cs2-insight:lucas-settings:v1";
const changed = "cs2-insight:lucas-background-changed";
const defaultBackground = "solid";
const valid = value => value === "" || value === "solid" || backgrounds.some(row => row.value === value);

// The settings record holds the background; the older background-only key is still honoured.
function readBackground() {
  try {
    const saved = JSON.parse(localStorage.getItem(LUCAS_SETTINGS_KEY))?.background;
    if (valid(saved)) return saved;
    const legacy = localStorage.getItem(LUCAS_BACKGROUND_KEY);
    return valid(legacy) ? legacy : defaultBackground;
  } catch {
    return defaultBackground;
  }
}
function subscribe(listener) {
  const storage = event => { if ([LUCAS_BACKGROUND_KEY, LUCAS_SETTINGS_KEY, null].includes(event.key)) listener(); };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(changed, listener);
  };
}
/** Page background of the workshop, Demo analysis, Demo library and recording queue. */
export function useLucasBackground() {
  return useSyncExternalStore(subscribe, readBackground, () => defaultBackground);
}
export function saveLucasBackground(value) {
  if (!valid(value)) throw new Error("Unknown background");
  localStorage.setItem(LUCAS_SETTINGS_KEY, JSON.stringify({ background: value }));
  window.dispatchEvent(new Event(changed));
}
