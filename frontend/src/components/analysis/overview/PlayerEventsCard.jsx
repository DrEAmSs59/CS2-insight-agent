import { useState } from "react";
import { Shield } from "lucide-react";
import InsightCard from "./InsightCard";

function teamTextClass(teamKey) {
  if (teamKey === "a") return "text-sky-400";
  if (teamKey === "b") return "text-amber-400";
  return "text-cs2-text-primary";
}

function eventLabel(event) {
  return event?.label || "精彩表现";
}

/**
 * @param {{
 *   events?: Array<object>,
 *   onSelectPlayer?: (name: string) => void,
 *   onOpenRound?: (roundNumber: number) => void,
 *   className?: string,
 * }} props
 */
export default function PlayerEventsCard({ events, onSelectPlayer, onOpenRound, className = "" }) {
  const list = Array.isArray(events) ? events : [];
  const [expanded, setExpanded] = useState(false);
  const canSelectPlayer = typeof onSelectPlayer === "function";
  const canOpenRound = typeof onOpenRound === "function";

  if (list.length === 0) return null;

  const visible = expanded ? list : list.slice(0, 4);
  const hiddenCount = Math.max(0, list.length - 4);

  return (
    <InsightCard
      title="精彩个人事件"
      icon={<Shield className="h-3.5 w-3.5 text-violet-400" />}
      compact
      className={`min-h-[135px] xl:min-h-[145px] ${className}`}
    >
      <ul>
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
                className={`grid min-h-[26px] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-cs2-border/40 py-1 text-[11px] first:border-t-0 ${
                  rowClickable ? "cursor-pointer hover:text-cs2-accent" : ""
                }`}
              >
                <span className="font-mono text-[10px] text-cs2-text-muted">
                  {hasRound ? `R${event.roundNumber}` : "全场"}
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
      {!expanded && hiddenCount > 0 ? (
        <button
          type="button"
          className="mt-1 text-[10px] font-semibold text-cs2-accent hover:underline"
          onClick={() => setExpanded(true)}
        >
          查看全部 {hiddenCount} 条
        </button>
      ) : null}
    </InsightCard>
  );
}
