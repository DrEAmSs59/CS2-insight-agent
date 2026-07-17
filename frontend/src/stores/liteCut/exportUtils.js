import API from "../../api/api.js";
import { ensureMp4Filename } from "../../utils/montageUtils.js";
import { mainVideoClips } from "./timelineUtils.js";

function dirnamePath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : s;
}

function joinPathSegments(base, ...segments) {
  const sep = String(base || "").includes("\\") ? "\\" : "/";
  const parts = [String(base || "").replace(/[/\\]+$/, ""), ...segments.filter(Boolean)];
  return parts.join(sep);
}

/** Default export folder beside recorded clips, or from project body.output.dir */
export function resolveLiteCutOutputDir(body, mediaCache = {}) {
  const trimmed = String(body?.output?.dir || "").trim();
  if (trimmed) return trimmed.replace(/[/\\]+$/, "");

  for (const clip of mainVideoClips(body)) {
    if (clip.source_type === "file" && clip.file_path) {
      return joinPathSegments(dirnamePath(clip.file_path), "exports", "lite-cut");
    }
    const row = mediaCache[clip.source_id];
    const p = row?.output_path || row?._raw?.output_path;
    if (p) {
      return joinPathSegments(dirnamePath(p), "exports", "lite-cut");
    }
  }
  return "";
}

export function buildLiteCutOutputPath(outputDir, filename) {
  const dir = String(outputDir || "").trim().replace(/[/\\]+$/, "");
  const fn = ensureMp4Filename(filename);
  if (!dir || !fn) return "";
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${fn}`;
}

export function defaultLiteCutFilename(body, projectName) {
  const fromBody = String(body?.output?.filename || "").trim();
  if (fromBody) return ensureMp4Filename(fromBody);
  const base = String(projectName || "lite_cut")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return ensureMp4Filename(base || "lite_cut_export");
}

export function normalizeLiteCutExportRange(output = {}, totalSec = 0) {
  const rangeMode = output?.range_mode === "custom" ? "custom" : "full";
  const timelineEnd = Math.max(0, Number(totalSec) || 0);
  const fallbackEnd = timelineEnd > 0 ? timelineEnd : 1;
  const rawStart = Number(output?.range_start_sec);
  const rawEnd = Number(output?.range_end_sec);
  const maxStart = Math.max(0, fallbackEnd - 0.1);
  const rangeStartSec = Math.max(0, Math.min(maxStart, Number.isFinite(rawStart) ? rawStart : 0));
  const nextEnd = Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : fallbackEnd;
  const rangeEndSec = Math.max(rangeStartSec + 0.1, timelineEnd > 0 ? Math.min(timelineEnd, nextEnd) : nextEnd);
  return {
    rangeMode,
    rangeStartSec,
    rangeEndSec,
    rangeValid: rangeMode !== "custom" || rangeEndSec > rangeStartSec + 0.05,
  };
}

export function liteCutRangePatchFromPlayhead(output = {}, totalSec = 0, playheadSec = 0, edge = "start") {
  const range = normalizeLiteCutExportRange({ ...output, range_mode: "custom" }, totalSec);
  const timelineEnd = Math.max(0.1, Number(totalSec) || range.rangeEndSec || 1);
  const t = Math.max(0, Math.min(timelineEnd, Number(playheadSec) || 0));
  if (edge === "end") {
    return {
      range_mode: "custom",
      range_start_sec: Math.max(0, Math.min(timelineEnd - 0.1, range.rangeStartSec)),
      range_end_sec: Math.max(range.rangeStartSec + 0.1, t),
    };
  }
  const start = Math.max(0, Math.min(timelineEnd - 0.1, t));
  return {
    range_mode: "custom",
    range_start_sec: start,
    range_end_sec: Math.max(start + 0.1, range.rangeEndSec),
  };
}

export function liteCutRangePatchFromDraggedEdge(output = {}, totalSec = 0, edgeTimeSec = 0, edge = "start") {
  const range = normalizeLiteCutExportRange({ ...output, range_mode: "custom" }, totalSec);
  const timelineEnd = Math.max(0.1, Number(totalSec) || range.rangeEndSec || 1);
  const t = Math.max(0, Math.min(timelineEnd, Number(edgeTimeSec) || 0));
  if (edge === "end") {
    return {
      range_mode: "custom",
      range_start_sec: range.rangeStartSec,
      range_end_sec: Math.max(range.rangeStartSec + 0.1, t),
    };
  }
  return {
    range_mode: "custom",
    range_start_sec: Math.min(t, range.rangeEndSec - 0.1),
    range_end_sec: range.rangeEndSec,
  };
}

export async function exportLiteCutProject({ projectId, body, outputDir, filename }) {
  const output_path = buildLiteCutOutputPath(outputDir, filename);
  if (!output_path) {
    const err = new Error("output_path_invalid");
    err.code = "MONTAGE_OUTPUT_PATH_EMPTY";
    throw err;
  }
  const { data } = await API.post("/lite-cut/export", {
    project_id: projectId ?? null,
    body,
    output_path,
  });
  return { ...data, output_path };
}

export async function startLiteCutExport({ projectId, body, outputDir, filename }) {
  const output_path = buildLiteCutOutputPath(outputDir, filename);
  if (!output_path) {
    const err = new Error("output_path_invalid");
    err.code = "MONTAGE_OUTPUT_PATH_EMPTY";
    throw err;
  }
  const { data } = await API.post("/lite-cut/export/start", {
    project_id: projectId ?? null,
    body,
    output_path,
  });
  return { ...data, output_path: data.output_path || output_path };
}

export async function getLiteCutExportStatus(exportId) {
  const { data } = await API.get(`/lite-cut/exports/${encodeURIComponent(String(exportId))}`);
  return data;
}

export async function cancelLiteCutExport(exportId) {
  const { data } = await API.post(`/lite-cut/exports/${encodeURIComponent(String(exportId))}/cancel`);
  return data;
}

export async function listLiteCutExports({ projectId = null, limit = 8, offset = 0 } = {}) {
  const params = { limit, offset };
  if (projectId != null) params.project_id = projectId;
  const { data } = await API.get("/lite-cut/exports", { params });
  return data;
}
