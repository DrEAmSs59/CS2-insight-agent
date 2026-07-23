const EXACT_KEYS = new Set([
  "cs2-insight-theme",
  "liteCut:panelLayout",
  "liteCut:lastProjectId",
]);
const KEY_PREFIXES = ["liteCut:recovery:v1:"];

export function isLegacyUiStateKey(key) {
  return EXACT_KEYS.has(key) || KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function applyLegacyElectronUiState(raw, storage = globalThis.localStorage) {
  if (!raw || !storage) return [];
  let body;
  try {
    body = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (body?.version !== 1 || !body.local_storage || typeof body.local_storage !== "object") {
    return [];
  }

  const restored = [];
  for (const [key, value] of Object.entries(body.local_storage)) {
    if (!isLegacyUiStateKey(key) || typeof value !== "string") continue;
    try {
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, value);
      restored.push(key);
    } catch {
      // A full or policy-disabled localStorage must not prevent app startup.
    }
  }
  return restored;
}

export async function restoreLegacyElectronUiState() {
  if (!globalThis.__TAURI_INTERNALS__) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke("read_legacy_ui_state");
    return applyLegacyElectronUiState(raw);
  } catch {
    return [];
  }
}
