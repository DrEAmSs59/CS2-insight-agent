import { useRoundCompilationPlan } from "../../recording/useRoundCompilationPlans";
import { useT } from "../../i18n/useT";

export default function RoundCompilationPlan({ item }) {
  const state = useRoundCompilationPlan(item);
  const t = useT();
  if (!state || state.status === "loading") return <p className="text-xs text-cs2-text-muted">{t("ftd.planLoading")}</p>;
  if (state.status === "error") return <div className="text-xs text-cs2-text-error" role="alert">
    {t(state.errorKey)}
    {state.retry && <button className="ml-2 underline" onClick={state.retry}>{t("ftd.planRetry")}</button>}
  </div>;
  const { plan } = state;
  return <div className="space-y-2 text-xs text-cs2-text-secondary">
    <p>{t("ftd.planSummary", { n: plan.active_segments.length, seconds: plan.estimated_duration_sec.toFixed(1) })}</p>
    <div className="flex h-3 overflow-hidden rounded bg-cs2-bg-input" aria-hidden="true">
      {plan.active_segments.map((segment) => <div key={segment.segment_index}
        className="border-r border-cs2-bg-input bg-cs2-accent/70"
        style={{ flex: segment.end_tick - segment.start_tick }} />)}
    </div>
    <details><summary className="cursor-pointer">{t("ftd.planDetails")}</summary>
      <ul className="mt-2 space-y-1 font-mono">
        {plan.active_segments.map((segment) => <li key={segment.segment_index}>
          R{segment.round} · {((segment.end_tick - segment.start_tick) / plan.tick_rate).toFixed(1)}s
          <span className="ml-2 text-cs2-text-muted">Tick {segment.start_tick}–{segment.end_tick}</span>
        </li>)}
      </ul>
    </details>
    {!!plan.disabled_segments?.length && <p>{t("ftd.planSkipped", { n: plan.disabled_segments.length })}</p>}
  </div>;
}
