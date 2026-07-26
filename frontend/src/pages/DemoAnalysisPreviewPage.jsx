import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleDollarSign,
  Crosshair,
  FileVideo2,
  Film,
  Flame,
  Library,
  ListChecks,
  Loader2,
  MapPin,
  Play,
  RefreshCw,
  Swords,
  Users,
} from "lucide-react";
import ActionBar from "../components/ActionBar";
import ClipList from "../components/ClipList";
import DemoUpload from "../components/DemoUpload";
import RoundTimelineView from "../components/analysis/timeline/RoundTimelineView";
import WeaponKillsView from "../components/analysis/WeaponKillsView";
import Demo2DReplayPreview from "../components/analysis/Demo2DReplayPreview";
import DemoHeatmapView from "../components/analysis/DemoHeatmapView";
import { useReplayStore } from "../stores/replayStore";
import {
  EconomyView,
  OverviewView,
  PlayersView,
  RoundsView,
  useWorkspaceData,
} from "../components/analysis/DemoAnalysisWorkspaceViews";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import { useAppShell } from "../context/AppShellContext";
import { useDemoPlaybackDialog } from "../hooks/useDemoPlaybackDialog.jsx";
import useSessionState from "../hooks/useSessionState";
import { summarizeWeaponKills } from "../utils/weaponKillCompilations.js";

const PAGE_CONTAINER_CLASS = "mx-auto w-full max-w-[1440px] px-5 sm:px-5";

const TABS = [
  { key: "highlights", label: "高光与录制", icon: Film },
  { key: "replay", label: "2D 回放", icon: MapPin },
  { key: "heatmap", label: "热力图", icon: Flame },
  { key: "overview", label: "概览", icon: Activity },
  { key: "players", label: "玩家", icon: Users },
  { key: "rounds", label: "回合", icon: ListChecks },
  { key: "economy", label: "经济", icon: CircleDollarSign },
];

function playerName(player) {
  return String(player?.name || player?.player_name || "").trim();
}

function playerTeamNumber(player) {
  const value = Number(player?.team ?? player?.team_number);
  return value === 2 || value === 3 ? value : null;
}

function splitTeams(players) {
  const list = Array.isArray(players) ? players : [];
  const explicitA = list.filter((player) => playerTeamNumber(player) === 2);
  const explicitB = list.filter((player) => playerTeamNumber(player) === 3);
  if (explicitA.length || explicitB.length) return { a: explicitA, b: explicitB };
  const pivot = Math.ceil(list.length / 2);
  return { a: list.slice(0, pivot), b: list.slice(pivot) };
}

function firstTeamName(players, fallback) {
  return players.map((player) => String(player?.team_name || "").trim()).find(Boolean) || fallback;
}

function demoLabel(match, index) {
  return String(match?.demo_filename || match?.filename || `Demo ${index + 1}`).trim();
}

function mapLabel(mapName) {
  const raw = String(mapName || "").trim();
  if (!raw) return "未知地图";
  return raw.replace(/^de_/, "").replace(/^./, (value) => value.toUpperCase());
}

function MetricCard({ icon: Icon, label, value, detail }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-cs2-border bg-cs2-bg-card px-3.5 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-cs2-text-muted">{label}</p>
        <p className="mt-0.5 truncate text-lg font-black tabular-nums text-cs2-text-primary">{value}</p>
        <p className="truncate text-[9px] text-cs2-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function Panel({ title, eyebrow, action, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm ${className}`}>
      {(title || eyebrow || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-cs2-border px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <p className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-cs2-accent">{eyebrow}</p>}
            {title && <h2 className="truncate text-[13px] font-bold text-cs2-text-primary">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

function DemoSelector({ matches, currentIndex, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = matches[currentIndex];

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => setOpen(false), [currentIndex]);

  return (
    <div ref={rootRef} className="relative z-[80] min-w-[310px] max-w-[520px]">
      <button
        type="button"
        aria-label="切换 Demo"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || !matches.length}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 text-left text-[10px] transition-colors hover:border-cs2-accent/45 disabled:opacity-45"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />
        <span className="shrink-0 font-semibold text-cs2-text-muted">Demo {matches.length ? currentIndex + 1 : 0}/{matches.length}</span>
        <span className="min-w-0 flex-1 truncate font-mono font-semibold text-cs2-text-primary" title={current ? demoLabel(current, currentIndex) : ""}>
          {current ? demoLabel(current, currentIndex) : "未载入 Demo"}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cs2-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-[100] w-full min-w-[420px] overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card shadow-2xl shadow-black/60">
          <div className="border-b border-cs2-border px-3 py-2 text-[9px] font-bold uppercase tracking-[0.18em] text-cs2-text-muted">
            本次载入的 Demo · {matches.length}
          </div>
          <div role="listbox" aria-label="本次载入的 Demo" className="max-h-72 overflow-y-auto p-1.5 custom-scrollbar">
            {matches.map((match, index) => {
              const active = index === currentIndex;
              const meta = match?.match_meta || {};
              return (
                <button
                  key={`${demoLabel(match, index)}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(index);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${active ? "bg-cs2-accent-soft text-cs2-text-primary" : "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary"}`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[9px] font-black ${active ? "bg-cs2-accent text-cs2-text-on-accent" : "bg-cs2-bg-input text-cs2-text-muted"}`}>{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[10px] font-semibold" title={demoLabel(match, index)}>{demoLabel(match, index)}</span>
                    <span className="mt-0.5 block truncate text-[8px] text-cs2-text-muted">{mapLabel(meta.map_name)}{match?.parsed ? " · 已解析" : " · 待解析"}</span>
                  </span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerPicker({ teams, teamAName, teamBName, activePlayer, parsedPlayers, totalPlayers, parsing, onSelect }) {
  const renderTeam = (players, teamName, tone) => {
    const isBlue = tone === "blue";
    return (
      <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-2.5">
        <div className="mb-2 flex items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted">
          <span className={`h-2 w-2 rounded-full ${isBlue ? "bg-sky-400" : "bg-amber-400"}`} />
          {teamName}
        </div>
        <div className="grid gap-1.5 sm:grid-cols-5 md:grid-cols-1 lg:grid-cols-5">
          {players.map((player) => {
            const name = playerName(player);
            const active = name === activePlayer;
            const clipCount = (parsedPlayers?.[name]?.clips || []).filter((clip) => clip.category !== "meme_death").length;
            return (
              <button
                key={`${name}-${player?.steam_id64 || player?.steam_id || ""}`}
                type="button"
                aria-label={`选择 ${name}`}
                onClick={() => onSelect(name)}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${active ? (isBlue ? "border-sky-400/60 bg-sky-500/10" : "border-amber-400/60 bg-amber-500/10") : "border-cs2-border bg-cs2-bg-card hover:bg-cs2-bg-hover"}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[10px] font-bold text-cs2-text-primary">{name}</span>
                  {active ? <span className={`h-1.5 w-1.5 rounded-full ${isBlue ? "bg-sky-400" : "bg-amber-400"}`} /> : null}
                </div>
                <p className="mt-1 font-mono text-[8px] text-cs2-text-muted">
                  {Number(player?.kills || 0)}–{Number(player?.deaths || 0)} · {clipCount} 片段
                </p>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Panel
      title="选择玩家"
      action={(
        <span className="inline-flex items-center gap-1.5 font-mono text-[9px] text-cs2-text-muted">
          {parsing ? <Loader2 className="h-3 w-3 animate-spin text-cs2-accent" /> : <Check className="h-3 w-3 text-emerald-400" />}
          {parsing ? "正在自动解析全场" : `已解析 ${Object.keys(parsedPlayers || {}).length}/${totalPlayers}`}
        </span>
      )}
    >
      <div className="grid gap-3 p-3 md:grid-cols-2">
        {renderTeam(teams.a, teamAName, "blue")}
        {renderTeam(teams.b, teamBName, "amber")}
      </div>
    </Panel>
  );
}

function TeamScoreboard({ name, score, players, tone, parsedNames }) {
  const isBlue = tone === "blue";
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-input/20">
      <header className={`flex items-center justify-between border-b px-4 py-3 ${isBlue ? "border-sky-500/20 bg-sky-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
        <div className="flex items-center gap-2.5">
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-black ${isBlue ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"}`}>{name.slice(0, 1).toUpperCase()}</span>
          <h3 className={`text-[12px] font-black tracking-wider ${isBlue ? "text-sky-300" : "text-amber-300"}`}>{name}</h3>
        </div>
        <span className={`font-mono text-2xl font-black ${isBlue ? "text-sky-200" : "text-amber-200"}`}>{score}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] border-collapse text-left">
          <thead className="border-b border-cs2-border bg-cs2-bg-input/55 text-[9px] uppercase tracking-wider text-cs2-text-muted">
            <tr><th className="px-3 py-2.5">玩家</th><th className="px-2 py-2.5 text-right">K</th><th className="px-2 py-2.5 text-right">D</th><th className="px-2 py-2.5 text-right">A</th><th className="px-3 py-2.5 text-right">K/D</th></tr>
          </thead>
          <tbody>
            {players.map((player) => {
              const nameValue = playerName(player);
              const kills = Number(player?.kills || 0);
              const deaths = Number(player?.deaths || 0);
              return (
                <tr key={`${nameValue}-${player?.steam_id64 || ""}`} className="border-t border-cs2-border/70">
                  <td className="px-3 py-2.5"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${isBlue ? "bg-sky-400" : "bg-amber-400"}`} /><span className="font-semibold text-cs2-text-primary">{nameValue}</span>{parsedNames.includes(nameValue) && <Badge variant="green" className="px-1 py-0 text-[8px]">已解析</Badge>}</div></td>
                  <td className="px-2 py-2.5 text-right font-mono text-[10px]">{kills}</td>
                  <td className="px-2 py-2.5 text-right font-mono text-[10px]">{deaths}</td>
                  <td className="px-2 py-2.5 text-right font-mono text-[10px]">{Number(player?.assists || 0)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[10px] font-bold">{Number(player?.kd ?? kills / Math.max(1, deaths)).toFixed(2)}</td>
                </tr>
              );
            })}
            {!players.length && <tr><td colSpan="5" className="px-3 py-8 text-center text-[10px] text-cs2-text-muted">暂无阵容数据</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EmptyResult({ onAnalyze, disabled, parsing }) {
  return (
    <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-card/45 p-8 text-center">
      <div><Swords className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold text-cs2-text-primary">{parsing ? "正在自动解析当前 Demo" : "当前 Demo 暂无解析结果"}</h2><p className="mt-1 text-[10px] text-cs2-text-muted">载入后会自动分析本场全部玩家；每个 Demo 的结果可在右上角独立切换。</p>{!parsing && <Button className="mt-4" disabled={disabled} onClick={onAnalyze}>重新解析当前 Demo</Button>}</div>
    </div>
  );
}

function UnsupportedPreview({ title, detail }) {
  return (
    <Panel title={title} eyebrow="保留预览入口">
      <div className="flex min-h-[300px] items-center justify-center p-8 text-center">
        <div><Activity className="mx-auto h-7 w-7 text-cs2-text-muted" /><p className="mt-3 text-[12px] font-bold text-cs2-text-primary">当前解析结果暂不包含此数据</p><p className="mt-1 text-[10px] text-cs2-text-muted">{detail}</p></div>
      </div>
    </Panel>
  );
}

export default function DemoAnalysisPreviewPage() {
  const s = useAppShell();
  const { requestPlayDemo, DemoPlaybackUi } = useDemoPlaybackDialog();
  const matches = s.matchTabsData || [];
  const currentUpload = s.uploadedDemos?.[s.currentMatchIndex] ?? null;
  const sessionIdentity = encodeURIComponent(String(
    currentUpload?.path
    || currentUpload?.id
    || matches[s.currentMatchIndex]?.demo_filename
    || matches[s.currentMatchIndex]?.filename
    || `demo-${s.currentMatchIndex}`,
  ));
  const sessionPrefix = `demo-analysis:${sessionIdentity}`;
  const [activeTab, setActiveTab] = useSessionState(`${sessionPrefix}:tab`, "highlights");
  const [activeHighlightView, setActiveHighlightView] = useSessionState(`${sessionPrefix}:highlight-view`, "clips");
  const [selectedTag, setSelectedTag] = useSessionState(`${sessionPrefix}:tag`, "全部");
  const [selectedRound, setSelectedRound] = useSessionState(`${sessionPrefix}:round`, null);
  const [replayRound, setReplayRound] = useSessionState(`${sessionPrefix}:replay-round`, null);
  const [statsPlayer, setStatsPlayer] = useSessionState(`${sessionPrefix}:stats-player`, "");
  const uploadedDemoCount = s.uploadedDemos?.length || 0;
  const parsedDemoCount = matches.filter((match) => match?.parsed).length;
  const allDemosParsed = uploadedDemoCount > 0
    && matches.length === uploadedDemoCount
    && matches.every((match) => match?.parsed);
  const analysisGateActive = Boolean(
    s.parsing
    || s.anyDemoParsing
    || s.analysisInlineProgress?.active,
  );
  const analysisGateText = s.analysisInlineProgress?.text
    || s.progressText
    || (analysisGateActive
      ? `正在解析所选 Demo（${parsedDemoCount}/${uploadedDemoCount}）…`
      : `尚有 ${Math.max(0, uploadedDemoCount - parsedDemoCount)} 个 Demo 未完成解析`);
  const meta = s.matchMeta || currentUpload?.match_meta || matches[s.currentMatchIndex]?.match_meta || {};
  const teams = useMemo(() => splitTeams(s.players), [s.players]);
  const teamAName = meta.team_a_name || firstTeamName(teams.a, "Team A");
  const teamBName = meta.team_b_name || firstTeamName(teams.b, "Team B");
  const workspaceFallback = useMemo(() => ({
    players: s.players,
    meta,
    teamAName,
    teamBName,
  }), [s.players, meta, teamAName, teamBName]);
  const workspace = useWorkspaceData(s.analysisWorkspace, workspaceFallback);
  const teamAScore = Number(workspace.team_a_score ?? meta.team_a_score ?? 0);
  const teamBScore = Number(workspace.team_b_score ?? meta.team_b_score ?? 0);
  const durationMins = Number(workspace.duration_mins ?? meta.duration_mins ?? 0);
  const totalRounds = Number(workspace.summary?.total_rounds ?? workspace.rounds?.length ?? meta.total_rounds ?? 0);
  const parsingCurrent = Boolean(s.parsing || s.parsingByIndex?.[s.currentMatchIndex]);
  const selectedCount = s.selectedPlayersList?.length || 0;
  const parsedNames = s.parsedPlayerNames || [];
  const parsedPlayers = s.currentParsed?.players || {};
  const activePlayer = s.currentActivePlayer || "";
  const selectedPlayer = (s.players || []).find((player) => playerName(player) === activePlayer) || null;
  const activePlayerResult = activePlayer ? parsedPlayers[activePlayer] : null;
  const playerAiReviewed = Boolean(activePlayerResult?.ai_reviewed) || (activePlayerResult?.clips || []).some((clip) => (
    clip?.ai_score != null || String(clip?.ai_commentary || clip?.ai_comment || "").trim()
  ));
  const playerAiReviewing = Boolean(s.aiReviewingPlayers?.[`${s.currentMatchIndex}:${activePlayer}`]);
  const totalClips = Object.values(s.currentParsed?.players || {}).reduce((sum, player) => sum + (player?.clips || []).filter((clip) => clip.category !== "meme_death").length, 0);
  const regularClips = (s.clips || []).filter((clip) => clip.category !== "meme_death");
  const tagCounts = useMemo(() => {
    const counts = new Map([["全部", regularClips.length]]);
    regularClips.forEach((clip) => (clip.context_tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()];
  }, [regularClips]);
  const visibleClips = selectedTag === "全部"
    ? regularClips
    : regularClips.filter((clip) => (clip.context_tags || []).includes(selectedTag));
  const weaponSummary = summarizeWeaponKills(s.roundTimeline);
  const canAnalyze = Boolean(s.hasDemos && selectedCount && !parsingCurrent && !s.batchRecording);

  const selectPlayer = (name) => {
    s.setActivePlayerTabs((previous) => ({ ...previous, [s.currentMatchIndex]: name }));
    setActiveHighlightView("clips");
    setSelectedTag("全部");
    if (s.aiMode) void s.ensurePlayerAiReview?.(name, s.currentMatchIndex);
  };

  const playCurrentDemo = () => {
    if (!currentUpload) return;
    void requestPlayDemo({
      id: currentUpload.id,
      path: currentUpload.path,
      label: currentUpload.filename || s.currentFilename || "Demo",
    });
  };

  const openPlayerStats = (name) => {
    setStatsPlayer(name);
    setActiveTab("players");
  };

  const openRound = (roundNumber) => {
    setSelectedRound(roundNumber);
    setActiveTab("rounds");
  };

  const openReplayRound = (roundNumber) => {
    setReplayRound(roundNumber);
    setActiveTab("replay");
  };

  if (!s.hasDemos) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3"><div><h1 className="text-lg font-black text-cs2-text-primary">Demo 分析</h1><p className="mt-1 text-[10px] text-cs2-text-muted">上传单个或多个 Demo，或从 Demo 库勾选本次要分析的文件。</p></div><Link to="/library" className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"><Library className="h-3.5 w-3.5" />前往 Demo 库</Link></div>
          <DemoUpload onUpload={s.handleUpload} loading={Boolean(s.parsing)} loadingText={s.progressText} />
        </div>
      </div>
    );
  }

  if (!allDemosParsed || analysisGateActive) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-black text-cs2-text-primary">Demo 分析</h1>
              <p className="mt-1 text-[10px] text-cs2-text-muted">全部 Demo 解析完成后将自动进入计分板。</p>
            </div>
            <Button variant="secondary" size="sm" onClick={s.handleResetDemo} disabled={analysisGateActive}>
              <RefreshCw className="h-3.5 w-3.5" />重置 Demo
            </Button>
          </div>
          <DemoUpload onUpload={s.handleUpload} loading loadingText={analysisGateText} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-page text-cs2-text-primary">
      <header className="relative z-[60] shrink-0 overflow-visible border-b border-cs2-border bg-cs2-bg-page/95 py-3 backdrop-blur-md">
        <div className={`${PAGE_CONTAINER_CLASS} flex flex-wrap items-center justify-between gap-3`} data-testid="demo-analysis-header-container">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent"><BarChart3 className="h-4.5 w-4.5" /></div>
            <div className="min-w-0"><h1 className="text-[15px] font-black tracking-wide">Demo 分析</h1><p className="truncate font-mono text-[9px] text-cs2-text-muted">{s.currentFilename} · {s.currentMatchIndex + 1}/{matches.length}</p></div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DemoSelector matches={matches} currentIndex={s.currentMatchIndex} onChange={s.setCurrentMatchIndex} disabled={s.batchRecording} />
            <Button variant="secondary" size="sm" disabled={!currentUpload?.id && !currentUpload?.path} onClick={playCurrentDemo}><Play className="h-3 w-3 fill-current" />播放 Demo</Button>
            <Button variant="secondary" size="sm" onClick={s.handleResetDemo} disabled={s.anyDemoParsing || s.batchRecording}><RefreshCw className="h-3.5 w-3.5" />切换 Demo</Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className={`${PAGE_CONTAINER_CLASS} space-y-3 py-3`} data-testid="demo-analysis-content-container">
          <section className="relative overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card shadow-md">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-sky-500 via-cs2-accent to-amber-500" />
            <div className="grid h-[72px] items-center gap-2 px-4 md:grid-cols-[1fr_auto_1fr]">
              <div className={`flex min-w-0 items-center gap-2.5 md:justify-end md:text-right ${teamAScore > teamBScore ? "rounded-md bg-sky-500/8 px-2 py-1" : ""}`}>
                <div className="order-2 min-w-0 md:order-1">
                  <p className="truncate text-[11px] font-bold uppercase tracking-[0.14em] text-sky-400">{teamAName}</p>
                </div>
                <div className="order-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sm font-black text-sky-400 md:order-2">{teamAName.slice(0, 1).toUpperCase()}</div>
              </div>
              <div className="text-center">
                <div className="flex items-center justify-center gap-2.5">
                  <span className="font-mono text-3xl font-black text-sky-300">{teamAScore}</span>
                  <span className="text-lg font-black text-cs2-text-muted">:</span>
                  <span className="font-mono text-3xl font-black text-amber-300">{teamBScore}</span>
                </div>
                <div className="mt-0.5 text-[9px] uppercase tracking-wider text-cs2-text-muted">
                  {mapLabel(meta.map_name)} · {totalRounds} 回合{durationMins > 0 ? ` · ${durationMins} 分钟` : ""}
                </div>
              </div>
              <div className={`flex min-w-0 items-center gap-2.5 ${teamBScore > teamAScore ? "rounded-md bg-amber-500/8 px-2 py-1" : ""}`}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-sm font-black text-amber-400">{teamBName.slice(0, 1).toUpperCase()}</div>
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-bold uppercase tracking-[0.14em] text-amber-400">{teamBName}</p>
                </div>
              </div>
            </div>
          </section>

          <nav className="flex h-10 gap-1 overflow-x-auto rounded-[10px] border border-cs2-border bg-cs2-bg-card p-1" aria-label="Demo 分析视图">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onPointerDown={() => {
                  if (activeTab === "replay" && key !== "replay") {
                    useReplayStore.getState().requestSuspendPlayback();
                  }
                }}
                onClick={() => setActiveTab(key)}
                className={`flex min-w-fit items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${activeTab === key ? "bg-cs2-accent text-cs2-text-on-accent shadow-md shadow-cs2-accent/20" : "text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary"}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </nav>

          {activeTab === "highlights" && (
            <div className="space-y-4">
              <PlayerPicker teams={teams} teamAName={teamAName} teamBName={teamBName} activePlayer={activePlayer} parsedPlayers={parsedPlayers} totalPlayers={s.players.length} parsing={parsingCurrent} onSelect={selectPlayer} />
              {!s.currentParsed ? <EmptyResult parsing={parsingCurrent} onAnalyze={() => void s.handleParse()} disabled={!canAnalyze} /> : !selectedPlayer ? (
                <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-card/45 p-8 text-center"><div><Users className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold">先选择一名玩家</h2><p className="mt-1 text-[10px] text-cs2-text-muted">选择后显示该玩家的片段、回合时间线与枪械击杀。</p></div></div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="inline-flex rounded-lg border border-cs2-border bg-cs2-bg-card p-0.5">
                      {[["clips", "片段卡片"], ["rounds", "回合时间线"], ["weapons", "枪械击杀"]].map(([key, label]) => <button key={key} type="button" onClick={() => setActiveHighlightView(key)} className={`rounded-md px-3 py-1.5 text-[11px] font-semibold ${activeHighlightView === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-primary"}`}>{label}</button>)}
                    </div>
                    <div className="flex items-center gap-2 text-[9px] text-cs2-text-muted"><span className={`h-2 w-2 rounded-full ${playerTeamNumber(selectedPlayer) === 2 ? "bg-sky-400" : "bg-amber-400"}`} /><b className="text-cs2-text-primary">{activePlayer}</b><span>{Number(selectedPlayer.kills || 0)}–{Number(selectedPlayer.deaths || 0)} · {regularClips.length} 片段</span></div>
                  </div>

                  {activeHighlightView === "clips" && (
                    <>
                      {s.aiMode && <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2.5 text-[10px] text-violet-200">{playerAiReviewing ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Bot className="h-4 w-4 shrink-0" />}<span>{playerAiReviewing ? `正在为 ${activePlayer} 生成 AI 锐评…` : playerAiReviewed ? `已按设置中的 AI 洞察模式，为 ${activePlayer} 生成锐评。` : `已选择 ${activePlayer}，AI 锐评将在后台生成。`}</span></div>}
                      <Panel><div className="flex flex-wrap items-center gap-1.5 p-3"><span className="mr-1 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted">标签</span>{tagCounts.map(([tag, count]) => <button key={tag} type="button" onClick={() => setSelectedTag(tag)} className={`rounded-md border px-2 py-1 text-[9px] font-semibold transition-colors ${selectedTag === tag ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/80 bg-cs2-bg-input/35 text-cs2-text-muted hover:text-cs2-text-primary"}`}>{tag} <span className="ml-1 font-mono opacity-70">{count}</span></button>)}</div></Panel>
                      <ClipList clips={visibleClips} targetPlayer={activePlayer} selectedIds={s.selectedClientClipUids} onToggle={s.handleToggleClip} aiMode={s.aiMode} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onDequeue={s.handleDequeueClip} parsedPlayers={parsedPlayers} matchTotalRounds={s.roundMontageMaxRounds} freezeToDeathDraft={s.freezeToDeathDraft} onFreezeToDeathDraftChange={s.setFreezeToDeathDraft} roundMontagePickerDisabled={parsingCurrent || s.batchRecording} suppressSummaryHeader />
                      {regularClips.length > 0 && <ActionBar selectedCount={s.selectedRegularCount} totalCount={s.regularSelectableTotal} hasSelection={s.selectedClientClipUids.size > 0} onSelectAll={s.handleSelectAll} onDeselectAll={s.handleDeselectAll} onAddSelectedToQueue={s.handleAddSelectedToQueue} onAddCurrentPlayerHighlights={s.handleAddCurrentPlayerHighlights} currentPlayer={activePlayer} queueLength={s.queue.length} batchRecording={s.batchRecording} canAddCurrentPlayerHighlights={s.canAddCurrentPlayerHighlights} sticky />}
                    </>
                  )}
                  {activeHighlightView === "rounds" && <RoundTimelineView roundTimeline={s.roundTimeline} focusedPlayer={activePlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAddEvent={s.handleAddTimelineEventToQueue} onAddRound={s.handleAddTimelineRoundToQueue} onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} onRemoveRound={s.handleRemoveTimelineRoundFromQueue} suppressSummaryHeader />}
                  {activeHighlightView === "weapons" && <WeaponKillsView roundTimeline={s.roundTimeline} focusedPlayer={activePlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAdd={s.handleAddWeaponKillsToQueue} onRemove={s.handleDequeueClip} onAddEvent={s.handleAddTimelineEventToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} suppressSummaryHeader />}
                </>
              )}
            </div>
          )}

          {activeTab === "replay" && (
            <Demo2DReplayPreview
              key={currentUpload?.path || currentUpload?.id || s.currentMatchIndex}
              workspace={workspace}
              demoPath={currentUpload?.path}
              players={s.players}
              teamAName={workspace.team_a_name || teamAName}
              teamBName={workspace.team_b_name || teamBName}
              initialRound={replayRound}
              onRoundChange={setReplayRound}
            />
          )}

          {activeTab === "heatmap" && (
            <DemoHeatmapView
              key={currentUpload?.path || currentUpload?.id || s.currentMatchIndex}
              workspace={workspace}
              demoPath={currentUpload?.path}
              players={s.players}
            />
          )}

          {activeTab === "overview" && (
            <OverviewView
              data={workspace}
              onSelectPlayer={openPlayerStats}
              onOpenRound={openRound}
              onOpenReplayRound={openReplayRound}
              onOpenHighlights={() => setActiveTab("highlights")}
            />
          )}

          {activeTab === "rounds" && (
            <RoundsView
              data={workspace}
              selectedRound={selectedRound}
              onSelectRound={setSelectedRound}
              onOpenReplayRound={openReplayRound}
            />
          )}

          {activeTab === "players" && (
            <PlayersView
              data={workspace}
              selectedPlayer={statsPlayer || activePlayer}
              onSelectPlayer={setStatsPlayer}
              onBackToOverview={() => setActiveTab("overview")}
            />
          )}

          {activeTab === "economy" && (
            <EconomyView data={workspace} onOpenRound={openRound} />
          )}
        </main>
      </div>
      <DemoPlaybackUi />
    </div>
  );
}
