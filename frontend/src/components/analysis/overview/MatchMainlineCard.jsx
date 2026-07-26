import { Crosshair } from "lucide-react";

const TAG_TONES = {
  accent: "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
};

/**
 * Single-line match headline bar (~52–60px).
 * @param {{
 *   mainline?: {
 *     title?: string,
 *     text?: string,
 *     tags?: Array<{ key?: string, label?: string, tone?: string }>,
 *     maxLead?: number,
 *     longestStreak?: number,
 *   }
 * }} props
 */
export default function MatchMainlineCard({ mainline }) {
  const title = mainline?.title || "比赛主线";
  const text = mainline?.text || "";
  const tags = Array.isArray(mainline?.tags) ? mainline.tags.slice(0, 3) : [];
  const maxLead = Number(mainline?.maxLead || 0);
  const longestStreak = Number(mainline?.longestStreak || 0);

  return (
    <section className="flex min-h-[52px] items-center gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-card px-3.5 py-2.5 shadow-sm">
      <div className="flex w-[84px] shrink-0 items-center gap-1.5">
        <Crosshair className="h-3.5 w-3.5 text-cs2-accent" />
        <h2 className="text-[12px] font-bold text-cs2-text-primary">{title}</h2>
      </div>
      <p className="min-w-0 flex-1 truncate text-[12px] text-cs2-text-secondary" title={text}>
        {text}
      </p>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.key || tag.label}
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${TAG_TONES[tag.tone] || TAG_TONES.accent}`}
          >
            {tag.label}
          </span>
        ))}
        {maxLead > 0 ? (
          <span className="inline-flex items-center rounded-md border border-cs2-border/80 bg-cs2-bg-input/40 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-text-secondary">
            最大领先 {maxLead}
          </span>
        ) : null}
        {longestStreak > 0 ? (
          <span className="inline-flex items-center rounded-md border border-cs2-border/80 bg-cs2-bg-input/40 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-text-secondary">
            最长连胜 {longestStreak}
          </span>
        ) : null}
      </div>
    </section>
  );
}
