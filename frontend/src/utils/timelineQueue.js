/**
 * 将回合时间线事件/整回合转为与导播兼容的 clipData（整回合带 fixed_segment；单事件可走智能节奏）。
 */

import { isTimelineSourceClip } from "./montageUtils";

/**
 * 队列单行：地图 + R# + 比分（若有）+ 杀数/整回合/死亡 + 估算时长（与高光条风格对齐）。
 * @param {Record<string, unknown>} clipData
 * @param {number} estSeconds
 */
export function timelineQueueMetaOneLiner(clipData, estSeconds) {
  const cd = clipData && typeof clipData === "object" ? clipData : {};
  if (!isTimelineSourceClip(cd)) return "";
  const mapName = String(cd.map_name || cd.map || "").trim() || "—";
  const rn = cd.round != null && Number.isFinite(Number(cd.round)) ? Number(cd.round) : null;
  const est = Number.isFinite(Number(estSeconds)) ? Math.max(0, Math.round(Number(estSeconds))) : null;
  const parts = [mapName];
  if (rn != null && rn > 0) {
    let r = `R${rn}`;
    if (cd.score_own != null && cd.score_opp != null) {
      r += ` · ${cd.score_own}:${cd.score_opp}`;
    }
    parts.push(r);
  }
  const src = String(cd.timeline_source || "").trim();
  if (src === "round_timeline_round") {
    parts.push("整回合");
  } else {
    const kc = Number(cd.kill_count) || 0;
    const kind = String(cd.timeline_record_kind || "").trim();
    if (kc > 0) {
      parts.push(`${kc} 杀`);
    } else if (kind === "death") {
      parts.push("死亡");
    } else {
      parts.push("—");
    }
  }
  parts.push(est != null ? `~${est}s` : "~—s");
  return parts.join(" · ");
}

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
  const roundNum =
    round != null && Number.isFinite(Number(round))
      ? Number(round)
      : Number.isFinite(Number(event?.round))
        ? Number(event.round)
        : 0;
  const atk = String(event?.attacker_name || "").trim();
  const vic = String(event?.victim_name || "").trim();
  const wpn = String(event?.weapon_name || event?.weapon || "").trim();
  let queueSummaryLine = "";
  if (isKill) {
    const parts = [vic ? `击杀 ${vic}` : "击杀", wpn || null].filter(Boolean);
    queueSummaryLine = parts.join(" · ");
  } else if (isDeath) {
    const parts = [atk ? `被 ${atk} 击杀` : "死亡", wpn || null].filter(Boolean);
    queueSummaryLine = parts.join(" · ");
  } else {
    queueSummaryLine = "时间线事件";
  }
  return {
    clip_id: client_clip_uid,
    client_clip_uid,
    round: roundNum,
    category: isKill ? "highlight" : isDeath ? "fail" : "highlight",
    weapon_used: wpn,
    kill_count: isKill ? 1 : 0,
    start_tick: safeSt,
    end_tick: safeEt,
    map_name: mapName || "unknown",
    context_tags: [],
    queue_summary_line: queueSummaryLine,
    timeline_record_kind: isKill ? "kill" : isDeath ? "death" : "other",
    clip_min_tick: safeSt,
    clip_max_tick: safeEt,
    kill_ticks: isKill && Number.isFinite(tick) ? [tick] : [],
    death_tick: isDeath && Number.isFinite(tick) ? tick : null,
    killer_name: isDeath ? atk || null : null,
    victims: isKill && vic ? [vic] : [],
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
  const en =
    roundRow?.record_end_tick ?? roundRow?.end_tick ?? roundRow?.round_end_tick;
  const st = fe != null && Number.isFinite(Number(fe)) ? Number(fe) : 0;
  let et = en != null && Number.isFinite(Number(en)) ? Number(en) : st + 64 * 45;
  if (et <= st) et = st + 64 * 10;
  /** 本回合目标死亡后短留白即结束，避免死亡观战结束镜头切到他人仍长时间录制 */
  const ROUND_DEATH_TAIL_TICKS = Math.round(64 * 2.0);
  const events = Array.isArray(roundRow?.events) ? roundRow.events : [];
  const deathTicks = events
    .filter((e) => e?.record_type === "death" || e?.type === "death")
    .map((e) => Number(e?.tick))
    .filter((t) => Number.isFinite(t) && t > 0);
  const lastDeathTick = deathTicks.length ? Math.max(...deathTicks) : null;
  if (lastDeathTick != null) {
    const cap = lastDeathTick + ROUND_DEATH_TAIL_TICKS;
    et = Math.min(et, cap);
    if (et <= st) et = st + 64;
  }
  const client_clip_uid = `tl_round_${Number.isFinite(rn) ? rn : "x"}`;
  const sum = roundRow?.summary && typeof roundRow.summary === "object" ? roundRow.summary : {};
  const ps = roundRow?.player_stats && typeof roundRow.player_stats === "object" ? roundRow.player_stats : {};
  const tk = Number(ps.kills ?? sum.kills) || 0;
  const td = Number(ps.deaths ?? sum.deaths) || 0;
  const ta = Number(ps.assists ?? sum.assists) || 0;
  const queueSummaryLine = `本回合目标 ${tk} 杀 / ${td} 死 / ${ta} 助攻`;
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
    context_tags: [],
    queue_summary_line: queueSummaryLine,
    timeline_record_kind: "round",
    fixed_segment_pacing: true,
    clip_min_tick: st,
    clip_max_tick: et,
    kill_ticks: [],
    timeline_source: "round_timeline_round",
    _timeline_target: targetPlayer || null,
  };
}
