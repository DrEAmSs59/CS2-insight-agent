import { useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  ChevronRight,
  CircleDollarSign,
  Crosshair,
  Film,
  Filter,
  Gauge,
  ListChecks,
  MapPin,
  Play,
  ShieldCheck,
  Sparkles,
  Star,
  Swords,
  Target,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import ClipCard from "../components/ClipCard";
import Demo2DReplayPreview from "../components/analysis/Demo2DReplayPreview";

const TEAM_A = "NOVA";
const TEAM_B = "ORBIT";

const PLAYERS = [
  { id: "a1", name: "Mako", team: "a", kills: 24, deaths: 14, assists: 7, adr: 96.4, kast: 82, hs: 58, entry: 5, trade: 4, rr: 1.29 },
  { id: "a2", name: "Lynx", team: "a", kills: 20, deaths: 15, assists: 8, adr: 84.7, kast: 77, hs: 45, entry: 3, trade: 5, rr: 1.17 },
  { id: "a3", name: "Rime", team: "a", kills: 18, deaths: 14, assists: 10, adr: 79.2, kast: 73, hs: 39, entry: 2, trade: 6, rr: 1.09 },
  { id: "a4", name: "Aster", team: "a", kills: 16, deaths: 16, assists: 6, adr: 72.8, kast: 68, hs: 63, entry: 4, trade: 2, rr: 1.01 },
  { id: "a5", name: "Kite", team: "a", kills: 13, deaths: 15, assists: 9, adr: 66.1, kast: 73, hs: 46, entry: 1, trade: 4, rr: 0.94 },
  { id: "b1", name: "Frost", team: "b", kills: 21, deaths: 18, assists: 5, adr: 87.5, kast: 73, hs: 52, entry: 4, trade: 3, rr: 1.14 },
  { id: "b2", name: "Sonic", team: "b", kills: 17, deaths: 18, assists: 7, adr: 76.3, kast: 68, hs: 59, entry: 3, trade: 3, rr: 1.02 },
  { id: "b3", name: "Juno", team: "b", kills: 15, deaths: 17, assists: 8, adr: 71.9, kast: 64, hs: 41, entry: 2, trade: 4, rr: 0.96 },
  { id: "b4", name: "Vale", team: "b", kills: 13, deaths: 19, assists: 6, adr: 65.4, kast: 59, hs: 47, entry: 1, trade: 2, rr: 0.86 },
  { id: "b5", name: "Echo", team: "b", kills: 11, deaths: 19, assists: 9, adr: 61.2, kast: 64, hs: 55, entry: 2, trade: 3, rr: 0.82 },
];

const ROUNDS = [
  { n: 1, winner: "a", side: "CT", score: "1 : 0", economyA: "手枪", economyB: "手枪", moneyA: 4000, moneyB: 4000, site: "B", headline: "Mako 双杀守住 B 区", tags: ["首杀", "2K"], time: "00:42" },
  { n: 2, winner: "a", side: "CT", score: "2 : 0", economyA: "强起", economyB: "ECO", moneyA: 16200, moneyB: 9800, site: "A", headline: "NOVA 无伤处理强起局", tags: ["无伤"], time: "00:54" },
  { n: 3, winner: "b", side: "T", score: "2 : 1", economyA: "长枪", economyB: "强起", moneyA: 24750, moneyB: 18100, site: "A", headline: "Frost 沙鹰打开 A1", tags: ["翻盘", "首杀"], time: "01:07" },
  { n: 4, winner: "b", side: "T", score: "2 : 2", economyA: "半起", economyB: "长枪", moneyA: 13400, moneyB: 22600, site: "B", headline: "ORBIT 夹 B 后守住回防", tags: ["下包"], time: "01:21" },
  { n: 5, winner: "a", side: "CT", score: "3 : 2", economyA: "长枪", economyB: "长枪", moneyA: 23650, moneyB: 25800, site: "A", headline: "Lynx 1v2 残局", tags: ["1v2", "高光"], time: "01:12" },
  { n: 6, winner: "a", side: "CT", score: "4 : 2", economyA: "长枪", economyB: "半起", moneyA: 28100, moneyB: 14700, site: "B", headline: "中路首杀后快速收缩", tags: ["首杀"], time: "00:49" },
  { n: 7, winner: "b", side: "T", score: "4 : 3", economyA: "长枪", economyB: "长枪", moneyA: 26400, moneyB: 24400, site: "A", headline: "Sonic 穿烟击杀打破平衡", tags: ["穿烟"], time: "01:18" },
  { n: 8, winner: "a", side: "CT", score: "5 : 3", economyA: "长枪", economyB: "长枪", moneyA: 25350, moneyB: 27300, site: "B", headline: "Rime 三杀完成回防", tags: ["3K", "回防"], time: "01:26" },
  { n: 9, winner: "a", side: "CT", score: "6 : 3", economyA: "长枪", economyB: "ECO", moneyA: 29800, moneyB: 10600, site: "A", headline: "NOVA 稳定收下反 ECO", tags: ["无伤"], time: "00:44" },
  { n: 10, winner: "b", side: "T", score: "6 : 4", economyA: "长枪", economyB: "长枪", moneyA: 31200, moneyB: 25150, site: "B", headline: "Frost AWP 双杀控住超市", tags: ["AWP", "2K"], time: "01:09" },
  { n: 11, winner: "a", side: "CT", score: "7 : 4", economyA: "长枪", economyB: "半起", moneyA: 28400, moneyB: 15950, site: "A", headline: "Aster 前压拿到关键情报", tags: ["首杀"], time: "00:58" },
  { n: 12, winner: "a", side: "CT", score: "8 : 4", economyA: "长枪", economyB: "长枪", moneyA: 32600, moneyB: 27200, site: "B", headline: "Mako 四杀锁定半场优势", tags: ["4K", "高光"], time: "01:04" },
];

const WEAPONS = [
  { name: "AK-47", kills: 42, hs: 62, damage: 4218, owner: "Mako", delta: "+8" },
  { name: "M4A1-S", kills: 35, hs: 49, damage: 3670, owner: "Lynx", delta: "+3" },
  { name: "AWP", kills: 21, hs: 10, damage: 2764, owner: "Frost", delta: "+5" },
  { name: "Desert Eagle", kills: 9, hs: 78, damage: 1068, owner: "Sonic", delta: "+4" },
  { name: "MP9", kills: 8, hs: 38, damage: 824, owner: "Kite", delta: "+2" },
];

const HIGHLIGHT_CLIPS = [
  {
    client_clip_uid: "preview-r6",
    player: "Mako",
    category: "highlight",
    round: 6,
    round_won: true,
    score_own: 5,
    score_opp: 0,
    kill_count: 2,
    context_tags: ["双杀", "⚔ 首杀", "💥 颗秒", "🔪 手撕大狙", "🌫 混烟", "🔙 偷背身", "🔔 极限操作", "🩹 补枪"],
    weapon_used: "AK-47",
    victims: ["blitz", "910"],
    start_tick: 38632,
    end_tick: 40024,
    ai_score: 95,
    ai_commentary: "这波 AK 双杀跟打人机似的，混烟颗秒加手撕大狙，准星和转火都很干净。",
  },
  {
    client_clip_uid: "preview-r8",
    player: "Lynx",
    category: "highlight",
    round: 8,
    round_won: false,
    score_own: 6,
    score_opp: 1,
    kill_count: 2,
    context_tags: ["双杀", "🎯 超远穿墙", "🔔 极限操作", "😭 1v2 饮恨"],
    weapon_used: "AWP",
    victims: ["cobrazera", "910"],
    start_tick: 57242,
    end_tick: 58133,
    ai_score: 95,
    ai_commentary: "穿墙先打开局面，随后大狙完成第二杀；虽然残局没收下，但片段观赏性很强。",
  },
  {
    client_clip_uid: "preview-r10",
    player: "Mako",
    category: "highlight",
    round: 10,
    round_won: true,
    score_own: 8,
    score_opp: 1,
    kill_count: 1,
    context_tags: ["💥 颗秒"],
    weapon_used: "AK-47",
    victims: ["mzinho"],
    start_tick: 70633,
    end_tick: 71145,
    ai_score: 97,
    ai_commentary: "这一枪 AK 颗秒非常利落，预瞄高度和出枪节奏都值得保留。",
  },
  {
    client_clip_uid: "preview-r13",
    player: "Mako",
    category: "fail",
    round: 13,
    round_won: false,
    score_own: 8,
    score_opp: 4,
    kill_count: 0,
    context_tags: ["人体描边", "双持"],
    weapon_used: "Dual Berettas",
    killer_name: "mzinho",
    start_tick: 91502,
    end_tick: 92144,
    ai_score: 25,
    ai_commentary: "双枪持续描边却没能完成击杀，是一个很典型的下饭片段。",
  },
];

const HIGHLIGHT_TAGS = [
  ["全部", 4],
  ["双杀", 2],
  ["首杀", 1],
  ["颗秒", 2],
  ["极限操作", 2],
  ["超远穿墙", 1],
  ["人体描边", 1],
];

const TABS = [
  { key: "highlights", label: "高光与录制", icon: Film },
  { key: "replay", label: "2D 回放", icon: MapPin },
  { key: "overview", label: "概览", icon: Activity },
  { key: "rounds", label: "回合", icon: ListChecks },
  { key: "players", label: "玩家", icon: Users },
  { key: "weapons", label: "武器", icon: Crosshair },
  { key: "economy", label: "经济", icon: CircleDollarSign },
];

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

function TeamMark({ team }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${team === "a" ? "bg-sky-400" : "bg-amber-400"}`} />;
}

function MetricCard({ icon: Icon, label, value, detail, tone = "accent" }) {
  const tones = {
    accent: "bg-cs2-accent-soft text-cs2-accent",
    blue: "bg-sky-500/10 text-sky-400",
    green: "bg-emerald-500/10 text-emerald-400",
    violet: "bg-violet-500/10 text-violet-400",
  };
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-cs2-border bg-cs2-bg-card px-3.5 py-3">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">{label}</p>
        <p className="mt-0.5 truncate text-lg font-black tabular-nums text-cs2-text-primary">{value}</p>
        <p className="truncate text-[10px] text-cs2-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function EvidenceButton({ round, onOpen, children }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(round)}
      className="inline-flex items-center gap-1 text-[10px] font-semibold text-cs2-accent transition-colors hover:text-cs2-accent-light"
    >
      {children ?? `查看 R${round}`}
      <ChevronRight className="h-3 w-3" />
    </button>
  );
}

function TeamScoreboard({ team, followed, onToggleFollow, onSelectPlayer, onOpenRound }) {
  const isTeamA = team === "a";
  const teamPlayers = PLAYERS.filter((player) => player.team === team);
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-input/20">
      <header className={`flex items-center justify-between border-b px-4 py-3 ${isTeamA ? "border-sky-500/20 bg-sky-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
        <div className="flex items-center gap-2.5">
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-black ${isTeamA ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"}`}>{isTeamA ? "N" : "O"}</span>
          <div>
            <h3 className={`text-[12px] font-black tracking-wider ${isTeamA ? "text-sky-300" : "text-amber-300"}`}>{isTeamA ? TEAM_A : TEAM_B}</h3>
            <p className="text-[8px] uppercase tracking-wider text-cs2-text-muted">{isTeamA ? "CT 8 · T 5" : "T 4 · CT 5"}</p>
          </div>
        </div>
        <span className={`font-mono text-2xl font-black ${isTeamA ? "text-sky-200" : "text-amber-200"}`}>{isTeamA ? 13 : 9}</span>
      </header>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left">
        <thead className="border-b border-cs2-border bg-cs2-bg-input/55 text-[9px] uppercase tracking-wider text-cs2-text-muted">
          <tr>
            <th className="w-10 px-3 py-2.5" aria-label="关注" />
            <th className="px-2 py-2.5">玩家</th>
            <th className="px-2 py-2.5 text-right">K-D</th>
            <th className="px-2 py-2.5 text-right">ADR</th>
            <th className="px-2 py-2.5 text-right">KAST</th>
            <th className="px-2 py-2.5 text-right">RR</th>
            <th className="px-3 py-2.5 text-right">证据</th>
          </tr>
        </thead>
        <tbody>
          {teamPlayers.map((player) => (
            <tr
              key={player.id}
              className="border-t border-cs2-border/70 transition-colors hover:bg-cs2-bg-hover"
            >
              <td className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => onToggleFollow(player.id)}
                  aria-label={`${followed.has(player.id) ? "取消关注" : "关注"}${player.name}`}
                  className={followed.has(player.id) ? "text-cs2-accent" : "text-cs2-text-muted hover:text-cs2-accent"}
                >
                  <Star className={`h-3.5 w-3.5 ${followed.has(player.id) ? "fill-current" : ""}`} />
                </button>
              </td>
              <td className="px-2 py-2.5">
                <button type="button" onClick={() => onSelectPlayer(player.id)} className="group flex items-center gap-2 text-left">
                  <TeamMark team={player.team} />
                  <span className="font-semibold text-cs2-text-primary group-hover:text-cs2-accent">{player.name}</span>
                  {player.id === "a1" && <Badge variant="orange" className="px-1.5 py-0 text-[8px]">全场最佳</Badge>}
                </button>
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] text-cs2-text-secondary">
                <span className="font-bold text-cs2-text-primary">{player.kills}</span>–{player.deaths}
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] text-cs2-text-secondary">{player.adr}</td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] text-cs2-text-secondary">{player.kast}%</td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] font-bold text-cs2-accent">{player.rr.toFixed(2)}</td>
              <td className="px-3 py-2.5 text-right"><EvidenceButton round={player.id === "a1" ? 12 : 5} onOpen={onOpenRound} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function Scoreboard({ followed, onToggleFollow, onSelectPlayer, onOpenRound }) {
  return (
    <div className="grid gap-3 p-3 xl:grid-cols-2">
      <TeamScoreboard team="a" followed={followed} onToggleFollow={onToggleFollow} onSelectPlayer={onSelectPlayer} onOpenRound={onOpenRound} />
      <TeamScoreboard team="b" followed={followed} onToggleFollow={onToggleFollow} onSelectPlayer={onSelectPlayer} onOpenRound={onOpenRound} />
    </div>
  );
}

function OverviewView({ followed, onToggleFollow, onSelectPlayer, onOpenRound }) {
  const stories = [
    { icon: ShieldCheck, title: "NOVA 的防守半场决定比赛", text: "CT 方赢下 8/12 回合，B 区首杀后的回合转化率达到 86%。", round: 12 },
    { icon: Gauge, title: "经济优势从第 8 回合开始扩大", text: "NOVA 连续三轮保住 4 把以上长枪，迫使 ORBIT 两次进入半起局。", round: 8 },
    { icon: Target, title: "Mako 是最明确的胜负手", text: "24–14、96.4 ADR，并参与了全队 9 次首杀或补枪。", round: 12 },
  ];
  return (
    <div className="space-y-4">
      <Panel title="比赛主线" eyebrow="自动提炼">
        <div className="grid gap-2.5 p-3 sm:grid-cols-3">
          {stories.map(({ icon: Icon, title, text, round }) => (
            <article key={title} className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
              <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-cs2-accent-soft text-cs2-accent">
                <Icon className="h-3.5 w-3.5" />
              </div>
              <h3 className="text-[12px] font-bold leading-snug text-cs2-text-primary">{title}</h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-cs2-text-muted">{text}</p>
              <div className="mt-2"><EvidenceButton round={round} onOpen={onOpenRound} /></div>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="全场计分板" eyebrow="双方阵容 · 左右对照" action={<span className="font-mono text-[10px] text-cs2-text-muted">RR v1 · Stable</span>}>
        <Scoreboard followed={followed} onToggleFollow={onToggleFollow} onSelectPlayer={onSelectPlayer} onOpenRound={onOpenRound} />
      </Panel>
    </div>
  );
}

function FilterChip({ active, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold transition-colors ${active ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-input/40 text-cs2-text-muted hover:text-cs2-text-primary"}`}>
      {children}
    </button>
  );
}

function RoundsView({ selectedRound, setSelectedRound }) {
  const [winnerFilter, setWinnerFilter] = useState("all");
  const [specialOnly, setSpecialOnly] = useState(false);
  const visibleRounds = useMemo(() => ROUNDS.filter((round) => {
    if (winnerFilter !== "all" && round.winner !== winnerFilter) return false;
    if (specialOnly && !round.tags.some((tag) => ["4K", "3K", "1v2", "翻盘", "穿烟"].includes(tag))) return false;
    return true;
  }), [winnerFilter, specialOnly]);
  const round = ROUNDS.find((item) => item.n === selectedRound) ?? visibleRounds[0] ?? ROUNDS[0];

  return (
    <div className="space-y-3">
      <Panel>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="mr-1 flex items-center gap-1.5 text-[10px] font-bold text-cs2-text-secondary"><Filter className="h-3.5 w-3.5" />筛选</div>
          <FilterChip active={winnerFilter === "all"} onClick={() => setWinnerFilter("all")}>全部回合</FilterChip>
          <FilterChip active={winnerFilter === "a"} onClick={() => setWinnerFilter("a")}>{TEAM_A} 获胜</FilterChip>
          <FilterChip active={winnerFilter === "b"} onClick={() => setWinnerFilter("b")}>{TEAM_B} 获胜</FilterChip>
          <FilterChip active={specialOnly} onClick={() => setSpecialOnly((value) => !value)}>只看关键回合</FilterChip>
          <span className="ml-auto font-mono text-[10px] text-cs2-text-muted">命中 {visibleRounds.length}/{ROUNDS.length}</span>
        </div>
      </Panel>
      <div className="grid min-h-[480px] gap-4 lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.5fr)]">
        <Panel title="回合列表" eyebrow="Round explorer" className="min-h-0">
          <div className="max-h-[520px] overflow-y-auto p-2">
            {visibleRounds.map((item) => (
              <button key={item.n} type="button" onClick={() => setSelectedRound(item.n)} className={`mb-1 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${round.n === item.n ? "border-cs2-accent/45 bg-cs2-accent-soft" : "border-transparent hover:border-cs2-border hover:bg-cs2-bg-hover"}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold ${item.winner === "a" ? "bg-sky-500/15 text-sky-400" : "bg-amber-500/15 text-amber-400"}`}>R{item.n}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-cs2-text-primary">{item.headline}</p><p className="mt-0.5 text-[9px] text-cs2-text-muted">{item.score} · {item.site} 区 · {item.time}</p></div>
                <div className="flex shrink-0 gap-1">{item.tags.slice(0, 2).map((tag) => <span key={tag} className="rounded bg-cs2-bg-input px-1.5 py-0.5 text-[8px] text-cs2-text-secondary">{tag}</span>)}</div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title={`第 ${round.n} 回合 · ${round.headline}`} eyebrow={`${round.winner === "a" ? TEAM_A : TEAM_B} 获胜`} action={<Button size="sm"><Play className="h-3 w-3 fill-current" /> 从证据点播放</Button>}>
          <div className="p-4">
            <div className="mb-5 grid grid-cols-3 items-center gap-3 rounded-xl border border-cs2-border bg-cs2-bg-input/35 p-4 text-center">
              <div><p className="text-[10px] font-bold text-sky-400">{TEAM_A}</p><p className="mt-1 text-[11px] text-cs2-text-muted">{round.economyA} · ${round.moneyA.toLocaleString()}</p></div>
              <div><p className="font-mono text-2xl font-black text-cs2-text-primary">{round.score}</p><p className="text-[9px] uppercase tracking-wider text-cs2-text-muted">Round score</p></div>
              <div><p className="text-[10px] font-bold text-amber-400">{TEAM_B}</p><p className="mt-1 text-[11px] text-cs2-text-muted">{round.economyB} · ${round.moneyB.toLocaleString()}</p></div>
            </div>
            <div className="relative ml-2 border-l border-cs2-border pl-5">
              {[
                ["00:18", "Mako", "在 B 小拿到首杀", Crosshair],
                ["00:31", TEAM_B, `向 ${round.site} 区投入三颗道具`, Zap],
                [round.time, round.winner === "a" ? TEAM_A : TEAM_B, round.headline, Trophy],
                ["01:26", "回合结束", `${round.winner === "a" ? TEAM_A : TEAM_B} 保留 3 把主武器`, ShieldCheck],
              ].map(([time, actor, text, Icon], index) => (
                <div key={`${time}-${text}`} className="relative pb-5 last:pb-0">
                  <span className={`absolute -left-[27px] top-0.5 h-3 w-3 rounded-full border-2 border-cs2-bg-card ${index === 2 ? "bg-cs2-accent" : "bg-cs2-text-muted"}`} />
                  <div className="flex items-start gap-3"><span className="w-9 shrink-0 font-mono text-[9px] text-cs2-text-muted">{time}</span><Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${index === 2 ? "text-cs2-accent" : "text-cs2-text-secondary"}`} /><div><p className="text-[11px] font-bold text-cs2-text-primary">{actor}</p><p className="mt-0.5 text-[10px] text-cs2-text-muted">{text}</p></div></div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PlayersView({ selectedPlayerId, setSelectedPlayerId, followed, onToggleFollow, onOpenRound }) {
  const player = PLAYERS.find((item) => item.id === selectedPlayerId) ?? PLAYERS[0];
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel title="全部玩家" eyebrow="10 / 10 已分析">
        <div className="divide-y divide-cs2-border">
          {PLAYERS.map((item) => (
            <button key={item.id} type="button" onClick={() => setSelectedPlayerId(item.id)} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${player.id === item.id ? "bg-cs2-accent-soft" : "hover:bg-cs2-bg-hover"}`}>
              <TeamMark team={item.team} />
              <div className="min-w-0 flex-1"><p className={`truncate text-[11px] font-bold ${player.id === item.id ? "text-cs2-accent" : "text-cs2-text-primary"}`}>{item.name}</p><p className="font-mono text-[9px] text-cs2-text-muted">{item.kills}–{item.deaths} · {item.adr} ADR</p></div>
              <span className="font-mono text-[10px] font-bold text-cs2-text-secondary">{item.rr.toFixed(2)}</span>
            </button>
          ))}
        </div>
      </Panel>
      <div className="space-y-4">
        <Panel>
          <div className="flex flex-wrap items-center gap-4 p-5">
            <div className={`flex h-14 w-14 items-center justify-center rounded-xl text-xl font-black ${player.team === "a" ? "bg-sky-500/15 text-sky-400" : "bg-amber-500/15 text-amber-400"}`}>{player.name.slice(0, 1)}</div>
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="text-xl font-black text-cs2-text-primary">{player.name}</h2><Badge variant={player.team === "a" ? "orange" : "yellow"}>{player.team === "a" ? TEAM_A : TEAM_B}</Badge></div><p className="mt-1 text-[10px] text-cs2-text-muted">全场表现 · 22 回合 · 数据完整性 99.1%</p></div>
            <Button variant={followed.has(player.id) ? "primary" : "secondary"} onClick={() => onToggleFollow(player.id)}><Star className={`h-3.5 w-3.5 ${followed.has(player.id) ? "fill-current" : ""}`} />{followed.has(player.id) ? "已关注" : "关注玩家"}</Button>
            <Button variant="secondary"><Bot className="h-3.5 w-3.5" />生成 AI 点评</Button>
          </div>
        </Panel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={Swords} label="击杀 / 死亡" value={`${player.kills} / ${player.deaths}`} detail={`${player.assists} 次助攻`} tone="blue" />
          <MetricCard icon={Activity} label="ADR" value={player.adr} detail="高于全场均值 14.2" tone="accent" />
          <MetricCard icon={ShieldCheck} label="KAST" value={`${player.kast}%`} detail={`${player.trade} 次有效补枪`} tone="green" />
          <MetricCard icon={Gauge} label="RR" value={player.rr.toFixed(2)} detail="本场前 18%" tone="violet" />
        </div>
        <Panel title="逐回合影响" eyebrow="证据可追溯">
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {[
              [12, "B 区四杀", "+38.4", "击杀 · 守点 · 回合胜利"],
              [5, "关键残局参与", "+21.7", "补枪 · 存活 · 拆弹"],
              [8, "回防交叉火力", "+16.2", "助攻 · 道具伤害"],
              [3, "强起局首死", "−11.8", "首死 · 未被补枪"],
            ].map(([round, title, impact, detail]) => (
              <div key={round} className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-bold text-cs2-text-primary">R{round} · {title}</p><p className="mt-1 text-[9px] text-cs2-text-muted">{detail}</p></div><span className={`font-mono text-[11px] font-bold ${String(impact).startsWith("+") ? "text-emerald-400" : "text-rose-400"}`}>{impact}</span></div><div className="mt-2"><EvidenceButton round={round} onOpen={onOpenRound} /></div></div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function EconomyView({ onOpenRound }) {
  const rows = ROUNDS.slice(0, 10);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Trophy} label="手枪局" value="2 / 2" detail="两次均完成后续转化" tone="green" />
        <MetricCard icon={Zap} label="翻盘局" value="3" detail="2 次强起 · 1 次 ECO" tone="accent" />
        <MetricCard icon={CircleDollarSign} label="平均装备差" value="+$2.1K" detail={`${TEAM_A} 每回合`} tone="blue" />
        <MetricCard icon={ShieldCheck} label="保枪价值" value="$18.4K" detail="6 次有效保枪" tone="violet" />
      </div>
      <Panel title="回合经济矩阵" eyebrow="Stable · 装备价值">
        <div className="overflow-x-auto p-4">
          <div className="min-w-[720px] space-y-2">
            <div className="grid grid-cols-[52px_90px_1fr_58px_1fr_90px] items-center gap-3 px-2 text-[9px] uppercase tracking-wider text-cs2-text-muted"><span>回合</span><span>{TEAM_A}</span><span>装备价值</span><span className="text-center">胜方</span><span className="text-right">装备价值</span><span className="text-right">{TEAM_B}</span></div>
            {rows.map((round) => {
              const max = 33000;
              return (
                <button key={round.n} type="button" onClick={() => onOpenRound(round.n)} className="grid w-full grid-cols-[52px_90px_1fr_58px_1fr_90px] items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-cs2-border hover:bg-cs2-bg-hover">
                  <span className="font-mono text-[10px] font-bold text-cs2-text-secondary">R{round.n}</span>
                  <span className="text-[10px] text-cs2-text-muted">{round.economyA}</span>
                  <div className="h-5 overflow-hidden rounded bg-cs2-bg-input"><div className="flex h-full items-center justify-end rounded bg-sky-500/35 px-2 text-[9px] text-sky-200" style={{ width: `${Math.max(24, round.moneyA / max * 100)}%` }}>${(round.moneyA / 1000).toFixed(1)}K</div></div>
                  <span className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-black ${round.winner === "a" ? "bg-sky-500/20 text-sky-400" : "bg-amber-500/20 text-amber-400"}`}>{round.winner === "a" ? "A" : "B"}</span>
                  <div className="flex h-5 justify-end overflow-hidden rounded bg-cs2-bg-input"><div className="flex h-full items-center rounded bg-amber-500/35 px-2 text-[9px] text-amber-200" style={{ width: `${Math.max(24, round.moneyB / max * 100)}%` }}>${(round.moneyB / 1000).toFixed(1)}K</div></div>
                  <span className="text-right text-[10px] text-cs2-text-muted">{round.economyB}</span>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function WeaponsView() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
      <Panel title="武器表现" eyebrow="全场 154 次击杀">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left">
            <thead className="border-b border-cs2-border bg-cs2-bg-input/55 text-[9px] uppercase tracking-wider text-cs2-text-muted"><tr><th className="px-4 py-3">武器</th><th className="px-3 py-3 text-right">击杀</th><th className="px-3 py-3 text-right">爆头率</th><th className="px-3 py-3 text-right">伤害</th><th className="px-3 py-3">最佳使用者</th><th className="px-4 py-3 text-right">高于均值</th></tr></thead>
            <tbody>{WEAPONS.map((weapon) => <tr key={weapon.name} className="border-t border-cs2-border hover:bg-cs2-bg-hover"><td className="px-4 py-3"><div className="flex items-center gap-2"><div className="flex h-8 w-10 items-center justify-center rounded bg-cs2-bg-input text-cs2-text-secondary"><Crosshair className="h-4 w-4" /></div><span className="text-[11px] font-bold text-cs2-text-primary">{weapon.name}</span></div></td><td className="px-3 py-3 text-right font-mono text-[11px] text-cs2-text-secondary">{weapon.kills}</td><td className="px-3 py-3 text-right font-mono text-[11px] text-cs2-text-secondary">{weapon.hs}%</td><td className="px-3 py-3 text-right font-mono text-[11px] text-cs2-text-secondary">{weapon.damage}</td><td className="px-3 py-3 text-[11px] font-semibold text-cs2-text-primary">{weapon.owner}</td><td className="px-4 py-3 text-right font-mono text-[11px] font-bold text-emerald-400">{weapon.delta}</td></tr>)}</tbody>
          </table>
        </div>
      </Panel>
      <Panel title="武器结论" eyebrow="自动提炼">
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-cs2-accent/20 bg-cs2-accent-soft p-3"><Sparkles className="mb-2 h-4 w-4 text-cs2-accent" /><p className="text-[11px] font-bold text-cs2-text-primary">AK-47 是胜负差异最大的武器</p><p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">NOVA 的 AK 击杀转化率高出对手 12%，主要来自中路首杀后的多打少。</p></div>
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3"><p className="text-[10px] font-semibold text-cs2-text-secondary">值得复盘</p><p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">ORBIT 在 3 个长枪局中丢失 AWP，均未形成有效补枪。</p></div>
        </div>
      </Panel>
    </div>
  );
}

function PlayerRoundTimelinePreview({ player }) {
  const timeline = [
    { round: 1, result: "胜", score: "1 : 0", event: "手枪局双杀，守住 B 区", weapon: "Dual Berettas", tone: "good" },
    { round: 6, result: "胜", score: "4 : 2", event: "首杀后完成第二次补枪", weapon: "M4A1-S", tone: "good" },
    { round: 8, result: "负", score: "5 : 3", event: "回防到场较晚，保枪离场", weapon: "AWP", tone: "muted" },
    { round: 10, result: "胜", score: "7 : 3", event: "A1 颗秒打破默认站位", weapon: "AK-47", tone: "good" },
    { round: 12, result: "胜", score: "8 : 4", event: "四杀锁定半场优势", weapon: "M4A1-S", tone: "good" },
  ];
  return (
    <Panel title={`${player.name} · 回合时间线`} eyebrow="只展示该玩家参与的关键事件">
      <div className="p-4">
        <div className="relative space-y-2 before:absolute before:bottom-4 before:left-[17px] before:top-4 before:w-px before:bg-cs2-border">
          {timeline.map((item) => (
            <article key={item.round} className="relative grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
              <span className={`z-10 flex h-9 w-9 items-center justify-center rounded-full border font-mono text-[9px] font-black ${item.tone === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-cs2-border bg-cs2-bg-page text-cs2-text-muted"}`}>R{item.round}</span>
              <div><p className="text-[11px] font-bold text-cs2-text-primary">{item.event}</p><p className="mt-1 text-[9px] text-cs2-text-muted">{item.weapon} · {item.result} · {item.score}</p></div>
              <ChevronRight className="h-3.5 w-3.5 text-cs2-text-muted" />
            </article>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function PlayerWeaponKillsPreview({ player }) {
  const weapons = player.team === "a"
    ? [["M4A1-S", 11, 64, "R6 · R8 · R12"], ["AK-47", 7, 71, "R10 · R15"], ["Dual Berettas", 3, 33, "R1"], ["HE Grenade", 2, 0, "R9 · R18"]]
    : [["AK-47", 12, 58, "R3 · R7 · R14"], ["AWP", 5, 20, "R10 · R17"], ["Glock-18", 2, 50, "R13"], ["Molotov", 1, 0, "R4"]];
  return (
    <Panel title={`${player.name} · 枪械击杀`} eyebrow="击杀分布与证据回合">
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {weapons.map(([name, kills, hs, rounds]) => (
          <article key={name} className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
            <div className="flex items-start justify-between gap-3"><div className="flex h-8 w-10 items-center justify-center rounded-md bg-cs2-bg-page text-cs2-text-secondary"><Crosshair className="h-4 w-4" /></div><span className="font-mono text-xl font-black text-cs2-accent">{kills}</span></div>
            <h3 className="mt-2 text-[11px] font-bold text-cs2-text-primary">{name}</h3>
            <p className="mt-1 text-[9px] text-cs2-text-muted">爆头率 {hs}% · {rounds}</p>
          </article>
        ))}
      </div>
    </Panel>
  );
}

function HighlightsView() {
  const [selectedTag, setSelectedTag] = useState("全部");
  const [selectedPlayerId, setSelectedPlayerId] = useState(null);
  const [activeView, setActiveView] = useState("clips");
  const [aiMode, setAiMode] = useState(false);
  const [aiRequestedFor, setAiRequestedFor] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [queued, setQueued] = useState(new Set());
  const selectedPlayer = PLAYERS.find((player) => player.id === selectedPlayerId) ?? null;
  const playerClips = selectedPlayer ? HIGHLIGHT_CLIPS.filter((clip) => clip.player === selectedPlayer.name) : [];
  const visibleClips = playerClips.filter((clip) => selectedTag === "全部" || clip.context_tags.some((tag) => tag.includes(selectedTag)));
  const playerTags = HIGHLIGHT_TAGS.map(([tag]) => [
    tag,
    tag === "全部" ? playerClips.length : playerClips.filter((clip) => clip.context_tags.some((item) => item.includes(tag))).length,
  ]).filter(([tag, count]) => tag === "全部" || count > 0);

  const selectPlayer = (playerId) => {
    setSelectedPlayerId(playerId);
    setSelectedTag("全部");
    setActiveView("clips");
    setSelected(new Set());
    setAiRequestedFor(aiMode ? playerId : null);
  };
  const changeAiMode = (nextAiMode) => {
    setAiMode(nextAiMode);
    setAiRequestedFor(nextAiMode && selectedPlayerId ? selectedPlayerId : null);
  };

  const toggleSelected = (clipUid) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(clipUid)) next.delete(clipUid); else next.add(clipUid);
      return next;
    });
  };
  const addSelectedToQueue = () => {
    setQueued((current) => new Set([...current, ...selected]));
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      <Panel
        title="选择玩家"
        eyebrow="先选人，再查看高光与录制"
        action={(
          <div className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5" role="group" aria-label="点评模式">
            <button type="button" aria-pressed={!aiMode} onClick={() => changeAiMode(false)} className={`rounded px-2.5 py-1 text-[9px] font-semibold ${!aiMode ? "bg-cs2-text-primary text-cs2-bg-page" : "text-cs2-text-muted"}`}>本地模式</button>
            <button type="button" aria-pressed={aiMode} onClick={() => changeAiMode(true)} className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[9px] font-semibold ${aiMode ? "bg-violet-500/20 text-violet-300" : "text-cs2-text-muted"}`}><Bot className="h-3 w-3" />AI 模式</button>
          </div>
        )}
      >
        <div className="grid gap-3 p-3 md:grid-cols-2">
          {["a", "b"].map((team) => (
            <div key={team} className="rounded-lg border border-cs2-border bg-cs2-bg-input/25 p-2.5">
              <div className="mb-2 flex items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted"><TeamMark team={team} />{team === "a" ? TEAM_A : TEAM_B}</div>
              <div className="grid gap-1.5 sm:grid-cols-5 md:grid-cols-1 lg:grid-cols-5">
                {PLAYERS.filter((player) => player.team === team).map((player) => {
                  const clipCount = HIGHLIGHT_CLIPS.filter((clip) => clip.player === player.name).length;
                  const active = player.id === selectedPlayerId;
                  return (
                    <button key={player.id} type="button" onClick={() => selectPlayer(player.id)} aria-label={`选择 ${player.name}`} className={`rounded-lg border px-2 py-2 text-left transition-colors ${active ? team === "a" ? "border-sky-400/60 bg-sky-500/10" : "border-amber-400/60 bg-amber-500/10" : "border-cs2-border bg-cs2-bg-card hover:bg-cs2-bg-hover"}`}>
                      <div className="flex items-center justify-between gap-1"><span className="truncate text-[10px] font-bold text-cs2-text-primary">{player.name}</span>{active && <span className={`h-1.5 w-1.5 rounded-full ${team === "a" ? "bg-sky-400" : "bg-amber-400"}`} />}</div>
                      <p className="mt-1 font-mono text-[8px] text-cs2-text-muted">{player.kills}–{player.deaths} · {clipCount} 片段</p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {!selectedPlayer ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-card/45 p-8 text-center">
          <div><Users className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold text-cs2-text-primary">先选择一名玩家</h2><p className="mt-1 text-[10px] text-cs2-text-muted">选择后才显示片段卡片、回合时间线与枪械击杀。</p></div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-cs2-border bg-cs2-bg-card p-0.5">
              {[["clips", "片段卡片"], ["rounds", "回合时间线"], ["weapons", "枪械击杀"]].map(([key, label]) => <button key={key} type="button" onClick={() => setActiveView(key)} className={`rounded-md px-3 py-1.5 text-[11px] font-semibold ${activeView === key ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-primary"}`}>{label}</button>)}
            </div>
            <div className="flex items-center gap-2 text-[9px] text-cs2-text-muted"><TeamMark team={selectedPlayer.team} /><b className="text-cs2-text-primary">{selectedPlayer.name}</b><span>{selectedPlayer.kills}–{selectedPlayer.deaths} · {selectedPlayer.adr} ADR</span></div>
          </div>

          {aiMode && aiRequestedFor === selectedPlayer.id && (
            <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2.5 text-[10px] text-violet-200">
              <Bot className="h-4 w-4 shrink-0" /><span>已在选择 {selectedPlayer.name} 后触发 AI 锐评；本地解析与其他 9 名玩家不重复执行。</span>
            </div>
          )}

          {activeView === "clips" && (
            <>
              <Panel>
                <div className="flex flex-wrap items-center gap-1.5 p-3">
                  <span className="mr-1 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted">标签</span>
                  {playerTags.map(([tag, count]) => (
                    <button key={tag} type="button" onClick={() => setSelectedTag(tag)} className={`rounded-md border px-2 py-1 text-[9px] font-semibold transition-colors ${selectedTag === tag ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/80 bg-cs2-bg-input/35 text-cs2-text-muted hover:text-cs2-text-primary"}`}>{tag} <span className="ml-1 font-mono opacity-70">{count}</span></button>
                  ))}
                </div>
              </Panel>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-3">
                  {visibleClips.length ? visibleClips.map((clip) => (
                    <ClipCard key={clip.client_clip_uid} clip={clip} targetPlayer={selectedPlayer.name} selected={selected.has(clip.client_clip_uid)} onToggle={toggleSelected} aiMode={aiMode && aiRequestedFor === selectedPlayer.id} inQueue={queued.has(clip.client_clip_uid)} onDequeue={() => setQueued((current) => { const next = new Set(current); next.delete(clip.client_clip_uid); return next; })} />
                  )) : <div className="rounded-xl border border-dashed border-cs2-border bg-cs2-bg-card/45 p-10 text-center text-[10px] text-cs2-text-muted">该玩家在当前标签下没有片段。</div>}
                </div>
                <aside className="space-y-4">
                  <Panel title="录制计划" eyebrow={`${queued.size} 条待录制`}>
                    <div className="space-y-3 p-4"><div className="flex items-center justify-between text-[10px]"><span className="text-cs2-text-muted">已选择片段</span><span className="font-mono font-bold text-cs2-text-primary">{selected.size}</span></div><Button className="w-full" disabled={!selected.size} onClick={addSelectedToQueue}><Film className="h-3.5 w-3.5" />将已选加入队列</Button><Button variant="secondary" className="w-full" disabled={!queued.size}>打开录制队列</Button></div>
                  </Panel>
                  <Panel title={aiMode ? "AI 锐评" : "本地模式"} eyebrow={aiMode ? "选中玩家后运行" : "不调用 AI"}>
                    <div className="p-4"><div className={`flex items-start gap-2 rounded-lg p-3 ${aiMode ? "bg-violet-500/10" : "bg-cs2-bg-input/45"}`}><Bot className={`mt-0.5 h-4 w-4 shrink-0 ${aiMode ? "text-violet-400" : "text-cs2-text-muted"}`} /><p className="text-[10px] leading-relaxed text-cs2-text-muted">{aiMode ? `只为 ${selectedPlayer.name} 的可见高光生成锐评，切换玩家后再调用。` : "仅展示本地规则生成的标签与评分，不产生 AI 请求。"}</p></div></div>
                  </Panel>
                </aside>
              </div>
            </>
          )}
          {activeView === "rounds" && <PlayerRoundTimelinePreview player={selectedPlayer} />}
          {activeView === "weapons" && <PlayerWeaponKillsPreview player={selectedPlayer} />}
        </>
      )}
    </div>
  );
}

export default function DemoAnalysisPreviewPage() {
  const [activeTab, setActiveTab] = useState("highlights");
  const [selectedRound, setSelectedRound] = useState(12);
  const [selectedPlayerId, setSelectedPlayerId] = useState("a1");
  const [followed, setFollowed] = useState(new Set(["a1"]));

  const toggleFollow = (playerId) => setFollowed((current) => {
    const next = new Set(current);
    if (next.has(playerId)) next.delete(playerId); else next.add(playerId);
    return next;
  });
  const openRound = (roundNumber) => {
    setSelectedRound(roundNumber);
    setActiveTab("rounds");
  };
  const openPlayer = (playerId) => {
    setSelectedPlayerId(playerId);
    setActiveTab("players");
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-page text-cs2-text-primary">
      <header className="shrink-0 border-b border-cs2-border bg-cs2-bg-page/95 px-5 py-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent"><BarChart3 className="h-4.5 w-4.5" /></div>
            <div className="min-w-0"><div className="flex items-center gap-2"><h1 className="text-[15px] font-black tracking-wide">Demo 分析</h1><Badge variant="orange" className="px-1.5 py-0 text-[8px]">PREVIEW</Badge></div><p className="truncate font-mono text-[9px] text-cs2-text-muted">nova-vs-orbit_mirage.dem · analysis/1.0</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" size="sm"><Play className="h-3 w-3 fill-current" />在 CS2 中播放</Button><Button variant="secondary" size="sm">导出报告</Button></div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-[1500px] space-y-4 px-5 py-4 sm:px-6">
          <section className="relative overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-lg">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 via-cs2-accent to-amber-500" />
            <div className="grid items-center gap-4 px-5 py-5 md:grid-cols-[1fr_auto_1fr]">
              <div className="flex items-center gap-3 md:justify-end md:text-right"><div className="order-2 md:order-1"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-sky-400">{TEAM_A}</p><p className="mt-1 text-[10px] text-cs2-text-muted">CT 8 · T 5</p></div><div className="order-1 flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/15 text-lg font-black text-sky-400 md:order-2">N</div></div>
              <div className="text-center"><div className="flex items-center justify-center gap-3"><span className="font-mono text-4xl font-black text-sky-300">13</span><span className="text-xl font-black text-cs2-text-muted">:</span><span className="font-mono text-4xl font-black text-amber-300">9</span></div><div className="mt-2 flex items-center justify-center gap-2 text-[9px] uppercase tracking-widest text-cs2-text-muted"><MapPin className="h-3 w-3" /> Mirage · 36:42</div></div>
              <div className="flex items-center gap-3 md:text-left"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-lg font-black text-amber-400">O</div><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">{TEAM_B}</p><p className="mt-1 text-[10px] text-cs2-text-muted">T 4 · CT 5</p></div></div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Trophy} label="全场最佳" value="Mako" detail="24–14 · 96.4 ADR" tone="accent" />
            <MetricCard icon={Crosshair} label="首杀转化" value="76%" detail="13 次首杀 · 赢下 10 回合" tone="blue" />
            <MetricCard icon={CircleDollarSign} label="经济翻盘" value="3" detail="2 次强起 · 1 次 ECO" tone="green" />
            <MetricCard icon={Film} label="推荐高光" value="3" detail="已覆盖双方全部玩家" tone="violet" />
          </section>

          <nav className="flex gap-1 overflow-x-auto rounded-xl border border-cs2-border bg-cs2-bg-card p-1.5" aria-label="Demo 分析视图">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button key={key} type="button" onClick={() => setActiveTab(key)} className={`flex min-w-fit items-center gap-2 rounded-lg px-3.5 py-2 text-[11px] font-semibold transition-colors ${activeTab === key ? "bg-cs2-accent text-cs2-text-on-accent shadow-md shadow-cs2-accent/20" : "text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary"}`}><Icon className="h-3.5 w-3.5" />{label}</button>
            ))}
          </nav>

          {activeTab === "overview" && <OverviewView followed={followed} onToggleFollow={toggleFollow} onSelectPlayer={openPlayer} onOpenRound={openRound} />}
          {activeTab === "replay" && <Demo2DReplayPreview />}
          {activeTab === "rounds" && <RoundsView selectedRound={selectedRound} setSelectedRound={setSelectedRound} />}
          {activeTab === "players" && <PlayersView selectedPlayerId={selectedPlayerId} setSelectedPlayerId={setSelectedPlayerId} followed={followed} onToggleFollow={toggleFollow} onOpenRound={openRound} />}
          {activeTab === "economy" && <EconomyView onOpenRound={openRound} />}
          {activeTab === "weapons" && <WeaponsView />}
          {activeTab === "highlights" && <HighlightsView onOpenRound={openRound} />}
        </main>
      </div>
    </div>
  );
}
