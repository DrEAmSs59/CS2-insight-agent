import { useMemo, useState } from "react";
import {
  Package,
  Trash2,
  Rocket,
  Settings,
  RotateCcw,
  Eye,
  EyeOff,
  OctagonX,
} from "lucide-react";
import { useRecordingQueue, BACKEND_DEFAULT_PACING } from "../stores/recordingQueueStore";
import {
  formatClipCombatSummaryLine,
  isTimelineSourceClip,
  getMontageBlockShortLabel,
  isRoundTimelineRoundClip,
  isClipPacingAndPovLocked,
  queueBlockBadgeClass,
} from "../utils/montageUtils";
import {
  freezeToDeathQueueRoundBadgeText,
  isFreezeToDeathCompilation,
} from "../utils/freezeToDeathRoundFilter";
import { estimateItemRecordSeconds } from "../utils/recordingQueueDerive";
import { timelineQueueMetaOneLiner } from "../utils/timelineQueue";
import { AiScoreBadge } from "./ClipCard";
import QueueMiniTimeline from "./recordingQueue/QueueMiniTimeline";

// 与后端 build_smart_jump_segments 保持一致
const DEFAULT_PACING = BACKEND_DEFAULT_PACING;

export function killBadgeColorClass(clip) {
  return queueBlockBadgeClass(clip);
}

function pickVictimsPreview(clip) {
  const victims = Array.isArray(clip?.victims) ? clip.victims : [];
  return victims
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
}

function groupByDemo(queue) {
  const map = new Map();
  for (const item of queue) {
    const key = item.demoFilename || item.demoPath || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries());
}

/** 单参数滑块：标签一行，滑块 + 可编辑数值一行（无数值重复） */
function PacingSliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  accent = "accent-cs2-orange",
  valueTextClass = "text-cs2-orange",
  onChange,
}) {
  const clamp = (n) => Math.min(max, Math.max(min, n));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
          className={`min-w-0 flex-1 ${accent}`}
        />
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(clamp(n));
          }}
          className={`w-14 shrink-0 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-right font-mono text-[11px] font-semibold ${valueTextClass}`}
        />
      </div>
      {hint ? (
        <p className="text-[9px] font-normal leading-snug text-zinc-600">{hint}</p>
      ) : null}
    </div>
  );
}

export function PacingMicroPanel({ item, updateItemPacing }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const gp = globalPacing || {};
  const po = item.pacing_override || {};
  const gNum = (key) => {
    const v = gp[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const pre = po.pre_first_sec ?? gNum("pre_first_sec") ?? DEFAULT_PACING.pre_first_sec;
  const post = po.post_last_sec ?? gNum("post_last_sec") ?? DEFAULT_PACING.post_last_sec;
  const gap = po.max_gap_sec ?? gNum("max_gap_sec") ?? DEFAULT_PACING.max_gap_sec;

  const commit = (partial) => {
    const next = { ...partial };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (typeof v !== "number" || !Number.isFinite(v)) delete next[k];
    }
    if (Object.keys(next).length) updateItemPacing(item.id, next);
  };

  return (
    <div className="space-y-3 rounded border border-white/[0.06] bg-black/30 p-2">
      <div className="border-b border-white/[0.06] pb-2">
        <p className="mb-2 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
          <Settings className="h-3 w-3" /> 基础参数
        </p>
        <div className="space-y-3">
          <PacingSliderRow
            label="击杀前预留 (秒)"
            value={pre}
            min={0}
            max={20}
            step={0.1}
            onChange={(n) => commit({ pre_first_sec: n })}
          />
          <PacingSliderRow
            label="击杀后预留 (秒)"
            value={post}
            min={0}
            max={10}
            step={0.1}
            onChange={(n) => commit({ post_last_sec: n })}
          />
          <PacingSliderRow
            label="防跳剪阈值 (秒)"
            value={gap}
            min={2}
            max={70}
            step={0.5}
            onChange={(n) => commit({ max_gap_sec: n })}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 追加 POV 段落开关面板，嵌入每个队列条目。
 * 高光片段 → 受害者视角；失误片段 → 击杀者视角。
 * 开关与独立时序参数均存入 item.pacing_override。
 */
export function PovSection({ item, updateItemPacing }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);

  if (isClipPacingAndPovLocked(item.clipData)) {
    const wholeRound = isRoundTimelineRoundClip(item.clipData);
    return (
      <p className="rounded border border-amber-500/15 bg-amber-950/15 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-500">
        {wholeRound ? (
          <>
            当前为<strong className="font-semibold text-zinc-300">整回合时间线</strong>
            （固定 tick 窗口），
            <span className="text-zinc-400">不支持剪辑节奏微调与追加受害者 / 击杀者回看视角</span>。
          </>
        ) : (
          <>
            当前为<strong className="font-semibold text-zinc-300">回合死亡合集</strong>（多回合勾选合辑），
            <span className="text-zinc-400">不支持剪辑节奏微调与追加回看视角</span>。
          </>
        )}
      </p>
    );
  }

  const gp = globalPacing || {};
  const po = item.pacing_override || {};
  const clipCategory = item.clipData?.category;
  const victimsList = item.clipData?.victims || [];
  const killersList = item.clipData?.killers || [];
  const killerName = item.clipData?.killer_name;

  const isHighlight = clipCategory === "highlight" && victimsList.length > 0;
  const isFail = clipCategory === "fail" && Boolean(killerName);
  const isCompilation = clipCategory === "compilation";
  const compilationKind = item.clipData?.compilation_kind;
  const isKillCompilation = isCompilation && ["rival_kills", "all_kills"].includes(compilationKind);
  const isDeathCompilation = isCompilation && ["nemesis_deaths", "all_deaths"].includes(compilationKind);
  const canVictimPov = (isHighlight || isKillCompilation) && victimsList.some((v) => String(v ?? "").trim());
  const canKillerPov = isFail || (isDeathCompilation && killersList.some((v) => String(v ?? "").trim()));

  if (!canVictimPov && !canKillerPov) return null;

  const gNum = (key) => {
    const v = gp[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };

  const povEnabled = Boolean(po.victim_pov);
  const killerPovEnabled = Boolean(po.killer_pov);
  const vicPre =
    po.victim_pov_pre_sec ?? gNum("victim_pov_pre_sec") ?? (isFail ? 3.0 : 1.5);
  const vicPost =
    po.victim_pov_post_sec ?? gNum("victim_pov_post_sec") ?? (isFail ? 1.5 : 1.0);
  const killPre = po.killer_pov_pre_sec ?? gNum("killer_pov_pre_sec") ?? vicPre;
  const killPost = po.killer_pov_post_sec ?? gNum("killer_pov_post_sec") ?? vicPost;

  const victimsPreview = pickVictimsPreview(item.clipData);
  const killersPreview = pickVictimsPreview({ victims: killersList });

  const commit = (partial) => updateItemPacing(item.id, partial);

  return (
    <div className="space-y-2">
      <div className="grid gap-1.5">
        {canVictimPov && (
          <button
            type="button"
            onClick={() => commit({ victim_pov: !povEnabled })}
            className={`flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
              povEnabled
                ? "border-cyan-500/40 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-950/60"
                : "border-white/10 bg-white/[0.04] text-zinc-400 hover:border-cyan-500/30 hover:text-cyan-400"
            }`}
          >
            {povEnabled ? <Eye className="h-3 w-3 shrink-0" /> : <EyeOff className="h-3 w-3 shrink-0" />}
            <span>追加受害者视角</span>
            {victimsPreview ? (
              <span
                className={`ml-1 truncate text-[9px] font-normal ${
                  povEnabled ? "text-cyan-200/70" : "text-zinc-500"
                }`}
                title={victimsPreview}
              >
                · {victimsPreview}
              </span>
            ) : null}
            {povEnabled && (
              <span className="ml-auto font-mono text-[9px] text-cyan-400/70">
                -{vicPre.toFixed(1)}s / +{vicPost.toFixed(1)}s
              </span>
            )}
          </button>
        )}
        {canKillerPov && (
          <button
            type="button"
            onClick={() => commit({ killer_pov: !killerPovEnabled })}
            className={`flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
              killerPovEnabled
                ? "border-amber-500/40 bg-amber-950/35 text-amber-300 hover:bg-amber-950/55"
                : "border-white/10 bg-white/[0.04] text-zinc-400 hover:border-amber-500/30 hover:text-amber-300"
            }`}
          >
            {killerPovEnabled ? <Eye className="h-3 w-3 shrink-0" /> : <EyeOff className="h-3 w-3 shrink-0" />}
            <span>追加击杀者视角</span>
            {killersPreview ? (
              <span
                className={`ml-1 truncate text-[9px] font-normal ${
                  killerPovEnabled ? "text-amber-200/70" : "text-zinc-500"
                }`}
                title={killersPreview}
              >
                · {killersPreview}
              </span>
            ) : null}
            {killerPovEnabled && (
              <span className="ml-auto font-mono text-[9px] text-amber-400/70">
                -{killPre.toFixed(1)}s / +{killPost.toFixed(1)}s
              </span>
            )}
          </button>
        )}
      </div>

      {povEnabled && canVictimPov && (
        <div className="space-y-2 rounded border border-cyan-500/10 bg-cyan-950/10 p-2">
          <PacingSliderRow
            label="击杀前预留 (秒) · 受害者视角"
            value={vicPre}
            min={0.5}
            max={5}
            step={0.5}
            accent="accent-cyan-500"
            valueTextClass="text-cyan-300"
            onChange={(n) => commit({ victim_pov_pre_sec: n })}
          />
          <PacingSliderRow
            label="死亡后停留 (秒) · 受害者视角"
            value={vicPost}
            min={0}
            max={5}
            step={0.5}
            accent="accent-cyan-500"
            valueTextClass="text-cyan-300"
            onChange={(n) => commit({ victim_pov_post_sec: n })}
          />
        </div>
      )}

      {killerPovEnabled && canKillerPov && (
        <div className="space-y-2 rounded border border-amber-500/15 bg-amber-950/10 p-2">
          <PacingSliderRow
            label="击杀前预留 (秒) · 击杀者视角"
            value={killPre}
            min={0.5}
            max={5}
            step={0.5}
            accent="accent-amber-500"
            valueTextClass="text-amber-300"
            onChange={(n) => commit({ killer_pov_pre_sec: n })}
          />
          <PacingSliderRow
            label="死亡后停留 (秒) · 击杀者视角"
            value={killPost}
            min={0}
            max={5}
            step={0.5}
            accent="accent-amber-500"
            valueTextClass="text-amber-300"
            onChange={(n) => commit({ killer_pov_post_sec: n })}
          />
        </div>
      )}
    </div>
  );
}

function countVictimPovEligibleHighlights(queue) {
  return queue.filter((q) => {
    const victims = Array.isArray(q.clipData?.victims) ? q.clipData.victims : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "highlight" ||
        (q.clipData?.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
      victims.some((v) => String(v ?? "").trim().length > 0)
    );
  }).length;
}

function countKillerPovEligible(queue) {
  return queue.filter((q) => {
    const killers = Array.isArray(q.clipData?.killers) ? q.clipData.killers : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "compilation" &&
        ["nemesis_deaths", "all_deaths"].includes(kind) &&
        killers.some((v) => String(v ?? "").trim().length > 0)) ||
      (q.clipData?.category === "fail" && String(q.clipData?.killer_name ?? "").trim().length > 0)
    );
  }).length;
}

/** 符合条件的高光是否已全部打开「受害者视角」 */
function allEligibleVictimPovEnabled(queue) {
  const eligible = queue.filter((q) => {
    const victims = Array.isArray(q.clipData?.victims) ? q.clipData.victims : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "highlight" ||
        (q.clipData?.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
      victims.some((v) => String(v ?? "").trim().length > 0)
    );
  });
  if (eligible.length === 0) return false;
  return eligible.every((q) => Boolean(q.pacing_override?.victim_pov));
}

function allEligibleKillerPovEnabled(queue) {
  const eligible = queue.filter((q) => {
    const killers = Array.isArray(q.clipData?.killers) ? q.clipData.killers : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "compilation" &&
        ["nemesis_deaths", "all_deaths"].includes(kind) &&
        killers.some((v) => String(v ?? "").trim().length > 0)) ||
      (q.clipData?.category === "fail" && String(q.clipData?.killer_name ?? "").trim().length > 0)
    );
  });
  if (eligible.length === 0) return false;
  return eligible.every((q) => Boolean(q.pacing_override?.killer_pov));
}

/** 全局节奏面板（始终展开常驻） */
export function GlobalPacingPanel({
  globalPacing,
  setGlobalPacing,
  resetGlobalPacing,
  queue,
  onToggleAllVictimPov,
  onToggleAllKillerPov,
  // eslint-disable-next-line no-unused-vars
  defaultExpanded = false,
}) {
  const post = globalPacing.post_last_sec ?? DEFAULT_PACING.post_last_sec;
  const pre  = globalPacing.pre_first_sec ?? DEFAULT_PACING.pre_first_sec;
  const gap  = globalPacing.max_gap_sec   ?? DEFAULT_PACING.max_gap_sec;
  const victimPovEligible = useMemo(() => countVictimPovEligibleHighlights(queue), [queue]);
  const allVictimPovOn = useMemo(() => allEligibleVictimPovEnabled(queue), [queue]);
  const killerPovEligible = useMemo(() => countKillerPovEligible(queue), [queue]);
  const allKillerPovOn = useMemo(() => allEligibleKillerPovEnabled(queue), [queue]);

  const commit = (partial) => {
    const next = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    );
    if (Object.keys(next).length) setGlobalPacing(next);
  };

  return (
    <div className="border-b border-white/[0.06] bg-black/20 px-3 py-2">
      <div className="mb-2 flex min-w-0 flex-nowrap items-baseline gap-x-2 overflow-x-auto">
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-zinc-200">
          <Settings className="h-3.5 w-3.5 text-zinc-500" />
          全局节奏设置
        </span>
        <span className="min-w-0 whitespace-nowrap text-[11px] text-zinc-500">
          （对所有片段生效，单独设置优先）
        </span>
      </div>

      <div className="space-y-3 rounded border border-white/[0.06] bg-black/30 p-2">
        <PacingSliderRow
          label="击杀前预留 (秒)"
          value={pre}
          min={0}
          max={20}
          step={0.1}
          onChange={(n) => commit({ pre_first_sec: n })}
        />
        <PacingSliderRow
          label="击杀后预留 (秒)"
          value={post}
          min={0}
          max={10}
          step={0.1}
          onChange={(n) => commit({ post_last_sec: n })}
        />
        <PacingSliderRow
          label="防跳剪阈值 (秒)"
          value={gap}
          min={2}
          max={70}
          step={0.5}
          onChange={(n) => commit({ max_gap_sec: n })}
        />
      </div>

      <div className="mt-2 rounded border border-white/[0.04] bg-black/20 p-2">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          批量视角设置
        </p>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <button
            type="button"
            disabled={victimPovEligible === 0}
            title={
              victimPovEligible === 0
                ? "队列中暂无适用片段"
                : allVictimPovOn
                  ? "关闭：取消所有符合条件的受害者回看"
                  : "打开：为所有符合条件的片段开启受害者回看"
            }
            onClick={onToggleAllVictimPov}
            className={
              "flex h-8 w-full min-w-0 flex-nowrap items-center justify-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10px] font-semibold leading-none transition-colors sm:gap-1.5 sm:px-2 sm:text-[11px] disabled:cursor-not-allowed disabled:opacity-40 " +
              (allVictimPovOn
                ? "border-zinc-500/40 bg-zinc-900/40 text-zinc-200 hover:border-zinc-400/55 hover:bg-zinc-900/60"
                : "border-cyan-500/35 bg-cyan-950/30 text-cyan-200 hover:border-cyan-400/60 hover:bg-cyan-950/50")
            }
          >
            {allVictimPovOn ? (
              <EyeOff className="h-3 w-3 shrink-0" />
            ) : (
              <Eye className="h-3 w-3 shrink-0" />
            )}
            <span className="shrink-0">{allVictimPovOn ? "关闭受害者视角" : "打开受害者视角"}</span>
            {victimPovEligible > 0 ? (
              <span
                className={
                  "shrink-0 font-mono tabular-nums text-[9px] " +
                  (allVictimPovOn ? "text-zinc-400/90" : "text-cyan-400/80")
                }
              >
                ({victimPovEligible})
              </span>
            ) : null}
          </button>
          <button
            type="button"
            disabled={killerPovEligible === 0}
            title={
              killerPovEligible === 0
                ? "队列中暂无适用片段"
                : allKillerPovOn
                  ? "关闭：取消所有符合条件的击杀者回看"
                  : "打开：为所有符合条件的片段开启击杀者回看"
            }
            onClick={onToggleAllKillerPov}
            className={
              "flex h-8 w-full min-w-0 flex-nowrap items-center justify-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10px] font-semibold leading-none transition-colors sm:gap-1.5 sm:px-2 sm:text-[11px] disabled:cursor-not-allowed disabled:opacity-40 " +
              (allKillerPovOn
                ? "border-zinc-500/40 bg-zinc-900/40 text-zinc-200 hover:border-zinc-400/55 hover:bg-zinc-900/60"
                : "border-amber-500/35 bg-amber-950/25 text-amber-200 hover:border-amber-400/60 hover:bg-amber-950/45")
            }
          >
            {allKillerPovOn ? (
              <EyeOff className="h-3 w-3 shrink-0" />
            ) : (
              <Eye className="h-3 w-3 shrink-0" />
            )}
            <span className="shrink-0">{allKillerPovOn ? "关闭击杀者视角" : "打开击杀者视角"}</span>
            {killerPovEligible > 0 ? (
              <span
                className={
                  "shrink-0 font-mono tabular-nums text-[9px] " +
                  (allKillerPovOn ? "text-zinc-400/90" : "text-amber-300/80")
                }
              >
                ({killerPovEligible})
              </span>
            ) : null}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={resetGlobalPacing}
        className="mt-2 flex items-center gap-1 text-[9px] text-zinc-600 hover:text-zinc-400"
      >
        <RotateCcw className="h-2.5 w-2.5" /> 恢复后端默认值
      </button>
    </div>
  );
}

/** 队列条目卡片（新版） */
function QueueItemCard({
  item,
  pacingExpanded,
  povExpanded,
  onTogglePacing,
  onTogglePov,
  onRemove,
  globalPacing,
  updateItemPacing,
}) {
  const cd = item.clipData || {};
  const tl = isTimelineSourceClip(cd);
  const hideQueueAi = tl || cd.category === "compilation";
  const killBadge = getMontageBlockShortLabel(cd);
  const playerName = String(item.targetPlayer || cd.player_name || "—").trim() || "—";
  const round = cd.round != null && Number.isFinite(Number(cd.round)) ? Number(cd.round) : null;
  const ftdRoundBadge = freezeToDeathQueueRoundBadgeText(item, cd);
  const own = cd.score_own != null ? Number(cd.score_own) : null;
  const opp = cd.score_opp != null ? Number(cd.score_opp) : null;
  const hasScorePair = own != null && opp != null && Number.isFinite(own) && Number.isFinite(opp);
  const mapName = String(cd.map_name || cd.map || "").trim();
  const aiScore = cd.ai_score;
  const queueSummary = String(cd.queue_summary_line || "").trim();
  const combatSummary = !tl ? formatClipCombatSummaryLine(cd) : "";
  const showLegacyTags =
    !queueSummary &&
    Array.isArray(cd.context_tags) &&
    cd.context_tags.length > 0 &&
    !tl;
  const victimsPreview = pickVictimsPreview(cd);

  return (
    <li
      className="flex flex-col px-3 py-2 text-[11px] text-zinc-300"
      title={item.clipId || undefined}
    >
      {/* 标题行：徽章 + 玩家名 + AI 分数 */}
      <div className="flex items-center gap-2">
        {killBadge ? (
          <span
            className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-bold ${killBadgeColorClass(cd)}`}
          >
            {killBadge}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">
          {playerName}
        </span>
        <div className="ml-auto shrink-0">
          {hideQueueAi ? null : <AiScoreBadge score={aiScore} />}
        </div>
      </div>

      {/* 比分 / 地图行 */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {isFreezeToDeathCompilation(cd) && ftdRoundBadge ? (
          <span className="rounded border border-white/[0.08] bg-black/30 px-1.5 py-px font-mono text-[10px] text-zinc-300">
            {ftdRoundBadge}
          </span>
        ) : round != null ? (
          <span className="rounded border border-white/[0.08] bg-black/30 px-1.5 py-px font-mono text-[10px] text-zinc-300">
            R{round}
          </span>
        ) : null}
        {hasScorePair ? (
          <>
            <span className="rounded bg-sky-500/15 px-1.5 py-px font-mono text-[10px] font-semibold text-sky-200">
              CT {own}
            </span>
            <span className="rounded bg-amber-500/15 px-1.5 py-px font-mono text-[10px] font-semibold text-amber-200">
              T {opp}
            </span>
          </>
        ) : null}
        {mapName ? (
          <span className="truncate text-[10px] text-zinc-500" title={mapName}>
            {mapName}
          </span>
        ) : null}
      </div>

      {/* 时序节奏迷你时间线（常驻） */}
      <QueueMiniTimeline
        clipData={cd}
        pacingOverride={item.pacing_override}
        globalPacing={globalPacing}
      />

      {/* 辅助信息 */}
      {queueSummary ? (
        <p className="mt-1 line-clamp-3 text-[10px] leading-snug text-cyan-100/85">
          {queueSummary}
        </p>
      ) : null}
      {!tl && combatSummary ? (
        <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-zinc-400" title={combatSummary}>
          {combatSummary}
        </p>
      ) : null}
      {!queueSummary && showLegacyTags ? (
        <p className="mt-0.5 truncate text-[10px] text-zinc-600">
          {cd.context_tags.join(" · ")}
        </p>
      ) : null}
      {tl ? (
        <p className="mt-0.5 font-mono text-[10px] leading-snug text-zinc-400">
          {timelineQueueMetaOneLiner(cd, estimateItemRecordSeconds(item, globalPacing))}
        </p>
      ) : null}
      {Array.isArray(item.freezeToDeathQueueRounds) &&
      item.freezeToDeathQueueRounds.length > 0 ? (
        <p className="mt-0.5 font-mono text-[10px] text-amber-400/85">
          回合合集含回合：{item.freezeToDeathQueueRounds.join("、")}
        </p>
      ) : null}

      {/* 可展开区：节奏微调 */}
      {pacingExpanded ? (
        isClipPacingAndPovLocked(cd) ? (
          <p className="mt-2 rounded border border-amber-500/20 bg-amber-950/20 px-2 py-1.5 text-[10px] text-amber-200/90">
            {isRoundTimelineRoundClip(cd)
              ? "整回合时间线为固定 tick 窗口，单条剪辑节奏与全局击杀前/击杀后预留不生效。"
              : "回合死亡合集为固定分段合辑，单条剪辑节奏与全局击杀前/击杀后预留不生效。"}
          </p>
        ) : (
          <div className="mt-2">
            <PacingMicroPanel item={item} updateItemPacing={updateItemPacing} />
          </div>
        )
      ) : null}

      {/* 可展开区：视角设置 */}
      {povExpanded ? (
        <div className="mt-2">
          <PovSection item={item} updateItemPacing={updateItemPacing} />
        </div>
      ) : null}

      {/* 操作栏 */}
      <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.06] pt-2">
        <button
          type="button"
          onClick={onTogglePacing}
          className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${
            pacingExpanded
              ? "border-cs2-orange/55 bg-cs2-orange/15 text-cs2-orange"
              : "border-cs2-orange/30 bg-cs2-orange/6 text-cs2-orange/90 hover:bg-cs2-orange/10"
          }`}
        >
          <Settings className="h-3 w-3" />
          节奏微调
        </button>
        <button
          type="button"
          onClick={onTogglePov}
          className={`flex min-w-0 items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${
            povExpanded
              ? "border-sky-500/55 bg-sky-500/15 text-sky-200"
              : "border-sky-500/30 bg-sky-500/5 text-sky-300/90 hover:bg-sky-500/10"
          }`}
        >
          <Eye className="h-3 w-3 shrink-0" />
          <span className="shrink-0">视角</span>
          {victimsPreview ? (
            <span
              className="ml-1 max-w-[8rem] truncate text-[9px] font-normal opacity-80"
              title={victimsPreview}
            >
              {victimsPreview}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="ml-auto flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[10px] font-semibold text-rose-300/90 transition-colors hover:bg-rose-500/15"
          aria-label="从队列移除"
        >
          <Trash2 className="h-3 w-3" />
          删除
        </button>
      </div>
    </li>
  );
}

/** 录制队列主面板（页面与旧版抽屉共用） */
export function RecordingQueuePanel({
  queue,
  onRemove,
  onClear,
  onStartBatch,
  batchRecording,
  onAbortBatch,
}) {
  const grouped = useMemo(() => groupByDemo(queue), [queue]);
  const [pacingExpandedId, setPacingExpandedId] = useState(null);
  const [povExpandedId, setPovExpandedId] = useState(null);
  const updateItemPacing  = useRecordingQueue((s) => s.updateItemPacing);
  const globalPacing      = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing   = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const toggleVictimPovForAllHighlightsInQueue = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPovForAllEligibleInQueue = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);

  return (
    <div className="flex h-full min-h-0 w-full max-w-3xl flex-col border border-white/10 bg-cs2-bg-sidebar shadow-xl lg:max-w-none lg:border-l lg:border-y-0 lg:border-r-0">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 id="queue-drawer-title" className="flex items-center gap-2 text-sm font-bold text-white">
            <Package className="h-4 w-4 text-cs2-orange" />
            待录制队列
            <span className="rounded bg-cs2-orange/20 px-2 py-0.5 font-mono text-xs text-cs2-orange">
              {queue.length}
            </span>
          </h2>
        </div>

        {/* 全局节奏设置 */}
        <GlobalPacingPanel
          globalPacing={globalPacing}
          setGlobalPacing={setGlobalPacing}
          resetGlobalPacing={resetGlobalPacing}
          queue={queue}
          onToggleAllVictimPov={toggleVictimPovForAllHighlightsInQueue}
          onToggleAllKillerPov={toggleKillerPovForAllEligibleInQueue}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {queue.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-zinc-500">
              暂无片段。在片段列表中勾选后点击「加入录制队列」。
            </p>
          ) : (
            <div className="space-y-4">
              {grouped.map(([demoKey, items]) => (
                <div
                  key={demoKey}
                  className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/25"
                >
                  <div className="border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
                    <p className="truncate font-mono text-[11px] font-semibold text-cs2-orange/90" title={demoKey}>
                      {demoKey}
                    </p>
                    <p className="text-[10px] text-zinc-500">{items.length} 个片段</p>
                  </div>
                  <ul className="divide-y divide-white/[0.04]">
                    {items.map((it) => (
                      <QueueItemCard
                        key={it.id}
                        item={it}
                        pacingExpanded={pacingExpandedId === it.id}
                        povExpanded={povExpandedId === it.id}
                        onTogglePacing={() =>
                          setPacingExpandedId((cur) => (cur === it.id ? null : it.id))
                        }
                        onTogglePov={() =>
                          setPovExpandedId((cur) => (cur === it.id ? null : it.id))
                        }
                        onRemove={onRemove}
                        globalPacing={globalPacing}
                        updateItemPacing={updateItemPacing}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/10 bg-black/20 p-4 space-y-2">
          {queue.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="w-full rounded-md border border-cs2-border py-2 text-xs font-semibold text-zinc-400 hover:border-red-500/40 hover:text-red-300"
            >
              清空队列
            </button>
          )}
          <button
            type="button"
            disabled={queue.length === 0 || batchRecording}
            onClick={onStartBatch}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-orange py-3.5 text-sm font-extrabold uppercase tracking-widest text-black shadow-lg shadow-cs2-orange/25 transition-all hover:bg-cs2-orange-light disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Rocket className="h-4 w-4" />
            开始批量录制
          </button>
          {batchRecording && typeof onAbortBatch === "function" ? (
            <button
              type="button"
              onClick={() => void onAbortBatch()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 py-3 text-sm font-bold text-red-300 transition-all hover:border-red-400 hover:bg-red-500/20"
            >
              <OctagonX className="h-4 w-4 shrink-0" />
              中止录制
            </button>
          ) : null}
        </div>
    </div>
  );
}

export default function RecordingQueueDrawer({ open, onClose, ...rest }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/50 backdrop-blur-[2px]" role="presentation">
      <button type="button" className="h-full min-w-0 flex-1 cursor-default" aria-label="关闭抽屉背景" onClick={onClose} />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-cs2-bg-sidebar shadow-2xl" role="dialog">
        <RecordingQueuePanel {...rest} />
      </aside>
    </div>
  );
}
