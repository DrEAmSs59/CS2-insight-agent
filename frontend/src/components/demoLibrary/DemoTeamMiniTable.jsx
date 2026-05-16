import DemoPlayerMiniRow from "./DemoPlayerMiniRow";

export default function DemoTeamMiniTable({
  label,
  score,
  players,
  showAdr,
  showRating,
  highlightQuery,
  steamHighlightQuery,
  focusPlayerName,
}) {
  const q = String(highlightQuery ?? "").trim().toLowerCase();
  const sq = String(steamHighlightQuery ?? "").trim().toLowerCase();

  const rowHighlight = (playerName, steam) => {
    const pn = String(playerName ?? "").toLowerCase();
    const fp = focusPlayerName ? String(focusPlayerName).trim().toLowerCase() : "";
    if (fp && pn === fp) return true;
    if (!q && !sq) return false;
    if (q && pn.includes(q)) return true;
    const sid = steam ? String(steam).toLowerCase() : "";
    if (sq && sid && sid.includes(sq)) return true;
    return false;
  };

  return (
    <div className="flex min-h-0 flex-col rounded border border-cs2-border bg-cs2-bg-input/50">
      <div className="flex items-baseline justify-between gap-2 border-b border-cs2-border px-2 py-1">
        <span className="text-[12px] font-bold text-cs2-text-primary">{label}</span>
        <span className="font-mono text-[12px] font-semibold tabular-nums text-cs2-accent">
          {score != null ? score : "—"}
        </span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-cs2-bg-page/85 text-[9px] uppercase tracking-wide text-cs2-text-muted">
            <tr>
              <th className="px-1 py-0.5 text-left font-semibold">选手</th>
              <th className="w-7 px-1 py-0.5 text-right font-semibold">K</th>
              <th className="w-7 px-1 py-0.5 text-right font-semibold">A</th>
              <th className="w-7 px-1 py-0.5 text-right font-semibold">D</th>
              <th className="w-9 px-1 py-0.5 text-right font-semibold">KD</th>
              {showAdr ? (
                <th className="w-9 px-1 py-0.5 text-right font-semibold">ADR</th>
              ) : null}
              {showRating ? (
                <th className="w-10 px-1 py-0.5 text-right font-semibold">Rt</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {players.map((p, idx) => (
              <DemoPlayerMiniRow
                key={`${label}-${idx}`}
                name={p.name}
                kills={p.kills}
                assists={p.assists}
                deaths={p.deaths}
                kd={p.kd}
                adr={p.adr}
                rating={p.rating}
                steam={p.steam}
                showAdr={showAdr}
                showRating={showRating}
                highlight={rowHighlight(p.name, p.steam)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
