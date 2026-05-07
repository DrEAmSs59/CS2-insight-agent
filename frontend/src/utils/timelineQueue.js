/**
 * 将回合时间线事件/整回合转为与导播兼容的 clipData（fixed_segment_pacing + tick 窗口）。
 */

/**
 * @param {{ event: Record<string, unknown>, mapName?: string, targetPlayer?: string | null, round?: number }} p
 */
export function buildTimelineEventClipData({ event, mapName = "", targetPlayer = "", round }) {
  const sc = event?.suggested_clip;
  const st = Number(event?.start_tick ?? sc?.start_tick);
  const et = Number(event?.end_tick ?? sc?.end_tick);
  const safeSt = Number.isFinite(st) ? st : 0;
  const safeEt = Number.isFinite(et) && et > safeSt ? et : safeSt + 64 * 10;
  const typ = String(event?.record_type || event?.type || "");
  const isKill = typ === "kill";
  const isDeath = typ === "death";
  const client_clip_uid = `tl_${String(event?.id || `${event?.round}-${event?.tick}-${typ}`)}`;
  const tick = Number(event?.tick);
  const desc = String(event?.description || (isKill ? "时间线击杀" : isDeath ? "时间线死亡" : "时间线事件"));
  const roundNum =
    round != null && Number.isFinite(Number(round))
      ? Number(round)
      : Number.isFinite(Number(event?.round))
        ? Number(event.round)
        : 0;
  return {
    clip_id: client_clip_uid,
    client_clip_uid,
    round: roundNum,
    category: isKill ? "highlight" : isDeath ? "fail" : "highlight",
    weapon_used: String(event?.weapon_name || event?.weapon || ""),
    kill_count: isKill ? 1 : 0,
    start_tick: safeSt,
    end_tick: safeEt,
    map_name: mapName || "unknown",
    context_tags: [desc],
    fixed_segment_pacing: true,
    clip_min_tick: safeSt,
    clip_max_tick: safeEt,
    kill_ticks: isKill && Number.isFinite(tick) ? [tick] : [],
    death_tick: isDeath && Number.isFinite(tick) ? tick : null,
    killer_name: isDeath ? String(event?.attacker_name || "").trim() || null : null,
    victims: isKill && String(event?.victim_name || "").trim() ? [String(event.victim_name).trim()] : [],
    timeline_source: "round_timeline_event",
    timeline_event_id: String(event?.id || ""),
    _timeline_target: targetPlayer || null,
  };
}

/**
 * @param {{ roundRow: Record<string, unknown>, mapName?: string, targetPlayer?: string | null }} p
 */
export function buildTimelineRoundClipData({ roundRow, mapName = "", targetPlayer = "" }) {
  const rn = Number(roundRow?.round_number ?? roundRow?.round);
  const fe = roundRow?.start_tick ?? roundRow?.round_start_tick;
  const en = roundRow?.end_tick ?? roundRow?.round_end_tick;
  const st = fe != null && Number.isFinite(Number(fe)) ? Number(fe) : 0;
  let et = en != null && Number.isFinite(Number(en)) ? Number(en) : st + 64 * 45;
  if (et <= st) et = st + 64 * 10;
  const client_clip_uid = `tl_round_${Number.isFinite(rn) ? rn : "x"}`;
  const title = `第 ${Number.isFinite(rn) ? rn : "?"} 回合`;
  return {
    clip_id: client_clip_uid,
    client_clip_uid,
    round: Number.isFinite(rn) ? rn : 0,
    category: "highlight",
    weapon_used: "",
    kill_count: 0,
    start_tick: st,
    end_tick: et,
    map_name: mapName || "unknown",
    context_tags: [title, "整回合时间线"],
    fixed_segment_pacing: true,
    clip_min_tick: st,
    clip_max_tick: et,
    kill_ticks: [],
    timeline_source: "round_timeline_round",
    _timeline_target: targetPlayer || null,
  };
}
