import { useT } from "../i18n/useT.js";

/** i18n key for POV HUD conflict message (CommonParamsModal and RecordWarmupModal). */
export const POV_CONFLICT_HUD = "record.hudPovConflict";

export function RecordingHudCard({
  title,
  description,
  checked,
  onChange,
  disabled = false,
  disabledReason,
}) {
  const t = useT();
  const disabledMsg = disabledReason ? t(disabledReason) : undefined;
  return (
    <label
      className={`flex flex-col justify-center rounded-lg border px-3 py-2.5 transition-colors ${
        checked && !disabled ? "border-cs2-accent/30 bg-cs2-accent-soft" : "border-cs2-border bg-cs2-bg-input"
      } ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-cs2-accent/50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-cs2-text-primary">{title}</p>
          {description ? <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{description}</p> : null}
        </div>
        <input
          type="checkbox"
          aria-label={title}
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            if (disabled) return;
            onChange(e.target.checked);
          }}
          className="mt-1 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-accent disabled:opacity-50"
        />
      </div>
      {disabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">{disabledMsg}</p>
      ) : null}
    </label>
  );
}
