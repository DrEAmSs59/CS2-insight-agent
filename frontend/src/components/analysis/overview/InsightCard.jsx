/**
 * Compact shared shell for overview insight panels.
 * @param {{
 *   title: string,
 *   icon?: import("react").ReactNode,
 *   summary?: string,
 *   compact?: boolean,
 *   className?: string,
 *   children: import("react").ReactNode,
 * }} props
 */
export default function InsightCard({
  title,
  icon,
  summary,
  compact = false,
  className = "",
  children,
}) {
  return (
    <article
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card ${
        compact ? "p-3" : "p-3.5"
      } ${className}`}
    >
      <header className="mb-1.5 flex shrink-0 items-center gap-2">
        {icon ? (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-cs2-bg-input/60 text-cs2-text-secondary">
            {icon}
          </div>
        ) : null}
        <h3 className="text-[12px] font-bold text-cs2-text-primary">{title}</h3>
      </header>
      {summary ? (
        <p className="mb-1.5 shrink-0 line-clamp-1 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </article>
  );
}
