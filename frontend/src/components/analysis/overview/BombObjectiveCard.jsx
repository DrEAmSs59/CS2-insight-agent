import { Bomb } from "lucide-react";

function formatPlantRate(rate) {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function SiteDonut({ siteA, siteB }) {
  const total = siteA + siteB;
  if (total <= 0) return null;

  const size = 88;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const aLen = (siteA / total) * c;
  const bLen = c - aLen;
  const pctA = Math.round((siteA / total) * 100);
  const pctB = 100 - pctA;

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={stroke}
            strokeDasharray={`${aLen} ${c - aLen}`}
            strokeDashoffset={0}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={stroke}
            strokeDasharray={`${bLen} ${c - bLen}`}
            strokeDashoffset={-aLen}
          />
        </g>
        <text
          x="50%"
          y="48%"
          textAnchor="middle"
          className="fill-cs2-text-muted"
          fontSize="8"
        >
          下包分布
        </text>
      </svg>
      <div className="space-y-1.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-400" />
          <span className="text-cs2-text-muted">A 点</span>
          <span className="font-bold tabular-nums text-sky-400">{pctA}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <span className="text-cs2-text-muted">B 点</span>
          <span className="font-bold tabular-nums text-amber-400">{pctB}%</span>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 * }} props
 */
export default function BombObjectiveCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
}) {
  const teamA = model?.teamA || {};
  const teamB = model?.teamB || {};
  const siteA = Number(model?.siteA) || 0;
  const siteB = Number(model?.siteB) || 0;
  const summary = model?.summary || "";
  const plants = (teamA.plants || 0) + (teamB.plants || 0);
  const hasPlants = plants > 0 || siteA + siteB > 0;
  const hasData = model?.hasData !== false && hasPlants;

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent">
          <Bomb className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">目标与包点</h3>
      </header>
      {summary ? (
        <p className="mb-2 line-clamp-2 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}

      {!hasData ? (
        <p className="mt-6 text-center text-[11px] text-cs2-text-muted">本场没有可识别的下包事件。</p>
      ) : (
        <div className="mt-auto flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <span className="text-cs2-text-muted">下包次数</span>
              <span>
                <span className="font-bold text-sky-400">{teamA.plants ?? 0}</span>
                <span className="mx-1 text-cs2-text-muted">/</span>
                <span className="font-bold text-amber-400">{teamB.plants ?? 0}</span>
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-cs2-text-muted">下包后胜率</span>
              <span>
                <span className="font-bold text-sky-400">{formatPlantRate(teamA.plantWinRate)}</span>
                <span className="mx-1 text-cs2-text-muted">/</span>
                <span className="font-bold text-amber-400">{formatPlantRate(teamB.plantWinRate)}</span>
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-cs2-text-muted">拆包</span>
              <span>
                <span className="font-bold text-sky-400">{teamA.defuses ?? 0}</span>
                <span className="mx-1 text-cs2-text-muted">/</span>
                <span className="font-bold text-amber-400">{teamB.defuses ?? 0}</span>
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-cs2-text-muted">爆炸取胜</span>
              <span>
                <span className="font-bold text-sky-400">{teamA.explodeWins ?? 0}</span>
                <span className="mx-1 text-cs2-text-muted">/</span>
                <span className="font-bold text-amber-400">{teamB.explodeWins ?? 0}</span>
              </span>
            </div>
            <p className="pt-1 text-[9px] text-cs2-text-muted">
              <span className="text-sky-400">{teamAName}</span>
              {" · "}
              <span className="text-amber-400">{teamBName}</span>
            </p>
          </div>
          <SiteDonut siteA={siteA} siteB={siteB} />
        </div>
      )}
    </article>
  );
}
