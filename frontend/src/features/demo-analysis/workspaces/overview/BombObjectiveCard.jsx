import { Bomb } from "lucide-react";
import InsightCard from "./InsightCard";

function formatPlantRate(rate) {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function SiteDonut({ siteA, siteB }) {
  const total = siteA + siteB;
  if (total < 3) return null;

  const size = 64;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const aLen = (siteA / total) * c;
  const bLen = c - aLen;
  const pctA = Math.round((siteA / total) * 100);
  const pctB = 100 - pctA;

  return (
    <div className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--cs2-team-blue)"
            strokeWidth={stroke}
            strokeDasharray={`${aLen} ${c - aLen}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--cs2-team-amber)"
            strokeWidth={stroke}
            strokeDasharray={`${bLen} ${c - bLen}`}
            strokeDashoffset={-aLen}
          />
        </g>
      </svg>
      <div className="space-y-0.5 text-[11px]">
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-cs2-team-blue" />
          <span className="text-cs2-text-muted">A</span>
          <span className="font-bold tabular-nums text-cs2-team-blue">{pctA}%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-cs2-team-amber" />
          <span className="text-cs2-text-muted">B</span>
          <span className="font-bold tabular-nums text-cs2-team-amber">{pctB}%</span>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, a, b }) {
  return (
    <div className="flex min-h-[24px] items-center justify-between gap-2 text-xs">
      <span className="text-cs2-text-muted">{label}</span>
      <span className="font-mono tabular-nums">
        <span className="font-bold text-cs2-team-blue">{a}</span>
        <span className="mx-1 text-cs2-text-muted">/</span>
        <span className="font-bold text-cs2-team-amber">{b}</span>
      </span>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 *   className?: string,
 * }} props
 */
export default function BombObjectiveCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
  className = "",
}) {
  const teamA = model?.teamA || {};
  const teamB = model?.teamB || {};
  const siteA = Number(model?.siteA) || 0;
  const siteB = Number(model?.siteB) || 0;
  const plants = (teamA.plants || 0) + (teamB.plants || 0);
  const hasPlants = plants > 0 || siteA + siteB > 0;
  const hasData = model?.hasData !== false && hasPlants;
  const showDonut = plants >= 3 || siteA + siteB >= 3;
  const dominantHint =
    model?.dominantSite && model?.summary?.startsWith?.("主要下包点")
      ? model.summary
      : null;

  if (!hasData) return null;

  return (
    <InsightCard
      title="目标与包点"
      icon={Bomb}
      tone="rose"
      className={className}
    >
      <div className={`flex flex-1 gap-3 ${showDonut ? "items-center" : "flex-col justify-center"}`}>
        <div className="min-w-0 flex-1">
          <StatRow label="下包次数" a={teamA.plants ?? 0} b={teamB.plants ?? 0} />
          <StatRow
            label="下包后胜率"
            a={formatPlantRate(teamA.plantWinRate)}
            b={formatPlantRate(teamB.plantWinRate)}
          />
          <StatRow label="成功拆包" a={teamA.defuses ?? 0} b={teamB.defuses ?? 0} />
          <StatRow label="爆炸取胜" a={teamA.explodeWins ?? 0} b={teamB.explodeWins ?? 0} />
          {dominantHint ? (
            <p className="mt-1 text-[11px] text-cs2-text-muted">{dominantHint}</p>
          ) : (
            <p className="mt-1 text-[11px] text-cs2-text-muted">
              <span className="text-cs2-team-blue">{teamAName}</span>
              {" · "}
              <span className="text-cs2-team-amber">{teamBName}</span>
            </p>
          )}
        </div>
        {showDonut ? <SiteDonut siteA={siteA} siteB={siteB} /> : null}
      </div>
    </InsightCard>
  );
}
