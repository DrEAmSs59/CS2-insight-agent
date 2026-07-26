import { useEffect, useMemo, useState } from "react";
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
import { getDemoRadarMapUrl } from "../../api/api";
import useSessionState from "../../hooks/useSessionState";
import {
  createReplayCacheKey,
  requestReplayFrames,
  useReplayStore,
} from "../../stores/replayStore";
import {
  buildReplayHeatmapSet,
  replayHeatmapPlayerKey,
} from "../../utils/replayHeatmap";
import { resolveReplayTransform } from "../../utils/replayRadarTransform";
import ReplayHeatmapCanvas from "./ReplayHeatmapCanvas";

const HEATMAP_FPS = 32;
const REQUEST_CONCURRENCY = 4;
const MAX_HEATMAP_CACHE_ENTRIES = 6;
const heatmapCache = new Map();
const HEATMAP_MODES = [
  { key: "movement", label: "走位密度", mapLabel: "走位", icon: Footprints },
  { key: "combat", label: "交战热点", mapLabel: "交战", icon: Swords },
  { key: "kills", label: "击杀热点", mapLabel: "击杀", icon: Crosshair },
  { key: "deaths", label: "死亡热点", mapLabel: "死亡", icon: Skull },
];
const HEATMAP_SIDES = [
  { key: "all", label: "全部" },
  { key: "CT", label: "CT" },
  { key: "T", label: "T" },
];

const MODE_DESCRIPTIONS = {
  movement: "显示所选玩家全场存活时的空间占用密度，适合观察默认站位、转点路线和控制区域。",
  combat: "显示所选玩家参与交战时的双方位置与交火连线，其中受害者位置权重更高。",
  kills: "显示所选玩家完成击杀时自身所在的位置，用于识别最常创造击杀的枪位与区域。",
  deaths: "显示所选玩家被击杀时所在的位置，用于识别高风险站位、路线和反复失守区域。",
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
  return String(player?.name || player?.player_name || "").trim();
}

function playerTeamKey(player, index, total) {
  if (player?.team_key === "a" || player?.team_key === "b") return player.team_key;
  const teamNumber = Number(player?.team ?? player?.team_number);
  if (teamNumber === 2) return "a";
  if (teamNumber === 3) return "b";
  return index < Math.ceil(total / 2) ? "a" : "b";
}

function teamDot(teamKey) {
  return teamKey === "a" ? "bg-violet-400" : "bg-emerald-400";
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
      <p className="text-[8px] font-bold uppercase tracking-[0.16em] text-cs2-text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl font-black text-cs2-text-primary">{value}</p>
      <p className="mt-0.5 text-[8px] text-cs2-text-muted">{detail}</p>
    </div>
  );
}

export default function DemoHeatmapView({ workspace, demoPath, players = [] }) {
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
      name: playerName(player),
      team_key: playerTeamKey(player, index, workspacePlayers.length),
    }))
    .filter((player) => player.name), [workspacePlayers]);
  const playerTeamKeys = useMemo(() => Object.fromEntries(playerOptions.map((player) => [
    replayHeatmapPlayerKey(player.name),
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
  const [selectedPlayer, setSelectedPlayer] = useSessionState(
    `demo-heatmap:${sessionIdentity}:player`,
    playerOptions[0]?.name || "",
  );
  const [reloadEpoch, setReloadEpoch] = useState(0);
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
    if (!playerOptions.some((player) => player.name === selectedPlayer)) {
      setSelectedPlayer(playerOptions[0]?.name || "");
    }
  }, [playerOptions, selectedPlayer, setSelectedPlayer]);

  useEffect(() => {
    let cancelled = false;
    if (!demoPath) {
      setLoadState((current) => ({ ...current, status: "error", error: "当前 Demo 缺少本地路径。" }));
      return undefined;
    }
    if (!jobs.length) {
      setLoadState((current) => ({ ...current, status: "error", error: "当前 Demo 没有可用于热力图的正式回合。" }));
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
      if (!transform) throw new Error("当前地图缺少坐标变换元数据，无法对齐热力图。");
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
        error: reason?.response?.data?.detail || reason?.message || "整场热力图生成失败",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [demoPath, heatmapCacheKey, jobs, mapName, playerTeamKeys, reloadEpoch, workspace?.map_transform]);

  const hasMapLayers = Boolean(loadState.data?.lower);
  useEffect(() => {
    if (!hasMapLayers) setMapLayer("upper");
  }, [hasMapLayers]);
  const selectedPlayerData = loadState.data?.players?.[replayHeatmapPlayerKey(selectedPlayer)] || null;
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
  const selectedPlayerOption = playerOptions.find((player) => player.name === selectedPlayer) || null;
  const activeRoundCount = selectedSide === "all"
    ? loadState.data?.roundCount || jobs.length || 0
    : rounds.filter((round) => {
      const roundSide = selectedPlayerOption?.team_key === "a" ? round?.team_a_side : round?.team_b_side;
      return String(roundSide || "").toUpperCase() === selectedSide;
    }).length;

  return (
    <section className="overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cs2-border px-4 py-3">
        <div>
          <h2 className="mt-0.5 text-[14px] font-black text-cs2-text-primary">整场热力图</h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div role="group" aria-label="热力图阵营" className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-0.5">
            {HEATMAP_SIDES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                aria-pressed={selectedSide === key}
                onClick={() => setSelectedSide(key)}
                className={`rounded-md px-2.5 py-1.5 text-[9px] font-black transition-colors ${
                  selectedSide === key
                    ? key === "CT"
                      ? "bg-sky-400 text-sky-950"
                      : key === "T"
                        ? "bg-amber-300 text-amber-950"
                        : "bg-cs2-accent text-cs2-text-on-accent"
                    : "text-cs2-text-muted hover:text-cs2-text-primary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="热力图类型" className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-0.5">
            {HEATMAP_MODES.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => setMode(key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[9px] font-bold transition-colors ${
                  mode === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-primary"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="grid gap-4 p-4 xl:grid-cols-[240px_minmax(0,1fr)_240px]">
        <aside className="overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-input/20">
          <div className="border-b border-cs2-border px-4 py-3">
            <h3 className="text-[11px] font-black text-cs2-text-primary">全部玩家</h3>
            <p className="mt-0.5 font-mono text-[8px] text-cs2-text-muted">{playerOptions.length} / {playerOptions.length} 已分析</p>
          </div>
          <div role="group" aria-label="热力图玩家列表" className="divide-y divide-cs2-border">
            {playerOptions.map((player) => {
              const active = player.name === selectedPlayer;
              const playerTeamName = String(
                player.team_name
                || (player.team_key === "a" ? workspace?.team_a_name : workspace?.team_b_name)
                || (player.team_key === "a" ? "A 队" : "B 队"),
              ).trim();
              return (
                <button
                  key={`${player.name}-${player.steam_id64 || player.steam_id || ""}`}
                  type="button"
                  aria-label={`查看 ${player.name} 的热力图`}
                  aria-pressed={active}
                  onClick={() => setSelectedPlayer(player.name)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${active ? "bg-cs2-accent-soft" : "hover:bg-cs2-bg-hover"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[11px] font-bold ${active ? "text-cs2-accent" : "text-cs2-text-primary"}`}>{player.name}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[8px] text-cs2-text-muted">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${teamDot(player.team_key)}`} />
                      <span className="max-w-[78px] truncate font-semibold" title={playerTeamName}>{playerTeamName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 font-mono">
                        {Number(player.kills || 0)}–{Number(player.deaths || 0)} · {Number(player.adr || 0).toFixed(1)} ADR
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="relative mx-auto aspect-square w-full max-w-[860px] overflow-hidden rounded-xl border border-white/10 bg-[#04080a] shadow-inner">
          <img
            src={getDemoRadarMapUrl(mapName, hasMapLayers ? mapLayer : "")}
            alt={`${mapName} ${selectedSide === "all" ? "" : `${selectedSide} `}${activeMode.mapLabel}热力图`}
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain opacity-[0.72]"
          />
          {activeHeatmap && <ReplayHeatmapCanvas heatmap={activeHeatmap} mode={mode} />}
          {hasMapLayers && (
            <div role="group" aria-label="热力图地图楼层" className="absolute left-3 top-3 z-10 flex rounded-md border border-white/15 bg-black/75 p-0.5 backdrop-blur-sm">
              {[
                ["upper", "上层"],
                ["lower", "下层"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={mapLayer === key}
                  onClick={() => setMapLayer(key)}
                  className={`rounded px-2.5 py-1 text-[8px] font-bold ${
                    mapLayer === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-white/55"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {loadState.status === "loading" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/65 text-center backdrop-blur-[2px]">
              <Loader2 className="h-7 w-7 animate-spin text-cs2-accent" />
              <div>
                <p className="text-[11px] font-bold text-white">正在汇总整场二进制轨迹</p>
                <p className="mt-1 font-mono text-[9px] text-white/60">{loadState.completed}/{loadState.total} 回合</p>
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
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-1.5 text-[9px] font-bold text-white"
                >
                  <RefreshCw className="h-3 w-3" />
                  重试
                </button>
              </div>
            </div>
          )}
          {loadState.status === "ready" && activeEventCount === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20 p-8 text-center">
              <p className="rounded-md border border-white/10 bg-black/65 px-4 py-2 text-[10px] font-semibold text-white/70">
                {selectedPlayer || "所选玩家"}{selectedSide === "all" ? "" : `在 ${selectedSide} 方`}暂无{activeMode.label}数据
              </p>
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
            <p className="text-[8px] font-bold uppercase tracking-[0.16em] text-cs2-text-muted">当前玩家</p>
            <div className="mt-1 flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[13px] font-black text-cs2-accent">{selectedPlayer || "未选择"}</p>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-black ${
                selectedSide === "CT"
                  ? "bg-sky-400/15 text-sky-400"
                  : selectedSide === "T"
                    ? "bg-amber-300/15 text-amber-300"
                    : "bg-cs2-accent-soft text-cs2-accent"
              }`}>{selectedSide === "all" ? "全部阵营" : selectedSide}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            <StatCard
              label="统计回合"
              value={activeRoundCount}
              detail={selectedSide === "all" ? "包含该玩家的全部比赛回合" : `该玩家担任 ${selectedSide} 时的回合`}
            />
            <StatCard label="参与交战" value={combatEvents.toLocaleString("en-US")} detail="作为击杀者或受害者" />
            <StatCard label="击杀 / 死亡" value={`${killEvents} / ${deathEvents}`} detail="按当前地图楼层统计" />
          </div>
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-3">
            <div className="flex items-center gap-2">
              <Layers3 className="h-3.5 w-3.5 text-cs2-accent" />
              <h3 className="text-[10px] font-bold text-cs2-text-primary">密度图例</h3>
            </div>
            <div className="mt-3 h-2.5 rounded-full bg-gradient-to-r from-transparent via-cyan-400 via-45% to-rose-600" />
            <div className="mt-1 flex justify-between text-[8px] font-semibold text-cs2-text-muted">
              <span>较少</span>
              <span>频繁</span>
            </div>
            <p className="mt-3 text-[9px] leading-relaxed text-cs2-text-muted">
              {MODE_DESCRIPTIONS[mode] || MODE_DESCRIPTIONS.movement}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
