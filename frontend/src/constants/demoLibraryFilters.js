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

export const DEMO_LIBRARY_STATUS_FILTER_OPTIONS = [
  { value: "loaded", label: "已入库（待高光）" },
  { value: "parsing", label: "解析中" },
  { value: "done", label: "已完成高光" },
  { value: "error", label: "解析失败" },
];

export const DEMO_LIBRARY_STATUS_LABELS = {
  pending: "待入库",
  loaded: "已入库",
  parsing: "解析中",
  done: "已完成高光",
  parsed: "已完成高光",
  error: "解析失败",
};

export function demoLibraryStatusLabel(code) {
  if (code == null || code === "") return "—";
  const key = String(code).trim().toLowerCase();
  return DEMO_LIBRARY_STATUS_LABELS[key] ?? String(code);
}
