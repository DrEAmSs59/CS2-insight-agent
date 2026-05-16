// frontend/src/recording/types.js

/**
 * @typedef {"highlight"|"fail"|"timeline_kill"|"timeline_death"|"kill_compilation"|"death_compilation"|"round_compilation"|"timeline_round"} RequestType
 */

/**
 * @typedef {"kill"|"death"|"round"} SourceType
 */

/**
 * @typedef {"killer"|"victim"|"main"|"round"} Perspective
 */

/**
 * @typedef {"kill"|"death"} EventType
 */

/**
 * @typedef {{ name: string, steamid64: string }} TargetPlayer
 */

/**
 * @typedef {{
 *   demo_path: string,
 *   demo_filename: string,
 *   map_name: string,
 *   tick_rate: number,
 *   first_tick: number,
 *   demo_end_tick: number,
 *   final_round: number,
 *   final_round_start_tick: number,
 *   final_round_end_tick: number
 * }} DemoContext
 */

/**
 * @typedef {{
 *   event_type: EventType,
 *   tick: number,
 *   round: number,
 *   killer: TargetPlayer,
 *   victim: TargetPlayer,
 *   target_player: TargetPlayer,
 *   perspective: Perspective
 * }} EventInfo
 */

/**
 * @typedef {{
 *   round: number,
 *   round_start_tick: number,
 *   round_end_tick: number,
 *   freeze_start_tick: number|null,
 *   freeze_end_tick: number|null,
 *   next_round_start_tick: number|null,
 *   next_round_freeze_start_tick: number|null,
 *   next_round_freeze_end_tick: number|null,
 *   target_death_tick: number|null
 * }} RoundInfo
 */

/**
 * @typedef {{
 *   highlight_pre_sec: number,
 *   highlight_post_sec: number,
 *   kill_jump_cut_threshold_sec: number,
 *   timeline_kill_pre_sec: number,
 *   timeline_kill_post_sec: number,
 *   death_pre_sec: number,
 *   death_post_sec: number,
 *   kill_compilation_pre_sec: number,
 *   kill_compilation_post_sec: number,
 *   kill_compilation_jump_cut_threshold_sec: number,
 *   death_compilation_pre_sec: number,
 *   death_compilation_post_sec: number,
 *   death_compilation_merge_gap_sec: number,
 *   round_freeze_preroll_sec: number,
 *   round_death_post_sec: number,
 *   enable_victim_pov: boolean,
 *   final_round_guard_sec: number,
 *   final_round_seek_guard_sec: number,
 *   final_round_min_duration_sec: number
 * }} RecordingOptions
 */

/**
 * @typedef {{
 *   original_clip_id: string|null,
 *   timeline_event_id: string|null,
 *   queue_item_id: string|null,
 *   group_id: string|null
 * }} SourceRef
 */

/**
 * @typedef {{
 *   request_id: string,
 *   request_type: RequestType,
 *   source_type: SourceType,
 *   demo: DemoContext,
 *   target_player: TargetPlayer,
 *   events: EventInfo[],
 *   rounds: RoundInfo[],
 *   options: RecordingOptions,
 *   source_ref: SourceRef
 * }} RecordingRequestDTO
 */

/**
 * @typedef {{
 *   segment_index: number,
 *   source_type: SourceType,
 *   start_tick: number,
 *   end_tick: number,
 *   anchor_ticks: number[],
 *   round: number|null,
 *   target_player_name: string,
 *   target_steamid64: string,
 *   perspective: Perspective,
 *   is_final_round: boolean,
 *   safe_seek_tick: number,
 *   safe_end_tick: number|null,
 *   disabled: boolean,
 *   disabled_reason: string|null,
 *   metadata: Record<string, unknown>
 * }} RecordingSegment
 */

/**
 * @typedef {{
 *   request_id: string,
 *   request_type: RequestType,
 *   demo_path: string,
 *   tick_rate: number,
 *   segments: RecordingSegment[],
 *   warnings: string[],
 *   disabled_segments: RecordingSegment[],
 *   estimated_duration_sec: number
 * }} RecordingPlan
 */

export {}
