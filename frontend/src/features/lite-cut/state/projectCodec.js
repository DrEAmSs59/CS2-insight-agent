import {
  LITE_CUT_ENCODERS,
  LITE_CUT_ENCODER_TIERS,
  LITE_CUT_CANVAS_FIT_VALUES,
  LITE_CUT_OUTPUT_DEFAULTS,
  LITE_CUT_OUTPUT_LIMITS,
  LITE_CUT_PROJECT_SCHEMA_VERSION,
  LITE_CUT_RANGE_MODES,
  LITE_CUT_TIMELINE_LIMITS,
} from "./projectContract.js";
import { AUDIO_MASTER_GAIN, clampAudioGain } from "../domain/audioContract.js";
import { reconcileTransitionEvents } from "./transitionModel.js";
import { normalizeVisualMaterialFields } from "../domain/visualMaterial.js";
import { normalizeTimelineTrackOrder } from "./timelineUtils.js";

const LEGACY_OUTPUT_FIELDS = ["frame_blend_enabled", "frame_blend_frames", "high_frame_downsample_enabled", "delivery_fps"];
const LEGACY_CLIP_FIELDS = ["transition_in", "transition_out", "canvas_fit"];
const LEGACY_OVERLAY_FIELDS = ["transition_in", "transition_out", "fade_in_sec", "fade_out_sec"];
const LEGACY_TEXT_FIELDS = ["anim_in", "anim_out"];

export class LiteCutProjectCompatibilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiteCutProjectCompatibilityError";
    this.code = code;
  }
}

function assertCurrentProjectContract(body) {
  if (body?.schema_version !== LITE_CUT_PROJECT_SCHEMA_VERSION) {
    throw new LiteCutProjectCompatibilityError(
      "LITECUT_PROJECT_VERSION_UNSUPPORTED",
      `LiteCut project schema ${String(body?.schema_version)} is unsupported; schema ${LITE_CUT_PROJECT_SCHEMA_VERSION} is required`,
    );
  }
  const paths = [];
  for (const field of LEGACY_OUTPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body?.output || {}, field)) paths.push(`output.${field}`);
  }
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  for (const [trackIndex, track] of tracks.entries()) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const [clipIndex, clip] of clips.entries()) {
      for (const field of LEGACY_CLIP_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(clip || {}, field)) paths.push(`tracks[${trackIndex}].clips[${clipIndex}].${field}`);
      }
    }
  }
  const overlays = Array.isArray(body?.overlays) ? body.overlays : [];
  for (const [overlayIndex, overlay] of overlays.entries()) {
    for (const field of LEGACY_OVERLAY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(overlay || {}, field)) paths.push(`overlays[${overlayIndex}].${field}`);
    }
    for (const field of LEGACY_TEXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(overlay?.text || {}, field)) paths.push(`overlays[${overlayIndex}].text.${field}`);
    }
  }
  if (paths.length) {
    throw new LiteCutProjectCompatibilityError(
      "LITECUT_LEGACY_PROJECT_FIELDS_UNSUPPORTED",
      `Retired LiteCut project fields are not supported: ${paths.sort().join(", ")}`,
    );
  }
}

/**
 * Normalize a current LiteCut project without reading or mutating application
 * state. Retired schemas and fields are rejected before any repair is applied.
 */
export function normalizeLiteCutBody(rawBody) {
  const source = rawBody == null ? { schema_version: LITE_CUT_PROJECT_SCHEMA_VERSION } : rawBody;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new LiteCutProjectCompatibilityError("LITECUT_PROJECT_INVALID", "LiteCut project body must be an object");
  }
  assertCurrentProjectContract(source);
  const body = structuredClone(source);
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
      encoder_tier: LITE_CUT_OUTPUT_DEFAULTS.encoder_tier,
      framemeld_enabled: LITE_CUT_OUTPUT_DEFAULTS.framemeld_enabled,
      canvas_fit: LITE_CUT_OUTPUT_DEFAULTS.canvas_fit,
      background_color: LITE_CUT_OUTPUT_DEFAULTS.background_color,
      blur_amount: LITE_CUT_OUTPUT_DEFAULTS.blur_amount,
      range_mode: LITE_CUT_OUTPUT_DEFAULTS.range_mode,
      range_start_sec: LITE_CUT_OUTPUT_DEFAULTS.range_start_sec,
      range_end_sec: LITE_CUT_OUTPUT_DEFAULTS.range_end_sec,
    };
    changed = true;
  } else {
    const outputDefaults = {
      width: [LITE_CUT_OUTPUT_DEFAULTS.width, LITE_CUT_OUTPUT_LIMITS.width.min, LITE_CUT_OUTPUT_LIMITS.width.max],
      height: [LITE_CUT_OUTPUT_DEFAULTS.height, LITE_CUT_OUTPUT_LIMITS.height.min, LITE_CUT_OUTPUT_LIMITS.height.max],
      fps: [LITE_CUT_OUTPUT_DEFAULTS.fps, LITE_CUT_OUTPUT_LIMITS.fps.min, LITE_CUT_OUTPUT_LIMITS.fps.max],
      blur_amount: [LITE_CUT_OUTPUT_LIMITS.blurAmount.default, LITE_CUT_OUTPUT_LIMITS.blurAmount.min, LITE_CUT_OUTPUT_LIMITS.blurAmount.max],
    };
    for (const [key, [fallback, minimum, maximum]] of Object.entries(outputDefaults)) {
      const raw = Number(body.output[key]);
      const next = Number.isInteger(raw) ? Math.max(minimum, Math.min(maximum, raw)) : fallback;
      if (raw !== next) {
        body.output[key] = next;
        changed = true;
      }
    }
    if (!LITE_CUT_CANVAS_FIT_VALUES.includes(body.output.canvas_fit)) {
      body.output.canvas_fit = LITE_CUT_OUTPUT_DEFAULTS.canvas_fit;
      changed = true;
    }
    const rawBackground = String(body.output.background_color || "").trim();
    const expandedBackground = /^#[0-9a-f]{3}$/i.test(rawBackground)
      ? `#${[...rawBackground.slice(1)].map((digit) => digit.repeat(2)).join("")}`
      : rawBackground;
    const backgroundColor = /^#[0-9a-f]{6}$/i.test(expandedBackground) ? expandedBackground.toLowerCase() : LITE_CUT_OUTPUT_DEFAULTS.background_color;
    if (body.output.background_color !== backgroundColor) {
      body.output.background_color = backgroundColor;
      changed = true;
    }
    if (!LITE_CUT_ENCODERS.includes(body.output.encoder)) {
      body.output.encoder = LITE_CUT_OUTPUT_DEFAULTS.encoder;
      changed = true;
    }
    if (!LITE_CUT_ENCODER_TIERS.includes(body.output.encoder_tier)) {
      body.output.encoder_tier = LITE_CUT_OUTPUT_DEFAULTS.encoder_tier;
      changed = true;
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
  // Keep track labels deterministic when a current project is malformed.
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
  if (normalizeTimelineTrackOrder(body)) changed = true;
  if (!Array.isArray(body.overlays)) {
    body.overlays = [];
    changed = true;
  }
  if (!Array.isArray(body.markers)) {
    body.markers = [];
    changed = true;
  } else {
    body.markers = body.markers
      .map((m) => ({
        id: String(m?.id || `marker-${globalThis.crypto?.randomUUID?.()?.slice?.(0, 10) || Date.now()}`),
        time_sec: Math.max(LITE_CUT_TIMELINE_LIMITS.time.min, Math.min(LITE_CUT_TIMELINE_LIMITS.time.max, Number(m?.time_sec) || LITE_CUT_TIMELINE_LIMITS.time.default)),
        label: String(m?.label || ""),
        color: /^#[0-9a-f]{6}$/i.test(String(m?.color || "")) ? m.color : "#f59e0b",
      }))
      .sort((a, b) => a.time_sec - b.time_sec);
  }
  if (!body.audio || typeof body.audio !== "object") {
    body.audio = { master_volume: AUDIO_MASTER_GAIN.default };
    changed = true;
  } else {
    const raw = Number(body.audio.master_volume);
    if (!Number.isFinite(raw)) {
      body.audio.master_volume = AUDIO_MASTER_GAIN.default;
      changed = true;
    } else {
      const next = clampAudioGain(raw, AUDIO_MASTER_GAIN);
      if (next !== raw) {
        body.audio.master_volume = next;
        changed = true;
      }
    }
  }
  if (normalizeVisualMaterialFields(body)) changed = true;
  const transitionsBefore = JSON.stringify([body.transition_model_version, body.transitions]);
  reconcileTransitionEvents(body);
  if (JSON.stringify([body.transition_model_version, body.transitions]) !== transitionsBefore) changed = true;
  return { body, changed };
}

export function selectLiteCutProjectReferences(body) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  const overlays = Array.isArray(body?.overlays) ? body.overlays : [];
  const markers = Array.isArray(body?.markers) ? body.markers : [];
  const transitions = Array.isArray(body?.transitions) ? body.transitions : [];
  const clips = tracks.flatMap((track) => (Array.isArray(track?.clips) ? track.clips : []));
  return {
    trackIds: tracks.map((track) => String(track?.id || "")),
    clipIds: clips.map((clip) => String(clip?.id || "")),
    overlayIds: overlays.map((overlay) => String(overlay?.id || "")),
    markerIds: markers.map((marker) => String(marker?.id || "")),
    transitionIds: transitions.map((transition) => String(transition?.id || "")),
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
  reportDuplicateIds("transition", references.transitionIds);

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
