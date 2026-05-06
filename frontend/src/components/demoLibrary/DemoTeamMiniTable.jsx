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
    <div className="flex min-h-0 flex-col rounded border border-white/[0.06] bg-black/30">
      <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.06] px-2 py-1">
        <span className="text-[11px] font-bold text-zinc-200">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-cs2-orange">
          {score != null ? score : "—"}
        </span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead className="sticky top-0 bg-black/55 text-[9px] uppercase tracking-wide text-zinc-600">
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
