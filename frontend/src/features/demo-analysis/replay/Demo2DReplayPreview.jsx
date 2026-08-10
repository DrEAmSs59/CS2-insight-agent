import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  Skull,
  Star,
  Swords,
} from "lucide-react";
import API from "../../../api/api";
import useSessionState from "../../../hooks/useSessionState";
import { useT } from "../../../i18n/useT.js";
import DockableRow from "../../../components/layout/DockableRow";
import { resolveHudWeaponStem } from "../workspaces/timeline/killfeed/resolveHudWeaponStem";
import ReplaySceneCanvas, { computeBombState } from "./ReplaySceneCanvas";
import { isSmokeDebugEnabled } from "./smokeDebugGate";
import { resolveReplayTransform } from "./replayRadarTransform";
import {
  clamp,
  createPlayheadStore,
  createReplayClock,
  findPreviousFrameIndex,
  interpolateReplayFrame,
  lerpNumber,
  replaySampleStrideForRate,
  replayVisualHzForRate,
  replayPositionForTime,
  resolvePlaybackStartSeconds,
  secondsForFramePosition,
} from "./replayPlayback";
import { useReplayStore, REPLAY_STORE_CACHE_VERSION } from "./replayStore";
import { replayUtilityExposureByName, roundEnemyKillCounts } from "./replayHudState";
import {
  MAX_SMOKE_TRAJECTORY_SECONDS,
  grenadeTrajectoryTimingIsValid,
} from "./replayGrenadeTrajectory";

const SAMPLE_HZ = 32;
const REPLAY_CACHE_VERSION = REPLAY_STORE_CACHE_VERSION;
const ROUND_CLOCK_SECONDS = 115;
const HUD_ICON_BASE = "/hud-death-notice";
const DEFAULT_REPLAY_LAYERS = {
  traces: true,
  kills: true,
  grenades: true,
  utilityAreas: true,
  shots: true,
};

function replayPositionStorageKey(sessionIdentity) {
  return `cs2-session-demo-replay:${sessionIdentity}:position`;
}

function readReplayPosition(sessionIdentity) {
  try {
    const raw = sessionStorage.getItem(replayPositionStorageKey(sessionIdentity));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeReplayPosition(sessionIdentity, value) {
  try {
    sessionStorage.setItem(replayPositionStorageKey(sessionIdentity), JSON.stringify(value));
  } catch {
    // Session recovery is best-effort and must never block replay navigation.
  }
}

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

function utilityInventory(inventory) {
  const groups = new Map();
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const item = safeLabel(raw).toLowerCase().replace(/^weapon_/, "");
    let entry = null;
    if (/smoke/.test(item)) entry = { key: "smoke", label: "烟雾弹", stem: "smokegrenade", order: 0 };
    else if (/molotov|incendiary|incgrenade/.test(item)) entry = { key: "fire", label: "燃烧弹", stem: /incendiary|incgrenade/.test(item) ? "incgrenade" : "molotov", order: 1 };
    else if (/high explosive|hegrenade|he grenade/.test(item)) entry = { key: "he", label: "HE 手雷", stem: "hegrenade", order: 2 };
    else if (/flash/.test(item)) entry = { key: "flash", label: "闪光弹", stem: "flashbang", order: 3 };
    else if (/decoy/.test(item)) entry = { key: "decoy", label: "诱饵弹", stem: "decoy", order: 4 };
    if (!entry) continue;
    const current = groups.get(entry.key);
    groups.set(entry.key, current ? { ...current, count: current.count + 1 } : { ...entry, count: 1 });
  }
  return [...groups.values()].sort((left, right) => left.order - right.order);
}

function isNonGunInventoryItem(item) {
  return /knife|bayonet|karambit|shadow_daggers|gut|flip|ursus|stiletto|talon|navaja|nomad|paracord|skeleton|survival|bowie|falchion|huntsman|smoke|flash|hegrenade|he_grenade|molotov|incendiary|incgrenade|decoy|taser|zeus|c4|defuser|healthshot|kevlar|assaultsuit|helmet|vest|^armor$/.test(item);
}

function primaryWeaponFromInventory(inventory) {
  const candidates = [];
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const label = safeLabel(raw);
    const item = label.toLowerCase().replace(/^weapon_/, "").replace(/[\s-]+/g, "_");
    if (!item || isNonGunInventoryItem(item)) continue;
    candidates.push(label);
  }
  for (const label of candidates) {
    if (resolveHudWeaponStem(label, label, { fallback: "" })) return label;
  }
  return candidates[0] || "";
}

function meleeFromInventory(inventory) {
  for (const raw of Array.isArray(inventory) ? inventory : []) {
    const item = safeLabel(raw).toLowerCase().replace(/^weapon_/, "");
    if (/knife|bayonet|karambit|shadow_daggers|gut|flip|ursus|stiletto|talon|navaja|nomad|paracord|skeleton|survival|bowie|falchion|huntsman/.test(item)) {
      return safeLabel(raw);
    }
  }
  return "";
}

function resolveReplayWeapon(state) {
  const direct = safeWeapon(state?.weapon, "").replace(/^weapon_/i, "");
  if (direct) return direct;
  return primaryWeaponFromInventory(state?.inventory)
    || meleeFromInventory(state?.inventory)
    || "knife";
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
  if (
    !grenadeTrajectoryTimingIsValid(points, event?.tick, tickRate, true)
    || endpointDistance > 256
  ) return -1;
  return points.length
    + Math.min(span, tickRate * MAX_SMOKE_TRAJECTORY_SECONDS) / Math.max(1, tickRate);
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
  const endTick = Number(round?.record_end_tick ?? round?.end_tick ?? Infinity);
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

export function replayEndTickForRound(round, rounds, workspace, tickRate = 64) {
  const storedEnd = Number(round?.record_end_tick ?? round?.end_tick ?? round?.round_end_tick ?? 0);
  const roundEnd = Number(round?.round_end_tick ?? round?.end_tick ?? 0);
  const roundNumber = Number(round?.round_number || 0);
  if (!(roundEnd > 0)) return storedEnd;
  const nextRound = [...(rounds || [])]
    .filter((candidate) => Number(candidate?.round_number || 0) > roundNumber)
    .sort((left, right) => Number(left?.round_number || 0) - Number(right?.round_number || 0))[0];
  const nextRoundStart = Number(nextRound?.start_tick || 0);
  const demoEndTick = Number(workspace?.demo_end_tick || 0);
  const availableEnd = nextRoundStart > 0 ? nextRoundStart - 1 : demoEndTick;
  if (!(availableEnd > roundEnd)) return storedEnd;
  const desiredEnd = Math.min(
    roundEnd + Math.max(1, Math.round((Number(tickRate) || 64) * 3)),
    availableEnd,
  );
  return Math.min(Math.max(storedEnd, desiredEnd), availableEnd);
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

function replayPlayerNumber(teamKey, index) {
  return teamKey === "a" ? index : index + 5;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function mapKey(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  return /^(de|cs|ar)_/.test(raw) ? raw : `de_${raw}`;
}

const ReplayPlayerPortrait = memo(function ReplayPlayerPortrait({
  number,
  alive,
  isT,
}) {
  return (
    <span className="relative inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center">
      <span className={`flex h-[14px] w-[14px] items-center justify-center rounded-full border font-mono text-[9px] font-black leading-none tabular-nums shadow-inner ${
        isT
          ? "border-amber-100/50 bg-amber-300/15 text-amber-50"
          : "border-sky-200/50 bg-sky-300/15 text-sky-100"
      } ${alive ? "" : "grayscale opacity-45"}`}>
        {number}
      </span>
      {!alive && <Skull className="absolute h-3 w-3 text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]" />}
    </span>
  );
});

export const ReplayRosterAmbientEffect = memo(function ReplayRosterAmbientEffect({
  smoked,
  burning,
  mirrored,
}) {
  if (!smoked && !burning) return null;
  return (
    <span
      aria-hidden="true"
      data-effect-renderer="static-css"
      className="replay-roster-ambient-static pointer-events-none absolute inset-0 z-[15] overflow-hidden"
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    >
      {smoked && <i className="replay-roster-smoke-sheet absolute inset-[-8%]" />}
      {burning && <i className="replay-roster-fire-sheet absolute inset-[-8%]" />}
    </span>
  );
});

const ReplayRosterSlot = memo(function ReplayRosterSlot({
  player,
  state,
  index,
  teamKey,
  isT,
  mirrored,
  exclusiveCarrier,
  liveStats,
  roundKillStars = 0,
  utilityExposure,
}) {
  const displayName = safeLabel(player.name, `玩家 ${index + 1}`);
  const alive = state.is_alive !== false;
  const health = Number.isFinite(Number(state.health))
    ? clamp(Math.round(Number(state.health)), 0, 100)
    : (alive ? 100 : 0);
  const previousHealthRef = useRef(health);
  const damageTimerRef = useRef(0);
  const [damagePulse, setDamagePulse] = useState(0);
  useEffect(() => {
    const previous = previousHealthRef.current;
    previousHealthRef.current = health;
    if (!alive || health >= previous) return undefined;
    window.clearTimeout(damageTimerRef.current);
    setDamagePulse((value) => value + 1);
    damageTimerRef.current = window.setTimeout(() => setDamagePulse(0), 420);
    return () => window.clearTimeout(damageTimerRef.current);
  }, [alive, health]);

  const number = replayPlayerNumber(teamKey, index);
  const weapon = resolveReplayWeapon(state) || (alive ? "" : "—");
  const weaponStem = resolveHudWeaponStem(weapon, weapon, { fallback: "knife" });
  const weaponLabel = weapon;
  const hasC4 = Boolean(exclusiveCarrier && displayName.toLowerCase() === exclusiveCarrier);
  const hasArmor = Number(state.armor || 0) > 0;
  const armorValue = Math.max(0, Number(state.armor) || 0);
  const utilities = utilityInventory(state.inventory);
  const blinded = Boolean(alive && Number(state.flash_duration || 0) > 0.01);
  const smoked = Boolean(alive && utilityExposure?.smoked);
  const burning = Boolean(alive && utilityExposure?.burning);
  const stats = liveStats || { kills: 0, deaths: 0 };
  const utilitiesRow = utilities.map(({ key, label, stem, count }) => (
    <span
      key={key}
      title={`${label}${count > 1 ? ` ×${count}` : ""}`}
      aria-label={`${displayName} 持有${label}${count > 1 ? ` ${count} 枚` : ""}`}
      className={`inline-flex h-5 shrink-0 items-center ${alive ? "" : "opacity-40"}`}
    >
      {Array.from({ length: Math.min(4, count) }, (_, utilityIndex) => (
        <HudEquipmentIcon key={`${key}-${utilityIndex}`} stem={stem} className="h-[18px] w-[17px] drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]" />
      ))}
    </span>
  ));
  const specialGear = (
    <>
      {hasC4 && (
        <span title="携带 C4" aria-label={`${displayName} 携带 C4`} className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-amber-300 text-black ${alive ? "" : "opacity-40"}`}>
          <HudEquipmentIcon stem="c4" className="h-4 w-4 brightness-0" />
        </span>
      )}
      {state.has_defuser && (
        <span title="携带拆弹器" aria-label={`${displayName} 携带拆弹器`} className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-sky-200 text-sky-950 ${alive ? "" : "opacity-40"}`}>
          <HudEquipmentIcon stem="defuser" className="h-4 w-4 brightness-0" />
        </span>
      )}
    </>
  );
  // Hand-held / gear grow from the HP-adjacent edge toward the player ID.
  const loadoutFromHp = mirrored
    ? <>{specialGear}{utilitiesRow}</>
    : <>{utilitiesRow}{specialGear}</>;

  return (
    <div
      data-replay-roster-slot={displayName}
      data-alive={alive ? "true" : "false"}
      data-side={isT ? "T" : "CT"}
      data-smoked={smoked ? "true" : "false"}
      data-burning={burning ? "true" : "false"}
      data-blinded={blinded ? "true" : "false"}
      data-mirrored={mirrored ? "true" : "false"}
      className={`replay-observer-slot replay-roster-slot relative isolate h-[84px] overflow-hidden border ${
        isT
          ? "border-amber-200/45 bg-[#1b1707]"
          : "border-sky-300/45 bg-[#07182a]"
      }`}
    >
      <span
        aria-hidden="true"
        data-health-fill
        className={`replay-roster-health-fill absolute inset-y-0 ${
          isT ? "replay-roster-health-fill--t" : "replay-roster-health-fill--ct"
        } ${mirrored ? "right-0" : "left-0"}`}
        style={{ width: `${alive ? health : 0}%` }}
      />
      {alive && health > 0 && health < 100 && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 z-[2] w-[2px] bg-white/65 shadow-[0_0_5px_rgba(255,255,255,0.35)]"
          style={mirrored ? { right: `${health}%` } : { left: `${health}%` }}
        />
      )}
      <ReplayRosterAmbientEffect smoked={smoked} burning={burning} mirrored={mirrored} />
      {blinded && <span aria-hidden="true" className="replay-observer-blind-overlay pointer-events-none absolute inset-0 z-[25] bg-white/35" />}
      {damagePulse > 0 && <span key={damagePulse} aria-hidden="true" className="replay-observer-damage-flash absolute inset-0 z-30 bg-rose-500/65" />}
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 z-[3] h-[4px] bg-black/55">
        <i
          className={`block h-full ${isT ? "bg-amber-100" : "bg-sky-200"} ${mirrored ? "ml-auto" : "mr-auto"}`}
          style={{
            width: `${alive ? health : 0}%`,
            boxShadow: alive && health > 0 && health < 100
              ? `${mirrored ? "-" : ""}2px 0 0 rgba(255,255,255,0.8)`
              : "none",
          }}
        />
      </span>
      {/* Two rows: ID / weapon / HP aligned on top; stats / gear / armor on bottom. */}
      <div className={`replay-roster-slot-grid relative z-10 -mt-0.5 grid h-full content-start grid-rows-[auto_auto] gap-x-2 gap-y-1 px-2.5 pb-2 pt-0 ${
        mirrored
          ? "grid-cols-[52px_minmax(0,1fr)_110px]"
          : "grid-cols-[110px_minmax(0,1fr)_52px]"
      }`}>
        {/* Identity: name row */}
        <div className={`replay-roster-slot-name flex min-w-0 items-start ${mirrored ? "col-start-3 row-start-1 justify-end text-right" : "col-start-1 row-start-1 justify-start text-left"}`}>
          <span className="inline-flex max-w-full items-center gap-1 pt-3">
            <span title={displayName} className={`min-w-0 truncate text-[12px] font-black tracking-[0.01em] drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] ${alive ? "text-white" : "text-white/40"}`}>
              {displayName}
            </span>
            <ReplayPlayerPortrait number={number} alive={alive} isT={isT} />
          </span>
        </div>
        {/* Identity: stats + money */}
        <div className={`replay-roster-slot-stats flex min-w-0 flex-col justify-start gap-0.5 ${mirrored ? "col-start-3 row-start-2 items-end text-right" : "col-start-1 row-start-2 items-start text-left"}`}>
          <span className={`flex items-center gap-1.5 text-[9px] font-bold ${alive ? "text-white/80" : "text-white/35"} ${mirrored ? "flex-row-reverse" : ""}`}>
            <span className="inline-flex items-center gap-0.5"><Crosshair className="h-2.5 w-2.5" />{stats.kills}</span>
            <span className="inline-flex items-center gap-0.5"><Skull className="h-2.5 w-2.5" />{stats.deaths}</span>
          </span>
          <span className={`font-mono text-[11px] font-black tabular-nums drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] ${alive ? "text-emerald-200" : "text-emerald-200/35"}`}>
            ${Math.max(0, Number(state.money) || 0).toLocaleString("en-US")}
          </span>
        </div>
        {/* Loadout: kill stars above weapon, weapon baseline matches ID */}
        <div
          title={weaponLabel}
          aria-label={`${displayName} 当前武器 ${weaponLabel}`}
          className={`replay-roster-slot-weapon flex min-w-0 flex-col justify-start gap-0.5 overflow-visible ${
            mirrored ? "col-start-2 row-start-1 items-start" : "col-start-2 row-start-1 items-end"
          }`}
        >
          <span
            aria-hidden={roundKillStars <= 0}
            aria-label={roundKillStars > 0 ? `${displayName} 本回合 ${roundKillStars} 次有效击杀` : undefined}
            className={`flex h-3 w-full shrink-0 items-center ${mirrored ? "justify-start" : "justify-end"} ${alive ? "" : "opacity-40"}`}
          >
            {weaponStem && roundKillStars > 0
              ? Array.from({ length: Math.min(5, roundKillStars) }, (_, starIndex) => (
                  <Star
                    key={starIndex}
                    className="-mr-0.5 h-2.5 w-2.5 shrink-0 fill-white text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.95)]"
                    strokeWidth={1.6}
                  />
                ))
              : null}
          </span>
          {weaponStem && (
            <HudEquipmentIcon
              stem={weaponStem}
              title={weaponLabel}
              className={`h-5 w-[60px] max-w-full object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${
                mirrored ? "object-left" : "object-right"
              } ${alive ? "" : "opacity-40"}`}
            />
          )}
        </div>
        {/* Loadout: utilities / C4 / defuser (same row as stats) */}
        <div className={`replay-roster-slot-gear flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          mirrored ? "col-start-2 row-start-2 justify-start pl-0.5" : "col-start-2 row-start-2 justify-end pr-0.5"
        }`}>
          {loadoutFromHp}
        </div>
        {/* HP — top-aligned with weapon after star row */}
        <div className={`replay-roster-slot-health flex items-start pt-3 ${
          mirrored ? "col-start-1 row-start-1 justify-start" : "col-start-3 row-start-1 justify-end"
        }`}>
          <span className={`font-mono text-[25px] font-black leading-none tabular-nums tracking-[-0.08em] ${
            alive ? "text-white" : "text-white/35"
          }`}>
            {alive ? health : "0"}
          </span>
        </div>
        {/* Armor */}
        <div className={`replay-roster-slot-armor flex items-start ${alive ? "" : "opacity-40"} ${
          mirrored ? "col-start-1 row-start-2 justify-start" : "col-start-3 row-start-2 justify-end"
        }`}>
          {hasArmor ? (
            <span
              title={state.has_helmet ? "vesthelm · 头盔 + 防弹衣" : "vest · 防弹衣"}
              aria-label={`${displayName} ${state.has_helmet ? "头盔和防弹衣" : "防弹衣"} ${armorValue}`}
              className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm border border-white/10 bg-black/20 px-0.5 font-mono text-[9px] font-black tabular-nums text-white/90"
            >
              <HudEquipmentIcon stem={state.has_helmet ? "armor_helmet" : "armor"} className="h-[17px] w-5" />
              {armorValue}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

const ReplayRoster = memo(function ReplayRoster({
  title,
  teamKey,
  side,
  players,
  framePlayers,
  bombCarrierName = "",
  liveStatsByName,
  roundKillStarsByName,
  utilityExposureByName,
}) {
  const byName = new Map((framePlayers || []).map((player) => [safeLabel(player.name).toLowerCase(), player]));
  const sideName = safeLabel(side, teamKey === "a" ? "T" : "CT").toUpperCase();
  const isT = sideName === "T";
  const mirrored = teamKey === "b";
  const exclusiveCarrier = safeLabel(bombCarrierName).toLowerCase();
  const aliveCount = players.filter((player) => byName.get(safeLabel(player.name).toLowerCase())?.is_alive !== false).length;
  return (
    <aside data-side={isT ? "T" : "CT"} className={`replay-roster replay-roster-surface h-fit self-start border p-2.5 ${isT ? "border-amber-300/20" : "border-sky-400/20"}`}>
      <div className={`mb-2 flex items-center justify-between border-b pb-2 ${mirrored ? "flex-row-reverse" : ""} ${isT ? "border-amber-300/20" : "border-sky-400/20"}`}>
        <div className={`flex items-center gap-2 ${mirrored ? "flex-row-reverse" : ""}`}>
          <span className={`h-5 min-w-7 rounded-sm px-1 text-center font-mono text-[11px] font-black leading-5 ${isT ? "bg-amber-300 text-amber-950" : "bg-sky-400 text-sky-950"}`}>{sideName}</span>
          <h3 className="replay-roster-title max-w-[190px] truncate text-[12px] font-black uppercase tracking-[0.08em]">{title}</h3>
        </div>
        <span className="replay-roster-count font-mono text-[12px] font-black">{aliveCount}/5</span>
      </div>
      <div className="space-y-1.5">
        {players.map((player, index) => {
          const displayName = safeLabel(player.name, `玩家 ${index + 1}`);
          const state = byName.get(displayName.toLowerCase()) || {};
          return (
            <ReplayRosterSlot
              key={displayName}
              player={player}
              state={state}
              index={index}
              teamKey={teamKey}
              isT={isT}
              mirrored={mirrored}
              exclusiveCarrier={exclusiveCarrier}
              liveStats={liveStatsByName?.[displayName.toLowerCase()]}
              roundKillStars={roundKillStarsByName?.[displayName.toLowerCase()] || 0}
              utilityExposure={utilityExposureByName?.[displayName.toLowerCase()]}
            />
          );
        })}
      </div>
    </aside>
  );
});

export default function Demo2DReplayPreview({
  workspace,
  demoPath,
  players = [],
  teamAName = "Team A",
  teamBName = "Team B",
  initialRound,
  onRoundChange,
  layoutEditing = false,
  layoutResetSignal = 0,
}) {
  const t = useT();
  const rounds = workspace?.rounds || [];
  const sessionIdentity = encodeURIComponent(String(demoPath || workspace?.demo_fingerprint || workspace?.map_name || "unknown"));
  const sessionPrefix = `demo-replay:${sessionIdentity}`;
  const [roundNumber, setRoundNumber] = useSessionState(
    `${sessionPrefix}:round`,
    initialRound || rounds[0]?.round_number || 1,
  );
  const [frames, setFrames] = useState([]);
  const [effectTracks, setEffectTracks] = useState([]);
  const [effectCapabilities, setEffectCapabilities] = useState(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [uiSampleIndex, setUiSampleIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useSessionState(`${sessionPrefix}:speed`, 1);
  const playbackSampleStride = replaySampleStrideForRate(speed);
  const interpolatePlayback = playbackSampleStride === 1;
  const [loading, setLoading] = useState(false);
  const [loadHint, setLoadHint] = useState("");
  const [error, setError] = useState("");
  const [mapLayer, setMapLayer] = useSessionState(`${sessionPrefix}:map-layer`, "upper");
  const [playerLabelMode, setPlayerLabelMode] = useSessionState(`${sessionPrefix}:label-mode`, "number");
  const [responseTransform, setResponseTransform] = useState(null);
  const [replayFps, setReplayFps] = useState(SAMPLE_HZ);
  const [layers, setLayers] = useSessionState(`${sessionPrefix}:layers`, DEFAULT_REPLAY_LAYERS);
  const smokeDebugOn = useMemo(() => isSmokeDebugEnabled(), []);
  const [smokeDebugLayer, setSmokeDebugLayer] = useSessionState(`${sessionPrefix}:smoke-debug-layer`, "final_render");
  const framePositionRef = useRef(0);
  const roundNumberRef = useRef(roundNumber);
  roundNumberRef.current = roundNumber;
  const pendingResumeRef = useRef(undefined);
  if (pendingResumeRef.current === undefined) {
    pendingResumeRef.current = readReplayPosition(sessionIdentity);
  }
  const clockRef = useRef(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const pauseSyncRef = useRef(null);
  const playheadStoreRef = useRef(null);
  const playbackAbortRef = useRef(null);
  if (!playheadStoreRef.current) {
    playheadStoreRef.current = createPlayheadStore({ position: 0, seconds: 0, tick: 0, sampleIndex: 0 });
  }

  const resetPlayheadToStart = (nextFrames = [], requestedPosition = 0) => {
    const lastIndex = Math.max(0, (Array.isArray(nextFrames) ? nextFrames.length : 0) - 1);
    const position = clamp(Number(requestedPosition) || 0, 0, lastIndex);
    const sampleIndex = clamp(Math.floor(position), 0, lastIndex);
    const frame = nextFrames[sampleIndex] || nextFrames[0] || null;
    const seconds = nextFrames.length
      ? secondsForFramePosition(nextFrames, position)
      : Number(frame?.time_sec) || 0;
    const tick = Number(frame?.tick) || 0;
    framePositionRef.current = position;
    pauseSyncRef.current = { seconds, position };
    playheadStoreRef.current?.set({
      position,
      seconds,
      tick,
      sampleIndex,
    });
    clockRef.current?.seek(seconds);
    setFrameIndex(position);
    setUiSampleIndex(sampleIndex);
  };

  useEffect(() => () => {
    const pending = pendingResumeRef.current;
    const savedPosition = Number(pending?.roundNumber) === Number(roundNumberRef.current)
      ? Number(pending?.position) || 0
      : framePositionRef.current;
    writeReplayPosition(sessionIdentity, {
      roundNumber: Number(roundNumberRef.current) || 1,
      position: Math.max(0, Number(savedPosition) || 0),
    });
  }, [sessionIdentity]);

  useEffect(() => {
    let prevEpoch = useReplayStore.getState().playbackSuspendEpoch;
    return useReplayStore.subscribe((state) => {
      if (state.playbackSuspendEpoch === prevEpoch) return;
      prevEpoch = state.playbackSuspendEpoch;
      // Stop rAF immediately so navigation is not blocked by 60fps scene work.
      playbackAbortRef.current?.();
      setPlaying(false);
    });
  }, []);

  useEffect(() => {
    const preferredRound = Number(initialRound || roundNumber || rounds[0]?.round_number || 1);
    const validRound = rounds.some((round) => Number(round?.round_number) === preferredRound)
      ? preferredRound
      : Number(rounds[0]?.round_number || 1);
    setRoundNumber(validRound);
    onRoundChange?.(validRound);
    const saved = pendingResumeRef.current;
    if (Number(saved?.roundNumber) !== validRound) pendingResumeRef.current = null;
    setFrames([]);
    setEffectTracks([]);
    setEffectCapabilities(null);
    resetPlayheadToStart([]);
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
  const hasMapLayers = Number.isFinite(Number(transform?.lower_level_max_units)) && ["de_nuke", "de_vertigo"].includes(mapName);
  useEffect(() => {
    if (!hasMapLayers) setMapLayer("upper");
  }, [hasMapLayers, mapName, setMapLayer]);
  const workspacePlayers = useMemo(() => (
    workspace?.players?.length
      ? workspace.players
      : players.map((player, index) => ({ name: player.name || player.player_name, team_key: Number(player.team ?? player.team_number) === 3 ? "b" : index < Math.ceil(players.length / 2) ? "a" : "b" }))
  ), [workspace?.players, players]);
  const teamAPlayers = workspacePlayers.filter((player) => player.team_key === "a").slice(0, 5);
  const teamBPlayers = workspacePlayers.filter((player) => player.team_key === "b").slice(0, 5);

  useEffect(() => {
    if (!selectedRound || !demoPath) return undefined;
    const replayStartTick = Number(selectedRound.freeze_end_tick || selectedRound.start_tick);
    const replayEndTick = replayEndTickForRound(selectedRound, rounds, workspace, tickRate);
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

    // Round change: snap scrubber/playhead to start immediately (also while loading).
    resetPlayheadToStart([]);

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
      const pending = pendingResumeRef.current;
      const restorePosition = Number(pending?.roundNumber) === Number(selectedRound?.round_number)
        ? Number(pending?.position) || 0
        : 0;
      pendingResumeRef.current = null;
      resetPlayheadToStart(nextFrames, restorePosition);
      setError(nextFrames.length ? "" : "该回合没有可用的坐标帧");
      setLoading(false);
      const cache = data?.cache || meta.cache;
      if (cache?.frames === "memory_hit" || meta.source === "memory") {
        setLoadHint("已从内存恢复回放");
      } else if (cache?.frames === "parquet_binary_hit" || meta.source === "binary") {
        setLoadHint("已从 Rust 二进制轨迹缓存读取回放");
      } else if (cache?.frames === "parquet_hit") {
        setLoadHint("已从整场轨迹缓存读取回放");
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
      setLoadHint("正在读取当前回合二进制轨迹…");
    }

    useReplayStore.getState().ensureReplay(cacheKey, requestBody, {
      onStatus: ({ source, shared }) => {
        if (cancelled) return;
        if (shared) setLoadHint("正在等待同一解析任务…");
        else if (source === "effects_loading") setLoadHint("正在同步加载烟雾与燃烧范围…");
        else if (source === "parsed") setLoadHint("正在读取当前回合二进制轨迹…");
      },
      onEffects: (effectsData) => {
        if (cancelled) return;
        setEffectTracks(Array.isArray(effectsData?.effect_tracks) ? effectsData.effect_tracks : []);
        setEffectCapabilities(
          effectsData?.effect_capabilities && typeof effectsData.effect_capabilities === "object"
            ? effectsData.effect_capabilities
            : null,
        );
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
  }, [demoPath, mapName, rounds, selectedRound, tickRate, workspace?.demo_end_tick, workspacePlayers]);

  useEffect(() => {
    const synced = pauseSyncRef.current;
    if (synced) {
      pauseSyncRef.current = null;
      const position = Number(synced.position);
      const sampleIndex = clamp(Math.floor(position), 0, Math.max(0, frames.length - 1));
      framePositionRef.current = position;
      setUiSampleIndex(sampleIndex);
      if (playing) return;
      const seconds = Number.isFinite(Number(synced.seconds))
        ? Number(synced.seconds)
        : secondsForFramePosition(frames, position);
      const approx = frames.length
        ? interpolateReplayFrame(frames, Number.NaN, seconds)
        : { tick: selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0 };
      playheadStoreRef.current?.set({
        position,
        seconds,
        tick: Number(approx.tick) || selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0,
        sampleIndex,
      });
      clockRef.current?.seek(seconds);
      if (Math.abs(position - Number(frameIndex)) > 1e-6) {
        setFrameIndex(position);
      }
      return;
    }
    const sampleIndex = clamp(Math.floor(frameIndex), 0, Math.max(0, frames.length - 1));
    framePositionRef.current = frameIndex;
    setUiSampleIndex(sampleIndex);
    if (playing) return;
    const seconds = secondsForFramePosition(frames, frameIndex);
    const approx = frames.length
      ? interpolateReplayFrame(frames, Number.NaN, seconds)
      : { tick: selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0 };
    const tick = Number(approx.tick) || selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0;
    playheadStoreRef.current?.set({
      position: frameIndex,
      seconds,
      tick,
      sampleIndex,
    });
    clockRef.current?.seek(seconds);
  }, [frameIndex, frames, playing, selectedRound?.freeze_end_tick, selectedRound?.start_tick]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const snap = playheadStoreRef.current?.getSnapshot();
    const startSeconds = resolvePlaybackStartSeconds(
      frames,
      framePositionRef.current,
      snap?.seconds,
    );
    const clock = createReplayClock({
      offsetSeconds: startSeconds,
      rate: speed,
      now: () => window.performance.now(),
    });
    clockRef.current = clock;
    clock.play();
    let animationFrame = 0;
    let alive = true;
    let lastRenderedSample = -1;
    let nextInterpolatedRenderAt = 0;
    const interpolatedFrameDurationMs = 1000 / 64;
    const lastFrame = frames.length - 1;
    const lastSeconds = Number(frames[lastFrame]?.time_sec) || 0;
    const store = playheadStoreRef.current;

    const stopLoop = () => {
      alive = false;
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    };
    playbackAbortRef.current = stopLoop;

    const animate = (now) => {
      if (!alive) return;
      const activeFrames = framesRef.current;
      if (!activeFrames.length) return;
      if (interpolatePlayback) {
        if (nextInterpolatedRenderAt > 0 && now < nextInterpolatedRenderAt) {
          animationFrame = window.requestAnimationFrame(animate);
          return;
        }
        if (nextInterpolatedRenderAt <= 0) nextInterpolatedRenderAt = now;
        do {
          nextInterpolatedRenderAt += interpolatedFrameDurationMs;
        } while (nextInterpolatedRenderAt <= now);
      }
      const playheadSeconds = clock.getPlayheadSeconds(now);
      const sourceIndex = findPreviousFrameIndex(activeFrames, Number.NaN, playheadSeconds);
      const sampleIndex = Math.floor(sourceIndex / playbackSampleStride) * playbackSampleStride;
      const sampleFrame = activeFrames[sampleIndex] || activeFrames[0];
      if (interpolatePlayback) {
        const nextIndex = Math.min(activeFrames.length - 1, sourceIndex + 1);
        const nextFrame = activeFrames[nextIndex] || sampleFrame;
        const startSeconds = Number(sampleFrame?.time_sec) || 0;
        const endSeconds = Number(nextFrame?.time_sec) || startSeconds;
        const ratio = endSeconds > startSeconds
          ? clamp((playheadSeconds - startSeconds) / (endSeconds - startSeconds), 0, 1)
          : 0;
        const position = sourceIndex + (nextIndex - sourceIndex) * ratio;
        framePositionRef.current = position;
        store.set({
          position,
          seconds: playheadSeconds,
          tick: lerpNumber(sampleFrame?.tick, nextFrame?.tick, ratio),
          sampleIndex: sourceIndex,
        });
      } else if (sampleIndex !== lastRenderedSample) {
        // 2x/4x use 16/8Hz source anchors: both remain about 32 updates per wall-clock second.
        framePositionRef.current = sampleIndex;
        store.set({
          position: sampleIndex,
          seconds: Number(sampleFrame?.time_sec) || playheadSeconds,
          tick: Number(sampleFrame?.tick) || 0,
          sampleIndex,
        });
      }

      // Slider, roster and event layers stay on source boundaries even while 1x player
      // positions are interpolated at display refresh rate.
      if (sampleIndex !== lastRenderedSample) {
        lastRenderedSample = sampleIndex;
        setUiSampleIndex(sampleIndex);
        setFrameIndex(sampleIndex);
      }

      if (Number.isFinite(lastSeconds) && playheadSeconds >= lastSeconds - 0.0001) {
        store.set({
          position: lastFrame,
          seconds: lastSeconds,
          tick: Number(activeFrames[lastFrame]?.tick) || Number(sampleFrame?.tick) || 0,
          sampleIndex: lastFrame,
        });
        setFrameIndex(lastFrame);
        setUiSampleIndex(lastFrame);
        setPlaying(false);
        return;
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => {
      stopLoop();
      playbackAbortRef.current = null;
      const at = window.performance.now();
      clock.pause(at);
      const snapshot = store.getSnapshot();
      // Pause on the last frame that was actually rendered.
      pauseSyncRef.current = {
        seconds: Number(snapshot?.seconds) || 0,
        position: framePositionRef.current,
      };
      store.set({
        position: framePositionRef.current,
        seconds: Number(snapshot?.seconds) || 0,
        tick: snapshot?.tick || 0,
        sampleIndex: clamp(Math.floor(framePositionRef.current), 0, Math.max(0, framesRef.current.length - 1)),
      });
    };
  }, [playing, frames.length, speed, selectedRound?.freeze_end_tick, selectedRound?.start_tick]);

  const fallbackTick = selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0;
  const uiFrame = frames[uiSampleIndex] || frames[0] || { players: [], tick: fallbackTick, time_sec: 0 };
  const uiTick = Number(uiFrame.tick || fallbackTick || 0);
  const replayEndTick = Number(
    frames.at(-1)?.tick
    || selectedRound?.record_end_tick
    || selectedRound?.end_tick
    || selectedRound?.round_end_tick
    || 0,
  );
  const liveStatsByName = useMemo(() => {
    const result = {};
    const seenKills = new Set();
    const selectedRoundNumber = Number(selectedRound?.round_number || 0);
    for (const round of rounds) {
      const roundNumberValue = Number(round?.round_number || 0);
      if (roundNumberValue > selectedRoundNumber) continue;
      for (const event of round?.events || []) {
        if (event?.type !== "kill") continue;
        if (roundNumberValue === selectedRoundNumber && Number(event.tick || 0) > uiTick) continue;
        const actor = safeLabel(event.actor).toLowerCase();
        const target = safeLabel(event.target).toLowerCase();
        const identity = `${roundNumberValue}|${Number(event.tick || 0)}|${actor}|${target}`;
        if (seenKills.has(identity)) continue;
        seenKills.add(identity);
        if (actor && actor !== "world") {
          result[actor] ||= { kills: 0, deaths: 0 };
          result[actor].kills += 1;
        }
        if (target) {
          result[target] ||= { kills: 0, deaths: 0 };
          result[target].deaths += 1;
        }
      }
    }
    return result;
  }, [rounds, selectedRound?.round_number, uiTick]);
  const roundKillStarsByName = useMemo(
    () => roundEnemyKillCounts(roundEvents, uiTick, workspacePlayers),
    [roundEvents, uiTick, workspacePlayers],
  );
  const utilityExposureByName = useMemo(
    () => replayUtilityExposureByName(
      uiFrame.players,
      effectTracks,
      uiTick,
      replayEndTick > 0 ? replayEndTick : null,
    ),
    [
      uiFrame.players,
      effectTracks,
      uiTick,
      replayEndTick,
    ],
  );
  const uiBombState = useMemo(
    () => computeBombState(roundEvents, uiTick, uiFrame.players, selectedRound?.bomb_initial_carrier, transform),
    [roundEvents, uiTick, uiFrame.players, selectedRound?.bomb_initial_carrier, transform],
  );
  const sliderIndex = playing ? uiSampleIndex : frameIndex;
  const freezeEndTick = Number(selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0);
  const roundEndTick = Number(selectedRound?.round_end_tick || selectedRound?.end_tick || 0);
  const activeRoundElapsed = Math.max(0, (uiTick - freezeEndTick) / Math.max(1, tickRate));
  const roundClockRemaining = uiTick >= roundEndTick
    ? 0
    : Math.max(0, ROUND_CLOCK_SECONDS - activeRoundElapsed);
  const eventMarkers = roundEvents.filter((event) => event.type === "kill" || event.type === "grenade" || event.type === "plant");

  const seekToFrameIndex = (index, { pause = false } = {}) => {
    if (!frames.length) return;
    const i = clamp(Number(index), 0, frames.length - 1);
    const seconds = secondsForFramePosition(frames, i);
    const sampleIndex = clamp(Math.floor(i), 0, frames.length - 1);
    const approx = interpolateReplayFrame(frames, Number.NaN, seconds);
    framePositionRef.current = i;
    pauseSyncRef.current = { seconds, position: i };
    playheadStoreRef.current?.set({
      position: i,
      seconds,
      tick: Number(approx.tick) || 0,
      sampleIndex,
    });
    clockRef.current?.seek(seconds);
    setFrameIndex(i);
    setUiSampleIndex(sampleIndex);
    if (pause) setPlaying(false);
  };

  const seekToEvent = (event) => {
    if (!frames.length) return;
    const eventTick = Number(event?.tick || 0);
    const firstFrameAfterEvent = frames.findIndex((item) => Number(item.tick || 0) >= eventTick);
    seekToFrameIndex(firstFrameAfterEvent >= 0 ? firstFrameAfterEvent : frames.length - 1);
  };

  const seekBySeconds = (deltaSeconds) => {
    if (!frames.length) return;
    const currentSeconds = playing
      ? Number(playheadStoreRef.current?.getSnapshot()?.seconds) || secondsForFramePosition(frames, frameIndex)
      : secondsForFramePosition(frames, frameIndex);
    const lastSeconds = Number(frames.at(-1)?.time_sec || currentSeconds);
    const target = clamp(currentSeconds + deltaSeconds, 0, lastSeconds);
    seekToFrameIndex(replayPositionForTime(frames, target));
  };

  const changeRound = (nextIndex) => {
    const next = rounds[clamp(nextIndex, 0, Math.max(0, rounds.length - 1))];
    if (next) {
      pendingResumeRef.current = null;
      setRoundNumber(next.round_number);
      onRoundChange?.(next.round_number);
    }
  };
  const toggleLayer = (key) => setLayers((current) => ({ ...current, [key]: !current[key] }));

  if (!selectedRound) {
    return <div className="rounded-xl border border-cs2-border bg-cs2-bg-card p-12 text-center text-[11px] text-cs2-text-muted">当前 Demo 尚未生成正式回合窗口。</div>;
  }

  return (
    <div className="space-y-3 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:gap-3 xl:space-y-0">
      <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3 xl:shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => changeRound(roundIndex - 1)} disabled={loading || roundIndex <= 0} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
          <select aria-label="选择回合" value={selectedRound.round_number} disabled={loading} onChange={(event) => { const nextRound = Number(event.target.value); pendingResumeRef.current = null; setRoundNumber(nextRound); onRoundChange?.(nextRound); }} className="h-8 rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-[10px] font-bold text-cs2-text-primary outline-none disabled:opacity-40">
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
                const markerTone = event.type === "kill"
                  ? "bg-rose-400"
                  : event.type === "plant"
                    ? "bg-orange-600"
                    : "bg-amber-300";
                const eventKind = event.type === "kill" ? "kill" : event.type === "plant" ? "plant" : "utility";
                return <button key={`${event.type}-${event.tick}-${event.actor || ""}`} type="button" data-event-kind={eventKind} aria-label={`定位事件：${eventLabel(event)}`} onClick={() => seekToEvent(event)} className="group absolute top-0 h-3 w-3 -translate-x-1/2" style={{ left: `${ratio * 100}%` }}><span className={`mx-auto block h-2.5 w-2.5 rounded-full border border-black/40 shadow-sm ${markerTone}`} /><span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md border border-cs2-border bg-cs2-bg-page px-2 py-1.5 text-left text-[9px] font-medium text-cs2-text-primary shadow-xl group-hover:block group-focus-visible:block"><b className="mr-1 font-mono text-cs2-accent">{event.time_text || "--:--"}</b>{eventLabel(event)}</span></button>;
              })}
            </div>
            <input aria-label="回放时间轴" type="range" min="0" max={Math.max(0, frames.length - 1)} step="0.01" value={sliderIndex} onChange={(event) => { seekToFrameIndex(Number(event.target.value)); }} className="h-1.5 w-full cursor-pointer accent-cs2-accent" />
          </div>
          <button type="button" onClick={() => { seekToFrameIndex(0, { pause: true }); }} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted"><RotateCcw className="h-3.5 w-3.5" /></button>
          <div className="min-w-[82px] text-right"><p className="text-[8px] uppercase text-cs2-text-muted">回合时间</p><p className="font-mono text-xl font-black text-cs2-text-primary">{formatClock(roundClockRemaining)}</p><p className="font-mono text-[8px] text-cs2-text-muted">Tick {Math.round(Number(uiFrame.tick) || 0)} · {replayVisualHzForRate(replayFps, speed)} Hz</p></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cs2-border pt-3">
          <div className="flex flex-wrap gap-2">
            {[{ key: "traces", icon: Route, label: "走位轨迹" }, { key: "kills", icon: Swords, label: "击杀连线" }, { key: "shots", icon: Crosshair, label: "射击弹道" }, { key: "grenades", icon: Bomb, label: "投掷物" }, { key: "utilityAreas", icon: MapIcon, label: "烟火区域" }].map(({ key, icon: Icon, label }) => <button key={key} type="button" aria-pressed={layers[key]} onClick={() => toggleLayer(key)} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[9px] font-semibold ${layers[key] ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border text-cs2-text-muted"}`}><Icon className="h-3 w-3" />{label}</button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-[9px] font-semibold text-cs2-text-muted" aria-label="时间轴事件图例"><span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-rose-400" />击杀</span><span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-amber-300" />道具</span><span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-orange-600" />下包</span></div>
            <div role="group" aria-label="人物标识" className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5">{[["number", "序号"], ["id", "ID"]].map(([value, label]) => <button key={value} type="button" aria-pressed={playerLabelMode === value} onClick={() => setPlayerLabelMode(value)} className={`rounded px-2 py-1 text-[8px] font-bold ${playerLabelMode === value ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted"}`}>{label}</button>)}</div>
            <div className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5">{[0.5, 1, 2, 4].map((value) => <button key={value} type="button" onClick={() => setSpeed(value)} className={`rounded px-2 py-1 font-mono text-[8px] ${speed === value ? "bg-cs2-text-primary text-cs2-bg-page" : "text-cs2-text-muted"}`}>{value}x</button>)}</div>
          </div>
        </div>
      </section>

      <DockableRow
        storageKey="analysis-replay-board"
        ariaLabel={t("analysis.layout.replay")}
        editMode={layoutEditing}
        resetSignal={layoutResetSignal}
        className="replay-dock-row min-h-[720px] xl:min-h-0 xl:flex-1"
        panels={[
          {
            id: "team-a-hud",
            label: t("analysis.layout.teamHud", { team: teamAName }),
            minSize: 120,
            defaultSize: 300,
            collapsible: false,
            className: "replay-roster-panel",
            content: (
              <ReplayRoster title={teamAName} teamKey="a" side={selectedRound.team_a_side} players={teamAPlayers} framePlayers={uiFrame.players} bombCarrierName={uiBombState.carrier} liveStatsByName={liveStatsByName} roundKillStarsByName={roundKillStarsByName} utilityExposureByName={utilityExposureByName} />
            ),
          },
          {
            id: "radar",
            label: t("analysis.layout.radar"),
            minSize: 210,
            defaultSize: 680,
            collapsible: false,
            className: "replay-radar-panel",
            content: (
        <section className="replay-radar-surface relative h-full min-h-[720px] overflow-hidden border border-cs2-border xl:min-h-0">
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
          {loading && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-cs2-bg-page/75 px-6 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-cs2-accent" />
              <p className="max-w-sm text-[11px] leading-relaxed text-cs2-text-secondary">{loadHint || "正在加载回放…"}</p>
            </div>
          )}
          {error && <div className="absolute inset-0 z-30 flex items-center justify-center p-8 text-center text-[11px] text-cs2-text-muted">{error}</div>}
          <ReplaySceneCanvas
            playheadStore={playheadStoreRef.current}
            frames={frames}
            playing={playing}
            frameIndex={frameIndex}
            sampleStride={playbackSampleStride}
            mapName={mapName}
            hasMapLayers={hasMapLayers}
            mapLayer={mapLayer}
            transform={transform}
            selectedRound={selectedRound}
            roundEvents={roundEvents}
            tickRate={tickRate}
            workspacePlayers={workspacePlayers}
            playerLabelMode={playerLabelMode}
            layers={layers}
            effectTracks={effectTracks}
            effectCapabilities={effectCapabilities}
            smokeDebugLayer={smokeDebugOn ? smokeDebugLayer : "off"}
          />
          {!transform && <div className="absolute inset-x-0 bottom-4 text-center text-[9px] text-cs2-text-muted">当前地图缺少坐标变换元数据</div>}
        </section>
            ),
          },
          {
            id: "team-b-hud",
            label: t("analysis.layout.teamHud", { team: teamBName }),
            minSize: 120,
            defaultSize: 300,
            collapsible: false,
            className: "replay-roster-panel",
            content: (
              <ReplayRoster title={teamBName} teamKey="b" side={selectedRound.team_b_side} players={teamBPlayers} framePlayers={uiFrame.players} bombCarrierName={uiBombState.carrier} liveStatsByName={liveStatsByName} roundKillStarsByName={roundKillStarsByName} utilityExposureByName={utilityExposureByName} />
            ),
          },
        ]}
      />
    </div>
  );
}
