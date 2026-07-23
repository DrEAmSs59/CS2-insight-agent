import "./index.css";
import { restoreLegacyElectronUiState } from "./utils/legacyElectronUiState";

restoreLegacyElectronUiState().finally(() => import("./renderApp.jsx"));
