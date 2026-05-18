import {
  normalizeClipType,
  getClipTitle,
  getClipDurationSeconds,
  getClipScore,
  getClipComment,
  getClipMetaLine,
  montageTypeTagBadgeClass,
} from "../../utils/montageUtils";

export default function RecordedClipCard({ clip, isAdded, onAdd }) {
  if (!clip) return null;
  const tag = normalizeClipType(clip);
  const title = getClipTitle(clip);
  const meta = getClipMetaLine(clip);
  const dur = getClipDurationSeconds(clip);
  const score = getClipScore(clip);
  const ai = getClipComment(clip);
  const durLabel = dur != null ? `${dur.toFixed(1)}s` : "未知时长";
  const sub = [meta, durLabel].filter(Boolean).join(" · ");

  return (
    <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/70 p-4 text-[12px] shadow-inner">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${montageTypeTagBadgeClass(tag)}`}>
          {tag}
        </span>
        <span className="text-cs2-text-secondary">{sub || durLabel}</span>
      </div>
      <p className="mt-1.5 font-medium leading-snug text-cs2-text-primary">{title}</p>
      {ai ? (
        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-cs2-text-secondary">
          <span className="text-cs2-text-muted">AI：</span>
          {ai}
        </p>
      ) : null}
      {score != null ? (
        <p className="mt-1 text-[11px] text-cs2-text-secondary">
          评分：<span className="text-cs2-accent">{Math.round(score)}</span>
        </p>
      ) : null}
      <button
        type="button"
        disabled={isAdded}
        onClick={() => onAdd?.(clip.id)}
        className="mt-2 w-full rounded-md border border-cs2-accent/45 bg-cs2-accent/10 py-1.5 text-[12px] font-semibold text-cs2-accent hover:bg-cs2-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isAdded ? "已在合辑中" : "加入合辑"}
      </button>
    </div>
  );
}
