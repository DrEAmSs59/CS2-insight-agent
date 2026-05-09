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
    <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-[11px] shadow-inner">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${montageTypeTagBadgeClass(tag)}`}>
          {tag}
        </span>
        <span className="text-zinc-400">{sub || durLabel}</span>
      </div>
      <p className="mt-1.5 font-medium leading-snug text-zinc-200">{title}</p>
      {ai ? (
        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-zinc-400">
          <span className="text-zinc-500">AI：</span>
          {ai}
        </p>
      ) : null}
      {score != null ? (
        <p className="mt-1 text-[10px] text-zinc-400">
          评分：<span className="text-cs2-orange">{Math.round(score)}</span>
        </p>
      ) : null}
      <button
        type="button"
        disabled={isAdded}
        onClick={() => onAdd?.(clip.id)}
        className="mt-2 w-full rounded-md border border-cs2-orange/45 bg-cs2-orange/10 py-1.5 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isAdded ? "已在合辑中" : "加入合辑"}
      </button>
    </div>
  );
}
