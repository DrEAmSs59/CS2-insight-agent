import { Crosshair } from "lucide-react";

const TAG_TONES = {
  accent: "bg-cs2-accent-soft text-cs2-accent",
  amber: "bg-cs2-amber-surface text-cs2-amber-on-surface",
  blue: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
  violet: "bg-cs2-violet-surface text-cs2-violet-on-surface",
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
    <section className="flex min-h-[52px] items-center gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-card px-3.5 py-2.5">
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
            data-overview-tone-tag
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${TAG_TONES[tag.tone] || TAG_TONES.accent}`}
          >
            {tag.label}
          </span>
        ))}
        {maxLead > 0 ? (
          <span data-overview-neutral-tag className="inline-flex items-center rounded-md bg-cs2-bg-input px-1.5 py-0.5 text-[10px] font-semibold text-cs2-text-secondary">
            最大领先 {maxLead}
          </span>
        ) : null}
        {longestStreak > 0 ? (
          <span data-overview-neutral-tag className="inline-flex items-center rounded-md bg-cs2-bg-input px-1.5 py-0.5 text-[10px] font-semibold text-cs2-text-secondary">
            最长连胜 {longestStreak}
          </span>
        ) : null}
      </div>
    </section>
  );
}
