import { useEffect, useMemo, useState } from "react";
import {
  Crosshair,
  Flame,
  Footprints,
  Layers3,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { getDemoRadarMapUrl } from "../../api/api";
import useSessionState from "../../hooks/useSessionState";
import {
  createReplayCacheKey,
  requestReplayFrames,
  useReplayStore,
} from "../../stores/replayStore";
import { buildReplayHeatmapSet } from "../../utils/replayHeatmap";
import { resolveReplayTransform } from "../../utils/replayRadarTransform";
import ReplayHeatmapCanvas from "./ReplayHeatmapCanvas";

const HEATMAP_FPS = 32;
const REQUEST_CONCURRENCY = 4;
const MAX_HEATMAP_CACHE_ENTRIES = 6;
const heatmapCache = new Map();

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
  const workspacePlayers = workspace?.players?.length ? workspace.players : players;
  const sessionIdentity = encodeURIComponent(String(demoPath || workspace?.demo_fingerprint || mapName));
  const [mode, setMode] = useSessionState(`demo-heatmap:${sessionIdentity}:mode`, "movement");
  const [mapLayer, setMapLayer] = useSessionState(`demo-heatmap:${sessionIdentity}:layer`, "upper");
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
    demoPath,
    workspace?.demo_fingerprint || "",
    mapName,
    `f${HEATMAP_FPS}`,
    ...jobs.map((job) => `${job.requestBody.start_tick}-${job.requestBody.end_tick}`),
  ].join("|"), [demoPath, jobs, mapName, workspace?.demo_fingerprint]);

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
  }, [demoPath, heatmapCacheKey, jobs, mapName, reloadEpoch, workspace?.map_transform]);

  const hasMapLayers = Boolean(loadState.data?.lower);
  useEffect(() => {
    if (!hasMapLayers) setMapLayer("upper");
  }, [hasMapLayers]);
  const activeLayer = loadState.data?.[mapLayer] || loadState.data?.upper || null;
  const activeHeatmap = activeLayer?.[mode] || null;
  const movementSamples = activeLayer?.movement?.sampleCount || 0;
  const combatEvents = activeLayer?.combat?.eventCount || 0;

  return (
    <section className="overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cs2-border px-4 py-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-cs2-accent">Whole-match spatial analysis</p>
          <h2 className="mt-0.5 text-[14px] font-black text-cs2-text-primary">整场热力图</h2>
          <p className="mt-1 text-[9px] text-cs2-text-muted">32Hz 原始轨迹按 4Hz 空间采样，投影到 48×48 双线性节点并平滑为连续场。</p>
        </div>
        <div role="group" aria-label="热力图类型" className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-0.5">
          {[
            { key: "movement", label: "走位密度", icon: Footprints },
            { key: "combat", label: "交战热点", icon: Crosshair },
          ].map(({ key, label, icon: Icon }) => (
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
      </header>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="relative mx-auto aspect-square w-full max-w-[860px] overflow-hidden rounded-xl border border-white/10 bg-[#04080a] shadow-inner">
          <img
            src={getDemoRadarMapUrl(mapName, hasMapLayers ? mapLayer : "")}
            alt={`${mapName} ${mode === "combat" ? "交战" : "走位"}热力图`}
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
        </div>

        <aside className="space-y-3">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            <StatCard label="正式回合" value={loadState.data?.roundCount || jobs.length || "—"} detail="全场累计，不随当前回合变化" />
            <StatCard label="轨迹采样点" value={movementSamples.toLocaleString("en-US")} detail="存活选手坐标，约 4Hz" />
            <StatCard label="有效交战" value={combatEvents.toLocaleString("en-US")} detail="击杀双方与交战走廊" />
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
              {mode === "movement"
                ? "显示双方全场存活时的空间占用密度，适合观察默认站位、转点路线和控制区域。"
                : "受害者位置权重最高，同时计入击杀者和交火连线，用于识别真正的交战核心区。"}
            </p>
          </div>
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-3 text-[8px] leading-relaxed text-cs2-text-muted">
            播放期间不会重复计算：整场数据只在进入本页时汇总一次，渲染结果是静态像素层。
          </div>
        </aside>
      </div>
    </section>
  );
}
