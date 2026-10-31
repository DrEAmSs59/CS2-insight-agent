import { IconTile } from "../../AnalysisUi.jsx";

/**
 * Shared shell for overview insight panels, styled like the highlight cards:
 * tinted icon tile, 13px title and an optional one-line summary.
 * @param {{
 *   title: string,
 *   icon?: import("react").ComponentType<{ className?: string }>,
 *   tone?: "neutral" | "accent" | "blue" | "amber" | "green" | "rose" | "violet",
 *   summary?: string,
 *   className?: string,
 *   children: import("react").ReactNode,
 * }} props
 */
export default function InsightCard({
  title,
  icon,
  tone = "neutral",
  summary,
  className = "",
  children,
}) {
  return (
    <article className={`analysis-card flex h-full min-h-0 flex-col overflow-hidden p-3 ${className}`}>
      <header className="mb-2 flex shrink-0 items-center gap-2.5">
        {icon ? <IconTile icon={icon} tone={tone} /> : null}
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-cs2-text-primary">{title}</h3>
          {summary ? (
            <p className="truncate text-[11.5px] text-cs2-text-muted" title={summary}>{summary}</p>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </article>
  );
}
