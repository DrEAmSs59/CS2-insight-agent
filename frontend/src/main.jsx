import "./index.css";
import { restoreLegacyElectronUiState } from "./utils/legacyElectronUiState";

restoreLegacyElectronUiState();
void import("./renderApp.jsx");
