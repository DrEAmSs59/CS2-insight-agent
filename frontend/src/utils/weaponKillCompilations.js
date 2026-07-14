import { weaponDisplayName } from "../i18n/weaponNames.js";
import { resolveHudWeaponStem } from "../components/analysis/timeline/killfeed/resolveHudWeaponStem.js";

function isKillEvent(event) {
  const type = String(event?.record_type || event?.type || "").trim();
  return type === "kill" && Number.isFinite(Number(event?.tick));
}

function normalizedWeaponKey(event) {
  const rawKey = String(event?.weapon_key || event?.weapon || "").trim();
  const rawName = String(event?.weapon_name || "").trim();
  const haystack = `${rawKey} ${rawName}`.toLowerCase().replace(/[-\s]+/g, "_");
  const hudStem = resolveHudWeaponStem(rawKey, rawName);
  // resolveHudWeaponStem intentionally falls back to ak47 for missing HUD assets.
  // Only accept that fallback when the source actually identifies an AK.
  if (hudStem !== "ak47" || haystack.includes("ak47") || haystack.includes("ak_47")) {
    return hudStem;
  }
  return (rawKey || rawName || "unknown").toLowerCase().replace(/^weapon_/, "") || "unknown";
}

function eventWindow(event) {
  const tick = Number(event?.tick);
  const suggested = event?.suggested_clip;
  const rawStart = Number(event?.start_tick ?? suggested?.start_tick);
  const rawEnd = Number(event?.end_tick ?? suggested?.end_tick);
  const start = Number.isFinite(rawStart) ? rawStart : Math.max(0, tick - 64 * 6);
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : tick + 64 * 4;
  return [start, end];
}

function uidPart(value) {
  return encodeURIComponent(String(value || "unknown").trim().toLowerCase());
}

/**
 * Flatten the round timeline and group the focused player's kills by weapon.
 * Groups are ordered by kill count, then by the first kill tick.
 */
export function groupTimelineKillsByWeapon(roundTimeline, locale = "zh") {
  const grouped = new Map();
  for (const roundRow of Array.isArray(roundTimeline) ? roundTimeline : []) {
    const round = Number(roundRow?.round_number ?? roundRow?.round);
    for (const rawEvent of Array.isArray(roundRow?.events) ? roundRow.events : []) {
      if (!isKillEvent(rawEvent)) continue;
      const event = {
        ...rawEvent,
        round: Number.isFinite(Number(rawEvent?.round)) ? Number(rawEvent.round) : round,
      };
      const key = normalizedWeaponKey(event);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    }
  }

  return [...grouped.entries()]
    .map(([weaponKey, events]) => {
      const sortedEvents = [...events].sort((a, b) => Number(a.tick) - Number(b.tick));
      const rawLabel = String(sortedEvents[0]?.weapon_name || weaponKey).trim();
      return {
        weaponKey,
        weaponName: weaponDisplayName(rawLabel, locale) || rawLabel || weaponKey,
        events: sortedEvents,
        killCount: sortedEvents.length,
        roundCount: new Set(sortedEvents.map((event) => Number(event.round)).filter(Number.isFinite)).size,
        firstTick: Number(sortedEvents[0]?.tick) || 0,
      };
    })
    .sort((a, b) => b.killCount - a.killCount || a.firstTick - b.firstTick);
}

export function summarizeWeaponKills(roundTimeline) {
  const groups = groupTimelineKillsByWeapon(roundTimeline, "zh");
  return {
    groupCount: groups.length,
    killCount: groups.reduce((sum, group) => sum + group.killCount, 0),
  };
}

/**
 * Convert one weapon group into the existing kill-compilation clip contract.
 * The recording layer will therefore merge nearby kills in the same round and
 * jump-cut between distant kills/rounds, just like the existing "all kills" card.
 */
export function buildWeaponKillCompilationClipData({
  events,
  weaponKey = "",
  weaponName = "",
  mapName = "",
  targetPlayer = "",
  demoFilename = "",
  t,
  locale = "zh",
}) {
  const kills = (Array.isArray(events) ? events : [])
    .filter(isKillEvent)
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  if (!kills.length) return null;

  const resolvedKey = weaponKey || normalizedWeaponKey(kills[0]);
  const rawName = weaponName || String(kills[0]?.weapon_name || resolvedKey).trim();
  const resolvedName = weaponDisplayName(rawName, locale) || rawName || resolvedKey;
  const sourceTicks = kills.map(eventWindow);
  const startTick = Math.min(...sourceTicks.map((window) => window[0]));
  const endTick = Math.max(...sourceTicks.map((window) => window[1]));
  const tr = typeof t === "function" ? t : (key, params = {}) => {
    if (key === "weaponKills.clipTitle") return `${params.weapon || resolvedName} weapon kills`;
    if (key === "weaponKills.queueSummary") return `${params.weapon || resolvedName} · ${params.n || kills.length}K`;
    if (key === "weaponKills.contextCount") return `${params.n || kills.length} kills`;
    return key;
  };
  const clientClipUid = [
    "weapon_kills",
    uidPart(demoFilename),
    uidPart(targetPlayer),
    uidPart(resolvedKey),
  ].join(":");

  return {
    clip_id: clientClipUid,
    client_clip_uid: clientClipUid,
    title: tr("weaponKills.clipTitle", { weapon: resolvedName }),
    round: Number(kills[0]?.round) || 0,
    category: "compilation",
    compilation_kind: "weapon_kills",
    weapon_used: resolvedName,
    weapon_key: resolvedKey,
    kill_count: kills.length,
    start_tick: startTick,
    end_tick: endTick,
    map_name: mapName || "unknown",
    context_tags: [
      `🔫 ${resolvedName}`,
      tr("weaponKills.contextCount", { n: kills.length }),
    ],
    queue_summary_line: tr("weaponKills.queueSummary", { weapon: resolvedName, n: kills.length }),
    killers: kills.map(() => targetPlayer),
    victims: kills.map((event) => String(event?.victim_name || "").trim()),
    victim_steamid64s: kills.map((event) => String(event?.victim_steamid || "").trim()),
    victim_spec_slots: kills.map((event) => event?.victim_spec_slot ?? null),
    kill_ticks: kills.map((event) => Number(event.tick)),
    kill_weapons: kills.map((event) => String(event?.weapon_key || event?.weapon_name || resolvedKey)),
    kill_headshots: kills.map((event) => Boolean(event?.is_headshot ?? event?.headshot)),
    kill_tag_lists: kills.map(() => []),
    source_rounds: kills.map((event) => Number(event?.round) || 0),
    source_ticks: sourceTicks,
    clip_min_tick: startTick,
    clip_max_tick: endTick,
    target_spec_slot: kills[0]?.attacker_spec_slot ?? null,
    weapon_kills_source: "round_timeline",
  };
}
