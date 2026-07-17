import { mergedPacingForItem } from "../../utils/recordingQueueDerive";
import { DEMO_TICK_RATE, isRoundTimelineRoundClip, isTimelineSourceClip } from "../../utils/montageUtils";
import { getRecordingPlanPreview } from "../../utils/recordingPlanPreview";
import RecordingPlanPreview from "./RecordingPlanPreview";
import { useT } from "../../i18n/useT.js";

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
 * @param {{ clipData: Record<string, unknown>, t: Function }} props
 */
function KillTickMarksOverlay({ clipData, t }) {
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
            title={t("queue.timelineKillTickTitle", { tick: kt })}
            className="absolute bottom-0 top-0 w-px -translate-x-1/2 bg-cs2-text-primary shadow-[0_0_5px_rgba(255,255,255,0.45)]"
            style={{ left: `${p}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * 下饭 / 死亡合集：在与主条同一时间轴上叠加热力刻度（不单独占一行）。
 * @param {{ clipData: Record<string, unknown>, t: Function }} props
 */
function DeathTickOverlay({ clipData, t }) {
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
      titleKey: "queue.timelineDeathTitle",
    });
  }
  for (const kt of killTicks) {
    if (deathTick != null && kt === deathTick) continue;
    marks.push({ tick: kt, cls: "bg-cs2-accent", titleKey: "queue.timelineKillTitle" });
  }
  if (!marks.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
      {marks.map((m, i) => {
        const p = Math.min(100, Math.max(0, ((m.tick - start) / span) * 100));
        return (
          <span
            key={`${m.tick}-${i}`}
            title={`${t(m.titleKey)} tick ${m.tick}`}
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
  const t = useT();

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
    ["rival_kills", "all_kills", "weapon_kills"].includes(kind) &&
    Array.isArray(src) &&
    src.length > 0;

  const vic = Boolean(pacingOverride?.victim_pov);
  const killer = Boolean(pacingOverride?.killer_pov);
  const planPreview = getRecordingPlanPreview(item, globalPacing);
  const extraParts = [];
  if (!planPreview) {
    if (vic) extraParts.push(t("queue.timelineVictimPov"));
    if (killer) extraParts.push(t("queue.timelineKillerPov"));
  }

  if (isGroupedCompilation) {
    const built = buildGroupedBlocks(src, pre, post);
    if (built) {
      const { blocks, segmentCount } = built;
      return (
        <div className="mt-1.5 space-y-1">
          <div className="relative flex h-5 w-full overflow-hidden rounded-[3px] border border-cs2-border bg-cs2-bg-input/70">
            {blocks.map((b) => (
              <div
                key={b.key}
                className={barClass(b.type)}
                style={{ width: `${b.pct}%` }}
                title={
                  b.type === "pre"
                    ? t("queue.timelinePreTitle", { s: pre.toFixed(1) })
                    : b.type === "post"
                      ? t("queue.timelinePostTitle", { s: post.toFixed(1) })
                      : t("queue.timelineCoreTitleGrouped")
                }
              />
            ))}
            <DeathTickOverlay clipData={clipData} t={t} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-cs2-text-muted">
            <span className="text-cs2-text-muted">
              {t("queue.timelineSegmentSummary", { n: segmentCount, pre: pre.toFixed(1), post: post.toFixed(1) })}
            </span>
            {extraParts.map((part) => (
              <span key={part} className="text-cs2-text-muted">
                · {part}
              </span>
            ))}
            {planPreview ? (
              <span className="w-full">
                <RecordingPlanPreview
                  item={item}
                  globalPacing={globalPacing}
                  compact
                />
              </span>
            ) : null}
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

  const highlightDots =
    !timelineSrc && killCount >= 1
      ? Array.from({ length: Math.min(killCount, 8) }, (_, i) => {
          const leftPct =
            killCount === 1 ? 50 : 16 + (i / Math.max(1, killCount - 1)) * 68;
          return (
            <span
              key={i}
              className="absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-cs2-text-primary shadow-[0_0_6px_rgba(225,116,57,0.9)]"
              style={{ left: `${leftPct}%` }}
            />
          );
        })
      : null;

  return (
    <div className="mt-1.5 space-y-1">
      <div className="relative flex h-5 w-full overflow-hidden rounded-[3px] border border-cs2-border bg-cs2-bg-input/70">
        <div
          className="h-full min-w-0 bg-gradient-to-b from-zinc-600/90 to-zinc-700/90"
          style={{ flex: `${pre} 1 0%` }}
          title={t("queue.timelinePreTitle", { s: pre.toFixed(1) })}
        />
        <div
          className="relative h-full min-w-0 bg-gradient-to-b from-cs2-orange/85 to-orange-700/90"
          style={{ flex: `${core} 1 0%` }}
          title={t("queue.timelineCoreTitleSingle")}
        >
          {highlightDots}
        </div>
        <div
          className="h-full min-w-0 bg-gradient-to-b from-zinc-600/85 to-zinc-800/90"
          style={{ flex: `${post} 1 0%` }}
          title={t("queue.timelinePostTitle", { s: post.toFixed(1) })}
        />
        <KillTickMarksOverlay clipData={clipData} t={t} />
        <DeathTickOverlay clipData={clipData} t={t} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-cs2-text-muted">
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-zinc-600" /> {t("queue.timelineLegendPre", { s: pre.toFixed(1) })}
        </span>
        <span className="text-cs2-text-muted">·</span>
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-cs2-accent/90" /> {t("queue.timelineLegendClip", { s: core.toFixed(0) })}
        </span>
        <span className="text-cs2-text-muted">·</span>
        <span className="inline-flex items-center gap-0.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-zinc-600" /> {t("queue.timelineLegendPost", { s: post.toFixed(1) })}
        </span>
        {extraParts.map((part) => (
          <span key={part} className="text-cs2-text-muted">
            · {part}
          </span>
        ))}
        {planPreview ? (
          <span className="w-full">
            <RecordingPlanPreview item={item} globalPacing={globalPacing} compact />
          </span>
        ) : null}
      </div>
    </div>
  );
}
