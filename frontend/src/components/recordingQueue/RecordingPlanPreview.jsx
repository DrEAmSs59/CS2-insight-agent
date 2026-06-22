import { Clapperboard } from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { getRecordingPlanPreview, planPreviewToTokens } from "../../utils/recordingPlanPreview";

function chipClass(token) {
  if (token === "K") {
    return "rounded border border-cs2-accent/40 bg-cs2-accent/15 px-1 py-px text-[9px] font-bold text-cs2-accent";
  }
  if (token === "V") {
    return "rounded border border-cyan-500/35 bg-cs2-cyan-surface px-1 py-px text-[9px] font-bold text-cs2-cyan-on-surface";
  }
  if (token === "→") {
    return "px-0.5 text-[9px] font-bold text-cs2-text-muted";
  }
  return "px-0.5 text-[9px] text-cs2-text-muted";
}

function chipLabel(token, t) {
  if (token === "K") return t("queue.planChipKiller");
  if (token === "V") return t("queue.planChipVictim");
  return token;
}

/**
 * @param {{
 *   item: import("../../stores/recordingQueueStore").RecordingQueueItem,
 *   globalPacing: Record<string, unknown>,
 *   compact?: boolean,
 *   embedded?: boolean,
 * }} props
 */
export default function RecordingPlanPreview({ item, globalPacing, compact = false, embedded = false }) {
  const t = useT();
  const plan = getRecordingPlanPreview(item, globalPacing);
  if (!plan) return null;

  const tokens = planPreviewToTokens(plan);
  const titleKey = `queue.planVariant_${plan.variant}`;
  const title = t(titleKey, {
    killerSegCount: plan.killerSegCount ?? 0,
    povSegCount: plan.povSegCount ?? 0,
    eventCount: plan.eventCount ?? 0,
    totalSegCount: plan.totalSegCount ?? 0,
  });
  const descKey = `queue.planDesc_${plan.variant}`;
  const desc = t(descKey, {
    killerSegCount: plan.killerSegCount ?? 0,
    povSegCount: plan.povSegCount ?? 0,
    eventCount: plan.eventCount ?? 0,
    totalSegCount: plan.totalSegCount ?? 0,
  });

  const tokenRow =
    tokens.length > 0 ? (
      <div className={`flex flex-wrap items-center gap-1 ${embedded || compact ? "mt-1" : "mt-2"}`} aria-label={title}>
        {tokens.map((tok, i) => (
          <span key={`${tok}-${i}`} className={chipClass(tok)}>
            {chipLabel(tok, t)}
          </span>
        ))}
      </div>
    ) : null;

  if (compact) {
    return (
      <div className="text-[9px] leading-relaxed text-cs2-text-muted">
        <span className="font-semibold text-cs2-text-secondary">{title}</span>
        {tokens.length > 0 ? (
          <span className="ml-1 inline-flex flex-wrap items-center gap-0.5 align-middle">
            {tokens.map((tok, i) => (
              <span key={`${tok}-${i}`} className={chipClass(tok)}>
                {chipLabel(tok, t)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    );
  }

  if (embedded) {
    return (
      <div>
        <p className="text-[10px] font-semibold leading-snug text-cs2-text-secondary">{title}</p>
        <p className="mt-1 text-[9px] leading-relaxed text-cs2-text-muted">{desc}</p>
        {tokenRow}
        <p className="mt-1.5 text-[9px] text-cs2-text-muted/80">
          {t("queue.planPreviewFootnote", { n: plan.totalSegCount ?? 0 })}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border border-cs2-border-subtle bg-cs2-bg-input/60 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-primary">
        <Clapperboard className="h-3 w-3 shrink-0 text-cs2-text-muted" />
        {t("queue.planPreviewTitle")}
      </div>
      <p className="text-[10px] font-semibold leading-snug text-cs2-text-secondary">{title}</p>
      <p className="mt-1 text-[9px] leading-relaxed text-cs2-text-muted">{desc}</p>
      {tokenRow}
      <p className="mt-1.5 text-[9px] text-cs2-text-muted/80">
        {t("queue.planPreviewFootnote", { n: plan.totalSegCount ?? 0 })}
      </p>
    </div>
  );
}
