const variants = {
  default: "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary",
  ghost: "border-transparent bg-transparent text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary",
  danger: "border-cs2-border-error/35 bg-cs2-rose-surface text-cs2-rose-on-surface hover:brightness-110",
};

const sizes = {
  sm: "h-7 w-7 rounded-md",
  md: "h-9 w-9 rounded-lg",
  lg: "h-11 w-11 rounded-lg",
};

export default function IconButton({
  label,
  variant = "default",
  size = "md",
  type = "button",
  className = "",
  children,
  ...rest
}) {
  if (!label && import.meta.env?.DEV) {
    console.warn("[ui] IconButton requires an accessible label");
  }

  return (
    <button
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={`inline-flex shrink-0 items-center justify-center border transition-colors disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-cs2-bg-page ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
