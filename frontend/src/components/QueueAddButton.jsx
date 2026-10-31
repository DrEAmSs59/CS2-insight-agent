import { Check, Plus, X } from "lucide-react";
import { useT } from "../i18n/useT.js";

const SIZES = {
  md: "h-8 gap-1.5 px-3 text-xs",
  sm: "h-7 gap-1 px-2.5 text-[11.5px]",
};

/**
 * The single "add to recording queue" control used across the analysis views.
 * Unqueued: "+ <label>". Queued: "✓ <queuedLabel> ×", which removes it again.
 *
 * @param {{
 *   queued?: boolean,
 *   onAdd?: () => void,
 *   onRemove?: () => void,
 *   label?: string,
 *   queuedLabel?: string,
 *   size?: "md" | "sm",
 *   solid?: boolean,
 *   disabled?: boolean,
 *   className?: string,
 *   ariaLabel?: string,
 * }} props
 */
export default function QueueAddButton({
  queued = false,
  onAdd,
  onRemove,
  label,
  queuedLabel,
  size = "md",
  solid = false,
  disabled = false,
  className = "",
  ariaLabel,
}) {
  const t = useT();
  const base = `inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 disabled:cursor-not-allowed disabled:opacity-45 ${SIZES[size] ?? SIZES.md}`;
  if (queued) {
    return (
      <button
        type="button"
        data-queued="true"
        disabled={!onRemove}
        title={onRemove ? t("analysis.queueRemoveTitle") : undefined}
        aria-label={onRemove ? t("analysis.queueRemoveAria", { label: queuedLabel ?? t("analysis.queueAdded") }) : undefined}
        onClick={(event) => {
          event.stopPropagation();
          onRemove?.();
        }}
        className={`${base} group/queue border-transparent bg-cs2-emerald-surface text-cs2-emerald-on-surface hover:bg-cs2-rose-surface hover:text-cs2-rose-on-surface disabled:opacity-100 ${className}`}
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
        {queuedLabel ?? t("analysis.queueAdded")}
        {onRemove ? <X className="h-3 w-3 opacity-70" aria-hidden /> : null}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-queued="false"
      disabled={disabled || !onAdd}
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onAdd?.();
      }}
      className={`${base} ${
        solid
          ? "border-cs2-accent bg-cs2-accent text-black hover:brightness-110"
          : "border-cs2-accent/60 bg-transparent text-cs2-accent hover:bg-cs2-accent-soft"
      } ${className}`}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
      {label ?? t("analysis.queueAdd")}
    </button>
  );
}
