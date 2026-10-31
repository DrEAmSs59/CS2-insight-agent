import PlayerIdentityAvatar from "./cosmetics/PlayerIdentityAvatar";

/**
 * Shared building blocks for the Demo analysis workspaces. They follow the
 * "Highlights & recording" view: 13px section titles with a muted note,
 * subtle 10px cards, tinted icon tiles, outlined accent actions and pill chips.
 */

const TILE_TONES = {
  neutral: "bg-cs2-bg-input text-cs2-text-secondary",
  accent: "bg-cs2-accent-soft text-cs2-accent",
  blue: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
  amber: "bg-cs2-amber-surface text-cs2-amber-on-surface",
  green: "bg-cs2-emerald-surface text-cs2-emerald-on-surface",
  rose: "bg-cs2-rose-surface text-cs2-rose-on-surface",
  violet: "bg-cs2-violet-surface text-cs2-violet-on-surface",
};

const ACTION_SIZES = {
  md: "h-8 gap-1.5 px-3 text-xs",
  sm: "h-7 gap-1 px-2.5 text-[11.5px]",
};

const ACTION_VARIANTS = {
  outline: "border-cs2-accent/60 bg-transparent text-cs2-accent hover:bg-cs2-accent-soft",
  solid: "border-cs2-accent bg-cs2-accent text-black hover:brightness-110",
  neutral: "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary hover:border-cs2-text-muted hover:text-cs2-text-primary",
};

export function IconTile({ icon: Icon, tone = "neutral", size = "md", className = "" }) {
  const box = size === "sm" ? "h-7 w-7 rounded-md" : "h-8 w-8 rounded-lg";
  return (
    <span className={`flex shrink-0 items-center justify-center ${box} ${TILE_TONES[tone] || TILE_TONES.neutral} ${className}`} aria-hidden>
      {Icon ? <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : null}
    </span>
  );
}

/** Section title row: 13px title on the left, a muted note or action on the right. */
export function SectionHeader({ title, description, icon, tone = "neutral", action, id, level = 3, className = "" }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">
        {icon ? <IconTile icon={icon} tone={tone} size="sm" /> : null}
        <Heading id={id} className="truncate text-[13px] font-semibold text-cs2-text-primary">{title}</Heading>
      </div>
      {action ?? (description ? <span className="text-xs text-cs2-text-muted">{description}</span> : null)}
    </div>
  );
}

export function AnalysisCard({ as: Tag = "section", className = "", children, ...rest }) {
  return (
    <Tag className={`analysis-card ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

/** A labelled number with a tinted icon tile, used for headline stats. */
export function StatTile({ icon, label, value, detail, tone = "neutral", testId, className = "" }) {
  return (
    <div data-testid={testId} className={`analysis-card flex min-w-0 items-center gap-3 rounded-[10px] px-3 py-2.5 ${className}`}>
      {icon ? <IconTile icon={icon} tone={tone} /> : null}
      <div className="min-w-0">
        <p className="truncate text-xs text-cs2-text-muted">{label}</p>
        <p className="mt-0.5 truncate font-mono text-lg font-bold tabular-nums text-cs2-text-primary">{value}</p>
        {detail ? <p className="truncate text-[11.5px] text-cs2-text-muted">{detail}</p> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, children, className = "" }) {
  return (
    <div className={`flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-cs2-border p-8 text-center ${className}`}>
      <div>
        {Icon ? <Icon className="mx-auto h-7 w-7 text-cs2-text-muted" aria-hidden /> : null}
        {title ? <h2 className="mt-3 text-[13px] font-semibold text-cs2-text-primary">{title}</h2> : null}
        {hint ? <p className="mt-1 text-xs text-cs2-text-muted">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** One-line usage hint, same strip as the queue tip in highlights. */
export function TipStrip({ icon: Icon, children, testId, className = "" }) {
  return (
    <p data-testid={testId} className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg bg-cs2-bg-input/60 px-3 py-2 text-xs text-cs2-text-secondary ${className}`}>
      {Icon ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-cs2-accent/60 text-cs2-accent" aria-hidden>
          <Icon className="h-3 w-3" />
        </span>
      ) : null}
      {children}
    </p>
  );
}

/** Outlined (or solid) accent action, matching the "+ Add to queue" control. */
export function AccentButton({ variant = "outline", size = "md", type = "button", className = "", children, ...rest }) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 disabled:cursor-not-allowed disabled:opacity-45 ${ACTION_SIZES[size] || ACTION_SIZES.md} ${ACTION_VARIANTS[variant] || ACTION_VARIANTS.outline} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Segmented control: a row of mutually exclusive options. */
export function Segmented({ options, value, onChange, ariaLabel, className = "", size = "md" }) {
  return (
    <div role="group" aria-label={ariaLabel} className={`analysis-segmented ${size === "sm" ? "analysis-segmented--sm" : ""} ${className}`}>
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            aria-label={option.ariaLabel}
            data-tone={option.tone}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Player identity row used at the top of player-focused views: avatar,
 * name, a coloured caption and a short stat line.
 */
export function FocusedPlayerHeader({ player, avatarUrl = "", name, caption, captionColor, fallbackTone = "blue", stats = [], actions, headingLevel = 2 }) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <PlayerIdentityAvatar player={player} avatarUrl={avatarUrl} fallbackTone={fallbackTone} className="h-9 w-9 text-xs" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <Heading className="truncate text-[15px] font-bold text-cs2-text-primary">{name}</Heading>
            {caption ? <p className="text-[10px] font-semibold tracking-wide" style={captionColor ? { color: captionColor } : undefined}>{caption}</p> : null}
          </div>
          {stats.length ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-cs2-text-muted">
              {stats.map(([label, value]) => (
                <span key={label}><strong className="mr-1 font-mono text-cs2-text-primary">{value}</strong>{label}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}
