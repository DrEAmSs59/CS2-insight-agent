import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bomb,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Loader2,
  Map as MapIcon,
  Pause,
  Play,
  RotateCcw,
  Route,
  Swords,
} from "lucide-react";
import { getDemoRadarMapUrl } from "../../api/api";
import KillfeedIconStrip from "./timeline/killfeed/KillfeedIconStrip";
import { resolveHudWeaponStem } from "./timeline/killfeed/resolveHudWeaponStem";
import ReplayAreaEffectsCanvas from "./ReplayAreaEffectsCanvas";
import { isSmokeDebugEnabled } from "./smokeDebugGate";
import {
  resolveReplayTransform,
  worldToRadarPercent,
  yawToCssRotation,
} from "../../utils/replayRadarTransform";
import { useReplayStore } from "../../stores/replayStore";

const SAMPLE_HZ = 8;
const REPLAY_CACHE_VERSION = 10;
const ROUND_CLOCK_SECONDS = 115;
const HUD_ICON_BASE = "/hud-death-notice";

function HudEquipmentIcon({ stem, className = "", title = "" }) {
  return <img src={`${HUD_ICON_BASE}/${stem}.svg`} alt="" title={title} draggable={false} className={`block object-contain ${className}`} />;
}

function safeLabel(value, fallback = "") {
  const text = String(value ?? "").trim();
  return !text || ["nan", "nat", "none", "null", "undefined"].includes(text.toLowerCase()) ? fallback : text;
}

function safeWeapon(value, fallback = "") {
  const text = safeLabel(value, "");
  return !text || /^\d+(?:\.0+)?$/.test(text) ? fallback : text;
}

function grenadeVisual(kind) {
  const value = safeLabel(kind, "投掷物");
  if (/烟|smoke/i.test(value)) return { stem: "smokegrenade", short: "烟", className: "border-sky-200 bg-sky-500/85 text-white" };
  if (/闪|flash/i.test(value)) return { stem: "flashbang", short: "闪", className: "border-yellow-100 bg-yellow-300/90 text-yellow-950" };
  if (/燃|火|molotov|inferno|incendiary/i.test(value)) return { stem: /incendiary|incgrenade/i.test(value) ? "incgrenade" : "molotov", short: "火", className: "border-orange-100 bg-orange-500/90 text-white" };
  return { stem: "hegrenade", short: /HE/i.test(value) ? "雷" : "投", className: "border-rose-100 bg-rose-500/90 text-white" };
}

function utilityInventory(inventory) {
  const groups = new Map();
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const item = safeLabel(raw).toLowerCase().replace(/^weapon_/, "");
    let entry = null;
    if (/smoke/.test(item)) entry = { key: "smoke", label: "烟雾弹", stem: "smokegrenade", tone: "text-slate-100 bg-slate-400/20" };
    else if (/flash/.test(item)) entry = { key: "flash", label: "闪光弹", stem: "flashbang", tone: "text-yellow-200 bg-yellow-400/15" };
    else if (/high explosive|hegrenade|he grenade/.test(item)) entry = { key: "he", label: "HE 手雷", stem: "hegrenade", tone: "text-rose-200 bg-rose-400/15" };
    else if (/molotov|incendiary|incgrenade/.test(item)) entry = { key: "fire", label: "燃烧弹", stem: /incendiary|incgrenade/.test(item) ? "incgrenade" : "molotov", tone: "text-orange-200 bg-orange-400/15" };
    else if (/decoy/.test(item)) entry = { key: "decoy", label: "诱饵弹", stem: "decoy", tone: "text-violet-200 bg-violet-400/15" };
    if (!entry) continue;
    const current = groups.get(entry.key);
    groups.set(entry.key, current ? { ...current, count: current.count + 1 } : { ...entry, count: 1 });
  }
  return [...groups.values()];
}

function primaryWeaponFromInventory(inventory) {
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const item = safeLabel(raw).toLowerCase().replace(/^weapon_/, "");
    if (!item) continue;
    if (/knife|bayonet|smoke|flash|hegrenade|molotov|incendiary|incgrenade|decoy|taser|c4|defuser|healthshot/.test(item)) {
      continue;
    }
    return safeLabel(raw);
  }
  return "";
}

function meleeFromInventory(inventory) {
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const item = safeLabel(raw).toLowerCase().replace(/^weapon_/, "");
    if (/knife|bayonet|karambit|shadow_daggers|gut|flip|bayonet/.test(item)) {
      return safeLabel(raw);
    }
  }
  return "";
}

function resolveReplayWeapon(state) {
  const direct = safeWeapon(state?.weapon, "").replace(/^weapon_/i, "");
  if (direct) return direct;
  return primaryWeaponFromInventory(state?.inventory) || meleeFromInventory(state?.inventory);
}

function armorText(state) {
  const armor = Math.max(0, Number(state?.armor) || 0);
  if (!armor) return "无甲";
  return state?.has_helmet ? `${armor} 头甲` : `${armor} 甲`;
}

function eventLabel(event) {
  if (event?.type === "kill") return `${safeLabel(event.actor, "未知玩家")} 使用 ${safeLabel(event.weapon, "武器")} 击杀 ${safeLabel(event.target, "未知玩家")}${event.headshot ? "（爆头）" : ""}`;
  if (event?.type === "grenade") return `${safeLabel(event.actor, "未知玩家")} 投掷 ${safeLabel(event.kind, "投掷物")}`;
  if (event?.type === "plant") return `${safeLabel(event.actor, "玩家")} 在 ${safeLabel(event.site, "?")} 区下包`;
  if (event?.type === "bomb_pickup") return `${safeLabel(event.actor, "玩家")} 捡起 C4`;
  if (event?.type === "bomb_drop") return `${safeLabel(event.actor, "玩家")} 丢下 C4`;
  if (event?.type === "defuse") return `${safeLabel(event.actor, "玩家")} 完成拆弹`;
  if (event?.type === "explode") return "C4 爆炸";
  return "比赛事件";
}

function grenadeLandingPoint(event) {
  if (Number.isFinite(Number(event?.x)) && Number.isFinite(Number(event?.y))) {
    return { x: Number(event.x), y: Number(event.y) };
  }
  const last = Array.isArray(event?.trajectory) ? event.trajectory.at(-1) : null;
  return Number.isFinite(Number(last?.x)) && Number.isFinite(Number(last?.y))
    ? { x: Number(last.x), y: Number(last.y) }
    : null;
}

function smokeTrajectoryQuality(event, tickRate) {
  const points = Array.isArray(event?.trajectory) ? event.trajectory : [];
  if (points.length < 2) return 0;
  const span = Number(points.at(-1)?.tick || 0) - Number(points[0]?.tick || 0);
  const landing = grenadeLandingPoint(event);
  const endpoint = points.at(-1);
  const endpointDistance = landing && endpoint
    ? Math.hypot(Number(endpoint.x) - landing.x, Number(endpoint.y) - landing.y)
    : 0;
  if (span <= 0 || span > tickRate * 5 || endpointDistance > 256) return -1;
  return points.length + Math.min(span, tickRate * 5) / Math.max(1, tickRate);
}

function grenadeThrowTick(event, tickRate) {
  const trajectoryStart = Array.isArray(event?.trajectory) ? Number(event.trajectory[0]?.tick || 0) : 0;
  const parsed = Number(event?.throw_tick || trajectoryStart || 0);
  if (parsed > 0) return parsed;
  const isSmoke = /烟|smoke/i.test(safeLabel(event?.kind));
  return Math.max(0, Number(event?.tick || 0) - tickRate * (isSmoke ? 2.25 : 1));
}

function replayEventsForRound(round, tickRate = 64) {
  const startTick = Number(round?.freeze_end_tick ?? round?.start_tick ?? -Infinity);
  const endTick = Number(round?.end_tick ?? Infinity);
  const seen = new Set();
  const terminalEvents = new Set();
  const filtered = (round?.events || []).filter((event) => {
    const tick = Number(event?.tick || 0);
    if (Number.isFinite(startTick) && tick < startTick) return false;
    if (Number.isFinite(endTick) && tick > endTick) return false;
    if (["explode", "defuse"].includes(event?.type)) {
      if (terminalEvents.has(event.type)) return false;
      terminalEvents.add(event.type);
    }
    const identity = [event?.type, tick, event?.actor, event?.target, event?.kind].join("|");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const merged = [];
  for (const event of filtered) {
    if (event?.type !== "grenade") {
      merged.push(event);
      continue;
    }
    const eventKind = safeLabel(event.kind).toLowerCase();
    const eventActor = safeLabel(event.actor).toLowerCase();
    const eventThrowTick = grenadeThrowTick(event, tickRate);
    const isSmoke = /烟|smoke/i.test(eventKind);
    const landing = grenadeLandingPoint(event);
    const duplicateIndex = merged.findIndex((candidate) => {
      if (candidate?.type !== "grenade") return false;
      if (safeLabel(candidate.kind).toLowerCase() !== eventKind) return false;
      if (safeLabel(candidate.actor).toLowerCase() !== eventActor) return false;
      const sameThrow = Math.abs(grenadeThrowTick(candidate, tickRate) - eventThrowTick) <= tickRate * 0.6;
      const eventWindow = isSmoke ? tickRate * 4 : tickRate * 0.75;
      if (!sameThrow && Math.abs(Number(candidate.tick || 0) - Number(event.tick || 0)) > eventWindow) return false;
      const candidateLanding = grenadeLandingPoint(candidate);
      const sameLanding = landing && candidateLanding
        && Math.hypot(landing.x - candidateLanding.x, landing.y - candidateLanding.y) <= 96;
      return sameThrow || sameLanding;
    });
    if (duplicateIndex < 0) {
      merged.push(event);
    } else if (smokeTrajectoryQuality(event, tickRate) > smokeTrajectoryQuality(merged[duplicateIndex], tickRate)) {
      merged[duplicateIndex] = event;
    }
  }
  return merged.sort((left, right) => Number(left.tick || 0) - Number(right.tick || 0));
}

function grenadeDurationSeconds(kind) {
  const value = safeLabel(kind);
  if (/烟|smoke/i.test(value)) return 18;
  if (/燃烧|molotov|inferno|incendiary/i.test(value)) return 7;
  if (/闪|flash/i.test(value)) return 0.85;
  return 0.4;
}

function eventFrameRatio(event, frames, selectedRound) {
  if (frames.length > 1) {
    const eventTick = Number(event?.tick || 0);
    const index = frames.findIndex((item) => Number(item.tick || 0) >= eventTick);
    return clamp((index >= 0 ? index : frames.length - 1) / (frames.length - 1), 0, 1);
  }
  return clamp(
    (Number(event?.tick || 0) - Number(selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0))
      / Math.max(1, Number(selectedRound?.end_tick || 0) - Number(selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0)),
    0,
    1,
  );
}

function interpolateTrajectoryPoint(points, tick) {
  if (!points.length) return null;
  if (tick <= Number(points[0].tick || 0)) return points[0];
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    const previous = points[index - 1];
    const nextTick = Number(next.tick || 0);
    if (nextTick < tick) continue;
    const previousTick = Number(previous.tick || 0);
    const ratio = clamp((tick - previousTick) / Math.max(1, nextTick - previousTick), 0, 1);
    return {
      tick,
      x: Number(previous.x) + (Number(next.x) - Number(previous.x)) * ratio,
      y: Number(previous.y) + (Number(next.y) - Number(previous.y)) * ratio,
      z: Number.isFinite(Number(previous.z)) && Number.isFinite(Number(next.z))
        ? Number(previous.z) + (Number(next.z) - Number(previous.z)) * ratio
        : undefined,
    };
  }
  return points.at(-1);
}

function trimPolylineEnd(points, distance) {
  if (!Array.isArray(points) || points.length < 2 || distance <= 0) return points || [];
  const next = points.map((point) => ({ ...point }));
  const totalLength = next.slice(1).reduce((sum, point, index) => {
    const previous = next[index];
    const length = Math.hypot(Number(point.x) - Number(previous.x), Number(point.y) - Number(previous.y));
    return Number.isFinite(length) ? sum + length : sum;
  }, 0);
  // Very short inferred paths still need to remain visible. Trim no more than
  // 45% of the path while keeping normal throws outside the grenade marker.
  let remaining = Math.min(distance, totalLength * 0.45);
  for (let index = next.length - 1; index > 0; index -= 1) {
    const end = next[index];
    const start = next[index - 1];
    const dx = Number(end.x) - Number(start.x);
    const dy = Number(end.y) - Number(start.y);
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= 0.0001) {
      next.splice(index, 1);
      continue;
    }
    if (length > remaining) {
      next[index] = {
        ...end,
        x: Number(end.x) - (dx / length) * remaining,
        y: Number(end.y) - (dy / length) * remaining,
      };
      return next;
    }
    remaining -= length;
    next.splice(index, 1);
  }
  return next;
}

function interpolateNumber(start, end, ratio) {
  const left = Number(start);
  const right = Number(end);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return start;
  return left + (right - left) * ratio;
}

function smoothstep(ratio) {
  const t = clamp(Number(ratio) || 0, 0, 1);
  return t * t * (3 - 2 * t);
}

function interpolateYaw(start, end, ratio) {
  const left = Number(start);
  const right = Number(end);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return start;
  const delta = ((right - left + 540) % 360) - 180;
  return left + delta * ratio;
}

function replayPlayerKey(player) {
  return String(player?.steamid64 || player?.steam_id64 || player?.name || "").trim().toLowerCase();
}

function interpolateReplayFrame(frames, position, fallbackTick) {
  if (!frames.length) return { players: [], tick: fallbackTick, time_sec: 0 };
  const lowerIndex = clamp(Math.floor(position), 0, frames.length - 1);
  const upperIndex = Math.min(frames.length - 1, lowerIndex + 1);
  const lower = frames[lowerIndex] || {};
  const upper = frames[upperIndex] || lower;
  const ratio = clamp(position - lowerIndex, 0, 1);
  if (upperIndex === lowerIndex || ratio <= 0) return lower;
  const eased = smoothstep(ratio);

  const upperPlayers = new Map((upper.players || []).map((player) => [replayPlayerKey(player), player]));
  const players = (lower.players || []).map((player) => {
    const next = upperPlayers.get(replayPlayerKey(player));
    if (!next) return player;
    return {
      ...player,
      x: interpolateNumber(player.x, next.x, eased),
      y: interpolateNumber(player.y, next.y, eased),
      z: interpolateNumber(player.z, next.z, eased),
      yaw: interpolateYaw(player.yaw, next.yaw, eased),
      weapon: (() => {
        const preferred = ratio >= 0.5 ? (next.weapon || player.weapon) : (player.weapon || next.weapon);
        return preferred || player.weapon || next.weapon || "";
      })(),
      inventory: ratio >= 0.5 ? (next.inventory || player.inventory) : (player.inventory || next.inventory),
    };
  });
  return {
    ...lower,
    players,
    tick: interpolateNumber(lower.tick, upper.tick, eased),
    time_sec: interpolateNumber(lower.time_sec, upper.time_sec, eased),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function replaySideForTeamKey(teamKey, round) {
  if (!["a", "b"].includes(teamKey)) return "";
  return String(teamKey === "a" ? round?.team_a_side : round?.team_b_side).trim().toUpperCase();
}

function isBlueReplaySide(side, fallback = false) {
  const normalized = String(side || "").trim().toUpperCase();
  return normalized ? normalized === "CT" : fallback;
}

function replaySideColor(side, fallback = false) {
  return isBlueReplaySide(side, fallback) ? "#38bdf8" : "#fbbf24";
}

function replayPlayerNumber(teamKey, index) {
  return teamKey === "a" ? index : index + 5;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function replayPositionForTime(frames, targetSeconds) {
  if (!frames.length) return 0;
  const target = Number(targetSeconds);
  if (!Number.isFinite(target) || target <= Number(frames[0]?.time_sec || 0)) return 0;
  for (let index = 1; index < frames.length; index += 1) {
    const previousTime = Number(frames[index - 1]?.time_sec || 0);
    const nextTime = Number(frames[index]?.time_sec || previousTime);
    if (target > nextTime) continue;
    const ratio = clamp((target - previousTime) / Math.max(0.0001, nextTime - previousTime), 0, 1);
    return index - 1 + ratio;
  }
  return frames.length - 1;
}

function mapKey(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  return /^(de|cs|ar)_/.test(raw) ? raw : `de_${raw}`;
}

function worldToPercent(player, transform) {
  const percent = worldToRadarPercent(player, transform);
  if (!percent) return null;
  return {
    x: clamp(percent.x, -5, 105),
    y: clamp(percent.y, -5, 105),
  };
}

function mapLayerThreshold(transform) {
  const value = Number(transform?.lower_level_max_units);
  return Number.isFinite(value) ? value : null;
}

function pointMatchesMapLayer(point, transform, layer) {
  const threshold = mapLayerThreshold(transform);
  if (threshold == null) return true;
  const z = Number(point?.z);
  if (!Number.isFinite(z)) return true;
  return layer === "lower" ? z <= threshold : z > threshold;
}

function ReplayRoster({ title, teamKey, side, players, framePlayers, bombCarrierName = "" }) {
  const byName = new Map((framePlayers || []).map((player) => [safeLabel(player.name).toLowerCase(), player]));
  const isBlue = isBlueReplaySide(side, !side && teamKey === "a");
  const exclusiveCarrier = safeLabel(bombCarrierName).toLowerCase();
  return (
    <aside className="rounded-xl border border-cs2-border bg-cs2-bg-card p-4">
      <div className="mb-3 flex items-center justify-between border-b border-cs2-border pb-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${isBlue ? "bg-sky-400" : "bg-amber-400"}`} />
          <h3 className="text-[14px] font-black uppercase tracking-wide text-cs2-text-primary">{title}</h3>
        </div>
        <span className="font-mono text-[12px] text-cs2-text-muted">{players.filter((player) => byName.get(safeLabel(player.name).toLowerCase())?.is_alive !== false).length}/5</span>
      </div>
      <div className="space-y-2">
        {players.map((player, index) => {
          const displayName = safeLabel(player.name, `玩家 ${index + 1}`);
          const state = byName.get(displayName.toLowerCase()) || {};
          const alive = state.is_alive !== false;
          const health = Number.isFinite(Number(state.health)) ? Math.max(0, Number(state.health)) : (alive ? 100 : 0);
          const weapon = alive ? resolveReplayWeapon(state) || "—" : "—";
          // Single source of truth: only the resolved bomb carrier may show C4.
          const hasC4 = Boolean(alive && exclusiveCarrier && displayName.toLowerCase() === exclusiveCarrier);
          const utilities = alive ? utilityInventory(state.inventory) : [];
          const hasArmor = Number(state.armor || 0) > 0;
          const armorValue = Math.max(0, Number(state.armor) || 0);
          const weaponStem = alive && weapon !== "—" ? resolveHudWeaponStem(weapon, weapon, { fallback: "" }) : "";
          return (
            <div key={displayName} className={`rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-3 py-3 ${alive ? "" : "opacity-45"}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-full font-mono text-[12px] font-black leading-none ${isBlue ? "bg-sky-500/20 text-sky-300" : "bg-amber-500/20 text-amber-300"}`}>
                  {replayPlayerNumber(teamKey, index)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-cs2-text-primary">{displayName}</span>
                <span
                  className={`shrink-0 font-mono text-[13px] font-black tabular-nums ${
                    !alive
                      ? "text-cs2-text-muted"
                      : health > 70
                        ? "text-emerald-300"
                        : health > 30
                          ? "text-amber-300"
                          : "text-rose-400"
                  }`}
                >
                  {alive ? `${health} HP` : "阵亡"}
                </span>
              </div>
              <div className="mt-1.5 flex min-h-5 items-center gap-1.5 pl-8 text-[10px] text-cs2-text-muted">
                <span className="flex min-w-0 flex-1 items-center" title={weapon} aria-label={`${displayName} 当前武器 ${weapon}`}>{weaponStem && <HudEquipmentIcon stem={weaponStem} className="h-[18px] w-8 shrink-0" />}</span>
                <span className="shrink-0 font-mono font-bold text-emerald-300">${Math.max(0, Number(state.money) || 0).toLocaleString("en-US")}</span>
                {hasArmor && (
                  <span
                    title={state.has_helmet ? "头盔 + 防弹衣" : "防弹衣"}
                    aria-label={`${displayName} ${state.has_helmet ? "头盔和防弹衣" : "防弹衣"} ${armorValue}`}
                    className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded bg-sky-500/12 px-1 font-mono text-[10px] font-bold tabular-nums text-sky-200"
                  >
                    <HudEquipmentIcon stem={state.has_helmet ? "armor_helmet" : "armor"} className="h-4 w-5" />
                    {armorValue}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-1.5 pl-8 text-[10px] text-cs2-text-muted">
                {utilities.map(({ key, label, stem, tone, count }) => <span key={key} title={`${label}${count > 1 ? ` ×${count}` : ""}`} aria-label={`${displayName} 持有${label}${count > 1 ? ` ${count} 枚` : ""}`} className={`inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1.5 ${tone}`}><HudEquipmentIcon stem={stem} className="h-4 w-4" />{count > 1 && <b className="font-mono text-[9px] leading-none">{count}</b>}</span>)}
                {hasC4 && <span title="携带 C4" aria-label={`${displayName} 携带 C4`} className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-[3px] bg-amber-400 px-1.5 font-black leading-none text-black"><HudEquipmentIcon stem="c4" className="h-4 w-4 brightness-0" />C4</span>}
                {state.has_defuser && <span title="携带拆弹器" aria-label={`${displayName} 携带拆弹器`} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-sky-300 text-sky-950"><HudEquipmentIcon stem="defuser" className="h-4 w-4 brightness-0" /></span>}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function GrenadeEffectMarker({ grenade, motionDuration, useAreaFallback = true }) {
  const visual = grenadeVisual(grenade.kind);
  const title = `${safeLabel(grenade.actor, "未知玩家")} ${safeLabel(grenade.kind, "投掷物")}`;
  const teamColor = grenade.teamColor || "#fbbf24";
  const style = { left: `${grenade.position.x}%`, top: `${grenade.position.y}%`, opacity: grenade.opacity };
  if (grenade.phase === "flight") {
    return (
      <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-[left,top] ease-linear" style={{ ...style, transitionDuration: motionDuration }} title={title} data-side={grenade.side || undefined}>
        <div className="demo-grenade-projectile flex h-4 w-4 items-center justify-center overflow-hidden rounded-full leading-none shadow-lg" style={{ backgroundColor: teamColor, boxShadow: `0 0 0 1px ${teamColor}88, 0 0 7px ${teamColor}` }}><HudEquipmentIcon stem={visual.stem} className="h-3 w-3" /></div>
      </div>
    );
  }
  if (/烟|smoke/i.test(grenade.kind)) {
    // Real voxel areas replace circles; countdown is drawn on the area itself.
    if (!useAreaFallback) return null;
    const remaining = Math.max(0, grenade.duration - grenade.effectAge);
    const ring = clamp(remaining / Math.max(0.01, grenade.duration), 0, 1);
    return (
      <div className="demo-effect-shell pointer-events-none absolute z-10 h-[32px] w-[32px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ ...style, backgroundColor: `${teamColor}18`, boxShadow: `0 0 5px ${teamColor}2e` }} title={`${title} · 剩余 ${remaining.toFixed(1)} 秒`} data-side={grenade.side || undefined}>
        <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full -rotate-90"><circle className="demo-duration-ring" cx="16" cy="16" r="14" fill="none" stroke={teamColor} strokeWidth="1.6" strokeLinecap="round" pathLength="1" strokeDasharray={`${ring} 1`} /></svg>
        <div className="demo-smoke-effect absolute inset-[4px]">
          {[0, 1, 2, 3, 4, 5].map((index) => <span key={index} style={{ "--sx": `${((index % 3) - 1) * 3}px`, "--sy": `${(Math.floor(index / 3) - 0.5) * 3}px`, "--ex": `${((index % 3) - 1) * 5}px`, "--ey": `${(Math.floor(index / 3) - 0.5) * 4}px`, animationDelay: `${index * -0.19}s` }} />)}
          <HudEquipmentIcon stem="smokegrenade" className="absolute left-1/2 top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 drop-shadow" />
        </div>
        <em className="absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[6px] not-italic text-sky-100">{remaining.toFixed(1)}s</em>
      </div>
    );
  }
  if (/燃烧|molotov|inferno|incendiary/i.test(grenade.kind)) {
    if (!useAreaFallback) return null;
    const remaining = Math.max(0, grenade.duration - grenade.effectAge);
    const ring = clamp(remaining / Math.max(0.01, grenade.duration), 0, 1);
    return (
      <div className="demo-effect-shell pointer-events-none absolute z-10 h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ ...style, backgroundColor: `${teamColor}1c`, boxShadow: `0 0 6px ${teamColor}38` }} title={`${title} · 剩余 ${remaining.toFixed(1)} 秒`} data-side={grenade.side || undefined}>
        <svg viewBox="0 0 30 30" className="absolute inset-0 h-full w-full -rotate-90"><circle className="demo-duration-ring" cx="15" cy="15" r="13" fill="none" stroke={teamColor} strokeWidth="1.6" strokeLinecap="round" pathLength="1" strokeDasharray={`${ring} 1`} /></svg>
        <div className="demo-fire-effect absolute inset-[4px]">
          {[0, 1, 2, 3].map((index) => <span key={index} style={{ left: `${1 + index * 5}px`, animationDelay: `${index * -0.16}s` }} />)}
          <HudEquipmentIcon stem={visual.stem} className="absolute left-1/2 top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 drop-shadow" />
        </div>
        <em className="absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[6px] not-italic text-orange-100">{remaining.toFixed(1)}s</em>
      </div>
    );
  }
  if (/闪|flash/i.test(grenade.kind)) {
    return <div className="demo-flash-effect pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2" style={{ ...style, backgroundColor: teamColor, boxShadow: `0 0 13px 6px ${teamColor}88` }} title={title} data-side={grenade.side || undefined}><HudEquipmentIcon stem="flashbang" className="h-3.5 w-3.5" /></div>;
  }
  return (
    <div className="demo-explosion-effect pointer-events-none absolute z-20 h-11 w-11 -translate-x-1/2 -translate-y-1/2" style={{ ...style, background: `radial-gradient(circle, #fff 0 8%, ${teamColor} 10% 30%, ${teamColor}88 31% 48%, transparent 50%)`, filter: `drop-shadow(0 0 7px ${teamColor})` }} title={title} data-side={grenade.side || undefined}>
      <span className="demo-explosion-ring" style={{ borderColor: teamColor, backgroundColor: `${teamColor}44` }} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => <i key={index} style={{ transform: `rotate(${index * 45}deg)` }} />)}
      <HudEquipmentIcon stem="hegrenade" className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2" />
    </div>
  );
}

export default function Demo2DReplayPreview({
  workspace,
  demoPath,
  players = [],
  teamAName = "Team A",
  teamBName = "Team B",
  initialRound,
}) {
  const rounds = workspace?.rounds || [];
  const [roundNumber, setRoundNumber] = useState(initialRound || rounds[0]?.round_number || 1);
  const [frames, setFrames] = useState([]);
  const [effectTracks, setEffectTracks] = useState([]);
  const [effectCapabilities, setEffectCapabilities] = useState(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadHint, setLoadHint] = useState("");
  const [error, setError] = useState("");
  const [mapLayer, setMapLayer] = useState("upper");
  const [playerLabelMode, setPlayerLabelMode] = useState("number");
  const [responseTransform, setResponseTransform] = useState(null);
  const [replayFps, setReplayFps] = useState(SAMPLE_HZ);
  const [layers, setLayers] = useState({ traces: true, kills: true, grenades: true, utilityAreas: true, shots: true });
  const smokeDebugOn = useMemo(() => isSmokeDebugEnabled(), []);
  const [smokeDebugLayer, setSmokeDebugLayer] = useState("final_render");
  const framePositionRef = useRef(0);

  useEffect(() => {
    setRoundNumber(initialRound || rounds[0]?.round_number || 1);
    setFrames([]);
    setEffectTracks([]);
    setEffectCapabilities(null);
    setFrameIndex(0);
    setPlaying(false);
    setResponseTransform(null);
    setReplayFps(SAMPLE_HZ);
  }, [workspace, initialRound]);

  const selectedRound = rounds.find((round) => Number(round.round_number) === Number(roundNumber)) || rounds[0];
  const tickRate = Number(workspace?.tick_rate || 64);
  const roundEvents = useMemo(() => replayEventsForRound(selectedRound, tickRate), [selectedRound, tickRate]);
  const roundIndex = Math.max(0, rounds.findIndex((round) => round === selectedRound));
  const mapName = mapKey(workspace?.map_name);
  // Prefer live /api/demo/replay map_transform over stale workspace metadata.
  const transform = resolveReplayTransform({
    responseTransform,
    workspaceTransform: workspace?.map_transform,
  });
  const hasMapLayers = mapLayerThreshold(transform) != null && ["de_nuke", "de_vertigo"].includes(mapName);
  const playerMarkerSizePx = 15.3;
  useEffect(() => setMapLayer("upper"), [mapName]);
  const workspacePlayers = useMemo(() => (
    workspace?.players?.length
      ? workspace.players
      : players.map((player, index) => ({ name: player.name || player.player_name, team_key: Number(player.team ?? player.team_number) === 3 ? "b" : index < Math.ceil(players.length / 2) ? "a" : "b" }))
  ), [workspace?.players, players]);
  const teamAPlayers = workspacePlayers.filter((player) => player.team_key === "a").slice(0, 5);
  const teamBPlayers = workspacePlayers.filter((player) => player.team_key === "b").slice(0, 5);
  const playerNumberByName = useMemo(() => new Map([
    ...teamAPlayers.map((player, index) => [safeLabel(player.name).toLowerCase(), replayPlayerNumber("a", index)]),
    ...teamBPlayers.map((player, index) => [safeLabel(player.name).toLowerCase(), replayPlayerNumber("b", index)]),
  ]), [teamAPlayers, teamBPlayers]);

  useEffect(() => {
    if (!selectedRound || !demoPath) return undefined;
    const replayStartTick = Number(selectedRound.freeze_end_tick || selectedRound.start_tick);
    const replayEndTick = Number(selectedRound.end_tick);
    const cacheKey = [
      demoPath,
      `v${REPLAY_CACHE_VERSION}`,
      `r${selectedRound.round_number}`,
      `t${replayStartTick}-${replayEndTick}`,
      `f${SAMPLE_HZ}`,
      "tv1",
    ].join("|");
    const requestBody = {
      path: demoPath,
      map_name: mapName,
      start_tick: replayStartTick,
      end_tick: replayEndTick,
      tick_rate: Number(workspace?.tick_rate || 64),
      fps: SAMPLE_HZ,
      pov_player_name: workspacePlayers[0]?.name || null,
      pov_steamid64: workspacePlayers[0]?.steam_id64 || null,
    };
    let cancelled = false;

    const applyPayload = (data, meta = {}) => {
      const nextFrames = Array.isArray(data?.frames) ? data.frames : [];
      const nextTransform = data?.map_transform && typeof data.map_transform === "object"
        ? data.map_transform
        : null;
      const nextFps = Math.max(1, Number(data?.fps) || SAMPLE_HZ);
      const nextEffectTracks = Array.isArray(data?.effect_tracks) ? data.effect_tracks : [];
      const nextCapabilities = data?.effect_capabilities && typeof data.effect_capabilities === "object"
        ? data.effect_capabilities
        : null;
      setFrames(nextFrames);
      setEffectTracks(nextEffectTracks);
      setEffectCapabilities(nextCapabilities);
      setResponseTransform(nextTransform);
      setReplayFps(nextFps);
      setFrameIndex(0);
      setError(nextFrames.length ? "" : "该回合没有可用的坐标帧");
      setLoading(false);
      const cache = data?.cache || meta.cache;
      if (cache?.frames === "memory_hit" || meta.source === "memory") {
        setLoadHint("已从内存恢复回放");
      } else if (cache?.frames === "disk_hit" || meta.source === "disk") {
        setLoadHint("已从本地缓存读取回放");
      } else {
        setLoadHint("");
      }
    };

    const existing = useReplayStore.getState().getEntry(cacheKey);
    if (existing?.status === "ready" && existing.frames) {
      applyPayload({
        frames: existing.frames,
        map_transform: existing.mapTransform,
        fps: existing.fps,
        effect_tracks: existing.effectTracks,
        effect_capabilities: existing.effectCapabilities,
        cache: existing.cache,
      }, { source: existing.source || "memory" });
      useReplayStore.getState().touch(cacheKey);
      return () => { cancelled = true; };
    }

    setLoading(true);
    setError("");
    setPlaying(false);
    if (existing?.status === "loading") {
      setLoadHint("正在等待同一解析任务…");
    } else {
      setEffectTracks([]);
      setEffectCapabilities(null);
      setLoadHint("正在解析当前回合回放（含烟火效果）…");
    }

    useReplayStore.getState().ensureReplay(cacheKey, requestBody, {
      onStatus: ({ source, shared }) => {
        if (cancelled) return;
        if (shared) setLoadHint("正在等待同一解析任务…");
        else if (source === "parsed") setLoadHint("正在解析当前回合回放（含烟火效果）…");
      },
    }).then((data) => {
      if (!cancelled) applyPayload(data);
    }).catch((reason) => {
      if (!cancelled) {
        setError(reason?.response?.data?.detail || reason?.message || "2D 回放加载失败");
        setLoading(false);
        setLoadHint("");
      }
    });
    return () => { cancelled = true; };
  }, [demoPath, mapName, selectedRound, workspace?.tick_rate, workspacePlayers]);

  useEffect(() => {
    framePositionRef.current = frameIndex;
  }, [frameIndex]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    let animationFrame = 0;
    let previousTime = window.performance.now();
    const lastFrame = frames.length - 1;
    const animate = (now) => {
      const elapsedSeconds = Math.min(0.1, Math.max(0, now - previousTime) / 1000);
      previousTime = now;
      const nextPosition = Math.min(
        lastFrame,
        framePositionRef.current + elapsedSeconds * replayFps * speed,
      );
      framePositionRef.current = nextPosition;
      setFrameIndex(nextPosition);
      if (nextPosition >= lastFrame) {
        setPlaying(false);
        return;
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [playing, frames.length, replayFps, speed]);

  const frameCursorIndex = clamp(Math.floor(frameIndex), 0, Math.max(0, frames.length - 1));
  const frame = interpolateReplayFrame(
    frames,
    frameIndex,
    selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0,
  );
  const currentTick = Number(frame.tick || selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0);
  const hasSmokeAreaTracks = Boolean(
    effectCapabilities?.smoke_voxels
    && effectTracks.some((track) => track?.type === "smoke" && Array.isArray(track.samples) && track.samples.length),
  );
  const hasInfernoAreaTracks = Boolean(
    effectCapabilities?.inferno_cells
    && effectTracks.some((track) => track?.type === "inferno" && Array.isArray(track.samples) && track.samples.length),
  );
  const bombState = useMemo(() => {
    let carrier = safeLabel(selectedRound?.bomb_initial_carrier);
    let status = carrier ? "carried" : "unknown";
    let position = null;
    let z = null;
    let site = "";
    const events = [...roundEvents].sort((a, b) => Number(a.tick || 0) - Number(b.tick || 0));
    for (const event of events) {
      if (Number(event.tick || 0) > currentTick) break;
      if (event.type === "bomb_pickup") {
        carrier = safeLabel(event.actor);
        status = carrier ? "carried" : status;
        position = null;
        z = null;
      } else if (event.type === "bomb_drop") {
        carrier = "";
        status = "dropped";
        position = worldToPercent(event, transform);
        z = Number.isFinite(Number(event.z)) ? Number(event.z) : null;
      } else if (event.type === "plant") {
        carrier = "";
        status = "planted";
        position = worldToPercent(event, transform);
        z = Number.isFinite(Number(event.z)) ? Number(event.z) : null;
        site = safeLabel(event.site);
      } else if (event.type === "defuse") {
        carrier = "";
        status = "defused";
      } else if (event.type === "explode") {
        carrier = "";
        status = "exploded";
      }
    }
    // Prefer event-derived exclusive carrier; fall back to a single frame has_c4.
    if (status === "carried" && !carrier) {
      const frameCarriers = (frame.players || []).filter((player) => player?.has_c4 && player?.is_alive !== false);
      if (frameCarriers.length === 1) carrier = safeLabel(frameCarriers[0].name);
    }
    if (status !== "carried") carrier = "";
    return { carrier, status, position, site, z };
  }, [currentTick, frame.players, roundEvents, selectedRound?.bomb_initial_carrier, transform]);
  const markerPlayers = (frame.players || []).map((player) => {
    const meta = workspacePlayers.find((item) => item.name?.toLowerCase() === String(player.name || "").toLowerCase());
    const frameSide = safeLabel(player.team).toUpperCase();
    const fallbackTeamKey = frameSide && frameSide === String(selectedRound?.team_a_side || "").toUpperCase() ? "a" : "b";
    const displayName = safeLabel(player.name);
    const carriesBomb = bombState.status === "carried"
      && bombState.carrier
      && displayName.toLowerCase() === bombState.carrier.toLowerCase();
    return {
      ...player,
      has_c4: carriesBomb,
      team_key: meta?.team_key || fallbackTeamKey,
      position: worldToPercent(player, transform),
    };
  }).filter((player) => player.position && pointMatchesMapLayer(player, transform, mapLayer));
  const teamKeyForPlayerName = (name) => {
    const normalized = safeLabel(name).toLowerCase();
    return workspacePlayers.find((player) => safeLabel(player.name).toLowerCase() === normalized)?.team_key
      || markerPlayers.find((player) => safeLabel(player.name).toLowerCase() === normalized)?.team_key
      || "";
  };
  const sideForPlayerName = (name) => replaySideForTeamKey(teamKeyForPlayerName(name), selectedRound);
  const traces = useMemo(() => {
    if (!layers.traces || !frames.length) return [];
    const start = Math.max(0, frameCursorIndex - 72);
    const byName = new Map();
    for (const sourceFrame of frames.slice(start, frameCursorIndex + 1)) {
      for (const player of sourceFrame.players || []) {
        if (!pointMatchesMapLayer(player, transform, mapLayer)) continue;
        const point = worldToPercent(player, transform);
        if (!point) continue;
        const list = byName.get(player.name) || [];
        list.push(point);
        byName.set(player.name, list);
      }
    }
    return [...byName.entries()].map(([name, points]) => ({ name, points, team_key: workspacePlayers.find((player) => player.name === name)?.team_key || "a" }));
  }, [frames, frameCursorIndex, layers.traces, mapLayer, transform, workspacePlayers]);
  const recentEvents = useMemo(() => {
    const events = roundEvents;
    const nearestFrame = (tick) => frames.reduce((best, item) => (
      Math.abs(Number(item.tick) - tick) < Math.abs(Number(best?.tick ?? Infinity) - tick) ? item : best
    ), null);
    const roundEndForEffects = Number(selectedRound?.round_end_tick || selectedRound?.end_tick || 0);
    const kills = [];
    const grenades = [];
    for (const event of events) {
      const eventTick = Number(event.tick || 0);
      const age = currentTick - eventTick;
      if (event.type === "kill" && layers.kills && age >= 0 && age <= tickRate * 4) {
        const sourceFrame = nearestFrame(eventTick);
        const frameActor = sourceFrame?.players?.find((item) => String(item.name || "").toLowerCase() === String(event.actor || "").toLowerCase());
        const frameTarget = sourceFrame?.players?.find((item) => String(item.name || "").toLowerCase() === String(event.target || "").toLowerCase());
        const actorSource = Number.isFinite(Number(event.actor_x)) ? { x: event.actor_x, y: event.actor_y, z: event.actor_z } : frameActor;
        const targetSource = Number.isFinite(Number(event.target_x)) ? { x: event.target_x, y: event.target_y, z: event.target_z } : frameTarget;
        if (!pointMatchesMapLayer(actorSource, transform, mapLayer) || !pointMatchesMapLayer(targetSource, transform, mapLayer)) continue;
        const actor = worldToPercent(
          actorSource,
          transform,
        );
        const target = worldToPercent(
          targetSource,
          transform,
        );
        if (actor && target) kills.push({ ...event, actor, target, opacity: 1 - age / Math.max(1, tickRate * 5) });
      }
      if (event.type === "grenade" && layers.grenades) {
        const rawTrajectory = [...(event.trajectory || [])].sort((a, b) => Number(a.tick || 0) - Number(b.tick || 0));
        const isSmoke = /烟|smoke/i.test(safeLabel(event.kind));
        const rawStartTick = Number(rawTrajectory[0]?.tick || 0);
        const rawEndTick = Number(rawTrajectory.at(-1)?.tick || 0);
        const rawEnd = rawTrajectory.at(-1);
        const rawEndpointDistance = rawEnd && Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))
          ? Math.hypot(Number(rawEnd.x) - Number(event.x), Number(rawEnd.y) - Number(event.y))
          : 0;
        const trajectoryValid = rawTrajectory.length >= 2
          && rawEndTick > rawStartTick
          && rawEndTick - rawStartTick <= tickRate * (isSmoke ? 5 : 9)
          && rawEndpointDistance <= 256;
        const parsedThrowTick = trajectoryValid ? Number(event.throw_tick || rawStartTick || 0) : 0;
        const fallbackFlightTicks = tickRate * (isSmoke ? 2.25 : 1);
        const throwTick = parsedThrowTick > 0 && parsedThrowTick < eventTick
          ? parsedThrowTick
          : Math.max(0, eventTick - fallbackFlightTicks);
        const effectDuration = grenadeDurationSeconds(event.kind) * tickRate;
        const effectEndTick = Number.isFinite(roundEndForEffects) && roundEndForEffects > 0
          ? Math.min(eventTick + effectDuration, roundEndForEffects)
          : eventTick + effectDuration;
        if (currentTick < throwTick || currentTick > effectEndTick) continue;
        let trajectory = trajectoryValid ? rawTrajectory : [];
        let trajectoryInferred = false;
        if (trajectory.length < 2 && Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))) {
          const throwFrame = nearestFrame(throwTick);
          const thrower = throwFrame?.players?.find((item) => safeLabel(item.name).toLowerCase() === safeLabel(event.actor).toLowerCase());
          if (thrower && Number.isFinite(Number(thrower.x)) && Number.isFinite(Number(thrower.y))) {
            trajectory = [
              { tick: throwTick, x: Number(thrower.x), y: Number(thrower.y), z: Number(thrower.z) },
              { tick: eventTick, x: Number(event.x), y: Number(event.y), z: Number(event.z) },
            ];
            trajectoryInferred = true;
          }
        }
        const flightTick = Math.min(currentTick, eventTick);
        const interpolated = interpolateTrajectoryPoint(trajectory, flightTick);
        const visibleTrajectory = trajectory.filter((point) => Number(point.tick || 0) < flightTick && pointMatchesMapLayer(point, transform, mapLayer));
        if (interpolated && pointMatchesMapLayer(interpolated, transform, mapLayer)) visibleTrajectory.push(interpolated);
        const path = visibleTrajectory
          .map((point) => worldToPercent(point, transform))
          .filter(Boolean);
        const effectPosition = worldToPercent(event, transform) || path.at(-1) || null;
        const phase = currentTick < eventTick ? "flight" : "effect";
        const layerPoint = phase === "flight" ? interpolated : event;
        if (!pointMatchesMapLayer(layerPoint, transform, mapLayer)) continue;
        const position = phase === "flight" ? path.at(-1) : effectPosition;
        const effectAge = Math.max(0, currentTick - eventTick) / Math.max(1, tickRate);
        const showTrajectory = phase === "flight"
          || (/烟|smoke/i.test(safeLabel(event.kind)) && trajectory.length > 1 && effectAge <= 2);
        if (position) {
          const renderedPath = trimPolylineEnd(path, phase === "flight" ? 1.35 : 2.65);
          const nextGrenade = {
            ...event,
            throwTick,
            team_key: teamKeyForPlayerName(event.actor),
            side: sideForPlayerName(event.actor),
            teamColor: replaySideColor(sideForPlayerName(event.actor), teamKeyForPlayerName(event.actor) === "a"),
            path,
            renderedPath,
            phase,
            position,
            effectPosition,
            duration: grenadeDurationSeconds(event.kind),
            effectAge,
            showTrajectory,
            trajectoryInferred,
            opacity: phase === "flight" ? 1 : Math.max(0.2, 1 - Math.max(0, age) / Math.max(1, effectDuration)),
          };
          const duplicateIndex = grenades.findIndex((grenade) => {
            if (safeLabel(grenade.actor).toLowerCase() !== safeLabel(nextGrenade.actor).toLowerCase()) return false;
            if (safeLabel(grenade.kind).toLowerCase() !== safeLabel(nextGrenade.kind).toLowerCase()) return false;
            const sameThrow = Math.abs(Number(grenade.throwTick || 0) - throwTick) <= tickRate * 0.6;
            const duplicateWindow = /烟|smoke/i.test(safeLabel(nextGrenade.kind)) ? tickRate * 4 : Math.max(8, tickRate * 0.75);
            if (!sameThrow && Math.abs(Number(grenade.tick || 0) - eventTick) > duplicateWindow) return false;
            if (!grenade.effectPosition || !nextGrenade.effectPosition) return false;
            return sameThrow || Math.hypot(
              grenade.effectPosition.x - nextGrenade.effectPosition.x,
              grenade.effectPosition.y - nextGrenade.effectPosition.y,
            ) <= 1.5;
          });
          if (duplicateIndex < 0) {
            grenades.push(nextGrenade);
          } else {
            const previous = grenades[duplicateIndex];
            const preferNext = (previous.trajectoryInferred && !nextGrenade.trajectoryInferred)
              || nextGrenade.path.length > previous.path.length;
            if (preferNext) grenades[duplicateIndex] = nextGrenade;
          }
        }
      }
    }
    return { kills, grenades };
  }, [currentTick, frames, layers.grenades, layers.kills, mapLayer, markerPlayers, roundEvents, selectedRound, tickRate, transform, workspacePlayers]);
  const recentShots = useMemo(() => {
    if (!layers.shots) return [];
    const life = Math.max(1, tickRate * 0.22);
    const workspaceShots = selectedRound?.shots || [];
    const replayShots = workspaceShots.length
      ? workspaceShots
      : frames.flatMap((sourceFrame) => sourceFrame.shots || []);
    return replayShots.flatMap((shot) => {
      const age = currentTick - Number(shot.tick || 0);
      if (age < 0 || age > life) return [];
      const sourceFrame = frames.reduce((best, item) => (
        Math.abs(Number(item.tick) - Number(shot.tick || 0)) < Math.abs(Number(best?.tick ?? Infinity) - Number(shot.tick || 0)) ? item : best
      ), null);
      const frameActor = sourceFrame?.players?.find((item) => safeLabel(item.name).toLowerCase() === safeLabel(shot.actor).toLowerCase());
      const shotSource = Number.isFinite(Number(shot.x)) ? shot : frameActor;
      if (!pointMatchesMapLayer(shotSource, transform, mapLayer)) return [];
      const origin = worldToPercent(shotSource, transform);
      if (!origin) return [];
      const yaw = Number.isFinite(Number(shot.yaw)) ? Number(shot.yaw) : Number(frameActor?.yaw || 0);
      const radians = yaw * Math.PI / 180;
      const length = 11;
      return [{ ...shot, origin, target: { x: origin.x + Math.cos(radians) * length, y: origin.y - Math.sin(radians) * length }, opacity: 1 - age / life }];
    });
  }, [currentTick, frames, layers.shots, mapLayer, selectedRound?.shots, tickRate, transform]);
  const freezeEndTick = Number(selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0);
  const roundEndTick = Number(selectedRound?.round_end_tick || selectedRound?.end_tick || 0);
  const activeRoundElapsed = Math.max(0, (currentTick - freezeEndTick) / Math.max(1, tickRate));
  const roundClockRemaining = currentTick >= roundEndTick
    ? 0
    : Math.max(0, ROUND_CLOCK_SECONDS - activeRoundElapsed);
  const eventMarkers = roundEvents.filter((event) => event.type === "kill" || event.type === "grenade");
  const killFeed = useMemo(() => roundEvents
    .filter((event) => event.type === "kill" && Number(event.tick) <= currentTick && currentTick - Number(event.tick) <= tickRate * 7)
    .slice(-5)
    .reverse(), [currentTick, roundEvents, tickRate]);
  const motionDuration = "0ms";

  const seekToEvent = (event) => {
    if (!frames.length) return;
    const eventTick = Number(event?.tick || 0);
    const firstFrameAfterEvent = frames.findIndex((item) => Number(item.tick || 0) >= eventTick);
    setFrameIndex(firstFrameAfterEvent >= 0 ? firstFrameAfterEvent : frames.length - 1);
    setPlaying(false);
  };

  const seekBySeconds = (seconds) => {
    if (!frames.length) return;
    const currentSeconds = Number(frame.time_sec || 0);
    const lastSeconds = Number(frames.at(-1)?.time_sec || currentSeconds);
    setFrameIndex(replayPositionForTime(frames, clamp(currentSeconds + seconds, 0, lastSeconds)));
    setPlaying(false);
  };

  const changeRound = (nextIndex) => {
    const next = rounds[clamp(nextIndex, 0, Math.max(0, rounds.length - 1))];
    if (next) setRoundNumber(next.round_number);
  };
  const toggleLayer = (key) => setLayers((current) => ({ ...current, [key]: !current[key] }));

  if (!selectedRound) {
    return <div className="rounded-xl border border-cs2-border bg-cs2-bg-card p-12 text-center text-[11px] text-cs2-text-muted">当前 Demo 尚未生成正式回合窗口。</div>;
  }

  return (
    <div className="space-y-3">
      <style>{`
        @keyframes demo-smoke-puff { 0%,100% { transform: translate(var(--sx),var(--sy)) scale(.76); opacity:.58; } 50% { transform: translate(var(--ex),var(--ey)) scale(1.08); opacity:.9; } }
        @keyframes demo-fire-flicker { 0%,100% { transform: translateY(2px) scale(.82) rotate(-5deg); opacity:.8; } 50% { transform: translateY(-4px) scale(1.08) rotate(6deg); opacity:1; } }
        @keyframes demo-flash-burst { from { transform: scale(.3) rotate(0); opacity:1; } to { transform: scale(2.4) rotate(50deg); opacity:0; } }
        @keyframes demo-explosion-ring { from { transform: scale(.2); opacity:1; } to { transform: scale(1.65); opacity:0; } }
        @keyframes demo-explosion-spark { from { width:3px; opacity:1; } to { width:16px; opacity:0; } }
        .demo-smoke-effect span { position:absolute; left:7px; top:7px; width:10px; height:10px; border-radius:999px; background:radial-gradient(circle at 35% 32%,rgba(241,245,249,.94),rgba(148,163,184,.88) 48%,rgba(71,85,105,.72)); filter:blur(.6px); box-shadow:0 0 3px rgba(226,232,240,.34); animation:demo-smoke-puff 1.65s ease-in-out infinite; }
        .demo-smoke-effect b,.demo-fire-effect b { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); color:white; font-size:8px; text-shadow:0 1px 3px #000; }
        .demo-fire-effect span { position:absolute; bottom:2px; width:5px; height:13px; border-radius:62% 38% 58% 42%; background:linear-gradient(#fff7ae 0 13%,#fde047 25%,#f97316 62%,#ef4444); filter:drop-shadow(0 0 2px #fb923c); transform-origin:50% 100%; animation:demo-fire-flicker .58s ease-in-out infinite; }
        .demo-flash-effect { display:flex; width:22px; height:22px; align-items:center; justify-content:center; border-radius:999px; color:#071014; animation:demo-flash-burst .7s ease-out 1 both; }
        .demo-explosion-effect { border-radius:999px; }
        .demo-explosion-ring { position:absolute; inset:5px; border:1.5px solid; border-radius:999px; animation:demo-explosion-ring .65s ease-out 1 both; }
        .demo-explosion-effect i { position:absolute; left:50%; top:50%; height:1.5px; width:2px; transform-origin:left center; background:#fde68a; animation:demo-explosion-spark .6s ease-out 1 both; }
        .demo-duration-ring { transition:stroke-dasharray 120ms linear; }
        .demo-shot-tracer { filter:none; }
        .demo-grenade-trajectory { filter:drop-shadow(0 0 .35px rgba(255,255,255,.5)); }
      `}</style>
      <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => changeRound(roundIndex - 1)} disabled={loading || roundIndex <= 0} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
          <select value={selectedRound.round_number} disabled={loading} onChange={(event) => setRoundNumber(Number(event.target.value))} className="h-8 rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-[10px] font-bold text-cs2-text-primary outline-none disabled:opacity-40">
            {rounds.map((round) => <option key={round.round_number} value={round.round_number}>回合 R{round.round_number} · {round.team_a_score_after} : {round.team_b_score_after}</option>)}
          </select>
          <button type="button" onClick={() => changeRound(roundIndex + 1)} disabled={loading || roundIndex >= rounds.length - 1} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setPlaying((value) => !value)} disabled={!frames.length} className="flex h-9 w-9 items-center justify-center rounded-full bg-cs2-accent text-cs2-text-on-accent disabled:opacity-40">{playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}</button>
          <button type="button" aria-label="后退 5 秒" onClick={() => seekBySeconds(-5)} disabled={!frames.length} className="h-8 rounded-md border border-cs2-border px-2 font-mono text-[9px] font-bold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-35">-5s</button>
          <button type="button" aria-label="前进 5 秒" onClick={() => seekBySeconds(5)} disabled={!frames.length} className="h-8 rounded-md border border-cs2-border px-2 font-mono text-[9px] font-bold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-35">+5s</button>
          <div className="relative min-w-[240px] flex-1 pt-3">
            <div className="absolute left-2 right-2 top-0 z-10 h-3">
              {eventMarkers.map((event) => {
                const ratio = eventFrameRatio(event, frames, selectedRound);
                const markerTone = event.type === "kill" ? "bg-rose-400" : "bg-amber-300";
                return <button key={`${event.type}-${event.tick}-${event.actor || ""}`} type="button" data-event-kind={event.type === "kill" ? "kill" : "utility"} aria-label={`定位事件：${eventLabel(event)}`} onClick={() => seekToEvent(event)} className="group absolute top-0 h-3 w-3 -translate-x-1/2" style={{ left: `${ratio * 100}%` }}><span className={`mx-auto block h-2.5 w-2.5 rounded-full border border-black/40 shadow-sm ${markerTone}`} /><span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md border border-cs2-border bg-cs2-bg-page px-2 py-1.5 text-left text-[9px] font-medium text-cs2-text-primary shadow-xl group-hover:block group-focus-visible:block"><b className="mr-1 font-mono text-cs2-accent">{event.time_text || "--:--"}</b>{eventLabel(event)}</span></button>;
              })}
            </div>
            <input aria-label="回放时间轴" type="range" min="0" max={Math.max(0, frames.length - 1)} step="0.01" value={frameIndex} onChange={(event) => { setFrameIndex(Number(event.target.value)); setPlaying(false); }} className="h-1.5 w-full cursor-pointer accent-cs2-accent" />
          </div>
          <button type="button" onClick={() => { setFrameIndex(0); setPlaying(false); }} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted"><RotateCcw className="h-3.5 w-3.5" /></button>
          <div className="min-w-[82px] text-right"><p className="text-[8px] uppercase text-cs2-text-muted">回合时间</p><p className="font-mono text-xl font-black text-cs2-text-primary">{formatClock(roundClockRemaining)}</p><p className="font-mono text-[8px] text-cs2-text-muted">Tick {Math.round(Number(frame.tick) || 0)} · {replayFps} Hz</p></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cs2-border pt-3">
          <div className="flex flex-wrap gap-2">
            {[{ key: "traces", icon: Route, label: "走位轨迹" }, { key: "kills", icon: Swords, label: "击杀连线" }, { key: "shots", icon: Crosshair, label: "射击弹道" }, { key: "grenades", icon: Bomb, label: "投掷物" }, { key: "utilityAreas", icon: MapIcon, label: "烟火区域" }].map(({ key, icon: Icon, label }) => <button key={key} type="button" aria-pressed={layers[key]} onClick={() => toggleLayer(key)} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[9px] font-semibold ${layers[key] ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border text-cs2-text-muted"}`}><Icon className="h-3 w-3" />{label}</button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-[9px] font-semibold text-cs2-text-muted" aria-label="时间轴事件图例"><span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-rose-400" />击杀</span><span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-amber-300" />道具</span></div>
            <div role="group" aria-label="人物标识" className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5">{[["number", "序号"], ["id", "ID"]].map(([value, label]) => <button key={value} type="button" aria-pressed={playerLabelMode === value} onClick={() => setPlayerLabelMode(value)} className={`rounded px-2 py-1 text-[8px] font-bold ${playerLabelMode === value ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted"}`}>{label}</button>)}</div>
            <div className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5">{[0.5, 1, 2, 4].map((value) => <button key={value} type="button" onClick={() => setSpeed(value)} className={`rounded px-2 py-1 font-mono text-[8px] ${speed === value ? "bg-cs2-text-primary text-cs2-bg-page" : "text-cs2-text-muted"}`}>{value}x</button>)}</div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[260px_minmax(460px,1fr)_260px]">
        <ReplayRoster title={`${teamAName} · ${selectedRound.team_a_side || ""}`} teamKey="a" side={selectedRound.team_a_side} players={teamAPlayers} framePlayers={frame.players} bombCarrierName={bombState.carrier} />
        <section className="relative min-h-[720px] overflow-hidden rounded-xl border border-cs2-border bg-[#060b0e]">
          <div className="absolute left-3 top-3 z-30 flex items-center gap-2">
            {hasMapLayers && <div role="group" aria-label="地图楼层" className="flex rounded-md border border-cs2-border bg-cs2-bg-card/95 p-0.5">{[{ key: "upper", label: "上层" }, { key: "lower", label: "下层" }].map((item) => <button key={item.key} type="button" aria-pressed={mapLayer === item.key} onClick={() => setMapLayer(item.key)} className={`rounded px-2 py-1 text-[8px] font-bold ${mapLayer === item.key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted"}`}>{item.label}</button>)}</div>}
            {smokeDebugOn && (
              <label className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-card/95 px-2 py-1 text-[8px] font-bold text-cs2-text-muted">
                <span>烟格</span>
                <select
                  aria-label="烟雾调试图层"
                  value={smokeDebugLayer}
                  onChange={(event) => setSmokeDebugLayer(event.target.value)}
                  className="rounded border border-cs2-border bg-cs2-bg-input px-1 py-0.5 text-[8px] font-semibold text-cs2-text-primary"
                >
                  <option value="off">off</option>
                  <option value="world_cells">world_cells</option>
                  <option value="radar_cells">radar_cells</option>
                  <option value="final_render">final_render</option>
                </select>
              </label>
            )}
          </div>
          <div className="pointer-events-none absolute right-3 top-3 z-20 flex w-[min(84%,390px)] flex-col items-end gap-1.5" aria-live="polite">{killFeed.map((kill) => {
            const weapon = safeWeapon(kill.weapon, "武器");
            const actorSide = sideForPlayerName(kill.actor);
            const targetSide = sideForPlayerName(kill.target);
            const actorBlue = isBlueReplaySide(actorSide, teamKeyForPlayerName(kill.actor) === "a");
            const targetBlue = isBlueReplaySide(targetSide, teamKeyForPlayerName(kill.target) === "a");
            return <div key={`feed-${kill.tick}-${kill.actor}-${kill.target}`} className="flex max-w-full items-center gap-2 rounded-md border border-white/10 bg-black/80 px-2.5 py-1 text-[9px] shadow-lg"><span data-side={actorSide || undefined} className={`truncate font-bold ${actorBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.actor, "未知玩家")}</span><KillfeedIconStrip event={{ ...kill, is_headshot: Boolean(kill.headshot) }} weaponName={weapon} weaponKey={weapon} /><span data-side={targetSide || undefined} className={`truncate font-bold ${targetBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.target, "未知玩家")}</span></div>;
          })}</div>
          {loading && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-cs2-bg-page/75 px-6 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-cs2-accent" />
              <p className="max-w-sm text-[11px] leading-relaxed text-cs2-text-secondary">{loadHint || "正在加载回放…"}</p>
            </div>
          )}
          {error && <div className="absolute inset-0 z-30 flex items-center justify-center p-8 text-center text-[11px] text-cs2-text-muted">{error}</div>}
          <div className="demo-radar-plane absolute left-1/2 top-1/2 aspect-square w-[min(88%,620px)]" data-map={mapName} data-layer={hasMapLayers ? mapLayer : undefined} style={{ transform: "translate(-50%, -50%)" }}>
            <img src={getDemoRadarMapUrl(mapName, hasMapLayers ? mapLayer : "")} alt={`${mapName}${hasMapLayers ? ` ${mapLayer === "upper" ? "上层" : "下层"}` : ""} 雷达地图`} className="h-full w-full object-contain opacity-80" />
            <ReplayAreaEffectsCanvas
              tracks={effectTracks}
              currentTick={currentTick}
              hideAfterTick={roundEndTick > 0 ? roundEndTick : null}
              tickRate={tickRate}
              transform={transform}
              mapLayer={hasMapLayers ? mapLayer : "upper"}
              enabled={Boolean(layers.utilityAreas)}
              capabilities={effectCapabilities}
              smokeDebugLayer={smokeDebugOn ? smokeDebugLayer : "off"}
            />
            <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {traces.map((trace) => <polyline key={trace.name} className="demo-player-trace" points={trace.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={isBlueReplaySide(replaySideForTeamKey(trace.team_key, selectedRound), trace.team_key === "a") ? "#38bdf8" : "#fbbf24"} strokeWidth="0.175" strokeOpacity="0.45" />)}
              {recentEvents.kills.map((kill) => <g key={`kill-${kill.tick}-${kill.actor}-${kill.target}`} opacity={Math.max(0.2, kill.opacity)}><line className="demo-death-line" x1={kill.actor.x} y1={kill.actor.y} x2={kill.target.x} y2={kill.target.y} stroke="#fb7185" strokeWidth="0.14" strokeDasharray="1.5 1" /><circle className="demo-death-circle" cx={kill.target.x} cy={kill.target.y} r="1.2" fill="none" stroke="#fb7185" strokeWidth="0.09" /><path className="demo-death-x" d={`M${kill.target.x - 0.8},${kill.target.y - 0.8} L${kill.target.x + 0.8},${kill.target.y + 0.8} M${kill.target.x + 0.8},${kill.target.y - 0.8} L${kill.target.x - 0.8},${kill.target.y + 0.8}`} stroke="#fb7185" strokeWidth="0.07" /></g>)}
              {recentShots.map((shot, index) => { const teamKey = teamKeyForPlayerName(shot.actor); return <line key={`shot-${shot.tick}-${shot.actor}-${index}`} className="demo-shot-tracer" x1={shot.origin.x} y1={shot.origin.y} x2={shot.target.x} y2={shot.target.y} stroke={isBlueReplaySide(replaySideForTeamKey(teamKey, selectedRound), teamKey === "a") ? "#bae6fd" : "#fde68a"} strokeWidth="0.12" strokeLinecap="round" opacity="1" />; })}
              {recentEvents.grenades.filter((grenade) => grenade.showTrajectory && grenade.renderedPath.length > 1).map((grenade) => <polyline key={`trajectory-${grenade.tick}-${grenade.actor}-${grenade.kind}`} className="demo-grenade-trajectory" data-inferred={grenade.trajectoryInferred ? "true" : undefined} data-side={grenade.side || undefined} points={grenade.renderedPath.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={grenade.teamColor} strokeWidth="0.205" strokeLinecap="round" strokeLinejoin="round" opacity="1" />)}
            </svg>
            {recentEvents.grenades.map((grenade) => {
              const isSmoke = /烟|smoke/i.test(grenade.kind);
              const isFire = /燃烧|molotov|inferno|incendiary/i.test(grenade.kind);
              const useAreaFallback = !(
                (isSmoke && hasSmokeAreaTracks && layers.utilityAreas)
                || (isFire && hasInfernoAreaTracks && layers.utilityAreas)
              );
              return (
                <GrenadeEffectMarker
                  key={`grenade-${grenade.throwTick}-${grenade.actor}-${grenade.kind}`}
                  grenade={grenade}
                  motionDuration={motionDuration}
                  useAreaFallback={useAreaFallback}
                />
              );
            })}
            {bombState.position && pointMatchesMapLayer(bombState, transform, mapLayer) && ["dropped", "planted", "defused", "exploded"].includes(bombState.status) && <div className={`demo-c4-marker pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 ${["defused", "exploded"].includes(bombState.status) ? "opacity-45" : ""}`} style={{ left: `${bombState.position.x}%`, top: `${bombState.position.y}%` }} title={`C4 ${bombState.status === "planted" ? `已放置${bombState.site ? ` · ${bombState.site} 区` : ""}` : bombState.status === "dropped" ? "已掉落" : bombState.status === "defused" ? "已拆除" : "已引爆"}`}><div className="flex h-4 w-4 items-center justify-center rounded-[2px] border border-amber-200 bg-amber-400"><HudEquipmentIcon stem="c4" className="h-3 w-3 brightness-0" /></div></div>}
            {markerPlayers.map((player) => {
              const isBlue = isBlueReplaySide(replaySideForTeamKey(player.team_key, selectedRound), player.team_key === "a");
              const displayName = safeLabel(player.name, "?");
              const playerNumber = playerNumberByName.get(displayName.toLowerCase());
              const yaw = Number.isFinite(Number(player.yaw)) ? Number(player.yaw) : 0;
              const markerTitle = `${displayName} · ${Number.isFinite(Number(player.health)) ? player.health : 0} HP · $${Math.max(0, Number(player.money) || 0).toLocaleString("en-US")} · ${armorText(player)} · ${safeWeapon(player.weapon, "—")}${player.has_c4 ? " · C4" : ""}${player.has_defuser ? " · 拆弹器" : ""}`;
              const idMaxLen = 8;
              const idLabel = displayName.length > idMaxLen ? `${displayName.slice(0, idMaxLen)}…` : displayName;
              const circleLabel = playerLabelMode === "id"
                ? (displayName.slice(0, 1).toUpperCase() || "?")
                : (Number.isInteger(playerNumber) ? playerNumber : "?");
              return (
                <div key={player.steamid64 || displayName} className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-[left,top] ease-linear" style={{ left: `${player.position.x}%`, top: `${player.position.y}%`, transitionDuration: motionDuration }} title={markerTitle}>
                  <div
                    data-player-number={Number.isInteger(playerNumber) ? playerNumber : undefined}
                    data-player-label-mode={playerLabelMode}
                    className={`demo-player-marker relative flex items-center justify-center rounded-full border border-white/80 font-mono font-black leading-none text-white ${isBlue ? "bg-sky-500" : "bg-amber-500"} ${player.is_alive === false ? "opacity-35 grayscale" : ""}`}
                    style={{ width: playerMarkerSizePx, height: playerMarkerSizePx, fontSize: 7 }}
                  >
                    <span className="demo-player-direction-arrow pointer-events-none absolute inset-0" style={{ transform: `rotate(${yawToCssRotation(yaw)}deg)` }}>
                      <i className={`absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 -translate-y-[calc(100%-0.5px)] border-x-[2.5px] border-b-[4.5px] border-x-transparent ${isBlue ? "border-b-sky-100" : "border-b-amber-100"}`} />
                    </span>
                    <span>{circleLabel}</span>
                    {player.has_c4 && <span className="demo-player-c4-badge absolute -right-1 -top-1 flex h-2 w-2 items-center justify-center rounded-[2px] bg-amber-400"><HudEquipmentIcon stem="c4" className="h-1.5 w-1.5 brightness-0" /></span>}
                    {player.has_defuser && <span className="demo-player-kit-badge absolute -bottom-1 -right-1 flex h-2 w-2 items-center justify-center rounded-[2px] bg-sky-300"><HudEquipmentIcon stem="defuser" className="h-1.5 w-1.5 brightness-0" /></span>}
                  </div>
                  {playerLabelMode === "id" && (
                    <span className="demo-player-id-label mt-0.5 max-w-[52px] truncate text-center text-[6px] font-bold leading-none text-white/95 drop-shadow-[0_1px_1px_rgba(0,0,0,.85)]">{idLabel}</span>
                  )}
                </div>
              );
            })}
          </div>
          {!transform && <div className="absolute inset-x-0 bottom-4 text-center text-[9px] text-cs2-text-muted">当前地图缺少坐标变换元数据</div>}
        </section>
        <ReplayRoster title={`${teamBName} · ${selectedRound.team_b_side || ""}`} teamKey="b" side={selectedRound.team_b_side} players={teamBPlayers} framePlayers={frame.players} bombCarrierName={bombState.carrier} />
      </div>
    </div>
  );
}
