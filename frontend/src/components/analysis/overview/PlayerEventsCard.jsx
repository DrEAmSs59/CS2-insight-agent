import { Crosshair, Flame, Shield, Skull, Zap } from "lucide-react";

function eventIcon(event) {
  const type = event?.type;
  const sub = event?.subType;
  if (type === "clutch" || sub?.startsWith?.("clutch")) return Shield;
  if (type === "ace" || sub === "ace") return Skull;
  if (type === "multikill" || sub === "multikill_4k") return Flame;
  if (type === "first_kills" || sub === "first_kills") return Crosshair;
  if (type === "utility_damage" || sub === "utility_damage") return Zap;
  return Flame;
}

function eventToneClass(event) {
  const type = event?.type;
  if (type === "clutch" || event?.subType?.startsWith?.("clutch")) {
    return "bg-violet-500/10 text-violet-300";
  }
  if (type === "ace" || type === "multikill") {
    return "bg-cs2-accent-soft text-cs2-accent";
  }
  return "bg-cs2-bg-input text-cs2-text-secondary";
}

function teamTextClass(teamKey) {
  if (teamKey === "a") return "text-sky-400";
  if (teamKey === "b") return "text-amber-400";
  return "text-cs2-text-primary";
}

function formatEventLine(event) {
  const name = event?.playerName || "未知选手";
  const label = event?.label || "精彩表现";
  if (event?.roundNumber != null) {
    return { name, rest: `在 R${event.roundNumber} 完成 ${label}` };
  }
  return { name, rest: label };
}

/**
 * @param {{
 *   events?: Array<object>,
 *   onSelectPlayer?: (name: string) => void,
 *   onOpenRound?: (roundNumber: number) => void,
 * }} props
 */
export default function PlayerEventsCard({ events, onSelectPlayer, onOpenRound }) {
  const list = Array.isArray(events) ? events : [];
  const canSelectPlayer = typeof onSelectPlayer === "function";
  const canOpenRound = typeof onOpenRound === "function";

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
          <Shield className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">精彩个人事件</h3>
      </header>

      {list.length === 0 ? (
        <p className="mt-6 text-center text-[11px] text-cs2-text-muted">本场暂无突出的个人事件。</p>
      ) : (
        <ul className="mt-auto space-y-1.5">
          {list.map((event, index) => {
            const Icon = eventIcon(event);
            const { name, rest } = formatEventLine(event);
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
                  className={`flex items-start gap-2 rounded-lg border border-cs2-border/60 bg-cs2-bg-input/25 px-2 py-1.5 ${
                    rowClickable ? "cursor-pointer hover:border-cs2-accent/35" : ""
                  }`}
                >
                  <div
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${eventToneClass(event)}`}
                  >
                    <Icon className="h-3 w-3" />
                  </div>
                  <p className="min-w-0 flex-1 text-[11px] leading-snug text-cs2-text-secondary">
                    {canSelectPlayer && name ? (
                      <button
                        type="button"
                        className={`font-semibold hover:underline ${teamTextClass(event.teamKey)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectPlayer(name);
                        }}
                      >
                        {name}
                      </button>
                    ) : (
                      <span className={`font-semibold ${teamTextClass(event.teamKey)}`}>{name}</span>
                    )}{" "}
                    {rest}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
