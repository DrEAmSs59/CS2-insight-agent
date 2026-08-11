import {
  LITE_CUT_ENCODERS,
  LITE_CUT_OUTPUT_DEFAULTS,
  LITE_CUT_RANGE_MODES,
} from "./projectContract.js";

/**
 * Normalize a schema v2 LiteCut project for the editor without reading or
 * mutating application state. Keep this behavior-compatible with the legacy
 * editorStore entry point until every caller has migrated to the codec.
 */
export function normalizeLiteCutBody(rawBody) {
  const body = rawBody && typeof rawBody === "object" ? structuredClone(rawBody) : {};
  let changed = false;
  if (!Array.isArray(body.tracks)) {
    body.tracks = [];
    changed = true;
  } else {
    body.tracks = body.tracks.map((track) => {
      if (!track || typeof track !== "object" || typeof track.solo === "boolean") return track;
      changed = true;
      return { ...track, solo: false };
    });
  }
  if (!body.output || typeof body.output !== "object") {
    body.output = {
      dir: LITE_CUT_OUTPUT_DEFAULTS.dir,
      filename: LITE_CUT_OUTPUT_DEFAULTS.filename,
      width: LITE_CUT_OUTPUT_DEFAULTS.width,
      height: LITE_CUT_OUTPUT_DEFAULTS.height,
      fps: LITE_CUT_OUTPUT_DEFAULTS.fps,
      encoder: LITE_CUT_OUTPUT_DEFAULTS.encoder,
      framemeld_enabled: LITE_CUT_OUTPUT_DEFAULTS.framemeld_enabled,
      range_mode: LITE_CUT_OUTPUT_DEFAULTS.range_mode,
      range_start_sec: LITE_CUT_OUTPUT_DEFAULTS.range_start_sec,
      range_end_sec: LITE_CUT_OUTPUT_DEFAULTS.range_end_sec,
    };
    changed = true;
  } else {
    const outputDefaults = {
      width: LITE_CUT_OUTPUT_DEFAULTS.width,
      height: LITE_CUT_OUTPUT_DEFAULTS.height,
      fps: LITE_CUT_OUTPUT_DEFAULTS.fps,
    };
    for (const [key, fallback] of Object.entries(outputDefaults)) {
      const raw = Number(body.output[key]);
      if (!Number.isInteger(raw) || raw < 1 || (key === "fps" && raw > 1000)) {
        body.output[key] = fallback;
        changed = true;
      }
    }
    if (!LITE_CUT_ENCODERS.includes(body.output.encoder)) {
      body.output.encoder = LITE_CUT_OUTPUT_DEFAULTS.encoder;
      changed = true;
    }
    for (const legacyKey of ["frame_blend_enabled", "frame_blend_frames", "high_frame_downsample_enabled", "delivery_fps"]) {
      if (legacyKey in body.output) {
        delete body.output[legacyKey];
        changed = true;
      }
    }
    if (typeof body.output.framemeld_enabled !== "boolean") {
      body.output.framemeld_enabled = LITE_CUT_OUTPUT_DEFAULTS.framemeld_enabled;
      changed = true;
    }
    if (!LITE_CUT_RANGE_MODES.includes(body.output.range_mode)) {
      body.output.range_mode = LITE_CUT_OUTPUT_DEFAULTS.range_mode;
      changed = true;
    }
    const rawRangeStart = Number(body.output.range_start_sec);
    if (!Number.isFinite(rawRangeStart) || rawRangeStart < 0) {
      body.output.range_start_sec = LITE_CUT_OUTPUT_DEFAULTS.range_start_sec;
      changed = true;
    }
  }
  if (!body.tracks.some((t) => t?.type === "video")) {
    body.tracks.unshift({
      id: "v1",
      type: "video",
      label: "V1",
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
      clips: [],
    });
    changed = true;
  }
  // Repair duplicate/missing video track labels left behind by older builds
  // that force-injected a second "V1" whenever the id "v1" was absent.
  const videoTrackLabels = body.tracks.filter((t) => t?.type === "video").map((t) => String(t?.label || ""));
  if (videoTrackLabels.some((label) => !label) || new Set(videoTrackLabels).size !== videoTrackLabels.length) {
    let nextVideoLabel = 1;
    for (const track of body.tracks) {
      if (track?.type === "video") track.label = `V${nextVideoLabel++}`;
    }
    changed = true;
  }
  if (!body.tracks.some((t) => t?.type === "audio")) {
    body.tracks.push({
      id: "a1",
      type: "audio",
      label: "A1",
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
      clips: [],
    });
    changed = true;
  }
  if (!Array.isArray(body.overlays)) {
    body.overlays = [];
    changed = true;
  }
  for (const overlay of body.overlays) {
    if (overlay?.type !== "text" || !overlay.text || typeof overlay.text !== "object") continue;
    if (!/^rajdhani(?:\s+bold)?$/i.test(String(overlay.text.font_family || ""))) continue;
    overlay.text.font_family = "微软雅黑";
    overlay.text.font_file = null;
    changed = true;
  }
  if (!Array.isArray(body.markers)) {
    body.markers = [];
    changed = true;
  } else {
    body.markers = body.markers
      .map((m) => ({
        id: String(m?.id || `marker-${globalThis.crypto?.randomUUID?.()?.slice?.(0, 10) || Date.now()}`),
        time_sec: Math.max(0, Number(m?.time_sec) || 0),
        label: String(m?.label || ""),
        color: /^#[0-9a-f]{6}$/i.test(String(m?.color || "")) ? m.color : "#f59e0b",
      }))
      .sort((a, b) => a.time_sec - b.time_sec);
  }
  if (!body.audio || typeof body.audio !== "object") {
    body.audio = { master_volume: 1 };
    changed = true;
  } else {
    const raw = Number(body.audio.master_volume);
    if (!Number.isFinite(raw)) {
      body.audio.master_volume = 1;
      changed = true;
    } else {
      const next = Math.max(0, Math.min(2, raw));
      if (next !== raw) {
        body.audio.master_volume = next;
        changed = true;
      }
    }
  }
  return { body, changed };
}

export function selectLiteCutProjectReferences(body) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  const overlays = Array.isArray(body?.overlays) ? body.overlays : [];
  const markers = Array.isArray(body?.markers) ? body.markers : [];
  const clips = tracks.flatMap((track) => (Array.isArray(track?.clips) ? track.clips : []));
  return {
    trackIds: tracks.map((track) => String(track?.id || "")),
    clipIds: clips.map((clip) => String(clip?.id || "")),
    overlayIds: overlays.map((overlay) => String(overlay?.id || "")),
    markerIds: markers.map((marker) => String(marker?.id || "")),
    sourceIds: clips
      .filter((clip) => clip?.source_id != null)
      .map((clip) => Number(clip.source_id))
      .filter(Number.isFinite),
  };
}

export function diagnoseLiteCutProjectReferences(body, { availableAssetIds = [] } = {}) {
  const diagnostics = [];
  const available = new Set((availableAssetIds || []).map(Number).filter(Number.isFinite));
  const references = selectLiteCutProjectReferences(body);
  const reportDuplicateIds = (kind, ids) => {
    const seen = new Set();
    for (const id of ids) {
      if (id && seen.has(id)) diagnostics.push({ code: `duplicate_${kind}_id`, kind, id });
      seen.add(id);
    }
  };
  reportDuplicateIds("track", references.trackIds);
  reportDuplicateIds("clip", references.clipIds);
  reportDuplicateIds("overlay", references.overlayIds);
  reportDuplicateIds("marker", references.markerIds);

  for (const track of body?.tracks || []) {
    for (const clip of track?.clips || []) {
      if (clip?.source_type === "file" && !String(clip?.file_path || "").trim()) {
        diagnostics.push({ code: "missing_file_path", kind: "clip", id: String(clip?.id || "") });
      }
      if (clip?.source_id != null && !available.has(Number(clip.source_id))) {
        diagnostics.push({ code: "unresolved_source_id", kind: "clip", id: String(clip?.id || ""), source_id: Number(clip.source_id) });
      }
    }
  }
  for (const overlay of body?.overlays || []) {
    if (overlay?.type !== "text" && !String(overlay?.asset_path || "").trim()) {
      diagnostics.push({ code: "missing_overlay_asset_path", kind: "overlay", id: String(overlay?.id || "") });
    }
  }
  return diagnostics;
}
