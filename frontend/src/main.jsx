import "./index.css";
import { restoreLegacyElectronUiState } from "./utils/legacyElectronUiState";
import { installAppInteractionGuards } from "./utils/appInteractionGuards.js";

restoreLegacyElectronUiState();
installAppInteractionGuards();
void import("./renderApp.jsx");
