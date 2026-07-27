import "./index.css";
import { restoreLegacyElectronUiState } from "./utils/legacyElectronUiState";

async function configureDesktopSession() {
  if (!window.__TAURI_INTERNALS__) return;
  const [{ invoke }, { setDesktopSessionToken }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("./api/api.js"),
  ]);
  setDesktopSessionToken(await invoke("backend_session_token"));
}

configureDesktopSession()
  .catch((error) => console.error("[Desktop Session] Token bootstrap failed", error))
  .then(() => restoreLegacyElectronUiState())
  .finally(() => import("./renderApp.jsx"));
