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
  Swords,
} from "lucide-react";
import { resolveHudWeaponStem } from "./timeline/killfeed/resolveHudWeaponStem";
import ReplaySceneCanvas, { computeBombState } from "./ReplaySceneCanvas";
import { isSmokeDebugEnabled } from "./smokeDebugGate";
import { resolveReplayTransform } from "../../utils/replayRadarTransform";
import {
  clamp,
  createPlayheadStore,
  createReplayClock,
  findPreviousFrameIndex,
  interpolateReplayFrame,
} from "../../utils/replayPlayback";
import { useReplayStore, REPLAY_STORE_CACHE_VERSION } from "../../stores/replayStore";

const SAMPLE_HZ = 8;
const REPLAY_CACHE_VERSION = REPLAY_STORE_CACHE_VERSION;
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

function isBlueReplaySide(side, fallback = false) {
  const normalized = String(side || "").trim().toUpperCase();
  return normalized ? normalized === "CT" : fallback;
}

function replayPlayerNumber(teamKey, index) {
  return teamKey === "a" ? index : index + 5;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** Map playhead seconds → fractional sample index (scrubber / ±5s seek). */
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

function secondsForFramePosition(frames, position) {
  if (!frames.length) return 0;
  const i0 = clamp(Math.floor(Number(position) || 0), 0, frames.length - 1);
  const i1 = Math.min(frames.length - 1, i0 + 1);
  const t0 = Number(frames[i0]?.time_sec) || 0;
  const t1 = Number(frames[i1]?.time_sec) || t0;
  const frac = clamp((Number(position) || 0) - i0, 0, 1);
  return i0 === i1 ? t0 : t0 + (t1 - t0) * frac;
}

function mapKey(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  return /^(de|cs|ar)_/.test(raw) ? raw : `de_${raw}`;
}

const ReplayRoster = memo(function ReplayRoster({ title, teamKey, side, players, framePlayers, bombCarrierName = "" }) {
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
});

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
  const [uiSampleIndex, setUiSampleIndex] = useState(0);
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
  const clockRef = useRef(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const playheadStoreRef = useRef(null);
  if (!playheadStoreRef.current) {
    playheadStoreRef.current = createPlayheadStore({ position: 0, seconds: 0, tick: 0, sampleIndex: 0 });
  }

  useEffect(() => {
    setRoundNumber(initialRound || rounds[0]?.round_number || 1);
    setFrames([]);
    setEffectTracks([]);
    setEffectCapabilities(null);
    setFrameIndex(0);
    setUiSampleIndex(0);
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
  useEffect(() => setMapLayer("upper"), [mapName]);
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
    const startIndex = clamp(Math.floor(framePositionRef.current), 0, frames.length - 1);
    const startSeconds = Number(frames[startIndex]?.time_sec || 0);
    const clock = createReplayClock({
      offsetSeconds: startSeconds,
      rate: speed,
      now: () => window.performance.now(),
    });
    clockRef.current = clock;
    clock.play();
    let animationFrame = 0;
    let lastUiSample = startIndex;
    const lastFrame = frames.length - 1;
    const lastSeconds = Number(frames[lastFrame]?.time_sec) || 0;
    const store = playheadStoreRef.current;

    const animate = (now) => {
      const activeFrames = framesRef.current;
      if (!activeFrames.length) return;
      const playheadSeconds = clock.getPlayheadSeconds(now);
      const approx = interpolateReplayFrame(activeFrames, Number.NaN, playheadSeconds);
      const sampleIndex = approx._sampleIndex ?? findPreviousFrameIndex(activeFrames, Number.NaN, playheadSeconds);
      framePositionRef.current = sampleIndex + (Number(approx._interpRatio) || 0);

      store.set({
        position: framePositionRef.current,
        seconds: playheadSeconds,
        tick: Number(approx.tick) || 0,
        sampleIndex,
      });

      // React UI (slider / roster) only at 8Hz sample boundaries — not every rAF.
      if (sampleIndex !== lastUiSample) {
        lastUiSample = sampleIndex;
        setUiSampleIndex(sampleIndex);
        setFrameIndex(sampleIndex);
      }

      if (Number.isFinite(lastSeconds) && playheadSeconds >= lastSeconds - 0.0001) {
        store.set({
          position: lastFrame,
          seconds: lastSeconds,
          tick: Number(activeFrames[lastFrame]?.tick) || Number(approx.tick) || 0,
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
      window.cancelAnimationFrame(animationFrame);
      clock.pause();
    };
  }, [playing, frames.length, speed, selectedRound?.freeze_end_tick, selectedRound?.start_tick]);

  const fallbackTick = selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0;
  const uiFrame = frames[uiSampleIndex] || frames[0] || { players: [], tick: fallbackTick, time_sec: 0 };
  const uiTick = Number(uiFrame.tick || fallbackTick || 0);
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

  const seekToFrameIndex = (index) => {
    if (!frames.length) return;
    const i = clamp(Number(index), 0, frames.length - 1);
    setFrameIndex(i);
    setPlaying(false);
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
    setFrameIndex(replayPositionForTime(frames, target));
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
          <button type="button" onClick={() => { seekToFrameIndex(0); }} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted"><RotateCcw className="h-3.5 w-3.5" /></button>
          <div className="min-w-[82px] text-right"><p className="text-[8px] uppercase text-cs2-text-muted">回合时间</p><p className="font-mono text-xl font-black text-cs2-text-primary">{formatClock(roundClockRemaining)}</p><p className="font-mono text-[8px] text-cs2-text-muted">Tick {Math.round(Number(uiFrame.tick) || 0)} · {replayFps} Hz</p></div>
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

      <div className="grid gap-3 xl:grid-cols-[260px_minmax(460px,1fr)_260px]">
        <ReplayRoster title={`${teamAName} · ${selectedRound.team_a_side || ""}`} teamKey="a" side={selectedRound.team_a_side} players={teamAPlayers} framePlayers={uiFrame.players} bombCarrierName={uiBombState.carrier} />
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
        <ReplayRoster title={`${teamBName} · ${selectedRound.team_b_side || ""}`} teamKey="b" side={selectedRound.team_b_side} players={teamBPlayers} framePlayers={uiFrame.players} bombCarrierName={uiBombState.carrier} />
      </div>
    </div>
  );
}
