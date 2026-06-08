import { ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import {
  normalizeClipType,
  getClipTitle,
  getClipDurationSeconds,
  formatMontageEstimate,
  montageTypeTagBadgeClass,
} from "../../utils/montageUtils";
import { useT } from "../../i18n/useT.js";

export default function MontageTimeline({
  clips,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSort,
  unknownDurationHint,
}) {
  const t = useT();

  const SORT_OPTIONS = [
    { id: "timeline", label: t("montage.timelineSortTimeline") },
    { id: "score", label: t("montage.timelineSortScore") },
    { id: "funny_first", label: t("montage.timelineSortFunnyFirst") },
    { id: "highlight_last", label: t("montage.timelineSortHighlightLast") },
  ];

  const knownDur = clips.reduce((acc, c) => {
    const d = getClipDurationSeconds(c);
    return d != null ? acc + d : acc;
  }, 0);

  return (
    <div className="flex h-full min-h-[200px] flex-col rounded-lg border border-cs2-border bg-cs2-bg-input/40">
      <div className="border-b border-cs2-border px-3 py-2">
        <p className="text-[12px] font-semibold text-cs2-text-primary">
          {t("montage.timelineHeader", { n: clips.length, dur: formatMontageEstimate(knownDur, clips.length) })}
        </p>
        {unknownDurationHint ? (
          <p className="mt-1 text-[11px] text-cs2-amber-on-surface">{unknownDurationHint}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSort?.(s.id)}
              className="rounded border border-cs2-border bg-cs2-bg-input/70 px-2 py-1 text-[10px] text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {clips.length === 0 ? (
          <div className="rounded-lg border border-dashed border-cs2-border bg-cs2-bg-input/50 px-3 py-8 text-center text-[12px] leading-relaxed text-cs2-text-muted">
            <p className="font-medium text-cs2-text-secondary">{t("montage.timelineEmptyTitle")}</p>
            <p className="mt-2">{t("montage.timelineEmptyHint")}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {clips.map((clip, idx) => {
              const tag = normalizeClipType(clip);
              const title = getClipTitle(clip);
              const dur = getClipDurationSeconds(clip);
              const durLabel = dur != null ? `${dur.toFixed(1)}s` : t("montage.timelineUnknownDuration");
              const meta = clip.demo_filename
                ? String(clip.demo_filename).replace(/\.[^.]+$/, "")
                : "";
              const line2 = [meta, durLabel].filter(Boolean).join(" · ");
              return (
                <li
                  key={clip.id}
                  className="rounded-lg border border-cs2-border bg-cs2-bg-input/70 px-3 py-2 text-[12px]"
                >
                  <div className="flex items-start gap-2">
                    <span className="w-6 shrink-0 font-mono text-[10px] text-cs2-text-muted">{String(idx + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${montageTypeTagBadgeClass(tag)}`}
                        >
                          {tag}
                        </span>
                        <span className="text-cs2-text-secondary">{line2}</span>
                      </div>
                      <p className="mt-1 text-cs2-text-primary">{title}</p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <button
                        type="button"
                        className="rounded p-1 text-cs2-text-muted hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary"
                        onClick={() => onMoveUp?.(clip.id)}
                        aria-label={t("montage.timelineAriaUp")}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-cs2-text-muted hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary"
                        onClick={() => onMoveDown?.(clip.id)}
                        aria-label={t("montage.timelineAriaDown")}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-cs2-text-muted hover:bg-red-400/80 hover:text-cs2-text-primary"
                        onClick={() => onRemove?.(clip.id)}
                        aria-label={t("montage.timelineAriaRemove")}
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
