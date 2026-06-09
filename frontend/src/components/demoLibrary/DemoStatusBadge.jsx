import { classifyDemoStatus } from "../../utils/demoLibraryDisplay";
import { useT } from "../../i18n/useT.js";

const styles = {
  pending: "border-cs2-amber-surface bg-cs2-amber-surface text-cs2-amber-on-surface",
  loaded: "border-cs2-cyan-surface bg-cs2-cyan-surface text-cs2-cyan-on-surface",
  parsing: "border-cs2-accent/45 bg-cs2-accent/12 text-cs2-accent",
  done: "border-cs2-emerald-surface bg-cs2-emerald-surface text-cs2-emerald-on-surface",
  error: "border-cs2-red-surface bg-cs2-red-surface text-cs2-red-on-surface",
  meta_missing: "border-cs2-border-subtle bg-cs2-bg-input text-cs2-text-secondary",
  unknown: "border-cs2-border bg-cs2-bg-hover text-cs2-text-secondary",
};

export default function DemoStatusBadge({ item, className = "" }) {
  const t = useT();
  const c = classifyDemoStatus(item);
  const label = t(c.labelKey, c.labelParams);
  const st = styles[c.kind] || styles.unknown;
  return (
    <span
      className={`inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${st} ${className}`}
      title={c.tooltip || label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
