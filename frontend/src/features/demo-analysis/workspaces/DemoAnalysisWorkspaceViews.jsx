import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  Bomb,
  CircleDollarSign,
  Crosshair,
  Gauge,
  ListChecks,
  ListFilter,
  MapPin,
  ShieldCheck,
  Sparkles,
  Swords,
  Users,
  Zap,
} from "lucide-react";
import Button from "../../../components/ui/Button";
import { AccentButton, EmptyState, FocusedPlayerHeader, IconTile, SectionHeader, Segmented, StatTile } from "../AnalysisUi.jsx";
import KillfeedIconStrip from "./timeline/killfeed/KillfeedIconStrip";
import { buildOverviewModel } from "./overview/buildOverviewModel";
import MatchMainlineCard from "./overview/MatchMainlineCard";
import MatchTrendCard from "./overview/MatchTrendCard";
import SidePerformanceCard from "./overview/SidePerformanceCard";
import EconomyInsightCard from "./overview/EconomyInsightCard";
import OpeningAdvantageCard from "./overview/OpeningAdvantageCard";
import BombObjectiveCard from "./overview/BombObjectiveCard";
import PlayerEventsCard from "./overview/PlayerEventsCard";
import KeyRoundsTimeline from "./overview/KeyRoundsTimeline";
import { playerIdentityKey } from "../../../utils/playerIdentity.js";
import { buildPlayerTeamMap, rewriteStoredRoundHeadline } from "./overview/overviewUtils";

export function Panel({ title, description, action, children, className = "" }) {
  return (
    <section className={`analysis-panel ${className}`}>
      {(title || description || action) && (
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-cs2-border-subtle px-3.5 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[13px] font-semibold text-cs2-text-primary">{title}</h2>}
            {description && <p className="mt-0.5 truncate text-[11.5px] text-cs2-text-muted">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function MetricCard({ icon, label, value, detail, tone = "accent" }) {
  return <StatTile testId="analysis-metric-card" icon={icon} label={label} value={value} detail={detail} tone={tone} />;
}

function teamDot(teamKey) {
  return teamKey === "a" ? "bg-cs2-team-blue" : "bg-cs2-team-amber";
}

function money(value) {
  return `$${(Number(value || 0) / 1000).toFixed(1)}K`;
}

function economyLabel(type) {
  return ({ pistol: "手枪", full: "长枪", force: "强起", semi: "半起", eco: "ECO" })[type] || "半起";
}

function scoreText(round) {
  return `${Number(round?.team_a_score_after || 0)} : ${Number(round?.team_b_score_after || 0)}`;
}

function durationText(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function fallbackWorkspace({ players = [], meta = {}, teamAName, teamBName }) {
  const pivot = Math.ceil(players.length / 2);
  const stats = players.map((player, index) => {
    const kills = Number(player.kills || 0);
    const deaths = Number(player.deaths || 0);
    return {
      name: player.name || player.player_name || `Player ${index + 1}`,
      team_key: Number(player.team ?? player.team_number) === 3 ? "b" : Number(player.team ?? player.team_number) === 2 ? "a" : index < pivot ? "a" : "b",
      kills,
      deaths,
      assists: Number(player.assists || 0),
      kd: Number(player.kd || kills / Math.max(1, deaths)),
      adr: Number(player.adr || 0),
      kast: Number(player.kast || 0),
      hs_percent: Number(player.hs_percent || player.hs || 0),
      first_kills: Number(player.first_kills || 0),
      trade_kills: Number(player.trade_kills || 0),
      awp_kills: Number(player.awp_kills || 0),
      utility_damage: Number(player.utility_damage || 0),
    };
  });
  return {
    players: stats,
    rounds: [],
    team_a_name: teamAName,
    team_b_name: teamBName,
    team_a_score: Number(meta.team_a_score || 0),
    team_b_score: Number(meta.team_b_score || 0),
    summary: { total_rounds: Number(meta.total_rounds || 0) },
  };
}

export function useWorkspaceData(workspace, fallback) {
  return useMemo(() => {
    const base = workspace?.version ? workspace : fallbackWorkspace(fallback);
    let teamAScore = 0;
    let teamBScore = 0;
    const sourceRounds = Array.isArray(base.rounds) ? base.rounds : [];
    const playerTeamMap = buildPlayerTeamMap(base.players);
    const rounds = sourceRounds.map((round, index) => {
      const nextStartTick = Number(sourceRounds[index + 1]?.start_tick || 0);
      const formalEndTick = Number(round.round_end_tick ?? round.end_tick ?? 0);
      const replayEndTick = nextStartTick > formalEndTick ? nextStartTick - 1 : Number(round.end_tick || formalEndTick);
      let winnerKey = round.winner_team_key;
      const winnerSide = Number(round.winner_side || 0);
      if (!winnerKey && winnerSide) {
        if ((winnerSide === 2 && round.team_a_side === "T") || (winnerSide === 3 && round.team_a_side === "CT")) winnerKey = "a";
        else if ((winnerSide === 2 && round.team_b_side === "T") || (winnerSide === 3 && round.team_b_side === "CT")) winnerKey = "b";
      }
      const scoreBeforeA = teamAScore;
      const scoreBeforeB = teamBScore;
      if (winnerKey === "a") teamAScore += 1;
      if (winnerKey === "b") teamBScore += 1;
      const teamAName = base.team_a_name || fallback.teamAName || "Team A";
      const teamBName = base.team_b_name || fallback.teamBName || "Team B";
      const winnerLabel = winnerKey === "a" ? teamAName : winnerKey === "b" ? teamBName : "本回合胜方";
      const headline = rewriteStoredRoundHeadline(round.headline || "", {
        events: round.events,
        playerTeamMap,
        winnerKey,
        winnerLabel,
        teamAName,
        teamBName,
        site: round.site,
        roundNumber: round.round_number,
      });
      return {
        ...round,
        round_end_tick: formalEndTick,
        end_tick: replayEndTick,
        winner_team_key: winnerKey,
        headline,
        duration_seconds: replayEndTick > Number(round.freeze_end_tick || 0)
          ? Math.round((replayEndTick - Number(round.freeze_end_tick || 0)) / Math.max(1, Number(base.tick_rate || 64)))
          : Number(round.duration_seconds || 0),
        team_a_score_before: scoreBeforeA,
        team_b_score_before: scoreBeforeB,
        team_a_score_after: teamAScore,
        team_b_score_after: teamBScore,
      };
    });
    return {
      ...base,
      team_a_name: base.team_a_name || fallback.teamAName || "Team A",
      team_b_name: base.team_b_name || fallback.teamBName || "Team B",
      team_a_score: Number(base.team_a_score ?? fallback.meta?.team_a_score ?? 0),
      team_b_score: Number(base.team_b_score ?? fallback.meta?.team_b_score ?? 0),
      players: Array.isArray(base.players) ? base.players : [],
      rounds,
    };
  }, [workspace, fallback]);
}

function TeamScoreboard({ teamKey, name, score, players, onSelectPlayer, winner = false }) {
  const isBlue = teamKey === "a";
  return (
    <section
      data-testid={`overview-team-scoreboard-${teamKey}`}
      data-winner={winner ? "true" : "false"}
      className="min-w-0 overflow-hidden rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card"
    >
      <header
        data-testid={`overview-team-scoreboard-header-${teamKey}`}
        className={`flex items-center justify-between px-3 py-2 ${isBlue ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "bg-cs2-amber-surface text-cs2-amber-on-surface"}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid={`overview-team-scoreboard-mark-${teamKey}`}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm font-black ${isBlue ? "bg-cs2-cyan-on-surface text-cs2-cyan-surface" : "bg-cs2-amber-on-surface text-cs2-amber-surface"}`}
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
          <h3 className="truncate text-[13px] font-semibold">{name}</h3>
          {winner ? <span className="rounded-full bg-cs2-bg-card px-2 py-0.5 text-[11px] font-semibold text-cs2-text-secondary">胜方</span> : null}
        </div>
        <span className="font-mono text-xl font-black">{score}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[28%]" />
            {Array.from({ length: 9 }).map((_, index) => <col key={index} className="w-[8%]" />)}
          </colgroup>
          <thead className="whitespace-nowrap border-b border-cs2-border-subtle text-[11px] text-cs2-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">玩家</th>
              <th className="px-1 text-right font-medium">K</th>
              <th className="px-1 text-right font-medium">D</th>
              <th className="px-1 text-right font-medium">A</th>
              <th className="px-1 text-right font-medium">ADR</th>
              <th className="px-1 text-right font-medium">KAST</th>
              <th className="px-1 text-right font-medium">HS%</th>
              <th className="px-1 text-right font-medium">首杀</th>
              <th className="px-1 text-right font-medium">AWP</th>
              <th className="px-2 text-right font-medium">道具</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs tabular-nums text-cs2-text-secondary">
            {players.map((player) => (
              <tr key={playerIdentityKey(player)} className="border-t border-cs2-border-subtle first:border-t-0 hover:bg-cs2-bg-hover">
                <td className="px-3 py-2">
                  <button
                    type="button"
                    title={`查看 ${player.name} 的个人数据`}
                    onClick={() => onSelectPlayer?.(playerIdentityKey(player))}
                    className="group/player flex max-w-full items-center gap-1.5 text-left font-sans"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${teamDot(teamKey)}`} />
                    <span className="truncate text-[12.5px] font-semibold text-cs2-text-primary group-hover/player:text-cs2-accent group-hover/player:underline">{player.name}</span>
                  </button>
                </td>
                <td className="px-1 text-right font-bold text-cs2-text-primary">{player.kills}</td>
                <td className="px-1 text-right">{player.deaths}</td>
                <td className="px-1 text-right">{player.assists}</td>
                <td className="px-1 text-right">{Number(player.adr || 0).toFixed(0)}</td>
                <td className="px-1 text-right">{Number(player.kast || 0).toFixed(0)}%</td>
                <td className="px-1 text-right">{Number(player.hs_percent || 0).toFixed(0)}%</td>
                <td className="px-1 text-right">{player.first_kills || 0}</td>
                <td className="px-1 text-right">{player.awp_kills || 0}</td>
                <td className="px-2 text-right">{player.utility_damage || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function roundWinnerSide(round) {
  if (!round) return "";
  return round.winner_team_key === "a" ? round.team_a_side || "" : round.team_b_side || "";
}

function sortScoreboardPlayers(players) {
  return [...players].sort((a, b) => {
    const killsDiff = Number(b.kills || 0) - Number(a.kills || 0);
    if (killsDiff !== 0) return killsDiff;
    return Number(b.adr || 0) - Number(a.adr || 0);
  });
}

export function OverviewView({ data, onSelectPlayer, onOpenRound, onOpenReplayRound, onOpenHighlights }) {
  const overview = useMemo(() => buildOverviewModel(data), [data]);
  const [mobileScoreTeam, setMobileScoreTeam] = useState("a");
  const teamAName = data.team_a_name || "Team A";
  const teamBName = data.team_b_name || "Team B";
  const playersA = sortScoreboardPlayers(data.players.filter((player) => player.team_key === "a"));
  const playersB = sortScoreboardPlayers(data.players.filter((player) => player.team_key === "b"));
  const scoreA = Number(data.team_a_score || 0);
  const scoreB = Number(data.team_b_score || 0);
  const winnerA = scoreA > scoreB;
  const winnerB = scoreB > scoreA;
  const hasOpening = overview.opening?.hasData !== false;
  const hasObjective =
    overview.objective?.hasData !== false &&
    ((overview.objective?.teamA?.plants || 0) + (overview.objective?.teamB?.plants || 0) > 0 ||
      (overview.objective?.siteA || 0) + (overview.objective?.siteB || 0) > 0);
  const hasPlayerEvents = (overview.playerEvents || []).length > 0;
  const secondaryCount = [hasOpening, hasObjective, hasPlayerEvents].filter(Boolean).length;

  return (
    <div data-testid="analysis-overview-content" className="w-full space-y-4 pb-6">
      <MatchMainlineCard mainline={overview.mainline} />

      <section className="grid auto-rows-fr grid-cols-1 gap-2.5 lg:grid-cols-2 xl:grid-cols-12 xl:auto-rows-[228px]">
        <MatchTrendCard
          model={overview.trend}
          phaseMeta={overview.phaseMeta}
          teamAName={teamAName}
          teamBName={teamBName}
          className="lg:col-span-2 xl:col-span-5"
        />
        <SidePerformanceCard
          model={overview.sidePerformance}
          teamAName={teamAName}
          teamBName={teamBName}
          className="xl:col-span-4"
        />
        <EconomyInsightCard
          model={overview.economy}
          teamAName={teamAName}
          teamBName={teamBName}
          className="xl:col-span-3"
        />
      </section>

      {secondaryCount > 0 ? (
        <section
          className={`grid auto-rows-fr grid-cols-1 gap-2.5 md:grid-cols-2 xl:auto-rows-[208px] ${
            secondaryCount >= 3 ? "xl:grid-cols-3" : secondaryCount === 2 ? "xl:grid-cols-2" : "xl:grid-cols-1"
          }`}
        >
          <OpeningAdvantageCard model={overview.opening} teamAName={teamAName} teamBName={teamBName} />
          <BombObjectiveCard model={overview.objective} teamAName={teamAName} teamBName={teamBName} />
          <PlayerEventsCard
            events={overview.playerEvents}
            onSelectPlayer={onSelectPlayer}
            onOpenRound={onOpenRound}
            onOpenHighlights={onOpenHighlights}
          />
        </section>
      ) : null}

      <KeyRoundsTimeline
        rounds={overview.keyRounds}
        onOpenRound={onOpenRound}
        onOpenReplayRound={onOpenReplayRound}
      />

      <section data-testid="overview-full-scoreboard">
        <SectionHeader level={2} title="全场数据" description="点击玩家名查看个人数据" className="mb-2" />
        <div>
          <Segmented
            ariaLabel="选择队伍"
            className="mb-2 md:hidden"
            value={mobileScoreTeam}
            onChange={setMobileScoreTeam}
            options={[
              { value: "a", label: teamAName, tone: "ct" },
              { value: "b", label: teamBName, tone: "t" },
            ]}
          />
          <div className="grid gap-2.5 md:grid-cols-2">
            <div className={mobileScoreTeam === "a" ? "block" : "hidden md:block"}>
              <TeamScoreboard
                teamKey="a"
                name={teamAName}
                score={scoreA}
                players={playersA}
                onSelectPlayer={onSelectPlayer}
                winner={winnerA}
              />
            </div>
            <div className={mobileScoreTeam === "b" ? "block" : "hidden md:block"}>
              <TeamScoreboard
                teamKey="b"
                name={teamBName}
                score={scoreB}
                players={playersB}
                onSelectPlayer={onSelectPlayer}
                winner={winnerB}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function FilterField({ label, value, onChange, children }) {
  return (
    <label className="analysis-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="analysis-filter-select">
        {children}
      </select>
    </label>
  );
}

const EVENT_ICONS = {
  kill: Crosshair,
  grenade: Bomb,
  plant: Zap,
  explode: Zap,
};

function roundEventsForDisplay(round) {
  const start = Number(round?.start_tick ?? round?.freeze_end_tick ?? -Infinity);
  const end = Number(round?.end_tick ?? Infinity);
  const seen = new Set();
  const terminal = new Set();
  return (round?.events || []).filter((event) => {
    const tick = Number(event.tick || 0);
    if (Number.isFinite(start) && tick < start) return false;
    if (Number.isFinite(end) && tick > end) return false;
    if (["explode", "defuse"].includes(event.type)) {
      if (terminal.has(event.type)) return false;
      terminal.add(event.type);
    }
    const identity = [event.type, tick, event.actor, event.target, event.kind].join("|");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function teamTextClass(teamKey) {
  if (teamKey === "a") return "text-cs2-team-blue";
  if (teamKey === "b") return "text-cs2-team-amber";
  return "text-cs2-text-primary";
}

function RoundEventDetail({ event, teamOf }) {
  if (event.type === "kill") {
    const weapon = event.weapon || "武器";
    return <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap"><KillfeedIconStrip event={{ ...event, is_headshot: Boolean(event.headshot) }} weaponName={weapon} weaponKey={weapon} /><span className={`text-[12.5px] font-semibold ${teamTextClass(teamOf(event.target))}`}>{event.target || "未知玩家"}</span></span>;
  }
  const text = event.type === "grenade" ? `投掷 ${event.kind || "投掷物"}`
    : event.type === "plant" ? `在 ${event.site || "?"} 区下包`
      : event.type === "defuse" ? "完成拆弹"
        : event.type === "bomb_pickup" ? "捡起 C4"
          : event.type === "bomb_drop" ? "丢下 C4"
            : event.type === "explode" ? "C4 爆炸"
              : "比赛事件";
  return <p className="mt-0.5 text-[11.5px] text-cs2-text-muted">{text}</p>;
}

function RoundEventBody({ event, teamOf }) {
  const actor = event.actor || (event.type === "explode" ? "C4" : "比赛事件");
  const actorClass = `text-[12.5px] font-semibold ${teamTextClass(teamOf(event.actor))}`;
  if (event.type === "kill") {
    return <div className="flex min-w-0 items-center gap-2 whitespace-nowrap"><p className={`shrink-0 ${actorClass}`}>{actor}</p><RoundEventDetail event={event} teamOf={teamOf} /></div>;
  }
  return <div><p className={actorClass}>{actor}</p><RoundEventDetail event={event} teamOf={teamOf} /></div>;
}

const EVENT_TONES = {
  kill: "rose",
  grenade: "amber",
  plant: "accent",
  explode: "accent",
};

export function RoundsView({ data, selectedRound, onSelectRound, onOpenReplayRound, contextRailTarget = null }) {
  const [winnerFilter, setWinnerFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [economyFilter, setEconomyFilter] = useState("all");
  const [siteFilter, setSiteFilter] = useState("all");
  const [openingFilter, setOpeningFilter] = useState("all");
  const [endFilter, setEndFilter] = useState("all");
  const [specialOnly, setSpecialOnly] = useState(false);
  const playerTeamByName = useMemo(() => new Map(data.players.map((player) => [String(player.name || "").toLowerCase(), player.team_key])), [data.players]);
  const teamOf = (name) => playerTeamByName.get(String(name || "").toLowerCase());
  const finishType = (round) => {
    const reason = String(round.end_reason || "").toLowerCase();
    if (reason.includes("defus")) return "defuse";
    if (reason.includes("bombed") || reason.includes("explode") || reason.includes("targetbomb")) return "explode";
    return roundWinnerSide(round) === "CT" ? "ct_elimination" : "t_elimination";
  };
  const visibleRounds = data.rounds.filter((round) => {
    const openingKill = (round.events || []).find((event) => event.type === "kill");
    const openingTeam = playerTeamByName.get(String(openingKill?.actor || "").toLowerCase());
    return (winnerFilter === "all" || round.winner_team_key === winnerFilter)
      && (sideFilter === "all" || roundWinnerSide(round) === sideFilter)
      && (economyFilter === "all" || round.team_a_economy === economyFilter || round.team_b_economy === economyFilter)
      && (siteFilter === "all" || (siteFilter === "none" ? !round.site : round.site === siteFilter))
      && (openingFilter === "all" || openingTeam === openingFilter)
      && (endFilter === "all" || finishType(round) === endFilter)
      && (!specialOnly || (round.tags || []).some((tag) => /[2-5]K|翻盘|爆头|下包|残局/.test(tag)));
  });
  const round = visibleRounds.find((item) => Number(item.round_number) === Number(selectedRound)) || visibleRounds[0] || null;
  if (!data.rounds.length) return <EmptyState icon={ListChecks} title="回合列表" hint="当前解析结果没有正式回合。" />;
  const displayEvents = round ? roundEventsForDisplay(round) : [];
  const filterFields = (
    <>
      <FilterField label="胜方" value={winnerFilter} onChange={setWinnerFilter}>
        <option value="all">全部胜方</option><option value="a">{data.team_a_name} 胜</option><option value="b">{data.team_b_name} 胜</option>
      </FilterField>
      <FilterField label="阵营" value={sideFilter} onChange={setSideFilter}>
        <option value="all">全部阵营</option><option value="CT">CT 胜</option><option value="T">T 胜</option>
      </FilterField>
      <FilterField label="经济" value={economyFilter} onChange={setEconomyFilter}>
        <option value="all">全部经济</option><option value="pistol">手枪</option><option value="eco">纯 ECO</option><option value="force">强起</option><option value="semi">半起</option><option value="full">全枪全弹</option>
      </FilterField>
      <FilterField label="包点" value={siteFilter} onChange={setSiteFilter}>
        <option value="all">全部包点</option><option value="A">A 点</option><option value="B">B 点</option><option value="none">未下包</option>
      </FilterField>
      <FilterField label="首杀" value={openingFilter} onChange={setOpeningFilter}>
        <option value="all">不限</option><option value="a">{data.team_a_name}</option><option value="b">{data.team_b_name}</option>
      </FilterField>
      <FilterField label="结束方式" value={endFilter} onChange={setEndFilter}>
        <option value="all">全部结束方式</option><option value="ct_elimination">CT 歼灭</option><option value="defuse">拆弹</option><option value="t_elimination">T 歼灭</option><option value="explode">爆弹</option>
      </FilterField>
    </>
  );
  const keyRoundToggle = (
    <button type="button" aria-pressed={specialOnly} data-active={specialOnly ? "true" : "false"} className="analysis-tag-chip self-end" onClick={() => setSpecialOnly((value) => !value)}>
      <Sparkles className="h-3.5 w-3.5" aria-hidden />
      只看关键回合
    </button>
  );
  const filters = contextRailTarget ? (
    <section className="analysis-side-section">
      <header className="flex items-center justify-between gap-2 border-b border-cs2-border-subtle px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-cs2-text-secondary"><ListFilter className="h-3.5 w-3.5 text-cs2-text-muted" />回合筛选</span>
        <span className="font-mono text-[11px] text-cs2-text-muted">{visibleRounds.length}/{data.rounds.length}</span>
      </header>
      <div className="analysis-rail-filter-grid grid grid-cols-2 gap-2 p-3">
        {filterFields}
        <div className="col-span-2">{keyRoundToggle}</div>
      </div>
    </section>
  ) : (
    <section className="analysis-card">
      <div className="analysis-filterbar">
        <span className="inline-flex h-8 items-center gap-1.5 self-end text-xs font-semibold text-cs2-text-secondary"><ListFilter className="h-3.5 w-3.5 text-cs2-text-muted" aria-hidden />回合筛选</span>
        {filterFields}
        {keyRoundToggle}
        <span className="ml-auto self-end pb-2 text-xs text-cs2-text-muted">命中 <strong className="font-mono text-cs2-text-primary">{visibleRounds.length}</strong> / {data.rounds.length} 回合</span>
      </div>
    </section>
  );
  const winnerName = round ? (round.winner_team_key === "a" ? data.team_a_name : data.team_b_name) : "";
  return (
    <div className="space-y-3">
      {contextRailTarget ? createPortal(filters, contextRailTarget) : filters}
      {round ? (
        <div className="grid h-[calc(100vh-106px)] min-h-[500px] gap-3 lg:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.5fr)]">
          <Panel title="回合列表" description={`共 ${visibleRounds.length} 个回合 · 点击查看详情`} className="flex min-h-0 flex-col overflow-hidden">
            <div className="custom-scrollbar min-h-0 flex-1 divide-y divide-cs2-border-subtle overflow-y-auto">
              {visibleRounds.map((item) => {
                const side = roundWinnerSide(item);
                const active = Number(round.round_number) === Number(item.round_number);
                return (
                  <button
                    key={item.round_number}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    data-active={active ? "true" : "false"}
                    data-team={item.winner_team_key || undefined}
                    onClick={() => onSelectRound(item.round_number)}
                    className="analysis-list-row"
                  >
                    <span className="w-9 shrink-0 font-mono text-[13px] font-bold text-cs2-text-primary">R{item.round_number}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-cs2-text-primary">{item.headline}</p>
                      <p className="mt-0.5 truncate text-[11.5px] text-cs2-text-muted"><span className="font-mono">{scoreText(item)}</span> · {item.site ? `${item.site} 区 · ` : ""}{durationText(item.duration_seconds)}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${side === "CT" ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : side === "T" ? "bg-cs2-amber-surface text-cs2-amber-on-surface" : "bg-cs2-bg-input text-cs2-text-muted"}`}>{side || "—"} 胜</span>
                  </button>
                );
              })}
            </div>
          </Panel>
          <Panel
            title={`第 ${round.round_number} 回合 · ${round.headline}`}
            description={`${winnerName} 获胜 · ${durationText(round.duration_seconds)}`}
            className="flex min-h-0 flex-col overflow-hidden"
            action={<AccentButton onClick={() => onOpenReplayRound(round.round_number)}><MapPin className="h-3.5 w-3.5" aria-hidden />在 2D 回放中查看</AccentButton>}
          >
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mb-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-[10px] bg-cs2-bg-input/60 px-4 py-3 text-center">
                <div className="min-w-0"><p className="truncate text-[13px] font-semibold text-cs2-team-blue">{data.team_a_name}</p><p className="mt-0.5 text-[11.5px] text-cs2-text-muted">{economyLabel(round.team_a_economy)} · <span className="font-mono">{money(round.team_a_equipment_value)}</span></p></div>
                <div><p className="font-mono text-2xl font-black text-cs2-text-primary">{scoreText(round)}</p><p className="text-[11px] text-cs2-text-muted">回合后比分</p></div>
                <div className="min-w-0"><p className="truncate text-[13px] font-semibold text-cs2-team-amber">{data.team_b_name}</p><p className="mt-0.5 text-[11.5px] text-cs2-text-muted">{economyLabel(round.team_b_economy)} · <span className="font-mono">{money(round.team_b_equipment_value)}</span></p></div>
              </div>
              <SectionHeader title="回合事件" description={`${displayEvents.length} 条`} className="mb-3" />
              {displayEvents.length ? (
                <ol className="space-y-1">
                  {displayEvents.map((event, index) => (
                    <li key={`${event.type}-${event.tick}-${index}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-cs2-bg-hover">
                      <span className="w-10 shrink-0 font-mono text-[11px] text-cs2-text-muted">{event.time_text || "--:--"}</span>
                      <IconTile icon={EVENT_ICONS[event.type] || ShieldCheck} tone={EVENT_TONES[event.type] || "neutral"} size="sm" />
                      <RoundEventBody event={event} teamOf={teamOf} />
                    </li>
                  ))}
                </ol>
              ) : <p className="rounded-xl border border-dashed border-cs2-border py-8 text-center text-xs text-cs2-text-muted">该回合没有可展示的击杀或目标事件。</p>}
            </div>
          </Panel>
        </div>
      ) : (
        <EmptyState icon={ListFilter} title="没有匹配的回合" hint="当前筛选条件没有匹配的回合，试试放宽筛选。" />
      )}
    </div>
  );
}

function StatBar({ label, value, display, max = 100 }) {
  const width = Math.max(0, Math.min(100, Number(value || 0) / Math.max(1, max) * 100));
  return (
    <div className="grid grid-cols-[112px_minmax(100px,1fr)_60px] items-center gap-2.5">
      <span className="truncate text-xs text-cs2-text-secondary">{label}</span>
      <div data-testid="analysis-stat-track" className="h-1.5 overflow-hidden rounded-full bg-cs2-border-subtle">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400" style={{ width: `${width}%` }} />
      </div>
      <span className="text-right font-mono text-xs font-bold tabular-nums text-cs2-text-primary">{display ?? value}</span>
    </div>
  );
}

function StatGroup({ title, description, icon, tone, rows }) {
  return (
    <section className="analysis-card p-3.5">
      <header className="mb-3 flex items-center gap-2.5">
        <IconTile icon={icon} tone={tone} size="sm" />
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-cs2-text-primary">{title}</h3>
          <p className="truncate text-[11.5px] text-cs2-text-muted">{description}</p>
        </div>
      </header>
      <div className="space-y-2.5">{rows.map((row) => <StatBar key={row.label} {...row} />)}</div>
    </section>
  );
}

export function PlayersView({ data, selectedPlayer, onBackToOverview, rosterPlayer = null, avatarUrl = "" }) {
  const player = data.players.find((item) => playerIdentityKey(item) === selectedPlayer) || data.players[0];
  if (!player) return <EmptyState icon={Users} title="全部玩家" hint="当前解析结果没有玩家统计。" />;
  const isBlue = player.team_key === "a";
  const groups = [
    { title: "对枪", description: "击杀、伤害与多杀回合", icon: Swords, tone: "rose", rows: [{ label: "击杀", value: player.kills, max: 40 }, { label: "死亡", value: player.deaths, max: 40 }, { label: "助攻", value: player.assists, max: 20 }, { label: "KPR", value: player.kpr, display: Number(player.kpr || 0).toFixed(2), max: 1.4 }, { label: "DPR", value: player.dpr, display: Number(player.dpr || 0).toFixed(2), max: 1.2 }, { label: "ADR", value: player.adr, display: Number(player.adr || 0).toFixed(1), max: 130 }, { label: "HS%", value: player.hs_percent, display: `${Number(player.hs_percent || 0).toFixed(0)}%` }, { label: "KAST", value: player.kast, display: `${Number(player.kast || 0).toFixed(0)}%` }, { label: "存活率", value: player.survival_rate, display: `${Number(player.survival_rate || 0).toFixed(0)}%` }, { label: "2 杀回合", value: player.two_kill_rounds, max: 8 }, { label: "3 杀回合", value: player.three_kill_rounds, max: 5 }, { label: "4 杀回合", value: player.four_kill_rounds, max: 3 }, { label: "5 杀回合", value: player.five_kill_rounds, max: 1 }] },
    { title: "首杀与补枪", description: "开局对决与交换", icon: Crosshair, tone: "amber", rows: [{ label: "首杀", value: player.first_kills, max: 10 }, { label: "首死", value: player.first_deaths, max: 10 }, { label: "首杀对决胜率", value: player.opening_duel_win_rate, display: `${Number(player.opening_duel_win_rate || 0).toFixed(0)}%` }, { label: "补枪", value: player.trade_kills, max: 10 }, { label: "被补枪", value: player.trade_deaths, max: 10 }, { label: "补枪率", value: player.trade_kill_rate, display: `${Number(player.trade_kill_rate || 0).toFixed(0)}%` }] },
    { title: "残局与武器", description: "残局处理与狙击", icon: ShieldCheck, tone: "violet", rows: [{ label: "残局尝试", value: player.clutch_attempts || 0, max: 8 }, { label: "残局获胜", value: player.clutch_wins || 0, max: 5 }, { label: "AWP 击杀", value: player.awp_kills, max: 20 }, { label: "爆头数", value: player.headshots, max: 30 }, { label: "多杀回合", value: Number(player.two_kill_rounds || 0) + Number(player.three_kill_rounds || 0) + Number(player.four_kill_rounds || 0) + Number(player.five_kill_rounds || 0), max: 12 }] },
    { title: "道具与经济", description: "道具伤害与装备投入", icon: CircleDollarSign, tone: "green", rows: [{ label: "道具伤害", value: player.utility_damage, max: 500 }, { label: "每回合道伤", value: player.utility_damage_per_round, display: Number(player.utility_damage_per_round || 0).toFixed(1), max: 25 }, { label: "平均装备价值", value: player.average_equipment_value, display: money(player.average_equipment_value), max: 6000 }] },
  ];
  return (
    <div className="space-y-4">
      <FocusedPlayerHeader
        player={rosterPlayer || player}
        avatarUrl={avatarUrl}
        fallbackTone={isBlue ? "blue" : "amber"}
        name={player.name}
        caption={isBlue ? data.team_a_name : data.team_b_name}
        captionColor={isBlue ? "var(--cs2-team-blue)" : "var(--cs2-team-amber)"}
        stats={[
          ["击杀", Number(player.kills || 0)],
          ["死亡", Number(player.deaths || 0)],
          ["回合", data.rounds.length],
        ]}
        actions={<Button variant="secondary" size="sm" onClick={onBackToOverview}><ArrowLeft className="h-3.5 w-3.5" />返回概览</Button>}
      />
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Swords} label="K / D / A" value={`${player.kills} / ${player.deaths} / ${player.assists}`} detail={`${Number(player.kd || 0).toFixed(2)} K/D`} tone="blue" />
        <MetricCard icon={Activity} label="ADR" value={Number(player.adr || 0).toFixed(1)} detail={`总伤害约 ${Math.round(Number(player.adr || 0) * Math.max(1, data.rounds.length))}`} />
        <MetricCard icon={ShieldCheck} label="KAST" value={`${Number(player.kast || 0).toFixed(0)}%`} detail={`${player.trade_kills || 0} 次有效补枪`} tone="green" />
        <MetricCard icon={Gauge} label="爆头率" value={`${Number(player.hs_percent || 0).toFixed(0)}%`} detail={`${player.first_kills || 0} 次首杀 · ${player.awp_kills || 0} 次 AWP 击杀`} tone="violet" />
      </div>
      <section>
        <SectionHeader level={2} title="详细数据" description="全场表现拆分 · 原始 Demo 统计" className="mb-2" />
        <div className="grid gap-2.5 xl:grid-cols-2">{groups.map((group) => <StatGroup key={group.title} {...group} />)}</div>
      </section>
    </div>
  );
}

const ECONOMY_BANDS = {
  pistol: "var(--cs2-amber-surface)",
  eco: "var(--cs2-bg-input)",
  semi: "var(--cs2-cyan-surface)",
  force: "var(--cs2-rose-surface)",
  full: "var(--cs2-emerald-surface)",
};

function EconomyChart({ rounds, teamAName, teamBName }) {
  const width = 1100;
  const height = 300;
  const pad = { left: 60, right: 20, top: 22, bottom: 42 };
  const values = rounds.flatMap((round) => [Number(round.team_a_equipment_value || 0), Number(round.team_b_equipment_value || 0)]);
  const maxValue = Math.max(10000, ...values, 1);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (rounds.length <= 1 ? innerW / 2 : index / (rounds.length - 1) * innerW);
  const y = (value) => pad.top + innerH - Number(value || 0) / maxValue * innerH;
  const path = (key) => rounds.map((round, index) => `${index ? "L" : "M"}${x(index)},${y(round[key])}`).join(" ");
  const bandW = innerW / Math.max(1, rounds.length);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[760px] w-full">
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="var(--cs2-border)" />
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="var(--cs2-border)" />
        {[0, 0.5, 1].map((ratio) => <g key={ratio}><line x1={pad.left} y1={pad.top + innerH * ratio} x2={width - pad.right} y2={pad.top + innerH * ratio} stroke="var(--cs2-border-subtle)" /><text x={pad.left - 10} y={pad.top + innerH * ratio + 4} textAnchor="end" fill="var(--cs2-text-muted)" fontSize="12">{money(maxValue * (1 - ratio))}</text></g>)}
        {rounds.map((round, index) => <g key={round.round_number}><rect x={pad.left + index * bandW} y={pad.top} width={bandW - 1} height={innerH} fill={ECONOMY_BANDS[round.team_a_economy] || ECONOMY_BANDS.semi} opacity=".62" /><text x={pad.left + index * bandW + bandW / 2} y={height - 18} textAnchor="middle" fill="var(--cs2-text-muted)" fontSize="11">R{round.round_number}</text></g>)}
        <path d={path("team_a_equipment_value")} fill="none" stroke="var(--cs2-team-blue)" strokeWidth="3" strokeLinejoin="round" />
        <path d={path("team_b_equipment_value")} fill="none" stroke="var(--cs2-team-amber)" strokeWidth="3" strokeLinejoin="round" />
        {rounds.map((round, index) => <g key={`points-${round.round_number}`}><circle cx={x(index)} cy={y(round.team_a_equipment_value)} r="3.5" fill="var(--cs2-team-blue)" /><circle cx={x(index)} cy={y(round.team_b_equipment_value)} r="3.5" fill="var(--cs2-team-amber)" /></g>)}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11.5px] text-cs2-text-muted">
        <span className="inline-flex items-center gap-1.5 font-semibold text-cs2-team-blue"><i className="h-0.5 w-4 rounded-full bg-cs2-team-blue" />{teamAName}</span>
        <span className="inline-flex items-center gap-1.5 font-semibold text-cs2-team-amber"><i className="h-0.5 w-4 rounded-full bg-cs2-team-amber" />{teamBName}</span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          背景：
          {["pistol", "eco", "semi", "force", "full"].map((type) => (
            <span key={type} className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm border border-cs2-border-subtle" style={{ background: ECONOMY_BANDS[type] }} />{economyLabel(type)}</span>
          ))}
        </span>
      </div>
    </div>
  );
}

export function EconomyView({ data, onOpenRound }) {
  if (!data.rounds.length) return <EmptyState icon={CircleDollarSign} title="经济走势" hint="当前解析结果没有正式回合。" />;
  return (
    <div className="space-y-4">
      <section className="analysis-card p-3.5">
        <SectionHeader level={2} icon={CircleDollarSign} tone="green" title="经济走势" description="双方每回合装备价值 · 背景为购买类型" className="mb-3" />
        <EconomyChart rounds={data.rounds} teamAName={data.team_a_name} teamBName={data.team_b_name} />
      </section>
      <section>
        <SectionHeader title="逐回合经济" description="点击回合查看详情" className="mb-2" />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {data.rounds.map((round) => {
            const winnerA = round.winner_team_key === "a";
            return (
              <button
                key={round.round_number}
                type="button"
                data-team={round.winner_team_key || undefined}
                onClick={() => onOpenRound(round.round_number)}
                className="analysis-card analysis-card--interactive p-2.5 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[13px] font-bold text-cs2-text-primary">R{round.round_number} <span className="font-semibold text-cs2-text-secondary">{Number(round.team_a_score_after || 0)}:{Number(round.team_b_score_after || 0)}</span></span>
                  <span className={`max-w-[50%] truncate rounded-full px-2 py-0.5 text-[11px] font-semibold ${winnerA ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "bg-cs2-amber-surface text-cs2-amber-on-surface"}`}>{winnerA ? data.team_a_name : data.team_b_name} 胜</span>
                </div>
                <p className="mt-1.5 flex items-center gap-1.5 truncate text-[11.5px] text-cs2-text-secondary"><i className="h-2 w-2 shrink-0 rounded-full bg-cs2-team-blue" />{economyLabel(round.team_a_economy)} · <span className="font-mono">{money(round.team_a_equipment_value)}</span></p>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-cs2-text-secondary"><i className="h-2 w-2 shrink-0 rounded-full bg-cs2-team-amber" />{economyLabel(round.team_b_economy)} · <span className="font-mono">{money(round.team_b_equipment_value)}</span></p>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
