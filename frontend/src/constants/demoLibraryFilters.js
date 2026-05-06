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
  { value: "pending", label: "待解析" },
  { value: "done", label: "已完成" },
  { value: "error", label: "解析失败" },
];

export const DEMO_LIBRARY_STATUS_LABELS = {
  pending: "待解析",
  done: "已完成",
  parsed: "已完成",
  error: "解析失败",
};

export function demoLibraryStatusLabel(code) {
  if (code == null || code === "") return "—";
  const key = String(code).trim().toLowerCase();
  return DEMO_LIBRARY_STATUS_LABELS[key] ?? String(code);
}
