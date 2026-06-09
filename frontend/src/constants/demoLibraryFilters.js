/** Demo 库地图筛选下拉项（顺序固定）。 */
export const DEMO_LIBRARY_MAP_OPTIONS = [
  "de_dust2",
  "de_mirage",
  "de_inferno",
  "de_ancient",
  "de_nuke",
  "de_anubis",
  "de_overpass",
  "de_train",
  "de_cache",
  "de_vertigo",
];

/** Filter options — label field is intentionally omitted; consumers use t() via STATUS_FILTER_LABELS map. */
export const DEMO_LIBRARY_STATUS_FILTER_OPTIONS = [
  { value: "loaded" },
  { value: "parsing" },
  { value: "done" },
  { value: "error" },
];

/** Maps raw status codes to i18n keys (consumers call t(key)). */
export const DEMO_LIBRARY_STATUS_I18N_KEYS = {
  pending: "status.pending",
  loaded: "status.loaded",
  parsing: "status.parsing",
  done: "library.statusFilterDone",
  parsed: "library.statusFilterDone",
  error: "status.error",
};

/**
 * Returns an i18n key for the given status code.
 * Consumers must call t(key) to produce the display string.
 */
export function demoLibraryStatusI18nKey(code) {
  if (code == null || code === "") return null;
  const key = String(code).trim().toLowerCase();
  return DEMO_LIBRARY_STATUS_I18N_KEYS[key] ?? null;
}
