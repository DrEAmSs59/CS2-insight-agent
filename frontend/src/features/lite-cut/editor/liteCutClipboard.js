import { desktopBridge } from "../../../desktop/desktopBridge.js";

export async function writeLiteCutClipboardText(value, {
  bridge = desktopBridge,
  clipboard = globalThis.navigator?.clipboard,
} = {}) {
  const text = String(value || "");
  if (!text) return false;
  try {
    if (bridge?.writeClipboardText) {
      await bridge.writeClipboardText(text);
      return true;
    }
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Copying is a convenience; callers keep the path visible on failure.
  }
  return false;
}
