import { Skull, Sparkles } from "lucide-react";
import QueueAddButton from "../../components/QueueAddButton";
import { useT } from "../../i18n/useT.js";
import QueueActionCard from "./QueueActionCard";

export default function QuickQueueActions({
  currentPlayer,
  onAddHighlights,
  onAddFails,
  canAddHighlights,
  canAddFails,
  disabled,
}) {
  const t = useT();
  return (
    <section aria-labelledby="analysis-quick-queue-title" data-testid="analysis-quick-queue" className="min-w-0">
      <h3 id="analysis-quick-queue-title" className="mb-2 text-[13px] font-semibold text-cs2-text-primary">{t("analysis.quickQueueTitle")}</h3>
      <div className="grid grid-cols-2 gap-2">
        <QueueActionCard icon={Sparkles} tone="bg-cs2-accent-soft text-cs2-accent"
          title={t("analysis.quickQueueHighlights")} subtitle={currentPlayer}>
          <QueueAddButton disabled={disabled || !canAddHighlights} onAdd={onAddHighlights}
            ariaLabel={t("actionbar.addCurrentPlayerHighlights", { player: currentPlayer })} />
        </QueueActionCard>
        <QueueActionCard icon={Skull} tone="bg-cs2-rose-surface text-cs2-rose-on-surface"
          title={t("analysis.quickQueueFails")} subtitle={currentPlayer}>
          <QueueAddButton disabled={disabled || !canAddFails} onAdd={onAddFails}
            ariaLabel={t("actionbar.addCurrentPlayerFails", { player: currentPlayer })} />
        </QueueActionCard>
      </div>
    </section>
  );
}
