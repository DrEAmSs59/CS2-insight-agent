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
  // victim_pov_pre_sec: null means "use highlight_pre_sec" on the backend
  victim_pov_pre_sec: null,
  victim_pov_post_sec: 1.5,
  enable_fail_killer_pov: false,
  fail_killer_pre_sec: 3.0,
  fail_killer_post_sec: 2.0,
  final_round_guard_sec: 4.0,
  final_round_seek_guard_sec: 2.0,
  final_round_min_duration_sec: 0.8,
  final_round_demo_exit_guard_sec: 1.5,
  obs_transition_enabled: null,
  obs_transition_name: null,
  obs_transition_duration_ms: null,
};

function buildTargetPlayer(name, steamid64, specSlot) {
  const obj = {
    name: String(name || ""),
    steamid64: String(steamid64 || ""),
  };
  if (specSlot != null) obj.spec_slot = Number(specSlot);
  return obj;
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
    server_name: matchMeta?.server_name || "",
    all_players: matchMeta?.all_players || [],
  };
}

/**
 * Resolve a killer player's steamid64 from multiple possible fields in clipData,
 * falling back to the roster map in matchMeta.
 *
 * @param {string} killerName
 * @param {object} clipData
 * @param {object|null} matchMeta
 * @returns {string}
 */
function resolveKillerSteamId(killerName, clipData, matchMeta) {
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  return String(
    clipData.killer_steamid64 ||
    clipData.killer_steam_id ||
    clipData.killer_steamid ||
    clipData.killers_steamid64s?.[0] ||
    nameToSteamId[killerName] ||
    ""
  );
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
  const next = windows.find((w) => Number(w.round) === Number(round) + 1);
  // Use the actual freeze_start_tick of the next round, NOT freeze_end_tick.
  return next ? (next.freeze_start_tick ?? null) : null;
}

function deriveNextRoundFreezeEnd(round, clipData) {
  const windows = clipData.freeze_to_death_round_windows || [];
  const next = windows.find((w) => Number(w.round) === Number(round) + 1);
  return next ? (next.freeze_end_tick ?? null) : null;
}

function deriveNextRoundStartTick(round, clipData) {
  const windows = clipData.freeze_to_death_round_windows || [];
  const next = windows.find((w) => Number(w.round) === Number(round) + 1);
  // Use the real round_start_tick from the demo's round_start event (added by demo_parser).
  // Fall back to start_tick (freeze_end - 8s) only when round_start_tick is unavailable.
  return next ? (next.round_start_tick ?? next.start_tick ?? null) : null;
}

export function buildHighlightRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  return {
    request_id: newRequestId(),
    request_type: "highlight",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events: (clipData.kill_ticks || []).map((killTick, i) => {
      const victimName = clipData.victims?.[i] || "";
      // victim_steamid64s is populated from player_death user_steamid in demo_parser; fall back to nameToSteamId roster map
      const victimSteamId = clipData.victim_steamid64s?.[i] || nameToSteamId[victimName] || "";
      const victimSpecSlot = clipData.victim_spec_slots?.[i] ?? null;
      return {
        event_type: "kill",
        tick: killTick,
        round: clipData.round,
        killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
        victim: buildTargetPlayer(victimName, victimSteamId, victimSpecSlot),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
        perspective: "killer",
      };
    }),
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildFailRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  const killerName = clipData.killer_name || "";
  const killerSteamId = resolveKillerSteamId(killerName, clipData, matchMeta);
  const killerSpecSlot = clipData.killer_spec_slot ?? null;
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
        killer: buildTargetPlayer(killerName, killerSteamId, killerSpecSlot),
        victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
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
  // timeline event fields: attacker_name/attacker_steamid/attacker_spec_slot (killer)
  //                        victim_name/victim_steamid/victim_spec_slot
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  const killerSpecSlot = clipData.attacker_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, killerSpecSlot);
  const victimName = clipData.victim_name || clipData.victims?.[0] || "";
  const victimSteamId =
    clipData.victim_steamid || clipData.victim_steamid64s?.[0] || nameToSteamId[victimName] || "";
  const victimSpecSlot = clipData.victim_spec_slot ?? null;
  return {
    request_id: newRequestId(),
    request_type: "timeline_kill",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events: [
      {
        event_type: "kill",
        tick: clipData.tick || clipData.kill_ticks?.[0] || 0,
        round: clipData.round,
        killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, killerSpecSlot),
        victim: buildTargetPlayer(victimName, victimSteamId, victimSpecSlot),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, killerSpecSlot),
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
  // timeline event fields: attacker_name/attacker_steamid/attacker_spec_slot (killer)
  //                        victim_spec_slot = target player's spec slot (target player died)
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  const targetSpecSlot = clipData.victim_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  const killerName = clipData.attacker_name || clipData.killer_name || "";
  const killerSteamId =
    clipData.attacker_steamid || resolveKillerSteamId(killerName, clipData, matchMeta);
  const killerSpecSlot = clipData.attacker_spec_slot ?? null;
  return {
    request_id: newRequestId(),
    request_type: "timeline_death",
    source_type: "death",
    demo,
    target_player: targetPlayer,
    events: [
      {
        event_type: "death",
        tick: clipData.tick || clipData.death_tick || clipData.kill_ticks?.[0] || 0,
        round: clipData.round,
        killer: buildTargetPlayer(killerName, killerSteamId, killerSpecSlot),
        victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
        target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
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
  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  return {
    request_id: newRequestId(),
    request_type: "kill_compilation",
    source_type: "kill",
    demo,
    target_player: targetPlayer,
    events:
      clipData.kill_ticks?.map((tick, i) => {
        const victimName = clipData.victims?.[i] || "";
        const victimSteamId =
          clipData.victim_steamid64s?.[i] || nameToSteamId[victimName] || "";
        const victimSpecSlot = clipData.victim_spec_slots?.[i] ?? null;
        return {
          event_type: "kill",
          tick,
          round: clipData.source_rounds?.[i] ?? clipData.round,
          killer: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
          victim: buildTargetPlayer(victimName, victimSteamId, victimSpecSlot),
          target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
          perspective: "killer",
        };
      }) || [],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildDeathCompilationRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  const nameToSteamId = matchMeta?.nameToSteamId ?? {};
  // kill_ticks holds death ticks for death compilation clips
  return {
    request_id: newRequestId(),
    request_type: "death_compilation",
    source_type: "death",
    demo,
    target_player: targetPlayer,
    events:
      clipData.kill_ticks?.map((tick, i) => {
        const kName = clipData.killers?.[i] || clipData.killer_name || "";
        const kSteamId = String(
          clipData.killers_steamid64s?.[i] || nameToSteamId[kName] || ""
        );
        const kSpecSlot = clipData.killers_spec_slots?.[i] ?? null;
        return {
          event_type: "death",
          tick,
          round: clipData.source_rounds?.[i] ?? clipData.round,
          killer: buildTargetPlayer(kName, kSteamId, kSpecSlot),
          victim: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
          target_player: buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot),
          perspective: "victim",
        };
      }) || [],
    rounds: [],
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildRoundCompilationRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };

  // demo_end_tick: use the max round_end_tick across selected windows so the backend
  // planner can end at the actual round boundary. clip_max_tick is the frontend's
  // crossRoundCap which can land inside a technical timeout, causing extra footage.
  const filter = clipData.freeze_to_death_round_filter;
  const filterSet =
    Array.isArray(filter) && filter.length > 0 ? new Set(filter.map(Number)) : null;
  const maxRoundEndTick = (clipData.freeze_to_death_round_windows || [])
    .filter((w) => filterSet === null || filterSet.has(Number(w.round)))
    .reduce((mx, w) => Math.max(mx, Number(w.end_tick) || 0), 0);

  const baseDemo = buildDemoContext(clipData, queueItem, matchMeta);
  const demo = maxRoundEndTick > 0 ? { ...baseDemo, demo_end_tick: maxRoundEndTick } : baseDemo;

  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
  return {
    request_id: newRequestId(),
    request_type: "round_compilation",
    source_type: "round",
    demo,
    target_player: targetPlayer,
    events: [],
    rounds: (() => {
      // freeze_to_death_round_windows keeps ALL rounds so deriveNextRoundFreezeStart can
      // look up consecutive rounds (e.g. round 6 when user only selected 4, 5, 9).
      // filterSet is already computed above for demo_end_tick — reuse it here.
      return (clipData.freeze_to_death_round_windows || [])
        .filter((w) => filterSet === null || filterSet.has(Number(w.round)))
        .map((w) => {
          const nextStart = deriveNextRoundStartTick(w.round, clipData);
          const nextFreezeStart = deriveNextRoundFreezeStart(w.round, clipData);
          const nextFreezeEnd = deriveNextRoundFreezeEnd(w.round, clipData);
          // round_end_tick must be the parser's real round-end tick, never a derived
          // recording-window value (e.g. next_freeze_end - 5 s). Use null if unavailable
          // so the backend Planner falls back to next_round_start_tick.
          const roundEndTick = w.round_end_tick ?? null;
          console.log(
            `[RecordingV3][RoundDTO] round=${w.round} raw round_end=${roundEndTick} ` +
            `next_start=${nextStart} next_freeze_start=${nextFreezeStart} next_freeze_end=${nextFreezeEnd}`
          );
          return {
            round: w.round,
            // round_start_tick: real freeze-phase start from the demo's round_start event.
            // Falls back to start_tick (freeze_end - 8s) for older parsed data.
            round_start_tick: w.round_start_tick ?? w.start_tick,
            round_end_tick: roundEndTick,
            freeze_start_tick: null,
            freeze_end_tick: w.freeze_end_tick ?? null,
            next_round_start_tick: nextStart,
            next_round_freeze_start_tick: nextFreezeStart,
            next_round_freeze_end_tick: nextFreezeEnd,
            target_death_tick: w.death_tick ?? null,
          };
        });
    })(),
    options: mergedOptions,
    source_ref: buildSourceRef(clipData, queueItem),
  };
}

export function buildTimelineRoundRecordingRequest(clipData, queueItem, matchMeta, options = {}) {
  const mergedOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const demo = buildDemoContext(clipData, queueItem, matchMeta);
  const targetSpecSlot = clipData.target_spec_slot ?? null;
  const targetPlayer = buildTargetPlayer(queueItem.targetPlayer, queueItem.targetSteamId, targetSpecSlot);
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
