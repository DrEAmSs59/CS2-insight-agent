export const DEFAULT_RECORDING_OPTIONS = {
  highlight_pre_sec: 3.0,
  highlight_post_sec: 2.0,
  kill_jump_cut_threshold_sec: 12.0,
  timeline_kill_pre_sec: 3.0,
  timeline_kill_post_sec: 2.0,
  death_pre_sec: 3.0,
  death_post_sec: 2.0,
  kill_compilation_pre_sec: 2.0,
  kill_compilation_post_sec: 1.5,
  kill_compilation_jump_cut_threshold_sec: 10.0,
  death_compilation_pre_sec: 2.0,
  death_compilation_post_sec: 1.5,
  death_compilation_merge_gap_sec: 2.0,
  round_freeze_preroll_sec: 3.0,
  round_death_post_sec: 2.0,
  enable_victim_pov: false,
  final_round_guard_sec: 4.0,
  final_round_seek_guard_sec: 2.0,
  final_round_min_duration_sec: 0.8,
};

function buildTargetPlayer(name, steamid64) {
  return {
    name: String(name || ""),
    steamid64: String(steamid64 || ""),
  };
}

function buildDemoContext(clipData, queueItem, matchMeta) {
  const finalRound = Number(matchMeta?.total_rounds) || 0;
  const clipRound = Number(clipData.round) || 0;
  const clipMaxTick = Number(clipData.clip_max_tick) || 0;

  // clip_max_tick is safe-per-round upper bound; use as final_round_end_tick when on final round
  const finalRoundEndTick = finalRound > 0 && clipRound === finalRound ? clipMaxTick : 0;

  // demo_end_tick: use clip_max_tick as best available proxy (no true demo_end_tick in MatchMeta)
  const demoEndTick = clipMaxTick || Number(clipData.end_tick) || 0;

  return {
    demo_path: queueItem.demoPath || "",
    demo_filename: queueItem.demoFilename || "",
    map_name: clipData.map_name || matchMeta?.map_name || "unknown",
    tick_rate: Number(clipData.tick_rate) || 64,
    first_tick: 0,
    demo_end_tick: demoEndTick,
    final_round: finalRound,
    final_round_start_tick: 0,
    final_round_end_tick: finalRoundEndTick,
  };
}

function buildSourceRef(clipData, queueItem) {
  return {
    original_clip_id: clipData.clip_id || null,
    timeline_event_id: clipData.timeline_event_id || null,
    queue_item_id: queueItem.id || null,
    group_id: null,
  };
}

function newRequestId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function deriveNextRoundFreezeStart(round, clipData) {
  const windows = clipData.freeze_to_death_round_windows || [];
  const next = windows.find((w) => w.round === round + 1);
  return next ? (next.freeze_end_tick ?? null) : null;
}

export function buildHighlightRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "highlight",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events: (clipData.kill_ticks || []).map((killTick, i) => ({
      event_type: "kill",
      tick: killTick,
      round: clipData.round,
      killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
      victim: buildTargetPlayer(clipData.victims?.[i] || "", ""),
      target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
      perspective: "killer",
    })),
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildFailRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "fail",
    source_type: "death",
    demo,
    target_player: targetPlayer,
    events: [
      {
        event_type: "death",
        tick: clipData.death_tick || clipData.kill_ticks?.[0] || 0,
        round: clipData.round,
        killer: buildTargetPlayer(clipData.killer_name || "", ""),
        victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        perspective: "victim",
      },
    ],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildTimelineKillRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "timeline_kill",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events: [
      {
        event_type: "kill",
        tick: clipData.kill_ticks?.[0] || 0,
        round: clipData.round,
        killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        victim: buildTargetPlayer(clipData.victims?.[0] || "", ""),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        perspective: "killer",
      },
    ],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildTimelineDeathRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "timeline_death",
    source_type: "death",
    demo,
    target_player: targetPlayer,
    events: [
      {
        event_type: "death",
        tick: clipData.death_tick || clipData.kill_ticks?.[0] || 0,
        round: clipData.round,
        killer: buildTargetPlayer(clipData.killer_name || "", ""),
        victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        perspective: "victim",
      },
    ],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildKillCompilationRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "kill_compilation",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events:
      clipData.kill_ticks?.map((tick, i) => ({
        event_type: "kill",
        tick,
        round: clipData.source_rounds?.[i] ?? clipData.round,
        killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        victim: buildTargetPlayer(clipData.victims?.[i] || "", ""),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        perspective: "killer",
      })) || [],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildDeathCompilationRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  // kill_ticks holds death ticks for death compilation clips
  return {
    request_id: newRequestId(),
    request_type: "death_compilation",
    source_type: "death",
    demo,
    target_player: targetPlayer,
    events:
      clipData.kill_ticks?.map((tick, i) => ({
        event_type: "death",
        tick,
        round: clipData.source_rounds?.[i] ?? clipData.round,
        killer: buildTargetPlayer(clipData.killers?.[i] || clipData.killer_name || "", ""),
        victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId),
        perspective: "victim",
      })) || [],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildRoundCompilationRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "round_compilation",
    source_type: "round",
    demo,
    target_player: targetPlayer,
    events: [],
    rounds: (clipData.freeze_to_death_round_windows || []).map((w) => ({
      round: w.round,
      round_start_tick: w.start_tick,
      round_end_tick: w.end_tick,
      freeze_start_tick: null,
      freeze_end_tick: w.freeze_end_tick ?? null,
      next_round_start_tick: null,
      next_round_freeze_start_tick: deriveNextRoundFreezeStart(w.round, clipData),
      next_round_freeze_end_tick: null,
      target_death_tick: w.death_tick ?? null,
    })),
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildTimelineRoundRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId);
  return {
    request_id: newRequestId(),
    request_type: "timeline_round",
    source_type: "round",
    demo,
    target_player: targetPlayer,
    events: [],
    rounds: [
      {
        round: clipData.round,
        round_start_tick: clipData.start_tick || 0,
        round_end_tick: clipData.end_tick || 0,
        freeze_start_tick: null,
        freeze_end_tick: clipData.clip_min_tick ?? null,
        next_round_start_tick: null,
        next_round_freeze_start_tick: null,
        next_round_freeze_end_tick: null,
        target_death_tick: clipData.death_tick ?? null,
      },
    ],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}
