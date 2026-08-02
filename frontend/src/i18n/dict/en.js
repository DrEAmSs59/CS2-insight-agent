import { mergeCatalogs } from "../catalog.js";
import common from "./locales/en/common.js";
import api from "./locales/en/api.js";
import guide from "./locales/en/guide.js";
import library from "./locales/en/library.js";
import analysis from "./locales/en/analysis.js";
import dialogs from "./locales/en/dialogs.js";
import settings from "./locales/en/settings.js";
import recording from "./locales/en/recording.js";
import montage from "./locales/en/montage.js";
import liteCut from "./locales/en/liteCut.js";
import match from "./locales/en/match.js";
import app from "./locales/en/app.js";

export default mergeCatalogs("en", {
  common,
  api,
  guide,
  library,
  analysis,
  dialogs,
  settings,
  recording,
  montage,
  liteCut,
  match,
  app,
});
