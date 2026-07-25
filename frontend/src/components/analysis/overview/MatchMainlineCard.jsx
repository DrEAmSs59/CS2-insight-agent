import { Crosshair } from "lucide-react";

const TAG_TONES = {
  accent: "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
};

/**
 * @param {{ mainline?: { title?: string, text?: string, tags?: Array<{ key?: string, label?: string, tone?: string }> } }} props
 */
export default function MatchMainlineCard({ mainline }) {
  const title = mainline?.title || "比赛主线";
  const text = mainline?.text || "";
  const tags = Array.isArray(mainline?.tags) ? mainline.tags : [];

  return (
    <section className="rounded-xl border border-cs2-border bg-cs2-bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent">
          <Crosshair className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-bold text-cs2-text-primary">{title}</h2>
          {text ? (
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">{text}</p>
          ) : null}
          {tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag.key || tag.label}
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold ${TAG_TONES[tag.tone] || TAG_TONES.accent}`}
                >
                  {tag.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
