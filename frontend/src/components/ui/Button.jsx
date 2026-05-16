const variants = {
  primary:
    "bg-cs2-accent text-cs2-text-on-accent font-semibold shadow-md shadow-cs2-accent/25 hover:brightness-110 disabled:opacity-50",
  secondary:
    "border border-cs2-border bg-cs2-bg-input text-cs2-text-primary font-semibold hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-45",
  ghost:
    "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:opacity-40",
  danger:
    "border border-cs2-border-error/35 bg-cs2-rose-surface text-cs2-rose-on-surface font-semibold hover:bg-cs2-rose-surface disabled:opacity-40",
};

const sizes = {
  sm: "h-7 px-2 text-[11px] rounded-md gap-1",
  md: "h-9 px-3.5 text-[12px] rounded-lg gap-1.5",
  lg: "h-11 px-5 text-[13px] rounded-lg gap-2",
};

export default function Button({
  variant = "primary",
  size = "md",
  type = "button",
  children,
  className = "",
  ...rest
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center transition-colors disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-cs2-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-cs2-bg-page ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
