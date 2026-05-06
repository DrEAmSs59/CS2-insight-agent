import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clapperboard,
  GripVertical,
  Loader2,
  Save,
  Shuffle,
  Trash2,
  Waves,
  X,
  Zap,
} from "lucide-react";
import {
  getClipDurationSeconds,
  getClipTitle,
  getMontageBlockShortLabel,
  getMontageTimelineVariant,
  getRecordedClipPerspectiveZh,
  mapNameFromClip,
} from "../../utils/montageUtils";

const VARIANT_BAR = {
  ace: "bg-rose-500",
  multikill: "bg-amber-500",
  pov: "bg-sky-500",
  fail: "bg-orange-500",
  compilation: "bg-violet-500",
  highlight: "bg-emerald-500",
  neutral: "bg-zinc-600",
};

const VARIANT_RING = {
  ace: "border-rose-500/45 bg-gradient-to-br from-rose-950/60 to-zinc-950/90 text-rose-50",
  multikill: "border-amber-500/40 bg-gradient-to-br from-amber-950/50 to-zinc-950/90 text-amber-50",
  pov: "border-sky-500/35 bg-gradient-to-br from-sky-950/40 to-zinc-950/90 text-sky-50",
  fail: "border-orange-500/45 bg-gradient-to-br from-orange-950/55 to-zinc-950/90 text-orange-50",
  compilation: "border-violet-500/45 bg-gradient-to-br from-violet-950/50 to-zinc-950/90 text-violet-50",
  highlight: "border-emerald-500/40 bg-gradient-to-br from-emerald-950/45 to-zinc-950/90 text-emerald-50",
  neutral: "border-white/12 bg-zinc-900/90 text-zinc-200",
};

export function CollapsibleSection({ title, hint, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-white/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
      >
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wide text-zinc-200">{title}</p>
          {hint ? <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{hint}</p> : null}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="space-y-2 pb-3">{children}</div> : null}
    </div>
  );
}

export function MontageWorkbenchToolbar({
  isPage,
  montageTitle,
  subtitle,
  autosaveLabel,
  onClose,
  onAutoSort,
  onRhythmSort,
  onRandomSort,
  onSaveDraft,
  savingDraft,
  onExport,
  exporting,
}) {
  return (
    <header className="flex h-[48px] shrink-0 items-center gap-2 border-b border-white/10 bg-black/50 px-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Clapperboard className="h-4 w-4 shrink-0 text-cs2-orange" aria-hidden />
        <div className="min-w-0">
          <h2 id="montage-title" className="truncate text-[13px] font-bold text-white">
            {montageTitle}
          </h2>
          <p className="truncate text-[10px] text-zinc-500">
            <span className="text-zinc-400">{subtitle}</span>
            <span className="mx-1.5 text-zinc-700">·</span>
            <span>{autosaveLabel}</span>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        <ToolbarMiniButton onClick={onAutoSort} title="高光片段优先排序当前时间线">
          <Zap className="h-3.5 w-3.5" />
          自动排序
        </ToolbarMiniButton>
        <ToolbarMiniButton onClick={onRhythmSort} title="高光与下饭交错">
          <Waves className="h-3.5 w-3.5" />
          节奏优先
        </ToolbarMiniButton>
        <ToolbarMiniButton onClick={onRandomSort} title="随机打乱当前顺序">
          <Shuffle className="h-3.5 w-3.5" />
          随机
        </ToolbarMiniButton>
        <ToolbarMiniButton onClick={onSaveDraft} disabled={savingDraft} title="保存草稿">
          {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </ToolbarMiniButton>
        <ToolbarMiniButton
          onClick={onExport}
          disabled={exporting}
          title="导出成片"
          className="border-cs2-orange/35 bg-cs2-orange/10 text-cs2-orange hover:bg-cs2-orange/18"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clapperboard className="h-3.5 w-3.5" />}
          导出
        </ToolbarMiniButton>
        {!isPage ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

function ToolbarMiniButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-zinc-300 hover:border-white/18 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-35 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function pathBasenameQuick(path) {
  const s = String(path || "").trim();
  if (!s) return "";
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

function MontageTransitionEdgeEditor({
  sourceClipId,
  nextClip,
  transitionByClipId,
  getEffectiveTransition,
  patchTransition,
  transitionTypeOptions,
  formatTransitionLine,
}) {
  const eff = getEffectiveTransition(transitionByClipId, sourceClipId);
  const [durDraft, setDurDraft] = useState("");
  useEffect(() => {
    if (eff.type === "none") {
      setDurDraft("");
      return;
    }
    const r = Math.round(eff.duration * 1000) / 1000;
    setDurDraft(Number.isInteger(r) ? String(r) : String(r).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  }, [sourceClipId, eff.type, eff.duration]);

  const applyDurSeconds = useCallback(() => {
    if (eff.type === "none") return;
    const raw = String(durDraft).replace(",", ".").trim();
    if (raw === "") return;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) return;
    patchTransition(sourceClipId, { duration: Math.min(1.5, n) });
  }, [durDraft, eff.type, patchTransition, sourceClipId]);

  const durMs = eff.type === "none" ? 0 : Math.round(Math.min(1.5, eff.duration) * 1000);

  return (
    <div className="mx-2 mb-2 ml-7 rounded-lg border border-cs2-orange/30 bg-black/50 px-3 py-2.5 shadow-inner">
      <p className="text-[10px] text-zinc-500">
        衔接至下一段：
        <span className="font-medium text-zinc-300" title={nextClip?.output_path}>
          {pathBasenameQuick(nextClip?.output_path) || getClipTitle(nextClip)}
        </span>
      </p>
      <p className="mt-1 font-mono text-[11px] font-semibold text-cs2-orange">
        {formatTransitionLine?.(transitionByClipId, sourceClipId) || "默认"}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {transitionTypeOptions.map((opt) => {
          const tid = opt.id;
          const active = eff.type === tid;
          return (
            <button
              key={tid}
              type="button"
              onClick={() => {
                if (tid === "none") patchTransition(sourceClipId, { type: "none", duration: 0 });
                else patchTransition(sourceClipId, { type: tid });
              }}
              className={`rounded border px-2 py-0.5 text-[9px] font-semibold ${
                active
                  ? "border-cs2-orange/60 bg-cs2-orange/20 text-cs2-orange"
                  : "border-white/10 bg-black/40 text-zinc-400 hover:border-white/25"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="mt-2">
        <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
          <span>本条时长</span>
          <span className="font-mono text-cs2-orange">{durMs} ms</span>
        </div>
        <input
          type="range"
          min={0}
          max={1500}
          step={10}
          disabled={eff.type === "none"}
          value={durMs}
          onChange={(e) =>
            patchTransition(sourceClipId, {
              duration: Math.min(1.5, Number(e.target.value) / 1000),
            })
          }
          className="mt-1 h-1.5 w-full accent-cs2-orange disabled:opacity-35"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-zinc-500">精确秒</span>
        <input
          type="text"
          inputMode="decimal"
          disabled={eff.type === "none"}
          value={durDraft}
          onChange={(e) => setDurDraft(e.target.value)}
          onBlur={applyDurSeconds}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyDurSeconds();
            }
          }}
          className="w-20 rounded border border-white/10 bg-black/50 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-cs2-orange/45 disabled:opacity-40"
          placeholder="秒"
        />
      </div>
    </div>
  );
}

export function MontageOrchestrationTimeline({
  clips,
  primarySelectedId,
  multiSelectedIds,
  onRowPointerDown,
  dragId,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDropOnRow,
  onRemoveOne,
  transitionByClipId,
  formatTransitionLine,
  transitionEdgeSourceId,
  onTransitionEdgeFocusChange,
  getEffectiveTransition,
  patchTransition,
  transitionTypeOptions,
  onApplyGlobalTransitionType,
  onApplyGlobalDurationToAll,
  onApplyRandomTransitions,
  onApplyKillTypeTransitions,
  globalTransitionTemplates,
  onApplyGlobalTemplate,
  onBulkRemove,
  multiCount,
  onBulkMoveUp,
  onBulkMoveDown,
  onClearTimeline,
  timelineClipCount,
}) {
  const rows = useMemo(() => {
    return clips.map((clip, idx) => {
      const next = clips[idx + 1];
      const trLine = next ? formatTransitionLine?.(transitionByClipId, clip.id) : null;
      const variant = getMontageTimelineVariant(clip);
      const dur = getClipDurationSeconds(clip);
      const weapon =
        clip.weapon_used &&
        String(clip.weapon_used)
          .split(" / ")
          .map((w) => w.trim())
          .filter(Boolean)[0];
      const tags = Array.isArray(clip.context_tags) ? clip.context_tags.slice(0, 6) : [];
      const mapName = mapNameFromClip(clip);
      const perspectiveZh = getRecordedClipPerspectiveZh(clip);
      return { clip, next, trLine, variant, dur, weapon, tags, mapName, perspectiveZh };
    });
  }, [clips, transitionByClipId, formatTransitionLine]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/15 bg-gradient-to-b from-[#16161f] via-[#12121a] to-[#0d0d12] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-black/25 px-3 py-2">
        <div>
          <p className="text-[12px] font-bold tracking-wide text-zinc-100">合集结构</p>
          <p className="text-[10px] text-zinc-500">拖拽排序 · Ctrl 多选 · 点两条片段之间的「转场」可单独改衔接</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={onClearTimeline}
            disabled={!timelineClipCount}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 disabled:opacity-30"
          >
            清空
          </button>
          {multiCount > 0 ? (
            <>
              <button
                type="button"
                onClick={onBulkMoveUp}
                title="连续选中时整体上移一格"
                className="inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-cs2-orange/35"
              >
                <ArrowUp className="h-3 w-3" />
                上移
              </button>
              <button
                type="button"
                onClick={onBulkMoveDown}
                title="连续选中时整体下移一格"
                className="inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-cs2-orange/35"
              >
                <ArrowDown className="h-3 w-3" />
                下移
              </button>
            </>
          ) : null}
          {multiCount > 0 ? (
            <button
              type="button"
              onClick={onBulkRemove}
              className="rounded-md border border-red-500/35 bg-red-950/25 px-2 py-1 text-[10px] font-semibold text-red-200 hover:bg-red-950/40"
            >
              移除 ({multiCount})
            </button>
          ) : null}
        </div>
      </div>
      {timelineClipCount >= 2 ? (
        <div className="shrink-0 space-y-2 border-b border-white/10 bg-black/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10px] font-semibold text-zinc-500">全局类型</span>
            <div className="flex flex-wrap gap-1">
              {transitionTypeOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onApplyGlobalTransitionType(opt.id)}
                  className="rounded border border-white/10 bg-black/40 px-2 py-0.5 text-[9px] font-medium text-zinc-300 hover:border-cs2-orange/40"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => onApplyGlobalDurationToAll()}
              className="rounded border border-white/12 bg-white/[0.04] px-2 py-1 text-[9px] font-semibold text-zinc-300 hover:border-cs2-orange/35"
            >
              统一时长
            </button>
            <button
              type="button"
              onClick={onApplyRandomTransitions}
              className="rounded border border-white/12 bg-white/[0.04] px-2 py-1 text-[9px] font-semibold text-zinc-300 hover:border-cs2-orange/35"
            >
              随机
            </button>
            <button
              type="button"
              onClick={onApplyKillTypeTransitions}
              className="rounded border border-white/12 bg-white/[0.04] px-2 py-1 text-[9px] font-semibold text-zinc-300 hover:border-cs2-orange/35"
            >
              按击杀
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10px] font-semibold text-zinc-600">模板</span>
            <div className="flex flex-wrap gap-1">
              {globalTransitionTemplates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onApplyGlobalTemplate(tpl.id, tpl.label)}
                  className="rounded border border-white/10 bg-black/35 px-2 py-0.5 text-[9px] text-zinc-300 hover:border-cs2-orange/40"
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData("text/plain");
          const id = Number(raw);
          if (!Number.isFinite(id)) return;
          onDropOnRow?.(id, null);
        }}
      >
        {clips.length === 0 ? (
          <div className="flex min-h-[200px] flex-col items-center justify-center rounded-lg border border-dashed border-white/15 bg-black/20 px-4 py-10 text-center">
            <p className="text-[12px] font-medium text-zinc-400">尚未编排片段</p>
            <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-zinc-600">
              从左侧素材池挑选并拖入，或使用顶部排序整理已有顺序。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0">
            {rows.map(({ clip, next, trLine, variant, dur, weapon, tags, mapName, perspectiveZh }) => {
              const active = primarySelectedId === clip.id;
              const inMulti = multiSelectedIds?.has?.(clip.id);
              const dragging = dragId === clip.id;
              const vCls = VARIANT_RING[variant] || VARIANT_RING.neutral;
              const killBadge = getMontageBlockShortLabel(clip);
              return (
                <li key={clip.id} className="flex flex-col">
                  <div
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => onDragStart(e, clip.id)}
                    onDragEnd={onDragEnd}
                    onDragOver={onDragOver}
                    onDrop={(e) => onDropOnItem(e, clip.id, onDropOnRow)}
                    onClick={(e) => onRowPointerDown(e, clip.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowPointerDown(e, clip.id);
                      }
                    }}
                    className={`relative flex cursor-grab gap-2 rounded-lg border px-3 py-3 text-left shadow-md shadow-black/50 transition-[border,box-shadow,background] active:cursor-grabbing ${
                      inMulti
                        ? "border-cs2-orange/50 bg-cs2-orange/[0.09] ring-1 ring-cs2-orange/35"
                        : "border-white/12 bg-zinc-900/85 hover:border-white/20"
                    } ${active ? "ring-2 ring-cs2-orange/45" : ""} ${dragging ? "opacity-50" : ""}`}
                  >
                    <div className={`absolute inset-y-2 left-0 w-1 rounded-full ${VARIANT_BAR[variant] || VARIANT_BAR.neutral}`} />
                    <GripVertical className="mt-1 h-5 w-5 shrink-0 text-zinc-500" aria-hidden />
                    <div className="min-w-0 flex-1 pl-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${vCls}`}>{killBadge}</span>
                        <span className="truncate text-[13px] font-bold text-white">{clip.player_name || "未知玩家"}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                        <span>
                          <span className="text-zinc-600">武器</span>{" "}
                          <span className="font-medium text-zinc-200">{weapon || "—"}</span>
                        </span>
                        <span className="font-mono tabular-nums text-zinc-300">{dur != null ? `${dur.toFixed(1)}s` : "?"}</span>
                        <span
                          className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                            perspectiveZh !== "观战视角"
                              ? "bg-sky-500/15 text-sky-200"
                              : "bg-zinc-800 text-zinc-600"
                          }`}
                          title={perspectiveZh}
                        >
                          {perspectiveZh}
                        </span>
                        {mapName ? (
                          <span className="truncate text-zinc-500" title={mapName}>
                            {mapName}
                          </span>
                        ) : null}
                      </div>
                      {tags.length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {tags.map((t) => (
                            <span
                              key={t}
                              className="rounded-md border border-white/[0.07] bg-black/35 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onRemoveOne(clip.id);
                      }}
                      className="shrink-0 self-start rounded-md p-2 text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
                      aria-label="从时间线移除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {next ? (
                    <>
                      <div className="relative flex justify-center py-1">
                        <div className="absolute inset-y-0 left-5 w-px bg-gradient-to-b from-cs2-orange/45 via-cs2-orange/15 to-cs2-orange/45" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTransitionEdgeFocusChange?.(transitionEdgeSourceId === clip.id ? null : clip.id);
                          }}
                          className={`relative z-[1] flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium shadow-sm transition-[border,box-shadow,background] ${
                            transitionEdgeSourceId === clip.id
                              ? "border-cs2-orange/70 bg-cs2-orange/15 text-cs2-orange ring-2 ring-cs2-orange/40"
                              : "border-cs2-orange/25 bg-[#1a1410] text-cs2-orange/95 hover:border-cs2-orange/45"
                          }`}
                        >
                          <span className="text-cs2-orange/60">转场</span>
                          <span>{trLine || "默认"}</span>
                        </button>
                      </div>
                      {transitionEdgeSourceId === clip.id ? (
                        <MontageTransitionEdgeEditor
                          sourceClipId={clip.id}
                          nextClip={next}
                          transitionByClipId={transitionByClipId}
                          getEffectiveTransition={getEffectiveTransition}
                          patchTransition={patchTransition}
                          transitionTypeOptions={transitionTypeOptions}
                          formatTransitionLine={formatTransitionLine}
                        />
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function MontageRhythmStrip({ hasIntro, hasOutro, hasBgm, clipCount, transitionSlots }) {
  return (
    <div className="mb-2 rounded border border-white/[0.06] bg-black/40 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
        <span className="font-semibold text-zinc-400">编排</span>
        <span className="rounded border border-white/10 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-zinc-400">
          {hasIntro ? "intro" : "—"}
        </span>
        <span className="text-zinc-700">|</span>
        <span className="rounded border border-emerald-500/25 bg-emerald-950/30 px-1.5 py-0.5 text-emerald-200/90">
          clips ×{clipCount}
        </span>
        {transitionSlots > 0 ? (
          <>
            <span className="text-zinc-700">|</span>
            <span className="rounded border border-cs2-orange/25 bg-cs2-orange/10 px-1.5 py-0.5 text-cs2-orange/90">
              转场 ×{transitionSlots}
            </span>
          </>
        ) : null}
        <span className="text-zinc-700">|</span>
        <span className="rounded border border-white/10 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-zinc-400">
          {hasOutro ? "outro" : "—"}
        </span>
        <span className="text-zinc-700">|</span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono ${
            hasBgm ? "border-violet-500/30 bg-violet-950/35 text-violet-200/90" : "border-white/10 text-zinc-600"
          }`}
        >
          BGM {hasBgm ? "on" : "off"}
        </span>
      </div>
    </div>
  );
}

function onDropOnItem(e, targetId, onDropOnBlock) {
  e.preventDefault();
  e.stopPropagation();
  const raw = e.dataTransfer.getData("text/plain");
  const draggedId = Number(raw);
  if (!Number.isFinite(draggedId)) return;
  onDropOnBlock?.(draggedId, targetId);
}

export function MontageMaterialPoolCard({
  clip,
  added,
  selected,
  onAdd,
  onDelete,
  onDragStart,
  onDragEnd,
  onClickMulti,
}) {
  const mapName = mapNameFromClip(clip);
  const dur = getClipDurationSeconds(clip);
  const durLabel = dur != null ? `${dur.toFixed(1)}s` : "?";
  const weaponPrimary =
    clip.weapon_used &&
    String(clip.weapon_used)
      .split(" / ")
      .map((w) => w.trim())
      .filter(Boolean)[0];
  const weaponShow = weaponPrimary
    ? weaponPrimary.length > 22
      ? `${weaponPrimary.slice(0, 20)}…`
      : weaponPrimary
    : "";
  const tags = Array.isArray(clip.context_tags) ? clip.context_tags.slice(0, 5) : [];
  const playerName = clip.player_name?.trim() || "未知玩家";
  const perspectiveZh = getRecordedClipPerspectiveZh(clip);
  const highlightRing = VARIANT_RING.highlight || VARIANT_RING.neutral;

  return (
    <li
      draggable
      onDragStart={(e) => onDragStart(e, clip.id)}
      onDragEnd={onDragEnd}
      onClick={(e) => onClickMulti(e, clip.id)}
      className={`group relative min-h-[118px] shrink-0 overflow-hidden rounded-lg border bg-zinc-950/80 transition-colors ${
        selected ? "border-cs2-orange/55 ring-1 ring-cs2-orange/25" : "border-white/[0.06] hover:border-white/14"
      }`}
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-emerald-500/65" aria-hidden />
      <div className="flex gap-2 p-2.5 pt-3">
        <div
          className={`flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 ${highlightRing}`}
        >
          <Zap className="h-4 w-4 text-emerald-200/95" aria-hidden />
          <span className="max-w-full truncate text-center text-[10px] font-bold leading-tight text-white/95">高光</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold leading-snug text-white">{playerName}</p>
          <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
            {weaponShow ? (
              <span className="max-w-[140px] truncate rounded-md bg-black/45 px-1.5 py-0.5 font-medium text-zinc-200" title={weaponPrimary}>
                {weaponShow}
              </span>
            ) : null}
            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono tabular-nums text-zinc-300">{durLabel}</span>
            <span
              className={`max-w-[7.5rem] truncate rounded-md px-1.5 py-0.5 font-semibold ${
                perspectiveZh !== "观战视角" ? "bg-sky-500/15 text-sky-200" : "bg-zinc-800 text-zinc-500"
              }`}
              title={perspectiveZh}
            >
              {perspectiveZh}
            </span>
            {mapName ? (
              <span className="max-w-[100px] truncate rounded-md border border-white/[0.08] px-1.5 py-0.5 text-zinc-400" title={mapName}>
                {mapName}
              </span>
            ) : null}
          </div>
          {tags.length ? (
            <div className="mt-2 flex min-w-0 flex-wrap gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="truncate rounded-md border border-white/[0.06] bg-black/35 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAdd(clip.id);
              }}
              disabled={added}
              className={`rounded-md border px-2.5 py-1 text-[10px] font-bold transition-colors ${
                added
                  ? "cursor-default border-emerald-500/25 bg-emerald-950/30 text-emerald-400/90"
                  : "border-cs2-orange/45 bg-cs2-orange/14 text-cs2-orange hover:bg-cs2-orange/22"
              }`}
            >
              {added ? "已在编排" : "加入编排"}
            </button>
            {selected ? (
              <span className="text-[9px] font-medium text-cs2-orange">已选中 · 点列表上方「批量加入编排」</span>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        title="删除素材"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(clip);
        }}
        className="absolute bottom-1.5 right-1.5 rounded p-1 text-zinc-600 opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-300 group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
