import { useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bomb,
  Crosshair,
  Filter,
  Gauge,
  MapPin,
  ShieldCheck,
  Swords,
  Zap,
} from "lucide-react";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
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

export function Panel({ title, eyebrow, action, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm ${className}`}>
      {(title || eyebrow || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-cs2-border px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <p className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-cs2-accent">{eyebrow}</p>}
            {title && <h2 className="truncate text-[13px] font-bold text-cs2-text-primary">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function MetricCard({ icon: Icon, label, value, detail, tone = "accent" }) {
  const tones = {
    accent: "bg-cs2-accent-soft text-cs2-accent",
    blue: "bg-sky-500/10 text-sky-400",
    green: "bg-emerald-500/10 text-emerald-400",
    violet: "bg-violet-500/10 text-violet-400",
  };
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-cs2-border bg-cs2-bg-card px-3.5 py-3">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone] || tones.accent}`}><Icon className="h-4 w-4" /></div>
      <div className="min-w-0"><p className="text-[9px] font-semibold uppercase tracking-wider text-cs2-text-muted">{label}</p><p className="mt-0.5 truncate text-lg font-black tabular-nums text-cs2-text-primary">{value}</p><p className="truncate text-[9px] text-cs2-text-muted">{detail}</p></div>
    </div>
  );
}

function teamDot(teamKey) {
  return teamKey === "a" ? "bg-sky-400" : "bg-amber-400";
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
      const rawHeadline = String(round.headline || "");
      const headline = rawHeadline
        .replaceAll("本回合胜方", winnerLabel)
        .replaceAll("A 队", teamAName)
        .replaceAll("B 队", teamBName);
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
    <section className={`min-w-0 overflow-hidden rounded-lg border bg-cs2-bg-input/20 ${winner ? (isBlue ? "border-sky-500/40" : "border-amber-500/40") : "border-cs2-border"}`}>
      <header className={`flex items-center justify-between border-b px-3 py-2 ${isBlue ? "border-sky-500/20 bg-sky-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm font-black ${isBlue ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"}`}>{name.slice(0, 1).toUpperCase()}</span>
          <h3 className={`truncate text-[11px] font-black tracking-wider ${isBlue ? "text-sky-300" : "text-amber-300"}`}>{name}</h3>
        </div>
        <span className={`font-mono text-xl font-black ${isBlue ? "text-sky-200" : "text-amber-200"}`}>{score}</span>
      </header>
      <div className="overflow-hidden">
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[28%]" />
            {Array.from({ length: 9 }).map((_, index) => <col key={index} className="w-[8%]" />)}
          </colgroup>
          <thead className="border-b border-cs2-border bg-cs2-bg-input/55 text-[7px] uppercase tracking-wide text-cs2-text-muted">
            <tr>
              <th className="px-2 py-1.5">玩家</th>
              <th className="px-1 text-right">K</th>
              <th className="px-1 text-right">D</th>
              <th className="px-1 text-right">A</th>
              <th className="px-1 text-right">ADR</th>
              <th className="px-1 text-right">KAST</th>
              <th className="px-1 text-right">HS%</th>
              <th className="px-1 text-right">首杀</th>
              <th className="px-1 text-right">AWP</th>
              <th className="px-2 text-right">道具</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => (
              <tr key={player.name} className="border-t border-cs2-border/70 hover:bg-cs2-bg-hover">
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => onSelectPlayer?.(player.name)} className="flex max-w-full items-center gap-1.5 text-left">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${teamDot(teamKey)}`} />
                    <span className="truncate text-[11px] font-bold text-cs2-text-primary">{player.name}</span>
                  </button>
                </td>
                <td className="px-1 text-right font-mono text-[9px] font-bold text-cs2-text-primary">{player.kills}</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{player.deaths}</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{player.assists}</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{Number(player.adr || 0).toFixed(0)}</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{Number(player.kast || 0).toFixed(0)}%</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{Number(player.hs_percent || 0).toFixed(0)}%</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{player.first_kills || 0}</td>
                <td className="px-1 text-right font-mono text-[9px] text-cs2-text-secondary">{player.awp_kills || 0}</td>
                <td className="px-2 text-right font-mono text-[9px] text-cs2-text-secondary">{player.utility_damage || 0}</td>
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
  const [scoreboardOpen, setScoreboardOpen] = useState(true);
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
    <div className="mx-auto w-full max-w-[1440px] space-y-3 pb-6">
      <MatchMainlineCard mainline={overview.mainline} />

      <section className="grid auto-rows-fr grid-cols-1 gap-2.5 lg:grid-cols-2 xl:grid-cols-12 xl:auto-rows-[210px]">
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
          className={`grid auto-rows-fr grid-cols-1 gap-2.5 md:grid-cols-2 xl:auto-rows-[176px] ${
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

      <section className="rounded-[10px] border border-cs2-border bg-cs2-bg-card shadow-sm">
        <header className="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <h2 className="text-[12px] font-bold text-cs2-text-primary">全场数据</h2>
          <button
            type="button"
            className="text-[10px] font-semibold text-cs2-accent hover:underline"
            onClick={() => setScoreboardOpen((open) => !open)}
          >
            {scoreboardOpen ? "收起数据" : "展开数据"}
          </button>
        </header>
        {scoreboardOpen ? (
          <div className="border-t border-cs2-border p-2.5">
            <div className="mb-2 flex gap-1 md:hidden">
              {[
                ["a", teamAName],
                ["b", teamBName],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMobileScoreTeam(key)}
                  className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold ${
                    mobileScoreTeam === key
                      ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent"
                      : "border-cs2-border text-cs2-text-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
        ) : null}
      </section>
    </div>
  );
}

function FilterChip({ active, children, onClick }) {
  return <button type="button" onClick={onClick} className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold ${active ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-input/40 text-cs2-text-muted hover:text-cs2-text-primary"}`}>{children}</button>;
}

function EventIcon({ type }) {
  if (type === "kill") return <Crosshair className="h-3.5 w-3.5" />;
  if (type === "grenade") return <Bomb className="h-3.5 w-3.5" />;
  if (type === "plant" || type === "explode") return <Zap className="h-3.5 w-3.5" />;
  return <ShieldCheck className="h-3.5 w-3.5" />;
}

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

function RoundEventDetail({ event }) {
  if (event.type === "kill") {
    const weapon = event.weapon || "武器";
    return <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"><KillfeedIconStrip event={{ ...event, is_headshot: Boolean(event.headshot) }} weaponName={weapon} weaponKey={weapon} /><span className="text-[10px] font-semibold text-sky-200">{event.target || "未知玩家"}</span></span>;
  }
  const text = event.type === "grenade" ? `投掷 ${event.kind || "投掷物"}`
    : event.type === "plant" ? `在 ${event.site || "?"} 区下包`
      : event.type === "defuse" ? "完成拆弹"
        : event.type === "bomb_pickup" ? "捡起 C4"
          : event.type === "bomb_drop" ? "丢下 C4"
            : event.type === "explode" ? "C4 爆炸"
              : "比赛事件";
  return <p className="mt-0.5 text-[10px] text-cs2-text-muted">{text}</p>;
}

function RoundEventBody({ event }) {
  const actor = event.actor || (event.type === "explode" ? "C4" : "比赛事件");
  if (event.type === "kill") {
    return <div className="flex min-w-0 items-center gap-2 whitespace-nowrap"><p className="shrink-0 text-[11px] font-bold text-cs2-text-primary">{actor}</p><RoundEventDetail event={event} /></div>;
  }
  return <div><p className="text-[11px] font-bold text-cs2-text-primary">{actor}</p><RoundEventDetail event={event} /></div>;
}

export function RoundsView({ data, selectedRound, onSelectRound, onOpenReplayRound }) {
  const [winnerFilter, setWinnerFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [economyFilter, setEconomyFilter] = useState("all");
  const [siteFilter, setSiteFilter] = useState("all");
  const [openingFilter, setOpeningFilter] = useState("all");
  const [endFilter, setEndFilter] = useState("all");
  const [specialOnly, setSpecialOnly] = useState(false);
  const playerTeamByName = useMemo(() => new Map(data.players.map((player) => [String(player.name || "").toLowerCase(), player.team_key])), [data.players]);
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
  const round = data.rounds.find((item) => Number(item.round_number) === Number(selectedRound)) || visibleRounds[0] || data.rounds[0];
  if (!round) return <Panel title="回合列表"><div className="p-12 text-center text-[11px] text-cs2-text-muted">当前解析结果没有正式回合。</div></Panel>;
  const displayEvents = roundEventsForDisplay(round);
  return (
    <div className="space-y-3">
      <Panel><div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2"><div className="mr-1 flex items-center gap-1.5 text-[10px] font-bold text-cs2-text-secondary"><Filter className="h-3.5 w-3.5" />回合筛选</div><FilterChip active={winnerFilter === "all"} onClick={() => setWinnerFilter("all")}>全部</FilterChip><FilterChip active={winnerFilter === "a"} onClick={() => setWinnerFilter("a")}>{data.team_a_name} 胜</FilterChip><FilterChip active={winnerFilter === "b"} onClick={() => setWinnerFilter("b")}>{data.team_b_name} 胜</FilterChip><span className="mx-1 h-4 w-px bg-cs2-border" /><FilterChip active={sideFilter === "CT"} onClick={() => setSideFilter(sideFilter === "CT" ? "all" : "CT")}>CT 胜</FilterChip><FilterChip active={sideFilter === "T"} onClick={() => setSideFilter(sideFilter === "T" ? "all" : "T")}>T 胜</FilterChip><FilterChip active={specialOnly} onClick={() => setSpecialOnly((value) => !value)}>关键回合</FilterChip><span className="ml-auto font-mono text-[10px] text-cs2-text-muted">命中 {visibleRounds.length}/{data.rounds.length}</span></div>
        <div className="flex flex-wrap items-center gap-2"><span className="text-[9px] font-bold text-cs2-text-muted">经济</span>{[["all", "全部经济"], ["pistol", "手枪"], ["eco", "纯 ECO"], ["force", "强起"], ["semi", "半起"], ["full", "全枪全弹"]].map(([key, label]) => <FilterChip key={key} active={economyFilter === key} onClick={() => setEconomyFilter(key)}>{label}</FilterChip>)}<span className="ml-2 text-[9px] font-bold text-cs2-text-muted">包点</span>{[["all", "全部包点"], ["A", "A 点"], ["B", "B 点"], ["none", "未下包"]].map(([key, label]) => <FilterChip key={key} active={siteFilter === key} onClick={() => setSiteFilter(key)}>{label}</FilterChip>)}</div>
        <div className="flex flex-wrap items-center gap-2"><span className="text-[9px] font-bold text-cs2-text-muted">首杀</span><FilterChip active={openingFilter === "all"} onClick={() => setOpeningFilter("all")}>不限</FilterChip><FilterChip active={openingFilter === "a"} onClick={() => setOpeningFilter("a")}>{data.team_a_name}</FilterChip><FilterChip active={openingFilter === "b"} onClick={() => setOpeningFilter("b")}>{data.team_b_name}</FilterChip><label className="ml-2 text-[9px] font-bold text-cs2-text-muted" htmlFor="round-end-filter">结束方式</label><select id="round-end-filter" value={endFilter} onChange={(event) => setEndFilter(event.target.value)} className="rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1 text-[10px] text-cs2-text-secondary outline-none focus:border-cs2-accent"><option value="all">全部结束方式</option><option value="ct_elimination">CT 歼灭</option><option value="defuse">拆弹</option><option value="t_elimination">T 歼灭</option><option value="explode">爆弹</option></select></div>
      </div></Panel>
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.5fr)]">
        <Panel title="回合列表" eyebrow="Round explorer" className="flex h-[620px] min-h-0 flex-col overflow-hidden"><div className="min-h-0 flex-1 overflow-y-auto p-2 custom-scrollbar">{visibleRounds.map((item) => { const side = roundWinnerSide(item); return <button key={item.round_number} type="button" onClick={() => onSelectRound(item.round_number)} className={`mb-1 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${Number(round.round_number) === Number(item.round_number) ? "border-cs2-accent/45 bg-cs2-accent-soft" : "border-transparent hover:border-cs2-border hover:bg-cs2-bg-hover"}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold ${item.winner_team_key === "a" ? "bg-sky-500/15 text-sky-400" : "bg-amber-500/15 text-amber-400"}`}>R{item.round_number}</span><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-cs2-text-primary">{item.headline}</p><p className="mt-0.5 text-[9px] text-cs2-text-muted">{scoreText(item)} · {item.site ? `${item.site} 区 · ` : ""}{durationText(item.duration_seconds)}</p></div><span className={`shrink-0 rounded px-2 py-1 text-[8px] font-black ${side === "CT" ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"}`}>{side || "—"} 胜</span></button>; })}{!visibleRounds.length && <p className="px-4 py-12 text-center text-[10px] text-cs2-text-muted">当前条件没有匹配的回合。</p>}</div></Panel>
        <Panel title={`第 ${round.round_number} 回合 · ${round.headline}`} eyebrow={`${round.winner_team_key === "a" ? data.team_a_name : data.team_b_name} 获胜`} className="flex h-[620px] min-h-0 flex-col overflow-hidden" action={<Button size="sm" onClick={() => onOpenReplayRound(round.round_number)}><MapPin className="h-3 w-3" />跳转至 2D 地图查看当前回合</Button>}>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar"><div className="mb-5 grid grid-cols-3 items-center gap-3 rounded-xl border border-cs2-border bg-cs2-bg-input/35 p-4 text-center"><div><p className="text-[10px] font-bold text-sky-400">{data.team_a_name}</p><p className="mt-1 text-[10px] text-cs2-text-muted">{economyLabel(round.team_a_economy)} · {money(round.team_a_equipment_value)}</p></div><div><p className="font-mono text-2xl font-black text-cs2-text-primary">{scoreText(round)}</p><p className="text-[9px] uppercase tracking-wider text-cs2-text-muted">Round score</p></div><div><p className="text-[10px] font-bold text-amber-400">{data.team_b_name}</p><p className="mt-1 text-[10px] text-cs2-text-muted">{economyLabel(round.team_b_economy)} · {money(round.team_b_equipment_value)}</p></div></div>
            <div className="relative ml-2 border-l border-cs2-border pl-5">{displayEvents.map((event, index) => <div key={`${event.type}-${event.tick}-${index}`} className="relative pb-5 last:pb-0"><span className={`absolute -left-[27px] top-0.5 h-3 w-3 rounded-full border-2 border-cs2-bg-card ${event.type === "kill" ? "bg-cs2-accent" : "bg-cs2-text-muted"}`} /><div className="flex items-start gap-3"><span className="w-9 shrink-0 font-mono text-[9px] text-cs2-text-muted">{event.time_text || "--:--"}</span><span className={event.type === "kill" ? "text-cs2-accent" : "text-cs2-text-secondary"}><EventIcon type={event.type} /></span><RoundEventBody event={event} /></div></div>)}{!displayEvents.length && <p className="py-8 text-center text-[10px] text-cs2-text-muted">该回合没有可展示的击杀或目标事件。</p>}</div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function StatBar({ label, value, display, max = 100 }) {
  const width = Math.max(0, Math.min(100, Number(value || 0) / Math.max(1, max) * 100));
  return <div className="grid grid-cols-[104px_minmax(100px,1fr)_52px] items-center gap-2"><span className="text-[10px] text-cs2-text-secondary">{label}</span><div className="h-1.5 overflow-hidden rounded-full bg-cs2-bg-input"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400" style={{ width: `${width}%` }} /></div><span className="text-right font-mono text-[10px] font-bold text-cs2-text-primary">{display ?? value}</span></div>;
}

function StatGroup({ title, rows }) {
  return <section className="rounded-lg border border-cs2-border bg-cs2-bg-input/20 p-3"><h3 className="mb-3 text-[9px] font-black uppercase tracking-wider text-cs2-text-secondary">{title}</h3><div className="space-y-2.5">{rows.map((row) => <StatBar key={row.label} {...row} />)}</div></section>;
}

export function PlayersView({ data, selectedPlayer, onSelectPlayer, onBackToOverview }) {
  const player = data.players.find((item) => item.name === selectedPlayer) || data.players[0];
  if (!player) return <Panel title="全部玩家"><div className="p-12 text-center text-[11px] text-cs2-text-muted">当前解析结果没有玩家统计。</div></Panel>;
  const groups = [
    { title: "Combat", rows: [{ label: "击杀", value: player.kills, max: 40 }, { label: "死亡", value: player.deaths, max: 40 }, { label: "助攻", value: player.assists, max: 20 }, { label: "KPR", value: player.kpr, display: Number(player.kpr || 0).toFixed(2), max: 1.4 }, { label: "DPR", value: player.dpr, display: Number(player.dpr || 0).toFixed(2), max: 1.2 }, { label: "ADR", value: player.adr, display: Number(player.adr || 0).toFixed(1), max: 130 }, { label: "HS%", value: player.hs_percent, display: `${Number(player.hs_percent || 0).toFixed(0)}%` }, { label: "KAST", value: player.kast, display: `${Number(player.kast || 0).toFixed(0)}%` }, { label: "存活率", value: player.survival_rate, display: `${Number(player.survival_rate || 0).toFixed(0)}%` }, { label: "2 杀回合", value: player.two_kill_rounds, max: 8 }, { label: "3 杀回合", value: player.three_kill_rounds, max: 5 }, { label: "4 杀回合", value: player.four_kill_rounds, max: 3 }, { label: "5 杀回合", value: player.five_kill_rounds, max: 1 }] },
    { title: "Opening / Trade", rows: [{ label: "首杀", value: player.first_kills, max: 10 }, { label: "首死", value: player.first_deaths, max: 10 }, { label: "首杀对决胜率", value: player.opening_duel_win_rate, display: `${Number(player.opening_duel_win_rate || 0).toFixed(0)}%` }, { label: "补枪", value: player.trade_kills, max: 10 }, { label: "被补枪", value: player.trade_deaths, max: 10 }, { label: "补枪率", value: player.trade_kill_rate, display: `${Number(player.trade_kill_rate || 0).toFixed(0)}%` }] },
    { title: "Clutch / Weapon", rows: [{ label: "残局尝试", value: player.clutch_attempts || 0, max: 8 }, { label: "残局获胜", value: player.clutch_wins || 0, max: 5 }, { label: "AWP 击杀", value: player.awp_kills, max: 20 }, { label: "爆头数", value: player.headshots, max: 30 }, { label: "多杀回合", value: Number(player.two_kill_rounds || 0) + Number(player.three_kill_rounds || 0) + Number(player.four_kill_rounds || 0) + Number(player.five_kill_rounds || 0), max: 12 }] },
    { title: "Utility / Economy", rows: [{ label: "道具伤害", value: player.utility_damage, max: 500 }, { label: "每回合道伤", value: player.utility_damage_per_round, display: Number(player.utility_damage_per_round || 0).toFixed(1), max: 25 }, { label: "平均装备价值", value: player.average_equipment_value, display: money(player.average_equipment_value), max: 6000 }] },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel title="全部玩家" eyebrow={`${data.players.length} / ${data.players.length} 已分析`}><div className="divide-y divide-cs2-border">{data.players.map((item) => <button key={item.name} type="button" onClick={() => onSelectPlayer(item.name)} className={`flex w-full items-center gap-3 px-4 py-3 text-left ${player.name === item.name ? "bg-cs2-accent-soft" : "hover:bg-cs2-bg-hover"}`}><span className={`h-2 w-2 rounded-full ${teamDot(item.team_key)}`} /><div className="min-w-0 flex-1"><p className={`truncate text-[11px] font-bold ${player.name === item.name ? "text-cs2-accent" : "text-cs2-text-primary"}`}>{item.name}</p><p className="font-mono text-[9px] text-cs2-text-muted">{item.kills}–{item.deaths} · {Number(item.adr || 0).toFixed(1)} ADR</p></div></button>)}</div></Panel>
      <div className="space-y-4">
        <Panel><div className="flex flex-wrap items-center gap-4 p-5"><div className={`flex h-14 w-14 items-center justify-center rounded-xl text-xl font-black ${player.team_key === "a" ? "bg-sky-500/15 text-sky-400" : "bg-amber-500/15 text-amber-400"}`}>{player.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="text-xl font-black text-cs2-text-primary">{player.name}</h2><Badge variant="orange">{player.team_key === "a" ? data.team_a_name : data.team_b_name}</Badge></div><p className="mt-1 text-[10px] text-cs2-text-muted">全场表现 · {data.rounds.length} 回合 · 原始 Demo 统计</p></div><Button variant="secondary" onClick={onBackToOverview}><ArrowLeft className="h-3.5 w-3.5" />返回概览</Button></div></Panel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard icon={Swords} label="K / D / A" value={`${player.kills} / ${player.deaths} / ${player.assists}`} detail={`${Number(player.kd || 0).toFixed(2)} K/D`} tone="blue" /><MetricCard icon={Activity} label="ADR" value={Number(player.adr || 0).toFixed(1)} detail={`总伤害约 ${Math.round(Number(player.adr || 0) * Math.max(1, data.rounds.length))}`} /><MetricCard icon={ShieldCheck} label="KAST" value={`${Number(player.kast || 0).toFixed(0)}%`} detail={`${player.trade_kills || 0} 次有效补枪`} tone="green" /><MetricCard icon={Gauge} label="爆头率" value={`${Number(player.hs_percent || 0).toFixed(0)}%`} detail={`${player.first_kills || 0} 次首杀 · ${player.awp_kills || 0} 次 AWP 击杀`} tone="violet" /></div>
        <Panel title="详细数据" eyebrow="全场表现拆分 · 原始统计"><div className="grid gap-3 p-4 xl:grid-cols-2">{groups.map((group) => <StatGroup key={group.title} {...group} />)}</div></Panel>
      </div>
    </div>
  );
}

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
  const bandColors = { pistol: "#7c6b32", eco: "#26303b", semi: "#173747", force: "#4a2d24", full: "#12382b" };
  const bandW = innerW / Math.max(1, rounds.length);
  return (
    <div className="overflow-x-auto"><svg viewBox={`0 0 ${width} ${height}`} className="min-w-[760px] w-full"><line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="rgba(255,255,255,.12)" /><line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="rgba(255,255,255,.12)" />{[0, 0.5, 1].map((ratio) => <g key={ratio}><line x1={pad.left} y1={pad.top + innerH * ratio} x2={width - pad.right} y2={pad.top + innerH * ratio} stroke="rgba(255,255,255,.07)" /><text x={pad.left - 10} y={pad.top + innerH * ratio + 4} textAnchor="end" fill="#747985" fontSize="11">{money(maxValue * (1 - ratio))}</text></g>)}{rounds.map((round, index) => <g key={round.round_number}><rect x={pad.left + index * bandW} y={pad.top} width={bandW - 1} height={innerH} fill={bandColors[round.team_a_economy] || bandColors.semi} opacity=".55" /><text x={pad.left + index * bandW + bandW / 2} y={height - 18} textAnchor="middle" fill="#747985" fontSize="10">R{round.round_number}</text></g>)}<path d={path("team_a_equipment_value")} fill="none" stroke="#5da9ff" strokeWidth="4" strokeLinejoin="round" /> <path d={path("team_b_equipment_value")} fill="none" stroke="#36d399" strokeWidth="4" strokeLinejoin="round" />{rounds.map((round, index) => <g key={`points-${round.round_number}`}><circle cx={x(index)} cy={y(round.team_a_equipment_value)} r="3.5" fill="#5da9ff" /><circle cx={x(index)} cy={y(round.team_b_equipment_value)} r="3.5" fill="#36d399" /></g>)}</svg><div className="flex items-center gap-5 px-2 text-[9px]"><span className="text-sky-400">━ {teamAName}</span><span className="text-emerald-400">━ {teamBName}</span><span className="ml-auto text-cs2-text-muted">背景：手枪 / ECO / 半起 / 强起 / 长枪</span></div></div>
  );
}

export function EconomyView({ data, onOpenRound }) {
  return (
    <Panel title="经济走势" eyebrow="双方每回合装备价值 · 背景表示低经济一方购买类型"><div className="p-4"><EconomyChart rounds={data.rounds} teamAName={data.team_a_name} teamBName={data.team_b_name} /><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">{data.rounds.map((round) => <button key={round.round_number} type="button" onClick={() => onOpenRound(round.round_number)} className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-2.5 text-left hover:border-cs2-accent/40"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] font-bold text-cs2-text-primary">R{round.round_number} {Number(round.team_a_score_after || 0)}:{Number(round.team_b_score_after || 0)}</span><span className={`shrink-0 text-[8px] font-bold ${round.winner_team_key === "a" ? "text-sky-400" : "text-emerald-400"}`}>{round.winner_team_key === "a" ? data.team_a_name : data.team_b_name} 胜</span></div><p className="mt-1 text-[8px] text-sky-400">{data.team_a_name}: {economyLabel(round.team_a_economy)} · {money(round.team_a_equipment_value)}</p><p className="mt-0.5 text-[8px] text-emerald-400">{data.team_b_name}: {economyLabel(round.team_b_economy)} · {money(round.team_b_equipment_value)}</p></button>)}</div></div></Panel>
  );
}
