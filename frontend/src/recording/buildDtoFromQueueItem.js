import {
  DEFAULT_RECORDING_OPTIONS,
  buildHighlightRecordingRequest,
  buildFailRecordingRequest,
  buildTimelineKillRecordingRequest,
  buildTimelineDeathRecordingRequest,
  buildKillCompilationRecordingRequest,
  buildDeathCompilationRecordingRequest,
  buildRoundCompilationRecordingRequest,
  buildTimelineRoundRecordingRequest,
} from "./recordingRequestFactory";
import { stripGlobalPacingMetaKeys } from "../stores/recordingQueueStore";

/**
 * Map pacing_override fields to RecordingOptions keys.
 * item.pacing_override takes priority over globalPacing.
 *
 * @param {import("../stores/recordingQueueStore").PacingOverride} pacing
 * @returns {Partial<typeof DEFAULT_RECORDING_OPTIONS>}
 */
function pacingOverrideToOptions(pacing) {
  if (!pacing || typeof pacing !== "object") return {};
  const opts = {};

  if (pacing.pre_first_sec != null) {
    opts.highlight_pre_sec = pacing.pre_first_sec;
    opts.kill_compilation_pre_sec = pacing.pre_first_sec;
    opts.timeline_kill_pre_sec = pacing.pre_first_sec;
  }
  if (pacing.post_last_sec != null) {
    opts.highlight_post_sec = pacing.post_last_sec;
    opts.kill_compilation_post_sec = pacing.post_last_sec;
    opts.timeline_kill_post_sec = pacing.post_last_sec;
  }
  if (pacing.max_gap_sec != null) {
    opts.kill_jump_cut_threshold_sec = pacing.max_gap_sec;
    opts.kill_compilation_jump_cut_threshold_sec = pacing.max_gap_sec;
  }
  if (pacing.victim_pov === true) opts.enable_victim_pov = true;

  // Victim POV independent timing — maps to dedicated backend fields.
  if (pacing.victim_pov_pre_sec != null) opts.victim_pov_pre_sec = pacing.victim_pov_pre_sec;
  if (pacing.victim_pov_post_sec != null) opts.victim_pov_post_sec = pacing.victim_pov_post_sec;

  // Killer POV for fail clips — maps to enable_fail_killer_pov + timing fields.
  if (pacing.killer_pov === true) {
    opts.enable_fail_killer_pov = true;
    // Mirror the UI fallback chain: killer_pov_pre/post_sec → victim_pov_pre/post_sec → 1.5
    // so that clips match what the drawer preview shows when the user hasn't dragged the slider.
    const resolvedVicPre = pacing.victim_pov_pre_sec ?? 1.5;
    const resolvedVicPost = pacing.victim_pov_post_sec ?? 1.5;
    opts.fail_killer_pre_sec = pacing.killer_pov_pre_sec ?? resolvedVicPre;
    opts.fail_killer_post_sec = pacing.killer_pov_post_sec ?? resolvedVicPost;
  } else {
    if (pacing.killer_pov_pre_sec != null) opts.fail_killer_pre_sec = pacing.killer_pov_pre_sec;
    if (pacing.killer_pov_post_sec != null) opts.fail_killer_post_sec = pacing.killer_pov_post_sec;
  }

  return opts;
}

/**
 * Determine which factory function to call and produce a RecordingRequestDTO.
 *
 * Returns null for unsupported clip types (e.g. meme_death) which should be
 * silently skipped by the caller.
 *
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {object|null} matchMeta  — match_meta for this demo (may be null)
 * @param {object} [globalPacing]  — store-level global pacing (lower priority than per-item)
 * @returns {object|null}  RecordingRequestDTO or null if unsupported
 */
export function buildDtoFromQueueItem(item, matchMeta, globalPacing = {}) {
  const { clipData } = item;
  if (!clipData || typeof clipData !== "object") return null;

  // Merge: global pacing (stripped of meta-only keys) < item pacing_override
  const mergedPacing = {
    ...stripGlobalPacingMetaKeys(globalPacing || {}),
    ...(item.pacing_override || {}),
  };
  const options = pacingOverrideToOptions(mergedPacing);

  // Per-item obs_transition overrides (null = use AppConfig global default).
  if (item.obs_transition_enabled !== undefined)
    options.obs_transition_enabled = item.obs_transition_enabled ?? null;
  if (item.obs_transition_name !== undefined)
    options.obs_transition_name = item.obs_transition_name ?? null;
  if (item.obs_transition_duration_ms !== undefined)
    options.obs_transition_duration_ms = item.obs_transition_duration_ms ?? null;

  const args = [clipData, item, matchMeta, options];

  const ts = String(clipData.timeline_source || "").trim();
  const trk = String(clipData.timeline_record_kind || "").trim();

  // Timeline clips take priority over category checks
  if (ts === "round_timeline_round") return buildTimelineRoundRecordingRequest(...args);
  if (ts === "round_timeline_event") {
    if (trk === "kill") return buildTimelineKillRecordingRequest(...args);
    if (trk === "death") return buildTimelineDeathRecordingRequest(...args);
    return null;
  }

  const cat = String(clipData.category || "").trim();
  const kind = String(clipData.compilation_kind || "").trim();

  if (cat === "highlight") return buildHighlightRecordingRequest(...args);
  if (cat === "fail") return buildFailRecordingRequest(...args);
  if (cat === "compilation") {
    if (kind === "freeze_to_death") return buildRoundCompilationRecordingRequest(...args);
    if (kind === "rival_kills" || kind === "all_kills")
      return buildKillCompilationRecordingRequest(...args);
    if (kind === "nemesis_deaths" || kind === "all_deaths")
      return buildDeathCompilationRecordingRequest(...args);
  }

  return null;
}
