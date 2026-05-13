import { mergedPacingForItem } from "../../utils/recordingQueueDerive";
import { DEMO_TICK_RATE, isRoundTimelineRoundClip, isTimelineSourceClip } from "../../utils/montageUtils";

function clipDataUsesDeathTickOverlay(clipData) {
  const cat = clipData?.category;
  const kind = String(clipData?.compilation_kind || "");
  return (
    cat === "fail" ||
    (cat === "compilation" && ["nemesis_deaths", "all_deaths"].includes(kind))
  );
}

/**
 * 按 start/end_tick 映射击杀刻度（高光、时间线击杀等；与下饭死亡条互斥）。
 * @param {{ clipData: Record<string, unknown> }} props
 */
function KillTickMarksOverlay({ clipData }) {
  if (!isTimelineSourceClip(clipData)) return null;
  if (clipDataUsesDeathTickOverlay(clipData)) return null;
  const start = Number(clipData?.start_tick);
  const end = Number(clipData?.end_tick);
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return null;
  const killTicks = Array.isArray(clipData?.kill_ticks)
    ? [...new Set(clipData.kill_ticks.map((x) => Number(x)).filter(Number.isFinite))].sort((a, b) => a - b)
    : [];
  if (!killTicks.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[2]" aria-hidden>
      {killTicks.map((kt, i) => {
        const p = Math.min(100, Math.max(0, ((kt - start) / span) * 100));
        return (
          <span
            key={`k-${kt}-${i}`}
            title={`击杀 tick ${kt}`}
            className="absolute bottom-0 top-0 w-px -translate-x-1/2 bg-white/80 shadow-[0_0_5px_rgba(255,255,255,0.45)]"
            style={{ left: `${p}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * 下饭 / 死亡合集：在与主条同一时间轴上叠加热力刻度（不单独占一行）。
 * @param {{ clipData: Record<string, unknown> }} props
 */
function DeathTickOverlay({ clipData }) {
  const show = clipDataUsesDeathTickOverlay(clipData);
  if (!show) return null;

  const start = Number(clipData?.start_tick);
  const end = Number(clipData?.end_tick);
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return null;

  const deathTick = clipData?.death_tick != null ? Number(clipData.death_tick) : null;
  const killTicks = Array.isArray(clipData.kill_ticks)
    ? [...new Set(clipData.kill_ticks.map((x) => Number(x)).filter(Number.isFinite))].sort(
        (a, b) => a - b
      )
    : [];

  const marks = [];
  if (deathTick != null && Number.isFinite(deathTick)) {
    marks.push({
      tick: deathTick,
      cls: "bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.9)]",
      title: "死亡",
    });
  }
  for (const kt of killTicks) {
    if (deathTick != null && kt === deathTick) continue;
    marks.push({ tick: kt, cls: "bg-cs2-orange", title: "击杀" });
  }
  if (!marks.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
      {marks.map((m, i) => {
        const p = Math.min(100, Math.max(0, ((m.tick - start) / span) * 100));
        return (
          <span
            key={`${m.tick}-${i}`}
            title={`${m.title} tick ${m.tick}`}
            className={`absolute bottom-0 top-0 w-[3px] -translate-x-1/2 rounded-sm ${m.cls}`}
            style={{ left: `${p}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * @param {[[number, number], ...]} sourceTicks
 * @param {number} preSec
 * @param {number} postSec
 */
function buildGroupedBlocks(sourceTicks, preSec, postSec) {
  const cores = [];
  for (const p of sourceTicks) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const ss = Number(p[0]);
    const ee = Number(p[1]);
    if (Number.isFinite(ss) && Number.isFinite(ee) && ee > ss) {
      cores.push((ee - ss) / DEMO_TICK_RATE);
    }
  }
  if (!cores.length) return null;

  let totalSec = 0;
  for (const c of cores) {
    totalSec += preSec + c + postSec;
  }

  const blocks = [];
  let idx = 0;
  for (const coreSec of cores) {
    blocks.push({
      key: `pre-${idx}`,
      type: "pre",
      pct: (preSec / totalSec) * 100,
    });
    blocks.push({
      key: `core-${idx}`,
      type: "core",
      pct: (coreSec / totalSec) * 100,
    });
    blocks.push({
      key: `post-${idx}`,
      type: "post",
      pct: (postSec / totalSec) * 100,
    });
    idx += 1;
  }
  return { blocks, segmentCount: cores.length };
}

function barClass(type) {
  if (type === "pre" || type === "post") {
    return "h-full bg-gradient-to-b from-zinc-600/90 to-zinc-800/90";
  }
  return "relative h-full bg-gradient-to-b from-cs2-orange/85 to-orange-700/90";
}

/**
 * @param {{
 *   clipData: Record<string, unknown>,
 *   pacingOverride: Record<string, unknown> | undefined,
 *   globalPacing: Record<string, unknown>,
 * }} props
 */
export default function QueueMiniTimeline({ clipData, pacingOverride, globalPacing }) {
  if (isRoundTimelineRoundClip(clipData)) {
    return null;
  }

  const item = { pacing_override: pacingOverride, clipData };
  const { pre_first_sec, post_last_sec } = mergedPacingForItem(item, globalPacing);
  const pre = Math.max(0.5, pre_first_sec);
  const post = Math.max(0.5, post_last_sec);

  const kind = String(clipData?.compilation_kind || "");
  const src = clipData?.source_ticks;
  const isGroupedCompilation =
    clipData?.category === "compilation" &&
    (kind === "rival_kills" || kind === "all_kills") &&
    Array.isArray(src) &&
    src.length > 0;

  const vic = Boolean(pacingOverride?.victim_pov);
  const killer = Boolean(pacingOverride?.killer_pov);
  const extraParts = [];
  if (vic) extraParts.push("含受害者回看段落");
  if (killer) extraParts.push("含击杀者回看段落");

  if (isGroupedCompilation) {
    const built = buildGroupedBlocks(src, pre, post);
    if (built) {
      const { blocks, segmentCount } = built;
      return (
        <div className="mt-1.5 space-y-1">
          <div className="relative flex h-5 w-full overflow-hidden rounded-[3px] border border-white/[0.08] bg-black/40">
            {blocks.map((b) => (
              <div
                key={b.key}
                className={barClass(b.type)}
                style={{ width: `${b.pct}%` }}
                title={
                  b.type === "pre"
                    ? `击杀前预留 ${pre.toFixed(1)}s`
                    : b.type === "post"
                      ? `击杀后预留 ${post.toFixed(1)}s`
                      : "击杀窗口（tick 跨度）"
                }
              />
            ))}
            <DeathTickOverlay clipData={clipData} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-zinc-600">
            <span className="text-zinc-500">
              ×{segmentCount} 段（每段：击杀前 {pre.toFixed(1)}s · 击杀窗口 · 击杀后 {post.toFixed(1)}s）
            </span>
            {extraParts.map((t) => (
              <span key={t} className="text-zinc-500">
                · {t}
              </span>
            ))}
          </div>
        </div>
      );
    }
  }

  const killCount = Number(clipData?.kill_count) || 0;
  const timelineSrc = isTimelineSourceClip(clipData);
  const coreHint =
    typeof clipData?.duration_sec === "number" && Number.isFinite(clipData.duration_sec)
      ? Math.max(4, clipData.duration_sec)
      : Math.max(6, killCount * 6 || 12);
  const core = Math.max(2, coreHint * 0.55);
  const sum = pre + core + post;
  const wp = (x) => `${Math.max(6, (x / sum) * 100)}%`;

  const highlightDots =
    !timelineSrc && killCount >= 1
      ? Array.from({ length: Math.min(killCount, 8) }, (_, i) => {
          const leftPct =
            killCount === 1 ? 50 : 16 + (i / Math.max(1, killCount - 1)) * 68;
          return (
            <span
              key={i}
              className="absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-white/85 shadow-[0_0_6px_rgba(225,116,57,0.9)]"
              style={{ left: `${leftPct}%` }}
            />
          );
        })
      : null;

  return (
    <div className="mt-1.5 space-y-1">
      <div className="relative flex h-5 w-full overflow-hidden rounded-[3px] border border-white/[0.08] bg-black/40">
        <div
          className="h-full bg-gradient-to-b from-zinc-600/90 to-zinc-700/90"
          style={{ width: wp(pre) }}
          title={`击杀前预留 ${pre.toFixed(1)}s`}
        />
        <div
          className="relative h-full bg-gradient-to-b from-cs2-orange/85 to-orange-700/90"
          style={{ width: wp(core) }}
          title="击杀片段主体"
        >
          {highlightDots}
        </div>
        <div
          className="h-full bg-gradient-to-b from-zinc-600/85 to-zinc-800/90"
          style={{ width: wp(post) }}
          title={`击杀后预留 ${post.toFixed(1)}s`}
        />
        <KillTickMarksOverlay clipData={clipData} />
        <DeathTickOverlay clipData={clipData} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-zinc-600">
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-zinc-600" /> 击杀前 {pre.toFixed(1)}s
        </span>
        <span className="text-zinc-700">·</span>
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-cs2-orange/90" /> 片段 ~{core.toFixed(0)}s
        </span>
        <span className="text-zinc-700">·</span>
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-zinc-600" /> 击杀后 {post.toFixed(1)}s
        </span>
        {extraParts.map((t) => (
          <span key={t} className="text-zinc-500">
            · {t}
          </span>
        ))}
      </div>
    </div>
  );
}
