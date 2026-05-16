export default function Card({ title, hint, children, className = "", fill = false }) {
  return (
    <section
      className={`rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm ${
        fill ? "flex min-h-0 flex-col flex-1" : "flex flex-col"
      } ${className}`}
    >
      {title && (
        <div className="mb-4 shrink-0">
          <h2 className="text-[15px] font-bold tracking-wide text-cs2-text-primary">{title}</h2>
          {hint && <p className="mt-1 text-[13px] leading-relaxed text-cs2-text-muted">{hint}</p>}
        </div>
      )}
      {fill ? <div className="flex min-h-0 flex-col flex-1">{children}</div> : children}
    </section>
  );
}
