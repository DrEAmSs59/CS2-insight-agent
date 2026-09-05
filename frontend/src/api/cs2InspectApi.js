import API from "./api.js";
import { desktopBridge } from "../desktop/desktopBridge.js";

/**
 * Launch a self-contained CS2 inspect payload on the local host.
 *
 * The backend path is primary so browser development and packaged desktop
 * builds use the same Insight-owned launch chain. The Tauri command remains a
 * fallback for the short backend-startup window in packaged builds.
 */
export async function launchCs2InspectOnHost(hex) {
  const payload = String(hex || "").trim();
  let backendError = null;
  try {
    const { data } = await API.post("/cs2/inspect", { hex: payload });
    return data;
  } catch (error) {
    backendError = error;
  }

  if (typeof desktopBridge?.launchCs2Inspect === "function") {
    await desktopBridge.launchCs2Inspect(payload);
    return { ok: true };
  }
  throw backendError;
}
