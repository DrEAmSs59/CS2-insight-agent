const variants = {
  orange: "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent",
  green: "border-cs2-emerald-surface bg-cs2-emerald-surface text-cs2-emerald-on-surface",
  red: "border-cs2-rose-surface bg-cs2-rose-surface text-cs2-rose-on-surface",
  yellow: "border-cs2-amber-surface bg-cs2-amber-surface text-cs2-amber-on-surface",
  neutral: "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary",
};

export default function Badge({ variant = "neutral", children, className = "", ...rest }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
