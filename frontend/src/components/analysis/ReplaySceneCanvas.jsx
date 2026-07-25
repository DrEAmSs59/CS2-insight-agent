import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getDemoRadarMapUrl } from "../../api/api";
import KillfeedIconStrip from "./timeline/killfeed/KillfeedIconStrip";
import { resolveHudWeaponStem } from "./timeline/killfeed/resolveHudWeaponStem";
import ReplayAreaEffectsCanvas from "./ReplayAreaEffectsCanvas";
import ReplayBombMarker from "./ReplayBombMarker";
import ReplayCameraControls from "./ReplayCameraControls";
import {
  worldToRadarPercent,
  yawToCssRotation,
} from "../../utils/replayRadarTransform";
import {
  interpolateReplayFrame,
} from "../../utils/replayPlayback";
import {
  SCENE_SIZE,
  USER_ZOOM_STEP,
  cameraCssTransform,
  clampUserZoom,
  contentRectFromTransform,
  createFittedCamera,
  panBy,
  rescaleCameraForFitChange,
  restoreCameraForViewport,
  zoomAtPointer,
} from "../../utils/replayCamera";
import { useReplayStore } from "../../stores/replayStore";

const HUD_ICON_BASE = "/hud-death-notice";
const MOTION_DURATION = "0ms";

function HudEquipmentIcon({ stem, className = "", title = "", style }) {
  return <img src={`${HUD_ICON_BASE}/${stem}.svg`} alt="" title={title} draggable={false} className={`block object-contain ${className}`} style={style} />;
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

function armorText(state) {
  const armor = Math.max(0, Number(state?.armor) || 0);
  if (!armor) return "无甲";
  return state?.has_helmet ? `${armor} 头甲` : `${armor} 甲`;
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

function grenadeDurationSeconds(kind) {
  const value = safeLabel(kind);
  if (/烟|smoke/i.test(value)) return 18;
  if (/燃烧|molotov|inferno|incendiary/i.test(value)) return 7;
  if (/闪|flash/i.test(value)) return 0.85;
  return 0.4;
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

export function computeBombState(roundEvents, currentTick, framePlayers, initialCarrier, transform) {
  let carrier = safeLabel(initialCarrier);
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
  if (status === "carried" && !carrier) {
    const frameCarriers = (framePlayers || []).filter((player) => player?.has_c4 && player?.is_alive !== false);
    if (frameCarriers.length === 1) carrier = safeLabel(frameCarriers[0].name);
  }
  if (status !== "carried") carrier = "";
  return { carrier, status, position, site, z };
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

export default function ReplaySceneCanvas({
  playheadStore,
  frames,
  playing,
  frameIndex,
  mapName,
  hasMapLayers,
  mapLayer,
  transform,
  selectedRound,
  roundEvents,
  tickRate,
  workspacePlayers,
  playerLabelMode,
  layers,
  effectTracks,
  effectCapabilities,
  smokeDebugLayer = "off",
}) {
  const playhead = useSyncExternalStore(playheadStore.subscribe, playheadStore.getSnapshot);
  const fallbackTick = selectedRound?.freeze_end_tick || selectedRound?.start_tick || 0;
  const frameCursorIndex = clamp(Math.floor(playing ? playhead.position : frameIndex), 0, Math.max(0, frames.length - 1));

  const viewportRef = useRef(null);
  const cameraRef = useRef(null);
  const spaceDownRef = useRef(false);
  const panSessionRef = useRef(null);
  const prevMapKeyRef = useRef("");
  const mapKey = String(mapName || "").trim().toLowerCase();
  const contentRect = useMemo(() => contentRectFromTransform(transform), [transform]);
  const [camera, setCamera] = useState(() => ({
    fitScale: 1,
    userZoom: 1,
    offsetX: 0,
    offsetY: 0,
  }));
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  cameraRef.current = camera;
  // Scene is CSS-scaled by fitScale; keep on-screen size ≈ 15.3×1.1 at Fit, grow with userZoom.
  const playerMarkerSizePx = (15.3 * 1.1) / Math.max(Number(camera.fitScale) || 1, 0.05);

  const applyCamera = (next) => {
    const resolved = typeof next === "function" ? next(cameraRef.current) : next;
    if (!resolved) return;
    cameraRef.current = resolved;
    setCamera(resolved);
    if (mapKey) useReplayStore.getState().setCamera(mapKey, resolved);
  };

  const fitCameraToViewport = (size = viewportSize) => {
    if (!(size.width > 0) || !(size.height > 0)) return;
    applyCamera(createFittedCamera(size, contentRect));
  };

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry?.contentRect?.width || node.clientWidth;
      const height = entry?.contentRect?.height || node.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      setViewportSize({ width, height });
    });
    observer.observe(node);
    setViewportSize({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Fit on map change (restore store if present). Same map: refresh fitScale; recenter when userZoom==1.
  useEffect(() => {
    if (!(viewportSize.width > 0) || !(viewportSize.height > 0)) return;
    const mapChanged = prevMapKeyRef.current !== mapKey;
    prevMapKeyRef.current = mapKey;
    const fitted = createFittedCamera(viewportSize, contentRect);

    if (mapChanged) {
      const saved = mapKey ? useReplayStore.getState().getCamera(mapKey) : null;
      if (saved && Number(saved.fitScale) > 0) {
        applyCamera(restoreCameraForViewport(saved, fitted, viewportSize));
        return;
      }
      applyCamera(fitted);
      return;
    }

    const current = cameraRef.current;
    if (!current || clampUserZoom(current.userZoom) === 1) {
      applyCamera(fitted);
      return;
    }
    applyCamera(rescaleCameraForFitChange(current, fitted.fitScale, viewportSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally ignore round/layer
  }, [mapKey, contentRect.x, contentRect.y, contentRect.width, contentRect.height, viewportSize.width, viewportSize.height]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code === "Space") spaceDownRef.current = true;
    };
    const onKeyUp = (event) => {
      if (event.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const current = cameraRef.current;
      if (!current) return;
      const rect = node.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const direction = event.deltaY < 0 ? 1 : -1;
      const nextUserZoom = clampUserZoom(
        current.userZoom * (direction > 0 ? USER_ZOOM_STEP : 1 / USER_ZOOM_STEP),
      );
      if (nextUserZoom === current.userZoom) return;
      const beforeScale = current.fitScale * current.userZoom;
      const afterScale = current.fitScale * nextUserZoom;
      const zoomed = zoomAtPointer({
        offsetX: current.offsetX,
        offsetY: current.offsetY,
        scale: beforeScale,
        pointerX,
        pointerY,
        nextScale: afterScale,
      });
      applyCamera(panBy(
        { ...current, userZoom: nextUserZoom, offsetX: zoomed.offsetX, offsetY: zoomed.offsetY },
        0,
        0,
        { width: rect.width, height: rect.height },
        { width: SCENE_SIZE, height: SCENE_SIZE },
      ));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [mapKey, contentRect.width, contentRect.height]);

  const stepUserZoom = (factor) => {
    const node = viewportRef.current;
    const current = cameraRef.current;
    if (!node || !current) return;
    const rect = node.getBoundingClientRect();
    const pointerX = rect.width / 2;
    const pointerY = rect.height / 2;
    const nextUserZoom = clampUserZoom(current.userZoom * factor);
    if (nextUserZoom === current.userZoom) return;
    const beforeScale = current.fitScale * current.userZoom;
    const afterScale = current.fitScale * nextUserZoom;
    const zoomed = zoomAtPointer({
      offsetX: current.offsetX,
      offsetY: current.offsetY,
      scale: beforeScale,
      pointerX,
      pointerY,
      nextScale: afterScale,
    });
    applyCamera(panBy(
      { ...current, userZoom: nextUserZoom, offsetX: zoomed.offsetX, offsetY: zoomed.offsetY },
      0,
      0,
      { width: rect.width, height: rect.height },
      { width: SCENE_SIZE, height: SCENE_SIZE },
    ));
  };

  const onViewportPointerDown = (event) => {
    const current = cameraRef.current;
    if (!current) return;
    // After zoom: left-drag pans (Space+LMB and middle-mouse still work).
    const canPan = current.userZoom > 1;
    const isMiddle = event.button === 1;
    const isLeft = event.button === 0;
    if (!canPan || (!isMiddle && !isLeft)) return;
    // Ignore interactive chrome (zoom controls, floor toggle).
    if (event.target?.closest?.("button, input, a, [data-no-pan]")) return;
    event.preventDefault();
    const node = viewportRef.current;
    if (!node) return;
    panSessionRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    node.setPointerCapture?.(event.pointerId);
    node.style.cursor = "grabbing";
  };

  const onViewportPointerMove = (event) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const node = viewportRef.current;
    const current = cameraRef.current;
    if (!node || !current) return;
    const dx = event.clientX - session.lastX;
    const dy = event.clientY - session.lastY;
    session.lastX = event.clientX;
    session.lastY = event.clientY;
    const rect = node.getBoundingClientRect();
    applyCamera(panBy(
      current,
      dx,
      dy,
      { width: rect.width, height: rect.height },
      { width: SCENE_SIZE, height: SCENE_SIZE },
    ));
  };

  const endPanSession = (event) => {
    const session = panSessionRef.current;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    panSessionRef.current = null;
    const node = viewportRef.current;
    if (node) {
      node.style.cursor = cameraRef.current?.userZoom > 1 ? "grab" : "default";
    }
  };

  const finalScale = camera.fitScale * camera.userZoom;
  const sceneTransform = cameraCssTransform({
    offsetX: camera.offsetX,
    offsetY: camera.offsetY,
    scale: finalScale,
  });

  const frame = useMemo(() => {
    if (!frames.length) return { players: [], tick: fallbackTick, time_sec: 0 };
    const seconds = Number(playhead.seconds);
    if (Number.isFinite(seconds)) {
      return interpolateReplayFrame(frames, Number.NaN, seconds);
    }
    const idx = clamp(Math.floor(frameIndex), 0, frames.length - 1);
    return frames[idx] || { players: [], tick: fallbackTick, time_sec: 0 };
  }, [fallbackTick, frameIndex, frames, playhead.seconds]);

  const currentTick = Number(frame.tick || fallbackTick || 0);
  const roundEndTick = Number(selectedRound?.round_end_tick || selectedRound?.end_tick || 0);

  const hasSmokeAreaTracks = Boolean(
    effectCapabilities?.smoke_voxels
    && effectTracks.some((track) => track?.type === "smoke" && Array.isArray(track.samples) && track.samples.length),
  );
  const hasInfernoAreaTracks = Boolean(
    effectCapabilities?.inferno_cells
    && effectTracks.some((track) => track?.type === "inferno" && Array.isArray(track.samples) && track.samples.length),
  );

  const bombState = useMemo(
    () => computeBombState(roundEvents, currentTick, frame.players, selectedRound?.bomb_initial_carrier, transform),
    [currentTick, frame.players, roundEvents, selectedRound?.bomb_initial_carrier, transform],
  );

  const playerNumberByName = useMemo(() => {
    const teamAPlayers = workspacePlayers.filter((player) => player.team_key === "a").slice(0, 5);
    const teamBPlayers = workspacePlayers.filter((player) => player.team_key === "b").slice(0, 5);
    return new Map([
      ...teamAPlayers.map((player, index) => [safeLabel(player.name).toLowerCase(), replayPlayerNumber("a", index)]),
      ...teamBPlayers.map((player, index) => [safeLabel(player.name).toLowerCase(), replayPlayerNumber("b", index)]),
    ]);
  }, [workspacePlayers]);

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
        const actor = worldToPercent(actorSource, transform);
        const target = worldToPercent(targetSource, transform);
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

  const killFeed = useMemo(() => roundEvents
    .filter((event) => event.type === "kill" && Number(event.tick) <= currentTick && currentTick - Number(event.tick) <= tickRate * 7)
    .slice(-5)
    .reverse(), [currentTick, roundEvents, tickRate]);

  return (
    <>
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
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex w-[min(84%,390px)] flex-col items-end gap-1.5" aria-live="polite">{killFeed.map((kill) => {
        const weapon = safeWeapon(kill.weapon, "武器");
        const actorSide = sideForPlayerName(kill.actor);
        const targetSide = sideForPlayerName(kill.target);
        const actorBlue = isBlueReplaySide(actorSide, teamKeyForPlayerName(kill.actor) === "a");
        const targetBlue = isBlueReplaySide(targetSide, teamKeyForPlayerName(kill.target) === "a");
        return <div key={`feed-${kill.tick}-${kill.actor}-${kill.target}`} className="flex max-w-full items-center gap-2 rounded-md border border-white/10 bg-black/80 px-2.5 py-1 text-[9px] shadow-lg"><span data-side={actorSide || undefined} className={`truncate font-bold ${actorBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.actor, "未知玩家")}</span><KillfeedIconStrip event={{ ...kill, is_headshot: Boolean(kill.headshot) }} weaponName={weapon} weaponKey={weapon} /><span data-side={targetSide || undefined} className={`truncate font-bold ${targetBlue ? "text-sky-300" : "text-amber-300"}`}>{safeLabel(kill.target, "未知玩家")}</span></div>;
      })}</div>
      <div
        ref={viewportRef}
        className="replay-viewport absolute inset-0 overflow-hidden"
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={endPanSession}
        onPointerCancel={endPanSession}
        onDoubleClick={() => fitCameraToViewport()}
        style={{ cursor: camera.userZoom > 1 ? "grab" : "default" }}
      >
        <div
          className="replay-scene demo-radar-plane absolute left-0 top-0"
          data-map={mapName}
          data-layer={hasMapLayers ? mapLayer : undefined}
          style={{
            width: SCENE_SIZE,
            height: SCENE_SIZE,
            transform: sceneTransform,
            transformOrigin: "0 0",
          }}
        >
          <img src={getDemoRadarMapUrl(mapName, hasMapLayers ? mapLayer : "")} alt={`${mapName}${hasMapLayers ? ` ${mapLayer === "upper" ? "上层" : "下层"}` : ""} 雷达地图`} className="h-full w-full object-contain opacity-80" draggable={false} />
          <ReplayAreaEffectsCanvas
            tracks={effectTracks}
            currentTick={currentTick}
            hideAfterTick={roundEndTick > 0 ? roundEndTick : null}
            tickRate={tickRate}
            transform={transform}
            mapName={mapName}
            mapLayer={hasMapLayers ? mapLayer : "upper"}
            enabled={Boolean(layers.utilityAreas)}
            capabilities={effectCapabilities}
            smokeDebugLayer={smokeDebugLayer}
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
                motionDuration={MOTION_DURATION}
                useAreaFallback={useAreaFallback}
              />
            );
          })}
          {bombState.position && pointMatchesMapLayer(bombState, transform, mapLayer) && ["dropped", "planted", "defused", "exploded"].includes(bombState.status) && (
            <ReplayBombMarker
              status={bombState.status}
              site={bombState.site}
              fitScale={camera.fitScale}
              style={{ left: `${bombState.position.x}%`, top: `${bombState.position.y}%` }}
            />
          )}
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
              <div key={player.steamid64 || displayName} className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-[left,top] ease-linear" style={{ left: `${player.position.x}%`, top: `${player.position.y}%`, transitionDuration: MOTION_DURATION }} title={markerTitle}>
                <div
                  data-player-number={Number.isInteger(playerNumber) ? playerNumber : undefined}
                  data-player-label-mode={playerLabelMode}
                  className={`demo-player-marker relative flex items-center justify-center rounded-full border border-white/80 font-mono font-black leading-none text-white ${isBlue ? "bg-sky-500" : "bg-amber-500"} ${player.is_alive === false ? "opacity-35 grayscale" : ""}`}
                  style={{ width: playerMarkerSizePx, height: playerMarkerSizePx, fontSize: Math.max(7, playerMarkerSizePx * 0.46) }}
                >
                  <span className="demo-player-direction-arrow pointer-events-none absolute inset-0" style={{ transform: `rotate(${yawToCssRotation(yaw)}deg)` }}>
                    <i className={`absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 -translate-y-[calc(100%-0.5px)] border-x-[2.5px] border-b-[4.5px] border-x-transparent ${isBlue ? "border-b-sky-100" : "border-b-amber-100"}`} />
                  </span>
                  <span>{circleLabel}</span>
                  {player.has_c4 && (
                    <span
                      className="demo-player-c4-badge absolute -right-1 -top-1 flex items-center justify-center rounded-[2px] bg-amber-400"
                      style={{ width: Math.max(8, playerMarkerSizePx * 0.45), height: Math.max(8, playerMarkerSizePx * 0.45) }}
                    >
                      <HudEquipmentIcon stem="c4" className="brightness-0" style={{ width: "75%", height: "75%" }} />
                    </span>
                  )}
                  {player.has_defuser && (
                    <span
                      className="demo-player-kit-badge absolute -bottom-1 -right-1 flex items-center justify-center rounded-[2px] bg-sky-300"
                      style={{ width: Math.max(8, playerMarkerSizePx * 0.45), height: Math.max(8, playerMarkerSizePx * 0.45) }}
                    >
                      <HudEquipmentIcon stem="defuser" className="brightness-0" style={{ width: "75%", height: "75%" }} />
                    </span>
                  )}
                </div>
                {playerLabelMode === "id" && (
                  <span
                    className="demo-player-id-label mt-0.5 truncate text-center font-bold leading-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]"
                    style={{
                      // Same fitScale compensation as markers; ~10px on-screen at Fit.
                      fontSize: Math.max(9, 10 / Math.max(Number(camera.fitScale) || 1, 0.05)),
                      maxWidth: Math.max(72, 88 / Math.max(Number(camera.fitScale) || 1, 0.05)),
                    }}
                  >
                    {idLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <ReplayCameraControls
          className={hasMapLayers ? "top-12 left-3" : "top-3 left-3"}
          userZoom={camera.userZoom}
          onZoomIn={() => stepUserZoom(USER_ZOOM_STEP)}
          onZoomOut={() => stepUserZoom(1 / USER_ZOOM_STEP)}
          onFit={() => fitCameraToViewport()}
        />
      </div>
    </>
  );
}
