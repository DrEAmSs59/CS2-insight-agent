const SHOW_GUIDE_KEY = "cs2-insight:show-guide-on-startup";

export function readShowGuideOnStartup() {
  try {
    return localStorage.getItem(SHOW_GUIDE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveShowGuideOnStartup(value) {
  localStorage.setItem(SHOW_GUIDE_KEY, String(value));
}
