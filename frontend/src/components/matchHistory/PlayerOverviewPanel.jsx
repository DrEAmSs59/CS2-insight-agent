const RATING_TIERS = [
  { min: 25000, color: "#f5c542" },
  { min: 20000, color: "#ff5b5b" },
  { min: 15000, color: "#ff6ec1" },
  { min: 10000, color: "#b478ff" },
  { min: 5000,  color: "#6aa9ff" },
  { min: 0,     color: "#9aa0a8" },
];

function getRatingColor(rating) {
  return (RATING_TIERS.find((t) => rating >= t.min) || RATING_TIERS[RATING_TIERS.length - 1]).color;
}

function StatCol({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center gap-0.5 border-r border-cs2-border last:border-r-0 px-3 py-4">
      <div className="font-mono text-[22px] font-bold text-cs2-text-primary">{value}</div>
      {sub && (
        <div className={`font-mono text-[11px] ${sub.startsWith("↑") ? "text-[#2eb86a]" : sub.startsWith("↓") ? "text-[#e0556a]" : "text-cs2-text-muted"}`}>
          {sub}
        </div>
      )}
      <div className="text-[11px] text-cs2-text-muted">{label}</div>
    </div>
  );
}

export default function PlayerOverviewPanel({ player, stats }) {
  if (!player) return null;
  const ratingColor = getRatingColor(player.cs_rating || 0);

  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: "340px 1fr" }}>
      {/* Player Card */}
      <div className="rounded-[10px] border border-cs2-border bg-cs2-bg-card p-4 flex items-start gap-3">
        <div className="relative shrink-0">
          {player.avatar ? (
            <img
              src={player.avatar}
              alt={player.name}
              className="h-16 w-16 rounded-lg object-cover"
            />
          ) : (
            <div className="h-16 w-16 rounded-lg bg-cs2-bg-elevated flex items-center justify-center text-2xl font-bold text-cs2-text-muted">
              {(player.name || "?")[0].toUpperCase()}
            </div>
          )}
          <div className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-cs2-bg-card bg-[#2eb86a]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold text-cs2-text-primary">{player.name}</div>

          {player.cs_rating > 0 && (
            <div
              className="mt-1 inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 font-mono text-[11px] font-bold"
              style={{ color: ratingColor, borderColor: ratingColor + "40", background: ratingColor + "18" }}
            >
              CS RATING &nbsp;
              {player.cs_rating.toLocaleString()}
              {player.cs_rating_delta != null && (
                <span style={{ color: player.cs_rating_delta >= 0 ? "#2eb86a" : "#e0556a" }}>
                  {player.cs_rating_delta >= 0 ? " ▲" : " ▼"} {Math.abs(player.cs_rating_delta)}
                </span>
              )}
            </div>
          )}

          {player.steam_id64 && (
            <div className="mt-1.5 font-mono text-[10px] text-cs2-text-muted">{player.steam_id64}</div>
          )}
        </div>
      </div>

      {/* Stats Card */}
      <div className="rounded-[10px] border border-cs2-border bg-cs2-bg-card flex items-center">
        {stats && (
          <div className="flex w-full divide-x divide-cs2-border">
            <StatCol label={`最近 ${(stats.wins || 0) + (stats.losses || 0)} 场`} value={`${stats.wins}胜/${stats.losses}负`} />
            <StatCol label="场均 K/D" value={stats.avg_kd} sub={stats.avg_kd >= 1.2 ? "↑ 优秀" : stats.avg_kd < 0.95 ? "↓ 偏低" : undefined} />
            <StatCol label="爆头率" value={`${stats.headshot_pct}%`} />
            <StatCol label="场均伤害 ADR" value={stats.avg_adr} />
            <StatCol label="综合评分" value={stats.rating} sub={stats.rating >= 1.2 ? "↑ 优秀" : stats.rating < 0.95 ? "↓ 偏低" : undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
