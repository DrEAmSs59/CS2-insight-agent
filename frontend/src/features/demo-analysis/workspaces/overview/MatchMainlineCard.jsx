import { Crosshair } from "lucide-react";
import { IconTile } from "../../AnalysisUi.jsx";

const TAG_TONES = {
  accent: "bg-cs2-accent-soft text-cs2-accent",
  amber: "bg-cs2-amber-surface text-cs2-amber-on-surface",
  blue: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
  violet: "bg-cs2-violet-surface text-cs2-violet-on-surface",
};

const TAG_SHAPE = "inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-semibold";

/**
 * Single-line match headline bar.
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
    <section className="analysis-card flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <IconTile icon={Crosshair} tone="accent" />
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-cs2-text-primary">{title}</h2>
          <p className="truncate text-xs text-cs2-text-secondary" title={text}>
            {text}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.key || tag.label}
            data-overview-tone-tag
            className={`${TAG_SHAPE} ${TAG_TONES[tag.tone] || TAG_TONES.accent}`}
          >
            {tag.label}
          </span>
        ))}
        {maxLead > 0 ? (
          <span data-overview-neutral-tag className={`${TAG_SHAPE} bg-cs2-bg-input text-cs2-text-secondary`}>
            最大领先 {maxLead}
          </span>
        ) : null}
        {longestStreak > 0 ? (
          <span data-overview-neutral-tag className={`${TAG_SHAPE} bg-cs2-bg-input text-cs2-text-secondary`}>
            最长连胜 {longestStreak}
          </span>
        ) : null}
      </div>
    </section>
  );
}
