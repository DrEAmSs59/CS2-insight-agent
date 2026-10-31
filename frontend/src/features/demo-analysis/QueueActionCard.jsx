export default function QueueActionCard({ icon: Icon, tone, title, subtitle, category, children }) {
  return (
    <article data-category={category} className="flex flex-col gap-2.5 rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-cs2-text-primary">{title}</p>
          <p className="truncate text-[11.5px] text-cs2-text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </article>
  );
}
