import { ArrowRight, Shield } from "lucide-react";
import { AccentButton } from "../../AnalysisUi.jsx";
import InsightCard from "./InsightCard";

function teamTextClass(teamKey) {
  if (teamKey === "a") return "text-cs2-team-blue";
  if (teamKey === "b") return "text-cs2-team-amber";
  return "text-cs2-text-primary";
}

function eventLabel(event) {
  return event?.label || "精彩表现";
}

function roundBadge(event) {
  if (event?.roundNumber == null) return "全场";
  const score =
    event.scoreA != null && event.scoreB != null ? ` ${event.scoreA}:${event.scoreB}` : "";
  return `R${event.roundNumber}${score}`;
}

/**
 * @param {{
 *   events?: Array<object>,
 *   onSelectPlayer?: (name: string) => void,
 *   onOpenRound?: (roundNumber: number) => void,
 *   onOpenHighlights?: () => void,
 *   className?: string,
 * }} props
 */
export default function PlayerEventsCard({
  events,
  onSelectPlayer,
  onOpenRound,
  onOpenHighlights,
  className = "",
}) {
  const list = Array.isArray(events) ? events : [];
  const canSelectPlayer = typeof onSelectPlayer === "function";
  const canOpenRound = typeof onOpenRound === "function";
  const canOpenHighlights = typeof onOpenHighlights === "function";

  if (list.length === 0) return null;

  const visible = list.slice(0, 4);

  return (
    <InsightCard
      title="精彩个人事件"
      icon={Shield}
      tone="violet"
      className={className}
    >
      <div className="flex h-full flex-1 flex-col">
        <ul className="flex-1">
          {visible.map((event, index) => {
            const name = event?.playerName || "未知选手";
            const hasRound = event?.roundNumber != null;
            const rowClickable = hasRound && canOpenRound;

            return (
              <li key={`${event.playerName}-${event.subType}-${event.roundNumber}-${index}`}>
                <div
                  role={rowClickable ? "button" : undefined}
                  tabIndex={rowClickable ? 0 : undefined}
                  onClick={() => {
                    if (rowClickable) onOpenRound(event.roundNumber);
                  }}
                  onKeyDown={(e) => {
                    if (!rowClickable) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenRound(event.roundNumber);
                    }
                  }}
                  className={`grid min-h-[26px] grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)_auto] items-center gap-2 rounded-md border-t border-cs2-border-subtle px-1 py-0.5 text-xs first:border-t-0 ${
                    rowClickable ? "cursor-pointer hover:bg-cs2-bg-hover" : ""
                  }`}
                >
                  <span className="whitespace-nowrap font-mono text-[11px] text-cs2-text-muted">
                    {roundBadge(event)}
                  </span>
                  {canSelectPlayer && name ? (
                    <button
                      type="button"
                      className={`truncate text-left font-semibold hover:underline ${teamTextClass(event.teamKey)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectPlayer(name);
                      }}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className={`truncate font-semibold ${teamTextClass(event.teamKey)}`}>{name}</span>
                  )}
                  <span className="shrink-0 text-cs2-text-secondary">{eventLabel(event)}</span>
                </div>
              </li>
            );
          })}
        </ul>
        {canOpenHighlights ? (
          <AccentButton size="sm" className="mt-2 self-start" onClick={onOpenHighlights}>
            前往高光与录制
            <ArrowRight className="h-3 w-3" aria-hidden />
          </AccentButton>
        ) : null}
      </div>
    </InsightCard>
  );
}
