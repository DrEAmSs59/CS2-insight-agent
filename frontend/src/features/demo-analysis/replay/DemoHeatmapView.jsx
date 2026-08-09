import { useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair,
  Flame,
  Footprints,
  Layers3,
  Loader2,
  RefreshCw,
  Skull,
  Swords,
} from "lucide-react";
import { getDemoRadarMapUrl } from "../../../api/api";
import useSessionState from "../../../hooks/useSessionState";
import { useT } from "../../../i18n/useT.js";
import {
  createReplayCacheKey,
  requestReplayFrames,
  useReplayStore,
} from "./replayStore";
import {
  buildReplayHeatmapSet,
  replayHeatmapPlayerKey,
} from "./replayHeatmap";
import { resolveReplayTransform } from "./replayRadarTransform";
import { playerDisplayName, playerIdentityKey } from "../../../utils/playerIdentity.js";
import ReplayCameraControls from "./ReplayCameraControls";
import ReplayHeatmapCanvas from "./ReplayHeatmapCanvas";

const HEATMAP_FPS = 32;
const REQUEST_CONCURRENCY = 4;
const MAX_HEATMAP_CACHE_ENTRIES = 6;
const HEATMAP_MIN_ZOOM = 0.5;
const HEATMAP_MAX_ZOOM = 4;
const HEATMAP_ZOOM_STEP = 1.2;
const heatmapCache = new Map();
const HEATMAP_MODES = [
  { key: "movement", labelKey: "analysis.heatmap.modeMovement", mapLabelKey: "analysis.heatmap.modeMovementMap", icon: Footprints },
  { key: "combat", labelKey: "analysis.heatmap.modeCombat", mapLabelKey: "analysis.heatmap.modeCombatMap", icon: Swords },
  { key: "kills", labelKey: "analysis.heatmap.modeKills", mapLabelKey: "analysis.heatmap.modeKillsMap", icon: Crosshair },
  { key: "deaths", labelKey: "analysis.heatmap.modeDeaths", mapLabelKey: "analysis.heatmap.modeDeathsMap", icon: Skull },
];
const HEATMAP_SIDES = [
  { key: "all", labelKey: "analysis.heatmap.sideAll" },
  { key: "CT", labelKey: null },
  { key: "T", labelKey: null },
];

const MODE_DESCRIPTIONS = {
  movement: "analysis.heatmap.movementDescription",
  combat: "analysis.heatmap.combatDescription",
  kills: "analysis.heatmap.killsDescription",
  deaths: "analysis.heatmap.deathsDescription",
};

function rememberHeatmap(key, value) {
  heatmapCache.delete(key);
  heatmapCache.set(key, value);
  while (heatmapCache.size > MAX_HEATMAP_CACHE_ENTRIES) {
    heatmapCache.delete(heatmapCache.keys().next().value);
  }
}

function mapKey(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  return /^(de|cs|ar)_/.test(raw) ? raw : `de_${raw}`;
}

function playerName(player) {
  return playerDisplayName(player);
}

function playerTeamKey(player, index, total) {
  if (player?.team_key === "a" || player?.team_key === "b") return player.team_key;
  const teamNumber = Number(player?.team ?? player?.team_number);
  if (teamNumber === 2) return "a";
  if (teamNumber === 3) return "b";
  return index < Math.ceil(total / 2) ? "a" : "b";
}

function clampHeatmapZoom(value) {
  return Math.max(HEATMAP_MIN_ZOOM, Math.min(HEATMAP_MAX_ZOOM, Number(value) || HEATMAP_MIN_ZOOM));
}

function heatmapRequest(round, { demoPath, mapName, tickRate, povPlayer }) {
  const startTick = Number(round?.freeze_end_tick ?? round?.start_tick);
  const endTick = Number(round?.end_tick);
  if (!Number.isFinite(startTick) || !Number.isFinite(endTick) || endTick <= startTick) return null;
  const requestBody = {
    path: demoPath,
    map_name: mapName,
    start_tick: startTick,
    end_tick: endTick,
    tick_rate: tickRate,
    fps: HEATMAP_FPS,
    pov_player_name: povPlayer?.name || null,
    pov_steamid64: povPlayer?.steam_id64 || null,
  };
  return {
    round,
    requestBody,
    cacheKey: createReplayCacheKey({
      demoPath,
      roundNumber: round?.round_number,
      startTick,
      endTick,
      fps: HEATMAP_FPS,
      transformVersion: 1,
    }),
  };
}

async function loadRoundFrames(job) {
  const entry = useReplayStore.getState().getEntry(job.cacheKey);
  if (entry?.status === "ready" && entry.frames) {
    return {
      frames: entry.frames,
      fps: entry.fps,
      map_transform: entry.mapTransform,
    };
  }
  if (entry?.status === "loading" && entry.promise) return entry.promise;
  return requestReplayFrames(job.requestBody);
}

function StatCard({ label, value, detail }) {
  return (
    <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cs2-text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl font-black text-cs2-text-primary">{value}</p>
      <p className="mt-0.5 text-[10px] text-cs2-text-muted">{detail}</p>
    </div>
  );
}

export default function DemoHeatmapView({
  workspace,
  demoPath,
  players = [],
  selectedPlayer = "",
}) {
  const t = useT();
  const rounds = workspace?.rounds || [];
  const mapName = mapKey(workspace?.map_name);
  const tickRate = Math.max(1, Number(workspace?.tick_rate) || 64);
  const workspacePlayers = useMemo(
    () => (workspace?.players?.length ? workspace.players : players),
    [players, workspace?.players],
  );
  const playerOptions = useMemo(() => workspacePlayers
    .map((player, index) => ({
      ...player,
      key: playerIdentityKey(player),
      name: playerName(player),
      analysis_name: String(player?.name || player?.player_name || "").trim(),
      team_key: playerTeamKey(player, index, workspacePlayers.length),
    }))
    .filter((player) => player.name && player.key), [workspacePlayers]);
  const playerTeamKeys = useMemo(() => Object.fromEntries(playerOptions.map((player) => [
    replayHeatmapPlayerKey(player.analysis_name || player.name),
    player.team_key,
  ])), [playerOptions]);
  const playerTeamSignature = useMemo(
    () => Object.entries(playerTeamKeys).map(([name, teamKey]) => `${name}:${teamKey}`).join(","),
    [playerTeamKeys],
  );
  const sessionIdentity = encodeURIComponent(String(demoPath || workspace?.demo_fingerprint || mapName));
  const [mode, setMode] = useSessionState(`demo-heatmap:${sessionIdentity}:mode`, "movement");
  const [mapLayer, setMapLayer] = useSessionState(`demo-heatmap:${sessionIdentity}:layer`, "upper");
  const [selectedSide, setSelectedSide] = useSessionState(`demo-heatmap:${sessionIdentity}:side`, "all");
  const selectedPlayerOption = playerOptions.find((player) => player.key === selectedPlayer)
    || playerOptions[0]
    || null;
  const focusedPlayer = selectedPlayerOption?.analysis_name || selectedPlayerOption?.name || "";
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [mapCamera, setMapCamera] = useState({ zoom: 1, offsetX: 0, offsetY: 0 });
  const mapSurfaceRef = useRef(null);
  const mapDragRef = useRef(null);
  const [loadState, setLoadState] = useState({
    status: "idle",
    completed: 0,
    total: 0,
    data: null,
    transform: null,
    error: "",
  });

  const jobs = useMemo(() => rounds
    .map((round) => heatmapRequest(round, {
      demoPath,
      mapName,
      tickRate,
      povPlayer: workspacePlayers[0],
    }))
    .filter(Boolean), [demoPath, mapName, rounds, tickRate, workspacePlayers]);
  const heatmapCacheKey = useMemo(() => [
    "v3",
    demoPath,
    workspace?.demo_fingerprint || "",
    mapName,
    `f${HEATMAP_FPS}`,
    `teams:${playerTeamSignature}`,
    ...jobs.map((job) => `${job.requestBody.start_tick}-${job.requestBody.end_tick}:${job.round?.team_a_side || ""}-${job.round?.team_b_side || ""}`),
  ].join("|"), [demoPath, jobs, mapName, playerTeamSignature, workspace?.demo_fingerprint]);

  useEffect(() => {
    let cancelled = false;
    if (!demoPath) {
      setLoadState((current) => ({ ...current, status: "error", error: t("analysis.heatmap.missingPath") }));
      return undefined;
    }
    if (!jobs.length) {
      setLoadState((current) => ({ ...current, status: "error", error: t("analysis.heatmap.noRounds") }));
      return undefined;
    }

    const cached = heatmapCache.get(heatmapCacheKey);
    if (cached) {
      // Refresh insertion order for the tiny LRU and skip all round requests.
      rememberHeatmap(heatmapCacheKey, cached);
      setLoadState(cached);
      return undefined;
    }

    setLoadState({
      status: "loading",
      completed: 0,
      total: jobs.length,
      data: null,
      transform: null,
      error: "",
    });

    const run = async () => {
      const bundles = new Array(jobs.length);
      let nextIndex = 0;
      let completed = 0;
      let liveTransform = null;
      const worker = async () => {
        while (!cancelled) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= jobs.length) return;
          const payload = await loadRoundFrames(jobs[index]);
          if (cancelled) return;
          bundles[index] = {
            round: jobs[index].round,
            frames: Array.isArray(payload?.frames) ? payload.frames : [],
            fps: Math.max(1, Number(payload?.fps) || HEATMAP_FPS),
          };
          if (!liveTransform && payload?.map_transform) liveTransform = payload.map_transform;
          completed += 1;
          setLoadState((current) => (
            current.status === "loading"
              ? { ...current, completed }
              : current
          ));
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(REQUEST_CONCURRENCY, jobs.length) },
          () => worker(),
        ),
      );
      if (cancelled) return;
      const transform = resolveReplayTransform({
        responseTransform: liveTransform,
        workspaceTransform: workspace?.map_transform,
      });
      if (!transform) throw new Error(t("analysis.heatmap.missingTransform"));
      const hasMapLayers = Number.isFinite(Number(transform.lower_level_max_units))
        && ["de_nuke", "de_vertigo"].includes(mapName);
      const data = buildReplayHeatmapSet({
        roundBundles: bundles.filter(Boolean),
        transform,
        hasMapLayers,
        playerTeamKeys,
      });
      if (cancelled) return;
      const readyState = {
        status: "ready",
        completed: jobs.length,
        total: jobs.length,
        data,
        transform,
        error: "",
      };
      rememberHeatmap(heatmapCacheKey, readyState);
      setLoadState(readyState);
    };

    run().catch((reason) => {
      if (cancelled) return;
      setLoadState({
        status: "error",
        completed: 0,
        total: jobs.length,
        data: null,
        transform: null,
        error: reason?.response?.data?.detail || reason?.message || t("analysis.heatmap.loadFailed"),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [demoPath, heatmapCacheKey, jobs, mapName, playerTeamKeys, reloadEpoch, t, workspace?.map_transform]);

  const hasMapLayers = Boolean(loadState.data?.lower);
  useEffect(() => {
    if (!hasMapLayers) setMapLayer("upper");
  }, [hasMapLayers]);
  const selectedPlayerData = loadState.data?.players?.[replayHeatmapPlayerKey(focusedPlayer)] || null;
  const selectedSideData = selectedSide === "all"
    ? selectedPlayerData
    : selectedPlayerData?.sides?.[selectedSide] || null;
  const activeLayer = selectedSideData?.[mapLayer] || selectedSideData?.upper || null;
  const activeHeatmap = activeLayer?.[mode] || null;
  const movementSamples = activeLayer?.movement?.sampleCount || 0;
  const combatEvents = activeLayer?.combat?.eventCount || 0;
  const killEvents = activeLayer?.kills?.eventCount || 0;
  const deathEvents = activeLayer?.deaths?.eventCount || 0;
  const activeMode = HEATMAP_MODES.find((item) => item.key === mode) || HEATMAP_MODES[0];
  const activeEventCount = mode === "movement" ? movementSamples : activeHeatmap?.eventCount || 0;
  const activeRoundCount = selectedSide === "all"
    ? loadState.data?.roundCount || jobs.length || 0
    : rounds.filter((round) => {
      const roundSide = selectedPlayerOption?.team_key === "a" ? round?.team_a_side : round?.team_b_side;
      return String(roundSide || "").toUpperCase() === selectedSide;
    }).length;

  const clampOffset = (value, zoom, axis) => {
    const rect = mapSurfaceRef.current?.getBoundingClientRect();
    const size = axis === "x" ? Number(rect?.width || 0) : Number(rect?.height || 0);
    const limit = Math.max(0, size * Math.abs(zoom - 1) / 2);
    return Math.max(-limit, Math.min(limit, Number(value) || 0));
  };

  const changeMapZoom = (nextZoom, pointer = null) => {
    setMapCamera((current) => {
      const zoom = clampHeatmapZoom(nextZoom);
      if (zoom === HEATMAP_MIN_ZOOM) return { zoom, offsetX: 0, offsetY: 0 };
      const ratio = zoom / current.zoom;
      const nextOffsetX = pointer
        ? pointer.x - ratio * (pointer.x - current.offsetX)
        : current.offsetX;
      const nextOffsetY = pointer
        ? pointer.y - ratio * (pointer.y - current.offsetY)
        : current.offsetY;
      return {
        zoom,
        offsetX: clampOffset(nextOffsetX, zoom, "x"),
        offsetY: clampOffset(nextOffsetY, zoom, "y"),
      };
    });
  };

  useEffect(() => {
    const surface = mapSurfaceRef.current;
    if (!surface) return undefined;
    const handleWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target instanceof Element && event.target.closest("button")) return;
      const rect = surface.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      changeMapZoom(
        mapCamera.zoom * (event.deltaY < 0 ? HEATMAP_ZOOM_STEP : 1 / HEATMAP_ZOOM_STEP),
        pointer,
      );
    };
    surface.addEventListener("wheel", handleWheel, { passive: false });
    return () => surface.removeEventListener("wheel", handleWheel);
  }, [mapCamera.zoom]);

  const handleMapPointerDown = (event) => {
    if (event.button !== 0 || Math.abs(mapCamera.zoom - 1) < 0.001 || event.target.closest("button")) return;
    mapDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: mapCamera.offsetX,
      offsetY: mapCamera.offsetY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleMapPointerMove = (event) => {
    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setMapCamera((current) => ({
      ...current,
      offsetX: clampOffset(drag.offsetX + event.clientX - drag.startX, current.zoom, "x"),
      offsetY: clampOffset(drag.offsetY + event.clientY - drag.startY, current.zoom, "y"),
    }));
  };

  const finishMapDrag = (event) => {
    if (mapDragRef.current?.pointerId !== event.pointerId) return;
    mapDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <section className="overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cs2-border px-4 py-3">
        <div>
          <h2 className="mt-0.5 text-[14px] font-black text-cs2-text-primary">{t("analysis.heatmap.title")}</h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div role="group" aria-label={t("analysis.heatmap.sideGroup")} className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-0.5">
            {HEATMAP_SIDES.map(({ key, labelKey }) => (
              <button
                key={key}
                type="button"
                aria-pressed={selectedSide === key}
                onClick={() => setSelectedSide(key)}
                className={`rounded-md px-2.5 py-1.5 text-[10px] font-black transition-colors ${
                  selectedSide === key
                    ? key === "CT"
                      ? "bg-sky-400 text-sky-950"
                      : key === "T"
                        ? "bg-amber-300 text-amber-950"
                        : "bg-cs2-accent text-cs2-text-on-accent"
                    : "text-cs2-text-muted hover:text-cs2-text-primary"
                }`}
              >
                {labelKey ? t(labelKey) : key}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t("analysis.heatmap.typeGroup")} className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-0.5">
            {HEATMAP_MODES.map(({ key, labelKey, icon: Icon }) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => setMode(key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold transition-colors ${
                  mode === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-primary"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_240px]">
        <div
          ref={mapSurfaceRef}
          data-testid="heatmap-map-surface"
          data-zoom={mapCamera.zoom.toFixed(2)}
          data-offset-x={mapCamera.offsetX.toFixed(0)}
          data-offset-y={mapCamera.offsetY.toFixed(0)}
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={finishMapDrag}
          onPointerCancel={finishMapDrag}
          className={`relative mx-auto aspect-square w-full max-w-[860px] overflow-hidden rounded-xl border border-white/10 bg-[#04080a] shadow-inner ${
            Math.abs(mapCamera.zoom - 1) >= 0.001 ? "cursor-grab active:cursor-grabbing" : ""
          }`}
          style={{ touchAction: "none" }}
        >
          <div
            className="pointer-events-none absolute inset-0 will-change-transform"
            style={{
              transform: `translate3d(${mapCamera.offsetX}px, ${mapCamera.offsetY}px, 0) scale(${mapCamera.zoom})`,
              transformOrigin: "50% 50%",
            }}
          >
            <img
              src={getDemoRadarMapUrl(mapName, hasMapLayers ? mapLayer : "")}
              alt={t("analysis.heatmap.imageAlt", { map: mapName, side: selectedSide === "all" ? "" : `${selectedSide} `, mode: t(activeMode.mapLabelKey) })}
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain opacity-[0.72]"
            />
            {activeHeatmap && <ReplayHeatmapCanvas heatmap={activeHeatmap} mode={mode} />}
          </div>
          <ReplayCameraControls
            userZoom={mapCamera.zoom}
            onZoomIn={() => changeMapZoom(mapCamera.zoom * HEATMAP_ZOOM_STEP)}
            onZoomOut={() => changeMapZoom(mapCamera.zoom / HEATMAP_ZOOM_STEP)}
            onFit={() => setMapCamera({ zoom: 1, offsetX: 0, offsetY: 0 })}
            className="right-3 top-3"
          />
          {hasMapLayers && (
            <div role="group" aria-label={t("analysis.heatmap.floorGroup")} className="absolute left-3 top-3 z-10 flex rounded-md border border-white/15 bg-black/75 p-0.5 backdrop-blur-sm">
              {[
                ["upper", "analysis.heatmap.upperFloor"],
                ["lower", "analysis.heatmap.lowerFloor"],
              ].map(([key, labelKey]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={mapLayer === key}
                  onClick={() => setMapLayer(key)}
                  className={`rounded px-2.5 py-1 text-[10px] font-bold ${
                    mapLayer === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-white/55"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          )}
          {loadState.status === "loading" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/65 text-center backdrop-blur-[2px]">
              <Loader2 className="h-7 w-7 animate-spin text-cs2-accent" />
              <div>
                <p className="text-[11px] font-bold text-white">{t("analysis.heatmap.aggregating")}</p>
                <p className="mt-1 font-mono text-[10px] text-white/60">{t("analysis.heatmap.roundProgress", { done: loadState.completed, total: loadState.total })}</p>
              </div>
            </div>
          )}
          {loadState.status === "error" && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-8 text-center">
              <div>
                <Flame className="mx-auto h-7 w-7 text-rose-400" />
                <p className="mt-3 max-w-md text-[10px] leading-relaxed text-white/75">{loadState.error}</p>
                <button
                  type="button"
                  onClick={() => setReloadEpoch((value) => value + 1)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-1.5 text-[10px] font-bold text-white"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t("analysis.heatmap.retry")}
                </button>
              </div>
            </div>
          )}
          {loadState.status === "ready" && activeEventCount === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20 p-8 text-center">
              <p className="rounded-md border border-white/10 bg-black/65 px-4 py-2 text-[10px] font-semibold text-white/70">
                {t("analysis.heatmap.noModeData", {
                  player: focusedPlayer || t("analysis.heatmap.selectedPlayerFallback"),
                  side: selectedSide === "all" ? "" : t("analysis.heatmap.sideContext", { side: selectedSide }),
                  mode: t(activeMode.labelKey),
                })}
              </p>
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cs2-text-muted">{t("analysis.heatmap.currentPlayer")}</p>
            <div className="mt-1 flex items-center gap-2">
              <p data-testid="heatmap-focused-player" className="min-w-0 flex-1 truncate text-[13px] font-black text-cs2-accent">{focusedPlayer || t("analysis.heatmap.notSelected")}</p>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-black ${
                selectedSide === "CT"
                  ? "bg-sky-400/15 text-sky-400"
                  : selectedSide === "T"
                    ? "bg-amber-300/15 text-amber-300"
                    : "bg-cs2-accent-soft text-cs2-accent"
              }`}>{selectedSide === "all" ? t("analysis.heatmap.allSides") : selectedSide}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            <StatCard
              label={t("analysis.heatmap.statRounds")}
              value={activeRoundCount}
              detail={selectedSide === "all" ? t("analysis.heatmap.statRoundsAll") : t("analysis.heatmap.statRoundsSide", { side: selectedSide })}
            />
            <StatCard label={t("analysis.heatmap.statCombat")} value={combatEvents.toLocaleString("en-US")} detail={t("analysis.heatmap.statCombatDetail")} />
            <StatCard label={t("analysis.heatmap.statKillsDeaths")} value={`${killEvents} / ${deathEvents}`} detail={t("analysis.heatmap.statFloorDetail")} />
          </div>
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-3">
            <div className="flex items-center gap-2">
              <Layers3 className="h-3.5 w-3.5 text-cs2-accent" />
              <h3 className="text-[10px] font-bold text-cs2-text-primary">{t("analysis.heatmap.legend")}</h3>
            </div>
            <div className="mt-3 h-2.5 rounded-full bg-gradient-to-r from-transparent via-cyan-400 via-45% to-rose-600" />
            <div className="mt-1 flex justify-between text-[10px] font-semibold text-cs2-text-muted">
              <span>{t("analysis.heatmap.legendLow")}</span>
              <span>{t("analysis.heatmap.legendHigh")}</span>
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-cs2-text-muted">
              {t(MODE_DESCRIPTIONS[mode] || MODE_DESCRIPTIONS.movement)}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
