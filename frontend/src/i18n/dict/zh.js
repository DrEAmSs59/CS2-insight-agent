import { mergeCatalogs } from "../catalog.js";
import common from "./locales/zh/common.js";
import api from "./locales/zh/api.js";
import guide from "./locales/zh/guide.js";
import library from "./locales/zh/library.js";
import analysis from "./locales/zh/analysis.js";
import dialogs from "./locales/zh/dialogs.js";
import settings from "./locales/zh/settings.js";
import recording from "./locales/zh/recording.js";
import montage from "./locales/zh/montage.js";
import liteCut from "./locales/zh/liteCut.js";
import match from "./locales/zh/match.js";
import app from "./locales/zh/app.js";
import cosmeticsWorkshop from "./locales/zh/cosmeticsWorkshop.js";

export default mergeCatalogs("zh", {
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
  cosmeticsWorkshop,
});
