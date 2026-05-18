import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clapperboard,
  GripVertical,
  History,
  Loader2,
  Save,
  Shuffle,
  Trash2,
  Waves,
  X,
  Zap,
  ArrowUpDown,
} from "lucide-react";
import { AiScoreBadge } from "../ClipCard";
import {
  getClipDurationSeconds,
  getClipRoundLabel,
  getClipTitle,
  getMontageBlockShortLabel,
  getMontageClipFactLine,
  getMontageTimelineVariant,
  getRecordedClipPerspectiveZh,
  getRecordedClipPerspectivePrimaryZh,
  mapNameFromClip,
  getMontageScorePair,
  mapNameAccentDotClass,
  getVictimPovSegmentsTooltip,
  getClipComment,
  getClipScore,
} from "../../utils/montageUtils";

function montageAiExplainText(clip) {
  const c = getClipComment(clip);
  if (c) return c.length > 80 ? `${c.slice(0, 78)}…` : c;
  const s = getClipScore(clip);
  if (s != null && Number.isFinite(Number(s))) return `AI 评分 ${Math.round(Number(s))} 分`;
  return "";
}

const VARIANT_BAR = {
  ace: "bg-cs2-rose-on-surface",
  multikill: "bg-cs2-amber-on-surface",
  pov: "bg-cs2-cyan-on-surface",
  fail: "bg-cs2-fail",
  compilation: "bg-cs2-amber-on-surface",
  highlight: "bg-cs2-highlight",
  timeline: "bg-cs2-cyan-on-surface",
  neutral: "bg-cs2-text-muted",
};

const VARIANT_RING = {
  ace: "border-cs2-rose-surface bg-gradient-to-br from-cs2-rose-surface to-cs2-bg-card text-cs2-rose-on-surface",
  multikill: "border-cs2-amber-surface bg-gradient-to-br from-cs2-amber-surface to-cs2-bg-card text-cs2-amber-on-surface",
  pov: "border-cs2-cyan-surface bg-gradient-to-br from-cs2-cyan-surface to-cs2-bg-card text-cs2-cyan-on-surface",
  fail: "border-cs2-red-surface bg-gradient-to-br from-cs2-red-surface to-cs2-bg-card text-cs2-red-on-surface",
  compilation: "border-cs2-amber-surface bg-gradient-to-br from-cs2-amber-surface to-cs2-bg-card text-cs2-amber-on-surface",
  highlight: "border-cs2-emerald-surface bg-gradient-to-br from-cs2-emerald-surface to-cs2-bg-card text-cs2-emerald-on-surface",
  timeline: "border-cs2-cyan-surface bg-gradient-to-br from-cs2-cyan-surface to-cs2-bg-card text-cs2-cyan-on-surface",
  neutral: "border-cs2-border bg-cs2-bg-elevated text-cs2-text-primary",
};

export function CollapsibleSection({ title, hint, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-cs2-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 py-3 text-left transition-colors hover:text-cs2-text-primary group"
      >
        <div className="min-w-0">
          <div className="text-xs font-bold tracking-wide text-cs2-text-primary group-hover:text-cs2-accent transition-colors">{title}</div>
          {hint ? <p className="mt-0.5 text-xs text-cs2-text-muted">{hint}</p> : null}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-cs2-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="space-y-3 pb-3">{children}</div> : null}
    </div>
  );
}

function SortDropdown({ onAutoSort, onTimelineSort, onRhythmSort, onRandomSort }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const items = [
    { label: "自动排序", icon: Zap, desc: "高光片段优先", fn: onAutoSort },
    { label: "时间线顺序", icon: History, desc: "按回合与 tick 升序", fn: onTimelineSort },
    { label: "节奏优先", icon: Waves, desc: "高光与下饭交错", fn: onRhythmSort },
    { label: "随机", icon: Shuffle, desc: "随机打乱", fn: onRandomSort },
  ];

  return (
    <div className="relative" ref={ref}>
      <ToolbarMiniButton onClick={() => setOpen((v) => !v)} title="排序方式">
        <ArrowUpDown className="h-3.5 w-3.5" />
        排序
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </ToolbarMiniButton>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border border-cs2-border bg-cs2-bg-card p-1.5 shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => { item.fn(); setOpen(false); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-cs2-text-secondary transition-colors hover:bg-cs2-surface-2 hover:text-cs2-text-primary"
            >
              <item.icon className="h-4 w-4 shrink-0 text-cs2-text-muted" />
              <div>
                <div className="font-semibold text-cs2-text-primary">{item.label}</div>
                <div className="text-[11px] text-cs2-text-muted mt-0.5">{item.desc}</div>
              </div>
            </button>
          ))}
        </div>
      )}
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
  onTimelineSort,
  onRhythmSort,
  onRandomSort,
  onSaveDraft,
  savingDraft,
  onHistory,
}) {
  return (
    <header className={`flex h-14 shrink-0 items-center gap-3 border-b px-4 ${isPage ? "border-cs2-border rounded-t-lg" : "border-cs2-border bg-cs2-surface-1"}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Clapperboard className="h-4 w-4 shrink-0 text-cs2-accent" aria-hidden />
        <div className="min-w-0">
          <h2 id="montage-title" className="truncate text-sm font-bold text-cs2-text-primary">
            {montageTitle}
          </h2>
          <p className="truncate text-xs text-cs2-text-muted mt-0.5">
            <span className="text-cs2-text-secondary">{subtitle}</span>
            <span className="mx-1.5 text-cs2-text-muted">·</span>
            <span>{autosaveLabel}</span>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <SortDropdown
          onAutoSort={onAutoSort}
          onTimelineSort={onTimelineSort}
          onRhythmSort={onRhythmSort}
          onRandomSort={onRandomSort}
        />
        <ToolbarMiniButton onClick={onHistory} title="查看历史合集记录">
          <History className="h-3.5 w-3.5" />
          历史
        </ToolbarMiniButton>
        <ToolbarMiniButton onClick={onSaveDraft} disabled={savingDraft} title="保存草稿">
          {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </ToolbarMiniButton>
        {!isPage ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary transition-colors"
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
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus hover:bg-cs2-surface-2 hover:text-cs2-text-primary transition-all disabled:cursor-not-allowed disabled:opacity-35 ${className}`}
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
    <div className="mx-2 mb-2 ml-7 rounded-xl border border-cs2-accent/40 bg-cs2-surface-2 p-3.5 shadow-inner transition-all">
      <p className="text-xs text-cs2-text-muted flex items-center gap-1.5">
        <span>衔接至下一段：</span>
        <span className="font-bold text-cs2-text-primary truncate max-w-[240px]" title={nextClip?.output_path}>
          {pathBasenameQuick(nextClip?.output_path) || getClipTitle(nextClip)}
        </span>
      </p>
      <p className="mt-1.5 font-mono text-xs font-bold text-cs2-accent">
        {formatTransitionLine?.(transitionByClipId, sourceClipId) || "默认快切"}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
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
              className={`rounded-lg border px-3 py-1 text-xs font-semibold transition-all ${
                active
                  ? "border-cs2-accent bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                  : "border-cs2-border-subtle bg-cs2-surface-1 text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="mt-3.5">
        <div className="flex items-center justify-between gap-2 text-xs text-cs2-text-muted">
          <span>转场衔接时长</span>
          <span className="font-mono font-bold text-cs2-accent">{durMs} ms</span>
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
          className="mt-1.5 h-2 w-full rounded-lg bg-cs2-bg-input accent-cs2-accent cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-cs2-text-muted">精确设置 (秒)</span>
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
          className="w-24 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent disabled:opacity-40 transition-all"
          placeholder="0.25"
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
      const perspectivePrimary = getRecordedClipPerspectivePrimaryZh(clip);
      const factLine = getMontageClipFactLine(clip);
      const scorePair = getMontageScorePair(clip);
      const rnd = clip.round != null && Number.isFinite(Number(clip.round)) ? Number(clip.round) : null;
      const povTip = getVictimPovSegmentsTooltip(clip);
      const victimSegCount = Array.isArray(clip.victim_pov_segments)
        ? clip.victim_pov_segments.filter((s) => String(s?.perspective_type || "").toLowerCase() === "victim").length
        : 0;
      return {
        clip,
        next,
        trLine,
        variant,
        dur,
        weapon,
        tags,
        mapName,
        perspectiveZh,
        perspectivePrimary,
        factLine,
        rowIndex: idx + 1,
        scorePair,
        rnd,
        povTip,
        victimSegCount,
      };
    });
  }, [clips, transitionByClipId, formatTransitionLine]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-surface-1 shadow-lg">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cs2-border-subtle p-4">
        <div>
          <p className="text-sm font-bold tracking-wide text-cs2-text-primary">合集编排主线</p>
          <p className="text-xs text-cs2-text-muted mt-0.5">拖拽排序 · Ctrl 多选 · 点击连线专属配置独立转场</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClearTimeline}
            disabled={!timelineClipCount}
            className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1.5 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all disabled:opacity-30"
          >
            清空主线
          </button>
          {multiCount > 0 ? (
            <>
              <button
                type="button"
                onClick={onBulkMoveUp}
                title="整体上移一格"
                className="inline-flex items-center gap-1 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1.5 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus transition-all"
              >
                <ArrowUp className="h-3.5 w-3.5" />
                上移
              </button>
              <button
                type="button"
                onClick={onBulkMoveDown}
                title="整体下移一格"
                className="inline-flex items-center gap-1 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1.5 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus transition-all"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                下移
              </button>
              <button
                type="button"
                onClick={onBulkRemove}
                className="rounded-lg border border-rose-500/30 bg-rose-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-600 transition-all shadow-sm"
              >
                批量移除 ({multiCount})
              </button>
            </>
          ) : null}
        </div>
      </div>
      {timelineClipCount >= 2 ? (
        <div className="shrink-0 border-b border-cs2-border-subtle bg-cs2-surface-2/60 px-4 py-2">
          <CollapsibleSection title="全局转场一键设定" hint="整体切换风格与节奏" defaultOpen={false}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1">
              <span className="text-xs font-bold text-cs2-text-muted w-16">基础类型</span>
              <div className="flex flex-wrap gap-1.5">
                {transitionTypeOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onApplyGlobalTransitionType(opt.id)}
                    className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent hover:text-cs2-text-primary transition-all"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1">
              <span className="text-xs font-bold text-cs2-text-muted w-16">节奏生成</span>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onApplyGlobalDurationToAll()} className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent transition-all">统一时长</button>
                <button type="button" onClick={onApplyRandomTransitions} className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent transition-all">全随机打乱</button>
                <button type="button" onClick={onApplyKillTypeTransitions} className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent transition-all">智能分析击杀节奏</button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1">
              <span className="text-xs font-bold text-cs2-text-muted w-16">风格模板</span>
              <div className="flex flex-wrap gap-1.5">
                {globalTransitionTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => onApplyGlobalTemplate(tpl.id, tpl.label)}
                    className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent transition-all"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          </CollapsibleSection>
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
          <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-cs2-border-subtle bg-cs2-surface-1 p-8 text-center">
            <p className="text-sm font-bold text-cs2-text-secondary">时间线空闲中</p>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-cs2-text-muted">
              从左侧素材池点选多条素材进行批量导入，或直接将卡片拖拽进入下方区域排布您的合辑结构。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map(
              ({
                clip,
                next,
                trLine,
                variant,
                dur,
                weapon,
                tags,
                mapName,
                perspectiveZh,
                perspectivePrimary,
                factLine,
                rowIndex,
                scorePair,
                rnd,
                povTip,
                victimSegCount,
              }) => {
              const active = primarySelectedId === clip.id;
              const inMulti = multiSelectedIds?.has?.(clip.id);
              const dragging = dragId === clip.id;
              const vCls = VARIANT_RING[variant] || VARIANT_RING.neutral;
              const killBadge = getMontageBlockShortLabel(clip);
              const suppressMontageAi = variant === "timeline" || variant === "compilation";
              const aiLine = suppressMontageAi ? "" : montageAiExplainText(clip);
              const outBase = pathBasenameQuick(clip?.output_path);
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
                    className={`relative flex cursor-grab gap-2.5 rounded-xl border p-3.5 text-left transition-all active:cursor-grabbing ${
                      inMulti
                        ? "border-cs2-accent bg-cs2-surface-2 shadow-glow-accent"
                        : "border-cs2-border-subtle bg-cs2-surface-1 hover:border-cs2-border-focus hover:bg-cs2-surface-2"
                    } ${active ? "ring-2 ring-cs2-accent" : ""} ${dragging ? "opacity-40 scale-[0.99]" : ""}`}
                  >
                    {/* 左侧类型高亮竖条 */}
                    <div className={`absolute left-0 top-3 bottom-3 w-1.5 rounded-r-md ${VARIANT_BAR[variant] || VARIANT_BAR.neutral}`} />
                    <GripVertical className="mt-1 h-4 w-4 shrink-0 text-cs2-text-muted cursor-grab" aria-hidden />
                    
                    <div className="min-w-0 flex-1 pl-1">
                      {/* 首行核心标题区 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-cs2-text-muted shrink-0">#{rowIndex}</span>
                        <span className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider shrink-0 ${vCls}`}>{killBadge}</span>
                        <span className="truncate text-sm font-bold text-cs2-text-primary">{clip.player_name || "未知玩家"}</span>
                        <span className="ml-auto font-mono text-xs font-bold text-cs2-accent bg-cs2-accent-soft px-2 py-0.5 rounded-md shrink-0">
                          {dur != null ? `${dur.toFixed(1)}s` : "?s"}
                        </span>
                      </div>

                      {/* 摘要行：武器、地图、回合、比分（详情拆到下方，避免 truncate + 仅靠 hover） */}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cs2-text-muted">
                        {weapon ? <span className="font-medium text-cs2-text-secondary">{weapon}</span> : null}
                        {weapon && (mapName || rnd != null) ? <span>•</span> : null}
                        {mapName ? <span className="break-words text-cs2-text-secondary">{mapName}</span> : null}
                        {getClipRoundLabel(clip) != null ? (
                          <span className="font-mono text-cs2-text-secondary">{getClipRoundLabel(clip)}</span>
                        ) : null}
                        {scorePair ? (
                          <span className="font-mono font-semibold text-cs2-text-primary">
                            {scorePair.left}:{scorePair.right}
                          </span>
                        ) : null}
                      </div>

                      {factLine ? (
                        <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-secondary break-words">
                          {factLine}
                        </p>
                      ) : null}

                      {/* 次级状态微标区 */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {victimSegCount > 0 ? (
                          <span className="rounded bg-cs2-violet-surface px-2 py-0.5 text-xs font-medium text-cs2-violet-on-surface">
                            受害者视角 ×{victimSegCount}
                          </span>
                        ) : null}
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            perspectivePrimary !== "观战视角"
                              ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface"
                              : "bg-cs2-bg-input text-cs2-text-muted"
                          }`}
                        >
                          {perspectivePrimary}
                        </span>
                        {clip.pov_hud_enabled === true ? (
                          <span className="rounded bg-cs2-cyan-surface px-2 py-0.5 text-xs font-bold text-cs2-cyan-on-surface">HUD</span>
                        ) : null}
                      </div>
                      {povTip ? (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-cs2-text-muted break-words">
                          {povTip}
                        </p>
                      ) : null}
                      {perspectiveZh !== perspectivePrimary ? (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-cs2-text-muted break-words">
                          录制视角：{perspectiveZh}
                        </p>
                      ) : null}
                      {aiLine ? (
                        <p className="mt-1.5 text-[11px] leading-relaxed italic text-cs2-text-muted break-words">
                          {aiLine}
                        </p>
                      ) : null}
                      {outBase ? (
                        <p
                          className="mt-1.5 font-mono text-[10px] text-cs2-text-muted/90 break-all"
                          title={String(clip.output_path || "")}
                        >
                          {outBase}
                        </p>
                      ) : null}

                      {/* 标签列表 */}
                      {tags.length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {tags.map((t) => (
                            <span
                              key={t}
                              className="rounded-md bg-cs2-bg-input px-2 py-0.5 text-xs font-medium text-cs2-text-secondary"
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
                      className="shrink-0 self-start rounded-lg p-2 text-cs2-text-muted hover:bg-rose-500/15 hover:text-rose-400 transition-colors"
                      aria-label="从时间线移除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* 两单行之间的转场配置纽带连线区 */}
                  {next ? (
                    <>
                      <div className="relative flex justify-center py-2">
                        <div className="absolute inset-y-0 left-6 w-0.5 bg-gradient-to-b from-cs2-accent via-cs2-accent-soft to-cs2-accent" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTransitionEdgeFocusChange?.(transitionEdgeSourceId === clip.id ? null : clip.id);
                          }}
                          className={`relative z-[1] flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold transition-all shadow-sm ${
                            transitionEdgeSourceId === clip.id
                              ? "border-cs2-accent bg-cs2-accent text-cs2-text-on-accent shadow-glow-accent scale-105"
                              : "border-cs2-border-subtle bg-cs2-surface-1 text-cs2-text-secondary hover:border-cs2-accent hover:text-cs2-text-primary"
                          }`}
                        >
                          <span className="text-[11px] uppercase tracking-wider font-semibold opacity-75">衔接转场</span>
                          <span>{trLine || "快切"}</span>
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

function onDropOnItem(e, targetId, onDropOnBlock) {
  e.preventDefault();
  e.stopPropagation();
  const raw = e.dataTransfer.getData("text/plain");
  const draggedId = Number(raw);
  if (!Number.isFinite(draggedId)) return;
  onDropOnBlock?.(draggedId, targetId);
}

function demoShortLabel(clip) {
  const raw =
    (clip.demo_filename && String(clip.demo_filename).replace(/\.(dem|mp4)$/i, "").trim()) ||
    (clip.demo_path && String(clip.demo_path).split(/[/\\]/).pop()?.replace(/\.dem$/i, "").trim()) ||
    "";
  if (!raw) return "";
  // e.g. "g161-20260509172073390_de_dust2" → "de_dust2"
  const underIdx = raw.indexOf("_");
  const afterUnderscore = underIdx >= 0 ? raw.slice(underIdx + 1) : raw;
  return afterUnderscore.length > 28 ? `${afterUnderscore.slice(0, 26)}…` : afterUnderscore;
}

export function MontageMaterialPoolCard({
  clip,
  index = 0,
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
  const perspectivePrimary = getRecordedClipPerspectivePrimaryZh(clip);
  const factLine = getMontageClipFactLine(clip, { includeDemoName: false });
  const killBadge = getMontageBlockShortLabel(clip);
  const variant = getMontageTimelineVariant(clip);
  const suppressMontageAi = variant === "timeline" || variant === "compilation";
  const scorePair = getMontageScorePair(clip);
  const rnd = clip.round != null && Number.isFinite(Number(clip.round)) ? Number(clip.round) : null;
  const povTip = getVictimPovSegmentsTooltip(clip);
  const victimSegCount = Array.isArray(clip.victim_pov_segments)
    ? clip.victim_pov_segments.filter((s) => String(s?.perspective_type || "").toLowerCase() === "victim").length
    : 0;
  const aiExplain = suppressMontageAi ? "" : montageAiExplainText(clip);
  const demoLabel = demoShortLabel(clip);

  return (
    <li
      draggable
      onDragStart={(e) => onDragStart(e, clip.id)}
      onDragEnd={onDragEnd}
      onClick={(e) => onClickMulti(e, clip.id)}
      className={`group flex min-h-[110px] shrink-0 gap-2.5 rounded-xl bg-cs2-surface-1 p-3.5 transition-all cursor-grab border ${
        selected
          ? "border-cs2-accent shadow-glow-accent bg-cs2-surface-2"
          : "border-cs2-border-subtle hover:border-cs2-border-focus hover:bg-cs2-surface-2"
      }`}
    >
      <div
        className={`w-1 shrink-0 self-stretch rounded-r-md ${VARIANT_BAR[variant] || VARIANT_BAR.neutral}`}
        aria-hidden
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div>
          {/* 首行：左信息 + 右 AI / 删除（同高对齐，左右留白一致） */}
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${VARIANT_RING[variant] || VARIANT_RING.neutral}`}>
                {killBadge}
              </span>
              <span className="truncate text-sm font-bold text-cs2-text-primary">{playerName}</span>
              <span className="shrink-0 font-mono text-xs font-semibold text-cs2-accent bg-cs2-accent-soft px-2 py-0.5 rounded-md">
                {dur != null ? `${dur.toFixed(1)}s` : "?s"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {suppressMontageAi ? null : <AiScoreBadge score={clip.ai_score} />}
              <button
                type="button"
                title="删除素材"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(clip);
                }}
                className="rounded-lg p-1.5 text-cs2-text-muted opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 次级合并说明行：地图、回合、武器 */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cs2-text-muted">
            {weaponShow ? <span className="font-medium text-cs2-text-secondary">{weaponShow}</span> : null}
            {weaponShow && (mapName || rnd != null) ? <span>•</span> : null}
            {mapName ? <span className="truncate max-w-[120px]">{mapName}</span> : null}
            {getClipRoundLabel(clip) != null ? (
              <span className="font-mono text-cs2-text-secondary">{getClipRoundLabel(clip)}</span>
            ) : null}
            {scorePair ? (
              <span className="font-mono font-semibold text-cs2-text-primary">
                {scorePair.left}:{scorePair.right}
              </span>
            ) : null}
          </div>

          {/* 事实摘要行：击杀数 + 被击杀玩家（截断防撑高） */}
          {factLine ? (
            <p className="mt-1.5 truncate text-[11px] text-cs2-text-secondary" title={factLine}>
              {factLine}
            </p>
          ) : null}

          {/* 视角徽标行 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                perspectivePrimary !== "观战视角"
                  ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface"
                  : "bg-cs2-bg-input text-cs2-text-muted"
              }`}
            >
              {perspectivePrimary}
            </span>
            {clip.pov_hud_enabled === true ? (
              <span className="rounded bg-cs2-cyan-surface px-1.5 py-0.5 text-[11px] font-bold text-cs2-cyan-on-surface">HUD</span>
            ) : null}
            {victimSegCount > 0 ? (
              <span className="rounded bg-cs2-violet-surface px-1.5 py-0.5 text-[11px] font-medium text-cs2-violet-on-surface" title={povTip || undefined}>
                受害者视角 ×{victimSegCount}
              </span>
            ) : null}
          </div>

          {/* 标签列表 */}
          {tags.length ? (
            <div className="mt-2 flex min-w-0 flex-wrap gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="truncate rounded-md bg-cs2-bg-input px-2 py-0.5 text-[11px] font-medium text-cs2-text-secondary"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* 底部操作区与辅助解说摘要 */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-cs2-border-subtle pt-2.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAdd(clip.id);
            }}
            disabled={added}
            className={`rounded-lg px-3 py-1 text-xs font-bold transition-all ${
              added
                ? "cursor-default bg-cs2-bg-skeleton text-cs2-text-muted"
                : "bg-cs2-accent text-cs2-text-on-accent hover:bg-cs2-accent-light hover:shadow-glow-accent"
            }`}
          >
            {added ? "已添加" : "加入"}
          </button>
          <div className="min-w-0 flex-1 text-right">
            {aiExplain ? (
              <p className="truncate text-[11px] text-cs2-text-muted" title={aiExplain}>
                {aiExplain}
              </p>
            ) : (
              <span className="font-mono text-xs text-cs2-text-muted">#{index}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
