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

/**
 * Map old pacing_override fields (legacy recording UI) to new RecordingOptions.
 * Fields that don't have a 1-to-1 mapping are spread across multiple option keys
 * that share the same semantic (e.g. pre_first_sec applies to both highlight and
 * kill_compilation pre-roll).
 *
 * @param {import("../stores/recordingQueueStore").PacingOverride|undefined} pacing
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
  if (pacing.victim_pov_pre_sec != null) opts.death_pre_sec = pacing.victim_pov_pre_sec;
  if (pacing.victim_pov_post_sec != null) opts.death_post_sec = pacing.victim_pov_post_sec;

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
 * @returns {object|null}  RecordingRequestDTO or null if unsupported
 */
export function buildDtoFromQueueItem(item, matchMeta) {
  const { clipData } = item;
  if (!clipData || typeof clipData !== "object") return null;

  const options = pacingOverrideToOptions(item.pacing_override);
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
