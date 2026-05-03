import { ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import {
  normalizeClipType,
  getClipTitle,
  getClipDurationSeconds,
  formatMontageEstimate,
} from "../../utils/montageUtils";

function typeBadgeClass(t) {
  if (t === "高光") return "bg-amber-500/20 text-amber-200 ring-amber-500/40";
  if (t === "下饭") return "bg-orange-500/20 text-orange-200 ring-orange-500/40";
  if (t === "梗死亡") return "bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-500/40";
  if (t === "合集") return "bg-violet-500/20 text-violet-200 ring-violet-500/45";
  if (t === "击杀") return "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40";
  return "bg-zinc-500/15 text-zinc-400 ring-white/10";
}

const SORT_OPTIONS = [
  { id: "timeline", label: "按时间线" },
  { id: "score", label: "按评分" },
  { id: "funny_first", label: "下饭优先" },
  { id: "highlight_last", label: "高光压轴" },
];

export default function MontageTimeline({
  clips,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSort,
  unknownDurationHint,
}) {
  const knownDur = clips.reduce((acc, c) => {
    const d = getClipDurationSeconds(c);
    return d != null ? acc + d : acc;
  }, 0);

  return (
    <div className="flex h-full min-h-[200px] flex-col rounded-lg border border-white/10 bg-black/25">
      <div className="border-b border-white/10 px-3 py-2">
        <p className="text-[11px] font-semibold text-zinc-200">
          当前合辑：{clips.length} 个片段 · 预计 {formatMontageEstimate(knownDur, clips.length)}
        </p>
        {unknownDurationHint ? (
          <p className="mt-1 text-[10px] text-amber-200/80">{unknownDurationHint}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSort?.(s.id)}
              className="rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-zinc-400 hover:border-cs2-orange/35 hover:text-zinc-200"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {clips.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/15 bg-black/30 px-3 py-8 text-center text-[11px] leading-relaxed text-zinc-500">
            <p className="font-medium text-zinc-400">还没有加入片段</p>
            <p className="mt-2">从左侧素材库选择高光、下饭或梗死亡片段加入合辑。</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {clips.map((clip, idx) => {
              const tag = normalizeClipType(clip);
              const title = getClipTitle(clip);
              const dur = getClipDurationSeconds(clip);
              const durLabel = dur != null ? `${dur.toFixed(1)}s` : "未知时长";
              const meta = clip.demo_filename
                ? String(clip.demo_filename).replace(/\.[^.]+$/, "")
                : "";
              const line2 = [meta, durLabel].filter(Boolean).join(" · ");
              return (
                <li
                  key={clip.id}
                  className="rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-[11px]"
                >
                  <div className="flex items-start gap-2">
                    <span className="w-6 shrink-0 font-mono text-[10px] text-zinc-500">{String(idx + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${typeBadgeClass(tag)}`}
                        >
                          {tag}
                        </span>
                        <span className="text-zinc-400">{line2}</span>
                      </div>
                      <p className="mt-1 text-zinc-200">{title}</p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <button
                        type="button"
                        className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                        onClick={() => onMoveUp?.(clip.id)}
                        aria-label="上移"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                        onClick={() => onMoveDown?.(clip.id)}
                        aria-label="下移"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-zinc-500 hover:bg-red-400/80 hover:text-white"
                        onClick={() => onRemove?.(clip.id)}
                        aria-label="移除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
