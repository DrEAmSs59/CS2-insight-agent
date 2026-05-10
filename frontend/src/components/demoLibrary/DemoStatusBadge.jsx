import { classifyDemoStatus } from "../../utils/demoLibraryDisplay";

const styles = {
  pending: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  loaded: "border-sky-500/35 bg-sky-500/10 text-sky-200",
  parsing: "border-cs2-orange/45 bg-cs2-orange/12 text-cs2-orange",
  done: "border-emerald-500/35 bg-emerald-500/10 text-emerald-200",
  error: "border-red-500/40 bg-red-500/10 text-red-200",
  meta_missing: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  unknown: "border-white/10 bg-white/[0.04] text-zinc-400",
};

export default function DemoStatusBadge({ item, className = "" }) {
  const c = classifyDemoStatus(item);
  const st = styles[c.kind] || styles.unknown;
  return (
    <span
      className={`inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${st} ${className}`}
      title={c.tooltip || c.label}
    >
      <span className="truncate">{c.label}</span>
    </span>
  );
}
