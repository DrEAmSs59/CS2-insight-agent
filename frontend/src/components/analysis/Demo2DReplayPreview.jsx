import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bomb,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Crosshair,
  Eye,
  Flame,
  Loader2,
  Map as MapIcon,
  Pause,
  Play,
  RotateCcw,
  Route,
  ShieldCheck,
  Swords,
} from "lucide-react";
import API from "../../api/api";
import KillfeedIconStrip from "./timeline/killfeed/KillfeedIconStrip";

const MAP_SIZE = 1024;
const SAMPLE_HZ = 8;

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
  if (/烟|smoke/i.test(value)) return { icon: Cloud, short: "烟", className: "border-sky-200 bg-sky-500/85 text-white" };
  if (/闪|flash/i.test(value)) return { icon: Eye, short: "闪", className: "border-yellow-100 bg-yellow-300/90 text-yellow-950" };
  if (/燃|火|molotov|inferno|incendiary/i.test(value)) return { icon: Flame, short: "火", className: "border-orange-100 bg-orange-500/90 text-white" };
  return { icon: Bomb, short: /HE/i.test(value) ? "雷" : "投", className: "border-rose-100 bg-rose-500/90 text-white" };
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

function replayEventsForRound(round, tickRate = 64) {
  const startTick = Number(round?.start_tick ?? round?.freeze_end_tick ?? -Infinity);
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
    if (event?.type !== "grenade" || !/烟|smoke/i.test(safeLabel(event.kind))) {
      merged.push(event);
      continue;
    }
    const landing = grenadeLandingPoint(event);
    const duplicateIndex = merged.findIndex((candidate) => {
      if (candidate?.type !== "grenade" || !/烟|smoke/i.test(safeLabel(candidate.kind))) return false;
      if (safeLabel(candidate.actor).toLowerCase() !== safeLabel(event.actor).toLowerCase()) return false;
      if (Math.abs(Number(candidate.tick || 0) - Number(event.tick || 0)) > tickRate * 4) return false;
      const candidateLanding = grenadeLandingPoint(candidate);
      return landing && candidateLanding
        && Math.hypot(landing.x - candidateLanding.x, landing.y - candidateLanding.y) <= 96;
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
  if (/燃|火|molotov|inferno|incendiary/i.test(value)) return 7;
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
    (Number(event?.tick || 0) - Number(selectedRound?.start_tick || selectedRound?.freeze_end_tick || 0))
      / Math.max(1, Number(selectedRound?.end_tick || 0) - Number(selectedRound?.start_tick || selectedRound?.freeze_end_tick || 0)),
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
    };
  }
  return points.at(-1);
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

function formatClock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function mapKey(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  return /^(de|cs|ar)_/.test(raw) ? raw : `de_${raw}`;
}

function worldToPercent(player, transform) {
  if (!player || !transform) return null;
  const scale = Number(transform.scale);
  if (!Number.isFinite(scale) || scale === 0) return null;
  const px = (Number(player.x) - Number(transform.pos_x)) / scale;
  const py = (Number(transform.pos_y) - Number(player.y)) / scale;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { x: clamp(px / MAP_SIZE * 100, -5, 105), y: clamp(py / MAP_SIZE * 100, -5, 105) };
}

function ReplayRoster({ title, teamKey, side, players, framePlayers, bombCarrierName = "" }) {
  const byName = new Map((framePlayers || []).map((player) => [safeLabel(player.name).toLowerCase(), player]));
  const isBlue = isBlueReplaySide(side, !side && teamKey === "a");
  return (
    <aside className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3">
      <div className="mb-3 flex items-center justify-between border-b border-cs2-border pb-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${isBlue ? "bg-sky-400" : "bg-amber-400"}`} />
          <h3 className="text-[11px] font-black uppercase tracking-wide text-cs2-text-primary">{title}</h3>
        </div>
        <span className="font-mono text-[9px] text-cs2-text-muted">{players.filter((player) => byName.get(safeLabel(player.name).toLowerCase())?.is_alive !== false).length}/5</span>
      </div>
      <div className="space-y-1.5">
        {players.map((player, index) => {
          const displayName = safeLabel(player.name, `玩家 ${index + 1}`);
          const state = byName.get(displayName.toLowerCase()) || {};
          const alive = state.is_alive !== false;
          const health = Number.isFinite(Number(state.health)) ? Math.max(0, Number(state.health)) : (alive ? 100 : 0);
          const weapon = alive ? safeWeapon(state.weapon, "—") : "—";
          const hasC4 = alive && (state.has_c4 || displayName.toLowerCase() === bombCarrierName.toLowerCase());
          return (
            <div key={displayName} className={`rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-2.5 py-2.5 ${alive ? "" : "opacity-45"}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-black ${isBlue ? "bg-sky-500/20 text-sky-300" : "bg-amber-500/20 text-amber-300"}`}>
                  {teamKey === "a" ? index + 1 : (index + 6) % 10}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-cs2-text-primary">{displayName}</span>
                <span className="font-mono text-[8px] text-cs2-text-muted">{alive ? `${health} HP` : "阵亡"}</span>
              </div>
              <div className="mt-1 flex min-h-4 items-center gap-1.5 pl-7 text-[8px] text-cs2-text-muted">
                <span className="truncate">{weapon}</span>
                {hasC4 && <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 font-bold text-amber-300"><Bomb className="h-2.5 w-2.5" />C4</span>}
                {state.has_defuser && <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sky-500/15 px-1 py-0.5 font-bold text-sky-300"><ShieldCheck className="h-2.5 w-2.5" />KIT</span>}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function GrenadeEffectMarker({ grenade, motionDuration }) {
  const visual = grenadeVisual(grenade.kind);
  const GrenadeIcon = visual.icon;
  const title = `${safeLabel(grenade.actor, "未知玩家")} ${safeLabel(grenade.kind, "投掷物")}`;
  const teamColor = grenade.teamColor || "#fbbf24";
  const style = { left: `${grenade.position.x}%`, top: `${grenade.position.y}%`, opacity: grenade.opacity };
  if (grenade.phase === "flight") {
    return (
      <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-[left,top] ease-linear" style={{ ...style, transitionDuration: motionDuration }} title={title} data-side={grenade.side || undefined}>
        <div className={`demo-grenade-projectile flex h-5 w-5 items-center justify-center rounded-full border-2 shadow-lg ${visual.className}`} style={{ borderColor: teamColor, boxShadow: `0 0 10px ${teamColor}99` }}><GrenadeIcon className="h-2.5 w-2.5" /></div>
      </div>
    );
  }
  if (/烟|smoke/i.test(grenade.kind)) {
    const remaining = Math.max(0, grenade.duration - grenade.effectAge);
    const ring = clamp(remaining / Math.max(0.01, grenade.duration), 0, 1);
    return (
      <div className="demo-effect-shell pointer-events-none absolute z-10 h-[54px] w-[54px] -translate-x-1/2 -translate-y-1/2" style={style} title={`${title} · 剩余 ${remaining.toFixed(1)} 秒`} data-side={grenade.side || undefined}>
        <svg viewBox="0 0 54 54" className="absolute inset-0 h-full w-full -rotate-90"><circle cx="27" cy="27" r="24" fill="rgba(15,23,42,.18)" stroke={teamColor} strokeOpacity=".25" strokeWidth="1.7" /><circle className="demo-duration-ring" cx="27" cy="27" r="24" fill="none" stroke={teamColor} strokeWidth="2" strokeLinecap="round" pathLength="1" strokeDasharray={`${ring} 1`} /></svg>
        <div className="demo-smoke-effect absolute inset-[5px]">
          {[0, 1, 2, 3, 4, 5].map((index) => <span key={index} style={{ "--sx": `${(index - 2.5) * 3}px`, "--sy": `${(index % 2) * 4}px`, "--ex": `${(index - 2.5) * 7}px`, "--ey": `${((index % 3) - 1) * 7}px`, animationDelay: `${index * -0.22}s` }} />)}
          <Cloud className="absolute left-1/2 top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
        </div>
        <em className="absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[6px] not-italic text-sky-100">{remaining.toFixed(1)}s</em>
      </div>
    );
  }
  if (/燃|火|molotov|inferno|incendiary/i.test(grenade.kind)) {
    const remaining = Math.max(0, grenade.duration - grenade.effectAge);
    const ring = clamp(remaining / Math.max(0.01, grenade.duration), 0, 1);
    return (
      <div className="demo-effect-shell pointer-events-none absolute z-10 h-[50px] w-[50px] -translate-x-1/2 -translate-y-1/2" style={style} title={`${title} · 剩余 ${remaining.toFixed(1)} 秒`} data-side={grenade.side || undefined}>
        <svg viewBox="0 0 50 50" className="absolute inset-0 h-full w-full -rotate-90"><circle cx="25" cy="25" r="22" fill="rgba(69,26,3,.16)" stroke={teamColor} strokeOpacity=".25" strokeWidth="1.7" /><circle className="demo-duration-ring" cx="25" cy="25" r="22" fill="none" stroke={teamColor} strokeWidth="2" strokeLinecap="round" pathLength="1" strokeDasharray={`${ring} 1`} /></svg>
        <div className="demo-fire-effect absolute inset-[5px]">
          {[0, 1, 2, 3, 4].map((index) => <span key={index} style={{ left: `${2 + index * 7}px`, animationDelay: `${index * -0.18}s` }} />)}
          <Flame className="absolute left-1/2 top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
        </div>
        <em className="absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[6px] not-italic text-orange-100">{remaining.toFixed(1)}s</em>
      </div>
    );
  }
  if (/闪|flash/i.test(grenade.kind)) {
    return <div className="demo-flash-effect pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 border-2" style={{ ...style, borderColor: teamColor }} title={title} data-side={grenade.side || undefined}><Eye className="h-4 w-4" /></div>;
  }
  return (
    <div className="demo-explosion-effect pointer-events-none absolute z-20 h-14 w-14 -translate-x-1/2 -translate-y-1/2" style={style} title={title} data-side={grenade.side || undefined}>
      <span className="demo-explosion-ring" style={{ borderColor: teamColor }} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => <i key={index} style={{ transform: `rotate(${index * 45}deg)` }} />)}
      <Bomb className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white" />
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
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [layers, setLayers] = useState({ traces: true, kills: true, grenades: true, shots: true });
  const cacheRef = useRef(new Map());

  useEffect(() => {
    setRoundNumber(initialRound || rounds[0]?.round_number || 1);
    setFrames([]);
    setFrameIndex(0);
    setPlaying(false);
  }, [workspace, initialRound]);

  const selectedRound = rounds.find((round) => Number(round.round_number) === Number(roundNumber)) || rounds[0];
  const tickRate = Number(workspace?.tick_rate || 64);
  const roundEvents = useMemo(() => replayEventsForRound(selectedRound, tickRate), [selectedRound, tickRate]);
  const roundIndex = Math.max(0, rounds.findIndex((round) => round === selectedRound));
  const mapName = mapKey(workspace?.map_name);
  const transform = workspace?.map_transform;
  const workspacePlayers = useMemo(() => (
    workspace?.players?.length
      ? workspace.players
      : players.map((player, index) => ({ name: player.name || player.player_name, team_key: Number(player.team ?? player.team_number) === 3 ? "b" : index < Math.ceil(players.length / 2) ? "a" : "b" }))
  ), [workspace?.players, players]);
  const teamAPlayers = workspacePlayers.filter((player) => player.team_key === "a").slice(0, 5);
  const teamBPlayers = workspacePlayers.filter((player) => player.team_key === "b").slice(0, 5);

  useEffect(() => {
    if (!selectedRound || !demoPath) return undefined;
    const replayStartTick = Number(selectedRound.start_tick || selectedRound.freeze_end_tick);
    const key = `${demoPath}:${selectedRound.round_number}:${replayStartTick}:${selectedRound.end_tick}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setFrames(cached);
      setFrameIndex(0);
      setError("");
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setPlaying(false);
    API.post("/demo/replay", {
      path: demoPath,
      map_name: workspace?.map_name || "unknown",
      start_tick: replayStartTick,
      end_tick: Number(selectedRound.end_tick),
      tick_rate: Number(workspace?.tick_rate || 64),
      fps: SAMPLE_HZ,
      pov_player_name: workspacePlayers[0]?.name || null,
      pov_steamid64: workspacePlayers[0]?.steam_id64 || null,
    }).then(({ data }) => {
      if (cancelled) return;
      const nextFrames = Array.isArray(data?.frames) ? data.frames : [];
      cacheRef.current.set(key, nextFrames);
      setFrames(nextFrames);
      setFrameIndex(0);
      if (!nextFrames.length) setError("该回合没有可用的坐标帧");
    }).catch((reason) => {
      if (!cancelled) setError(reason?.response?.data?.detail || reason?.message || "2D 回放加载失败");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [demoPath, selectedRound, workspace?.map_name, workspace?.tick_rate, workspacePlayers]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= frames.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, Math.max(16, 1000 / (SAMPLE_HZ * speed)));
    return () => window.clearInterval(timer);
  }, [playing, frames.length, speed]);

  const frame = frames[frameIndex] || { players: [], tick: selectedRound?.start_tick || selectedRound?.freeze_end_tick || 0, time_sec: 0 };
  const currentTick = Number(frame.tick || selectedRound?.start_tick || selectedRound?.freeze_end_tick || 0);
  const bombState = useMemo(() => {
    let carrier = safeLabel(selectedRound?.bomb_initial_carrier);
    let status = carrier ? "carried" : "unknown";
    let position = null;
    let site = "";
    const events = [...roundEvents].sort((a, b) => Number(a.tick || 0) - Number(b.tick || 0));
    for (const event of events) {
      if (Number(event.tick || 0) > currentTick) break;
      if (event.type === "bomb_pickup") {
        carrier = safeLabel(event.actor);
        status = carrier ? "carried" : status;
        position = null;
      } else if (event.type === "bomb_drop") {
        carrier = "";
        status = "dropped";
        position = worldToPercent(event, transform);
      } else if (event.type === "plant") {
        carrier = "";
        status = "planted";
        position = worldToPercent(event, transform);
        site = safeLabel(event.site);
      } else if (event.type === "defuse") {
        carrier = "";
        status = "defused";
      } else if (event.type === "explode") {
        carrier = "";
        status = "exploded";
      }
    }
    return { carrier, status, position, site };
  }, [currentTick, roundEvents, selectedRound?.bomb_initial_carrier, transform]);
  const markerPlayers = (frame.players || []).map((player) => {
    const meta = workspacePlayers.find((item) => item.name?.toLowerCase() === String(player.name || "").toLowerCase());
    const frameSide = safeLabel(player.team).toUpperCase();
    const fallbackTeamKey = frameSide && frameSide === String(selectedRound?.team_a_side || "").toUpperCase() ? "a" : "b";
    return {
      ...player,
      has_c4: Boolean(player.has_c4) || (bombState.status === "carried" && safeLabel(player.name).toLowerCase() === bombState.carrier.toLowerCase()),
      team_key: meta?.team_key || fallbackTeamKey,
      position: worldToPercent(player, transform),
    };
  }).filter((player) => player.position);
  const teamKeyForPlayerName = (name) => {
    const normalized = safeLabel(name).toLowerCase();
    return workspacePlayers.find((player) => safeLabel(player.name).toLowerCase() === normalized)?.team_key
      || markerPlayers.find((player) => safeLabel(player.name).toLowerCase() === normalized)?.team_key
      || "";
  };
  const sideForPlayerName = (name) => replaySideForTeamKey(teamKeyForPlayerName(name), selectedRound);
  const traces = useMemo(() => {
    if (!layers.traces || !frames.length) return [];
    const start = Math.max(0, frameIndex - 72);
    const byName = new Map();
    for (const sourceFrame of frames.slice(start, frameIndex + 1)) {
      for (const player of sourceFrame.players || []) {
        const point = worldToPercent(player, transform);
        if (!point) continue;
        const list = byName.get(player.name) || [];
        list.push(point);
        byName.set(player.name, list);
      }
    }
    return [...byName.entries()].map(([name, points]) => ({ name, points, team_key: workspacePlayers.find((player) => player.name === name)?.team_key || "a" }));
  }, [frames, frameIndex, layers.traces, transform, workspacePlayers]);
  const recentEvents = useMemo(() => {
    const events = roundEvents;
    const nearestFrame = (tick) => frames.reduce((best, item) => (
      Math.abs(Number(item.tick) - tick) < Math.abs(Number(best?.tick ?? Infinity) - tick) ? item : best
    ), null);
    const kills = [];
    const grenades = [];
    for (const event of events) {
      const eventTick = Number(event.tick || 0);
      const age = currentTick - eventTick;
      if (event.type === "kill" && layers.kills && age >= 0 && age <= tickRate * 4) {
        const sourceFrame = nearestFrame(eventTick);
        const frameActor = sourceFrame?.players?.find((item) => String(item.name || "").toLowerCase() === String(event.actor || "").toLowerCase());
        const frameTarget = sourceFrame?.players?.find((item) => String(item.name || "").toLowerCase() === String(event.target || "").toLowerCase());
        const actor = worldToPercent(
          Number.isFinite(Number(event.actor_x)) ? { x: event.actor_x, y: event.actor_y } : frameActor,
          transform,
        );
        const target = worldToPercent(
          Number.isFinite(Number(event.target_x)) ? { x: event.target_x, y: event.target_y } : frameTarget,
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
        if (currentTick < throwTick || currentTick > eventTick + effectDuration) continue;
        let trajectory = trajectoryValid ? rawTrajectory : [];
        let trajectoryInferred = false;
        if (trajectory.length < 2 && Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))) {
          const throwFrame = nearestFrame(throwTick);
          const thrower = throwFrame?.players?.find((item) => safeLabel(item.name).toLowerCase() === safeLabel(event.actor).toLowerCase());
          if (thrower && Number.isFinite(Number(thrower.x)) && Number.isFinite(Number(thrower.y))) {
            trajectory = [
              { tick: throwTick, x: Number(thrower.x), y: Number(thrower.y) },
              { tick: eventTick, x: Number(event.x), y: Number(event.y) },
            ];
            trajectoryInferred = true;
          }
        }
        const flightTick = Math.min(currentTick, eventTick);
        const interpolated = interpolateTrajectoryPoint(trajectory, flightTick);
        const visibleTrajectory = trajectory.filter((point) => Number(point.tick || 0) < flightTick);
        if (interpolated) visibleTrajectory.push(interpolated);
        const path = visibleTrajectory
          .map((point) => worldToPercent(point, transform))
          .filter(Boolean);
        const effectPosition = worldToPercent(event, transform) || path.at(-1) || null;
        const phase = currentTick < eventTick ? "flight" : "effect";
        const position = phase === "flight" ? path.at(-1) : effectPosition;
        const effectAge = Math.max(0, currentTick - eventTick) / Math.max(1, tickRate);
        const showTrajectory = phase === "flight"
          || (/烟|smoke/i.test(safeLabel(event.kind)) && trajectory.length > 1 && effectAge <= 2);
        if (position) {
          const nextGrenade = {
            ...event,
            team_key: teamKeyForPlayerName(event.actor),
            side: sideForPlayerName(event.actor),
            teamColor: replaySideColor(sideForPlayerName(event.actor), teamKeyForPlayerName(event.actor) === "a"),
            path,
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
            const duplicateWindow = /烟|smoke/i.test(safeLabel(nextGrenade.kind)) ? tickRate * 4 : Math.max(8, tickRate * 0.35);
            if (Math.abs(Number(grenade.tick || 0) - eventTick) > duplicateWindow) return false;
            if (!grenade.effectPosition || !nextGrenade.effectPosition) return false;
            return Math.hypot(
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
  }, [currentTick, frames, layers.grenades, layers.kills, markerPlayers, roundEvents, selectedRound, tickRate, transform, workspacePlayers]);
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
      const origin = worldToPercent(Number.isFinite(Number(shot.x)) ? shot : frameActor, transform);
      if (!origin) return [];
      const yaw = Number.isFinite(Number(shot.yaw)) ? Number(shot.yaw) : Number(frameActor?.yaw || 0);
      const radians = yaw * Math.PI / 180;
      const length = 11;
      return [{ ...shot, origin, target: { x: origin.x + Math.cos(radians) * length, y: origin.y - Math.sin(radians) * length }, opacity: 1 - age / life }];
    });
  }, [currentTick, frames, layers.shots, selectedRound?.shots, tickRate, transform]);
  const duration = frames.at(-1)?.time_sec ?? selectedRound?.duration_seconds ?? 0;
  const remaining = Math.max(0, duration - Number(frame.time_sec || 0));
  const eventMarkers = roundEvents;
  const killFeed = useMemo(() => roundEvents
    .filter((event) => event.type === "kill" && Number(event.tick) <= currentTick && currentTick - Number(event.tick) <= tickRate * 7)
    .slice(-5)
    .reverse(), [currentTick, roundEvents, tickRate]);
  const motionDuration = `${Math.max(30, Math.round(1000 / (SAMPLE_HZ * speed)))}ms`;

  const seekToEvent = (event) => {
    if (!frames.length) return;
    const eventTick = Number(event?.tick || 0);
    const firstFrameAfterEvent = frames.findIndex((item) => Number(item.tick || 0) >= eventTick);
    setFrameIndex(firstFrameAfterEvent >= 0 ? firstFrameAfterEvent : frames.length - 1);
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
        @keyframes demo-smoke-puff { 0%,100% { transform: translate(var(--sx),var(--sy)) scale(.72); opacity:.42; } 50% { transform: translate(var(--ex),var(--ey)) scale(1.18); opacity:.82; } }
        @keyframes demo-fire-flicker { 0%,100% { transform: translateY(3px) scale(.72) rotate(-4deg); opacity:.65; } 50% { transform: translateY(-5px) scale(1.16) rotate(5deg); opacity:1; } }
        @keyframes demo-flash-burst { from { transform: scale(.3) rotate(0); opacity:1; } to { transform: scale(2.4) rotate(50deg); opacity:0; } }
        @keyframes demo-explosion-ring { from { transform: scale(.2); opacity:1; } to { transform: scale(1.65); opacity:0; } }
        @keyframes demo-explosion-spark { from { width:3px; opacity:1; } to { width:25px; opacity:0; } }
        .demo-smoke-effect span { position:absolute; left:13px; top:13px; width:18px; height:18px; border-radius:999px; background:rgba(148,163,184,.84); filter:blur(2px); animation:demo-smoke-puff 1.8s ease-in-out infinite; }
        .demo-smoke-effect b,.demo-fire-effect b { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); color:white; font-size:8px; text-shadow:0 1px 3px #000; }
        .demo-fire-effect span { position:absolute; bottom:5px; width:8px; height:17px; border-radius:60% 40% 55% 45%; background:linear-gradient(#fde047,#f97316 56%,#ef4444); filter:drop-shadow(0 0 3px #f97316); transform-origin:50% 100%; animation:demo-fire-flicker .65s ease-in-out infinite; }
        .demo-flash-effect { display:flex; width:28px; height:28px; align-items:center; justify-content:center; border-radius:999px; color:#422006; background:#fde047; box-shadow:0 0 22px 10px rgba(254,240,138,.8); animation:demo-flash-burst .85s ease-out 1 both; }
        .demo-explosion-effect { border-radius:999px; background:radial-gradient(circle,#fff 0 9%,#fbbf24 10% 24%,#ef4444 25% 40%,transparent 42%); filter:drop-shadow(0 0 8px #fb923c); }
        .demo-explosion-ring { position:absolute; inset:7px; border:2px solid #fda4af; border-radius:999px; animation:demo-explosion-ring .75s ease-out 1 both; }
        .demo-explosion-effect i { position:absolute; left:50%; top:50%; height:2px; width:3px; transform-origin:left center; background:#fde68a; animation:demo-explosion-spark .7s ease-out 1 both; }
        .demo-duration-ring { transition:stroke-dasharray 120ms linear; }
        .demo-shot-tracer { filter:drop-shadow(0 0 1.5px rgba(255,255,255,.9)); }
        .demo-grenade-trajectory { filter:drop-shadow(0 0 1.4px rgba(255,255,255,.72)); }
      `}</style>
      <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => changeRound(roundIndex - 1)} disabled={roundIndex <= 0} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
          <select value={selectedRound.round_number} onChange={(event) => setRoundNumber(Number(event.target.value))} className="h-8 rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-[10px] font-bold text-cs2-text-primary outline-none">
            {rounds.map((round) => <option key={round.round_number} value={round.round_number}>回合 R{round.round_number} · {round.team_a_score_after} : {round.team_b_score_after}</option>)}
          </select>
          <button type="button" onClick={() => changeRound(roundIndex + 1)} disabled={roundIndex >= rounds.length - 1} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setPlaying((value) => !value)} disabled={!frames.length} className="flex h-9 w-9 items-center justify-center rounded-full bg-cs2-accent text-cs2-text-on-accent disabled:opacity-40">{playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}</button>
          <div className="relative min-w-[240px] flex-1 pt-3">
            <div className="absolute left-2 right-2 top-0 z-10 h-3">
              {eventMarkers.map((event) => {
                const ratio = eventFrameRatio(event, frames, selectedRound);
                const markerTone = event.type === "kill" ? "bg-rose-400" : event.type === "grenade" ? grenadeVisual(event.kind).className.split(" ").find((name) => name.startsWith("bg-")) || "bg-amber-300" : "bg-amber-300";
                return <button key={`${event.type}-${event.tick}-${event.actor || ""}`} type="button" aria-label={`定位事件：${eventLabel(event)}`} onClick={() => seekToEvent(event)} className="group absolute top-0 h-3 w-3 -translate-x-1/2" style={{ left: `${ratio * 100}%` }}><span className={`mx-auto block h-2.5 w-1 rounded ${markerTone}`} /><span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md border border-cs2-border bg-cs2-bg-page px-2 py-1.5 text-left text-[9px] font-medium text-cs2-text-primary shadow-xl group-hover:block group-focus-visible:block"><b className="mr-1 font-mono text-cs2-accent">{event.time_text || "--:--"}</b>{eventLabel(event)}</span></button>;
              })}
            </div>
            <input aria-label="回放时间轴" type="range" min="0" max={Math.max(0, frames.length - 1)} value={frameIndex} onChange={(event) => { setFrameIndex(Number(event.target.value)); setPlaying(false); }} className="h-1.5 w-full cursor-pointer accent-cs2-accent" />
          </div>
          <button type="button" onClick={() => { setFrameIndex(0); setPlaying(false); }} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border text-cs2-text-muted"><RotateCcw className="h-3.5 w-3.5" /></button>
          <div className="min-w-[82px] text-right"><p className="text-[8px] uppercase text-cs2-text-muted">回合时间</p><p className="font-mono text-xl font-black text-cs2-text-primary">{formatClock(remaining)}</p><p className="font-mono text-[8px] text-cs2-text-muted">Tick {frame.tick || 0} · {SAMPLE_HZ} Hz</p></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cs2-border pt-3">
          <div className="flex flex-wrap gap-2">
            {[{ key: "traces", icon: Route, label: "走位轨迹" }, { key: "kills", icon: Swords, label: "击杀连线" }, { key: "shots", icon: Crosshair, label: "射击弹道" }, { key: "grenades", icon: Bomb, label: "投掷物" }].map(({ key, icon: Icon, label }) => <button key={key} type="button" aria-pressed={layers[key]} onClick={() => toggleLayer(key)} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[9px] font-semibold ${layers[key] ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border text-cs2-text-muted"}`}><Icon className="h-3 w-3" />{label}</button>)}
          </div>
          <div className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5">{[0.5, 1, 2, 4].map((value) => <button key={value} type="button" onClick={() => setSpeed(value)} className={`rounded px-2 py-1 font-mono text-[8px] ${speed === value ? "bg-cs2-text-primary text-cs2-bg-page" : "text-cs2-text-muted"}`}>{value}x</button>)}</div>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[220px_minmax(460px,1fr)_220px]">
        <ReplayRoster title={`${teamAName} · ${selectedRound.team_a_side || ""}`} teamKey="a" side={selectedRound.team_a_side} players={teamAPlayers} framePlayers={frame.players} bombCarrierName={bombState.carrier} />
        <section className="relative min-h-[620px] overflow-hidden rounded-xl border border-cs2-border bg-[#060b0e]">
          <div className="absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-card/90 px-2.5 py-1.5 text-[9px] text-cs2-text-secondary"><MapIcon className="h-3.5 w-3.5 text-cs2-accent" />{mapName.replace(/^de_/, "")} · R{selectedRound.round_number} · {selectedRound.team_a_score_after} : {selectedRound.team_b_score_after}</div>
          <div className="pointer-events-none absolute right-3 top-3 z-20 flex w-[min(84%,390px)] flex-col items-end gap-1.5" aria-live="polite">{killFeed.map((kill) => {
            const weapon = safeWeapon(kill.weapon, "武器");
            const actorSide = sideForPlayerName(kill.actor);
            const targetSide = sideForPlayerName(kill.target);
            const actorBlue = isBlueReplaySide(actorSide, teamKeyForPlayerName(kill.actor) === "a");
            const targetBlue = isBlueReplaySide(targetSide, teamKeyForPlayerName(kill.target) === "a");
            return <div key={`feed-${kill.tick}-${kill.actor}-${kill.target}`} className="flex max-w-full items-center gap-2 rounded-md border border-white/10 bg-black/80 px-2.5 py-1 text-[9px] shadow-lg"><span data-side={actorSide || undefined} className={`truncate font-bold ${actorBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.actor, "未知玩家")}</span><KillfeedIconStrip event={{ ...kill, is_headshot: Boolean(kill.headshot) }} weaponName={weapon} weaponKey={weapon} /><span data-side={targetSide || undefined} className={`truncate font-bold ${targetBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.target, "未知玩家")}</span></div>;
          })}</div>
          {loading && <div className="absolute inset-0 z-30 flex items-center justify-center bg-cs2-bg-page/70"><Loader2 className="h-6 w-6 animate-spin text-cs2-accent" /></div>}
          {error && <div className="absolute inset-0 z-30 flex items-center justify-center p-8 text-center text-[11px] text-cs2-text-muted">{error}</div>}
          <div className="absolute left-1/2 top-1/2 aspect-square w-[min(88%,620px)] -translate-x-1/2 -translate-y-1/2">
            <img src={`/api/demo/radar-map/${mapName}`} alt={`${mapName} 雷达地图`} className="h-full w-full object-contain opacity-80" />
            <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {traces.map((trace) => <polyline key={trace.name} points={trace.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={isBlueReplaySide(replaySideForTeamKey(trace.team_key, selectedRound), trace.team_key === "a") ? "#38bdf8" : "#fbbf24"} strokeWidth="0.35" strokeOpacity="0.45" />)}
              {recentEvents.kills.map((kill) => <g key={`kill-${kill.tick}-${kill.actor}-${kill.target}`} opacity={Math.max(0.2, kill.opacity)}><line x1={kill.actor.x} y1={kill.actor.y} x2={kill.target.x} y2={kill.target.y} stroke="#fb7185" strokeWidth="0.7" strokeDasharray="1.5 1" /><circle cx={kill.target.x} cy={kill.target.y} r="1.2" fill="none" stroke="#fb7185" strokeWidth="0.45" /><path d={`M${kill.target.x - 0.8},${kill.target.y - 0.8} L${kill.target.x + 0.8},${kill.target.y + 0.8} M${kill.target.x + 0.8},${kill.target.y - 0.8} L${kill.target.x - 0.8},${kill.target.y + 0.8}`} stroke="#fb7185" strokeWidth="0.35" /></g>)}
              {recentShots.map((shot, index) => { const teamKey = teamKeyForPlayerName(shot.actor); return <line key={`shot-${shot.tick}-${shot.actor}-${index}`} className="demo-shot-tracer" x1={shot.origin.x} y1={shot.origin.y} x2={shot.target.x} y2={shot.target.y} stroke={isBlueReplaySide(replaySideForTeamKey(teamKey, selectedRound), teamKey === "a") ? "#bae6fd" : "#fde68a"} strokeWidth="0.48" strokeLinecap="round" opacity={Math.max(0.15, shot.opacity)} />; })}
              {recentEvents.grenades.filter((grenade) => grenade.showTrajectory && grenade.path.length > 1).map((grenade) => <polyline key={`trajectory-${grenade.tick}-${grenade.actor}-${grenade.kind}`} className="demo-grenade-trajectory" data-inferred={grenade.trajectoryInferred ? "true" : undefined} data-side={grenade.side || undefined} points={grenade.path.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={grenade.teamColor} strokeWidth="0.65" strokeDasharray="1.4 .55" strokeLinecap="round" strokeLinejoin="round" opacity="1" />)}
            </svg>
            {recentEvents.grenades.map((grenade) => <GrenadeEffectMarker key={`grenade-${grenade.tick}-${grenade.actor}-${grenade.kind}`} grenade={grenade} motionDuration={motionDuration} />)}
            {bombState.position && ["dropped", "planted", "defused", "exploded"].includes(bombState.status) && <div className={`demo-c4-marker pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 ${bombState.status === "dropped" ? "z-20" : "z-[5]"} ${["defused", "exploded"].includes(bombState.status) ? "opacity-45" : ""}`} style={{ left: `${bombState.position.x}%`, top: `${bombState.position.y}%` }} title={`C4 ${bombState.status === "planted" ? `已放置${bombState.site ? ` · ${bombState.site} 区` : ""}` : bombState.status === "dropped" ? "已掉落" : bombState.status === "defused" ? "已拆除" : "已引爆"}`}><div className="flex h-6 w-6 items-center justify-center rounded-[4px] border-2 border-amber-100 bg-amber-400 text-[7px] font-black text-black shadow-[0_0_12px_rgba(245,158,11,.68)]">C4</div></div>}
            {markerPlayers.map((player) => {
              const isBlue = isBlueReplaySide(replaySideForTeamKey(player.team_key, selectedRound), player.team_key === "a");
              const displayName = safeLabel(player.name, "?");
              const yaw = Number.isFinite(Number(player.yaw)) ? Number(player.yaw) : 0;
              return <div key={player.steamid64 || displayName} className="absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-[left,top] ease-linear" style={{ left: `${player.position.x}%`, top: `${player.position.y}%`, transitionDuration: motionDuration }} title={`${displayName} · ${Number.isFinite(Number(player.health)) ? player.health : 0} HP · ${safeWeapon(player.weapon, "—")}${player.has_c4 ? " · C4" : ""}${player.has_defuser ? " · 拆弹器" : ""}`}><div className={`relative flex h-6 w-6 items-center justify-center rounded-full border-2 border-white/80 text-[8px] font-black text-white shadow-lg ${isBlue ? "bg-sky-500" : "bg-amber-500"} ${player.is_alive === false ? "opacity-35 grayscale" : ""}`}><span className="demo-player-direction-arrow pointer-events-none absolute -inset-[5px]" style={{ transform: `rotate(${90 - yaw}deg)` }}><i className={`absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-x-[4px] border-b-[6px] border-x-transparent ${isBlue ? "border-b-sky-100" : "border-b-amber-100"}`} /></span>{displayName.slice(0, 1).toUpperCase()}{player.has_c4 && <span className="demo-player-c4-badge absolute -right-1 -top-1 rounded-[3px] bg-amber-400 px-0.5 text-[5px] font-black leading-[9px] text-black">C4</span>}{player.has_defuser && <span className="demo-player-kit-badge absolute -bottom-1 -right-1 rounded-[3px] bg-sky-300 px-0.5 text-[5px] font-black leading-[9px] text-sky-950">KIT</span>}</div><span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1 text-[7px] text-white">{displayName}</span></div>;
            })}
          </div>
          {!transform && <div className="absolute inset-x-0 bottom-4 text-center text-[9px] text-cs2-text-muted">当前地图缺少坐标变换元数据</div>}
        </section>
        <ReplayRoster title={`${teamBName} · ${selectedRound.team_b_side || ""}`} teamKey="b" side={selectedRound.team_b_side} players={teamBPlayers} framePlayers={frame.players} bombCarrierName={bombState.carrier} />
      </div>
    </div>
  );
}
