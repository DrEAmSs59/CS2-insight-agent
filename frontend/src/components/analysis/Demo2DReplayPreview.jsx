import { useEffect, useMemo, useState } from "react";
import {
  Bomb,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Map,
  Pause,
  Play,
  RotateCcw,
  Route,
  Swords,
} from "lucide-react";

/**
 * 2D replay interaction model adapted from cs2-demo-analysis-kit's MIT-licensed
 * ReplayViewer. Styling and the preview frame data are native to this project.
 * Source: packages/react/src/components/MatchWorkspace.tsx
 */

const SAMPLE_RATE = 8;
const TICK_RATE = 64;
const TICK_STEP = TICK_RATE / SAMPLE_RATE;
const FRAME_COUNT = 96;
const ROUND_SECONDS = 115;

const ROSTER = [
  { id: "a1", number: "1", name: "Mako", team: "a", weapon: "M4A1-S", utility: 3 },
  { id: "a2", number: "2", name: "Lynx", team: "a", weapon: "AWP", utility: 2 },
  { id: "a3", number: "3", name: "Rime", team: "a", weapon: "M4A1-S", utility: 4 },
  { id: "a4", number: "4", name: "Aster", team: "a", weapon: "FAMAS", utility: 2 },
  { id: "a5", number: "5", name: "Kite", team: "a", weapon: "MP9", utility: 3 },
  { id: "b1", number: "6", name: "Frost", team: "b", weapon: "AK-47", utility: 4, bomb: true },
  { id: "b2", number: "7", name: "Sonic", team: "b", weapon: "AK-47", utility: 3 },
  { id: "b3", number: "8", name: "Juno", team: "b", weapon: "AWP", utility: 2 },
  { id: "b4", number: "9", name: "Vale", team: "b", weapon: "Galil AR", utility: 3 },
  { id: "b5", number: "0", name: "Echo", team: "b", weapon: "AK-47", utility: 4 },
];

const ROUND_BLUEPRINTS = [
  {
    roundNumber: 6,
    startTick: 38632,
    score: "4 : 2",
    winner: "NOVA",
    kills: [
      { frame: 37, killer: "Mako", victim: "Sonic", weapon: "M4A1-S", headshot: true },
      { frame: 52, killer: "Mako", victim: "Frost", weapon: "M4A1-S" },
      { frame: 70, killer: "Lynx", victim: "Juno", weapon: "AWP" },
    ],
    grenades: [{ frame: 28, x: 57, y: 42, kind: "烟" }],
  },
  {
    roundNumber: 8,
    startTick: 57242,
    score: "5 : 3",
    winner: "NOVA",
    kills: [
      { frame: 31, killer: "Rime", victim: "Vale", weapon: "M4A1-S" },
      { frame: 48, killer: "Frost", victim: "Aster", weapon: "AK-47", headshot: true },
      { frame: 63, killer: "Rime", victim: "Frost", weapon: "M4A1-S" },
      { frame: 76, killer: "Rime", victim: "Echo", weapon: "M4A1-S" },
    ],
    grenades: [{ frame: 22, x: 63, y: 67, kind: "火" }],
  },
  {
    roundNumber: 12,
    startTick: 83612,
    score: "8 : 4",
    winner: "NOVA",
    kills: [
      { frame: 26, killer: "Mako", victim: "Vale", weapon: "M4A1-S", headshot: true },
      { frame: 41, killer: "Mako", victim: "Sonic", weapon: "M4A1-S" },
      { frame: 58, killer: "Frost", victim: "Kite", weapon: "AK-47" },
      { frame: 66, killer: "Mako", victim: "Juno", weapon: "M4A1-S" },
      { frame: 79, killer: "Mako", victim: "Frost", weapon: "M4A1-S", headshot: true },
    ],
    grenades: [
      { frame: 18, x: 49, y: 34, kind: "烟" },
      { frame: 34, x: 69, y: 63, kind: "闪" },
    ],
    bomb: { frame: 54, x: 74, y: 64 },
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeFrames(player, playerIndex, roundIndex) {
  const lane = playerIndex % 5;
  const isA = player.team === "a";
  return Array.from({ length: FRAME_COUNT }, (_, index) => {
    const progress = index / (FRAME_COUNT - 1);
    const curve = Math.sin(progress * Math.PI * (1.2 + lane * 0.08) + roundIndex * 0.5);
    const x = isA
      ? 18 + lane * 2.5 + progress * (42 + lane * 2)
      : 82 - lane * 2.4 - progress * (34 + lane * 1.6);
    const yBase = 23 + lane * 13;
    const yDirection = isA ? 1 : -1;
    return {
      x: clamp(x + curve * 5 * yDirection, 8, 92),
      y: clamp(yBase + curve * 11 + roundIndex * (lane % 2 ? 1.8 : -1.5), 8, 92),
      yaw: (isA ? 20 : 200) + curve * 34,
      hp: 100,
    };
  });
}

const REPLAY_ROUNDS = ROUND_BLUEPRINTS.map((round, roundIndex) => ({
  ...round,
  players: ROSTER.map((player, index) => ({
    ...player,
    frames: makeFrames(player, index, roundIndex),
  })),
}));

function clockLabel(frameIndex) {
  const seconds = Math.max(0, Math.round(ROUND_SECONDS * (1 - frameIndex / (FRAME_COUNT - 1))));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function TeamRoster({ team, currentFrame, round, deadPlayers }) {
  const rows = round.players.filter((player) => player.team === team);
  const teamName = team === "a" ? "NOVA · CT" : "ORBIT · T";
  return (
    <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3" aria-label={`${teamName} 当前状态`}>
      <div className="mb-2.5 flex items-center justify-between border-b border-cs2-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${team === "a" ? "bg-sky-400" : "bg-amber-400"}`} />
          <b className="text-[11px] text-cs2-text-primary">{teamName}</b>
        </div>
        <span className="font-mono text-[9px] text-cs2-text-muted">{rows.filter((row) => !deadPlayers.has(row.name)).length}/5</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((player) => {
          const dead = deadPlayers.has(player.name);
          return (
            <div key={player.id} className={`rounded-lg border px-2.5 py-2 ${dead ? "border-cs2-border/60 bg-cs2-bg-input/25 opacity-45" : "border-cs2-border bg-cs2-bg-input/55"}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black ${team === "a" ? "bg-sky-500/20 text-sky-300" : "bg-amber-500/20 text-amber-300"}`}>{dead ? "×" : player.number}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-cs2-text-primary">{player.name}</span>
                <span className="font-mono text-[8px] text-cs2-text-muted">{dead ? "阵亡" : "100 HP"}</span>
              </div>
              {!dead && (
                <div className="mt-1 flex items-center gap-2 pl-7 text-[8px] text-cs2-text-muted">
                  <span>{player.weapon}</span>
                  <span>{player.utility} 道具</span>
                  {player.bomb && currentFrame < (round.bomb?.frame ?? Infinity) && <span className="text-amber-300">C4</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LayerButton({ active, icon: Icon, children, onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[9px] font-semibold transition-colors ${active ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-input/40 text-cs2-text-muted hover:text-cs2-text-primary"}`}
    >
      <Icon className="h-3 w-3" />{children}
    </button>
  );
}

function MirageTacticalMap() {
  return (
    <svg className="absolute inset-5 h-[calc(100%_-_2.5rem)] w-[calc(100%_-_2.5rem)] opacity-90" viewBox="0 0 100 100" role="img" aria-label="Mirage 战术地图">
      <defs>
        <linearGradient id="mirageFloor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24313a" />
          <stop offset="1" stopColor="#111a20" />
        </linearGradient>
        <pattern id="mirageTile" width="4" height="4" patternUnits="userSpaceOnUse">
          <path d="M0 4 4 0" stroke="#94a3b8" strokeOpacity="0.04" strokeWidth="0.35" />
        </pattern>
      </defs>
      <g fill="url(#mirageFloor)" stroke="#52616c" strokeWidth="0.8" strokeLinejoin="round">
        <path d="M42 91 42 79 34 79 34 70 42 70 42 59 48 59 48 48 42 48 42 39 31 39 31 31 18 31 18 15 31 15 31 22 42 22 42 31 48 31 48 13 61 13 61 19 76 19 76 33 69 33 69 42 60 42 60 51 68 51 68 60 79 60 79 72 68 72 68 80 57 80 57 91Z" />
        <path d="M18 31 10 31 10 48 20 48 20 58 32 58 32 48 42 48 42 39 31 39 31 31Z" />
        <path d="M79 60 90 60 90 82 79 82 79 72Z" />
        <path d="M48 48 60 48 60 42 69 42 69 33 62 33 62 26 48 26Z" />
        <path d="M34 70 23 70 23 62 14 62 14 51 26 51 26 58 34 58Z" />
        <path d="M42 79 35 79 35 91 42 91Z" />
      </g>
      <g fill="url(#mirageTile)" stroke="none">
        <path d="M42 91 42 79 34 79 34 70 42 70 42 59 48 59 48 48 42 48 42 39 31 39 31 31 18 31 18 15 31 15 31 22 42 22 42 31 48 31 48 13 61 13 61 19 76 19 76 33 69 33 69 42 60 42 60 51 68 51 68 60 79 60 79 72 68 72 68 80 57 80 57 91Z" />
      </g>
      <g fill="none" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="0.75">
        <path d="M67 21h7v8h-7z" />
        <path d="M13 34h8v10h-8z" />
      </g>
      <g fill="#94a3b8" fontSize="3" fontWeight="700" textAnchor="middle">
        <text x="53" y="88">T 出生点</text>
        <text x="53" y="18">CT 出生点</text>
        <text x="53" y="46">中路</text>
        <text x="29" y="54">地下</text>
        <text x="72" y="58">连接</text>
      </g>
      <g fill="#fbbf24" fontSize="6" fontWeight="900" textAnchor="middle">
        <text x="70.5" y="28">A</text>
        <text x="17" y="42">B</text>
      </g>
    </svg>
  );
}

export default function Demo2DReplayPreview() {
  const [roundNumber, setRoundNumber] = useState(REPLAY_ROUNDS[2].roundNumber);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [layers, setLayers] = useState({ trace: true, killLines: true, grenades: true });
  const roundIndex = Math.max(0, REPLAY_ROUNDS.findIndex((item) => item.roundNumber === roundNumber));
  const round = REPLAY_ROUNDS[roundIndex];

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= FRAME_COUNT - 1) {
          setPlaying(false);
          return FRAME_COUNT - 1;
        }
        return current + 1;
      });
    }, Math.max(35, 1000 / (SAMPLE_RATE * speed)));
    return () => window.clearInterval(timer);
  }, [playing, speed]);

  const currentTick = round.startTick + frameIndex * TICK_STEP;
  const visibleKills = round.kills.filter((kill) => kill.frame <= frameIndex);
  const deadPlayers = useMemo(() => new Set(visibleKills.map((kill) => kill.victim)), [visibleKills]);
  const activeGrenades = round.grenades.filter((grenade) => frameIndex >= grenade.frame && frameIndex <= grenade.frame + 20);

  const selectRound = (nextRoundNumber) => {
    setRoundNumber(nextRoundNumber);
    setFrameIndex(0);
    setPlaying(false);
  };
  const shiftRound = (offset) => {
    const next = REPLAY_ROUNDS[clamp(roundIndex + offset, 0, REPLAY_ROUNDS.length - 1)];
    if (next) selectRound(next.roundNumber);
  };
  const seekFrame = (nextFrame) => {
    setPlaying(false);
    setFrameIndex(clamp(nextFrame, 0, FRAME_COUNT - 1));
  };

  return (
    <section className="space-y-3" aria-label="2D 小地图回放">
      <div className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="上一回合" onClick={() => shiftRound(-1)} disabled={roundIndex === 0} className="rounded-md border border-cs2-border bg-cs2-bg-input p-1.5 text-cs2-text-muted hover:text-cs2-text-primary disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <label className="flex items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[9px] font-bold text-cs2-text-muted">
              回合
              <select aria-label="回放回合" value={roundNumber} onChange={(event) => selectRound(Number(event.target.value))} className="bg-transparent font-mono text-[10px] text-cs2-text-primary outline-none">
                {REPLAY_ROUNDS.map((item) => <option key={item.roundNumber} value={item.roundNumber}>R{item.roundNumber} · {item.winner} {item.score}</option>)}
              </select>
            </label>
            <button type="button" aria-label="下一回合" onClick={() => shiftRound(1)} disabled={roundIndex === REPLAY_ROUNDS.length - 1} className="rounded-md border border-cs2-border bg-cs2-bg-input p-1.5 text-cs2-text-muted hover:text-cs2-text-primary disabled:opacity-30"><ChevronRight className="h-3.5 w-3.5" /></button>
          </div>

          <div className="flex min-w-[280px] flex-1 items-center gap-2">
            <button type="button" aria-label={playing ? "暂停回放" : "播放回放"} onClick={() => setPlaying((current) => !current)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cs2-accent text-cs2-text-on-accent shadow-md shadow-cs2-accent/20">{playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}</button>
            <div className="relative flex-1 pt-3">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-3">
                {round.kills.map((kill, index) => <button key={`${kill.frame}-${index}`} type="button" tabIndex={-1} className="pointer-events-auto absolute top-0 h-2.5 w-1 rounded-full bg-rose-400" style={{ left: `${kill.frame / (FRAME_COUNT - 1) * 100}%` }} title={`${kill.killer} → ${kill.victim}`} onClick={() => seekFrame(kill.frame)} />)}
                {round.bomb && <button type="button" tabIndex={-1} className="pointer-events-auto absolute top-0 h-2.5 w-1 rounded-full bg-amber-300" style={{ left: `${round.bomb.frame / (FRAME_COUNT - 1) * 100}%` }} title="下包" onClick={() => seekFrame(round.bomb.frame)} />}
              </div>
              <input aria-label="回放时间轴" type="range" min="0" max={FRAME_COUNT - 1} value={frameIndex} onChange={(event) => seekFrame(Number(event.target.value))} className="h-1.5 w-full cursor-pointer accent-cs2-accent" />
            </div>
            <button type="button" aria-label="回到开局" onClick={() => seekFrame(0)} className="rounded-md border border-cs2-border bg-cs2-bg-input p-1.5 text-cs2-text-muted hover:text-cs2-text-primary"><RotateCcw className="h-3.5 w-3.5" /></button>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right"><p className="text-[8px] uppercase tracking-wider text-cs2-text-muted">回合时间</p><p className="font-mono text-lg font-black text-cs2-text-primary">{clockLabel(frameIndex)}</p></div>
            <div className="hidden border-l border-cs2-border pl-3 text-[8px] text-cs2-text-muted sm:block"><p>Tick {Math.round(currentTick)}</p><p>{SAMPLE_RATE} Hz · 帧 {frameIndex + 1}/{FRAME_COUNT}</p></div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cs2-border pt-3">
          <div className="flex flex-wrap gap-1.5">
            <LayerButton icon={Route} active={layers.trace} onClick={() => setLayers((current) => ({ ...current, trace: !current.trace }))}>走位轨迹</LayerButton>
            <LayerButton icon={Swords} active={layers.killLines} onClick={() => setLayers((current) => ({ ...current, killLines: !current.killLines }))}>击杀连线</LayerButton>
            <LayerButton icon={Bomb} active={layers.grenades} onClick={() => setLayers((current) => ({ ...current, grenades: !current.grenades }))}>投掷物</LayerButton>
          </div>
          <div className="flex rounded-md border border-cs2-border bg-cs2-bg-input p-0.5" role="group" aria-label="播放速度">
            {[0.5, 1, 2, 4].map((nextSpeed) => <button key={nextSpeed} type="button" onClick={() => setSpeed(nextSpeed)} className={`rounded px-2 py-1 font-mono text-[8px] ${speed === nextSpeed ? "bg-cs2-text-primary text-cs2-bg-page" : "text-cs2-text-muted hover:text-cs2-text-primary"}`}>{nextSpeed}x</button>)}
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[220px_minmax(460px,1fr)_220px]">
        <TeamRoster team="a" currentFrame={frameIndex} round={round} deadPlayers={deadPlayers} />

        <div className="relative min-h-[480px] overflow-hidden rounded-xl border border-cs2-border bg-[#0a0d0f] shadow-lg" aria-label={`R${round.roundNumber} 雷达回放`}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.08),transparent_60%)]" />
          <MirageTacticalMap />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:8%_8%]" />

          <div className="absolute left-3 top-3 z-30 inline-flex items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-page/90 px-2.5 py-1.5 text-[9px] text-cs2-text-muted backdrop-blur">
            <Map className="h-3 w-3 text-cs2-accent" />Mirage · R{round.roundNumber}<span className="font-mono text-cs2-text-primary">{round.score}</span>
          </div>

          <div className="absolute right-3 top-3 z-30 w-[210px] space-y-1" aria-label="击杀信息">
            {visibleKills.slice(-3).reverse().map((kill, index) => (
              <div key={`${kill.frame}-${index}`} className="flex items-center justify-end gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-page/90 px-2 py-1 text-[8px] shadow backdrop-blur">
                <b className={ROSTER.find((player) => player.name === kill.killer)?.team === "a" ? "text-sky-300" : "text-amber-300"}>{kill.killer}</b>
                <Crosshair className="h-2.5 w-2.5 text-cs2-text-muted" />
                <span className="text-cs2-text-primary">{kill.victim}</span>
                {kill.headshot && <span className="text-rose-300">HS</span>}
              </div>
            ))}
          </div>

          {layers.trace && (
            <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {round.players.map((player) => {
                const trace = player.frames.slice(Math.max(0, frameIndex - 28), frameIndex + 1);
                return trace.length > 1 ? <polyline key={player.id} points={trace.map((frame) => `${frame.x},${frame.y}`).join(" ")} fill="none" stroke={player.team === "a" ? "#38bdf8" : "#fbbf24"} strokeWidth="0.35" strokeOpacity="0.5" strokeLinecap="round" /> : null;
              })}
            </svg>
          )}

          {layers.killLines && (
            <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {round.kills.filter((kill) => frameIndex >= kill.frame && frameIndex <= kill.frame + 15).map((kill, index) => {
                const killer = round.players.find((player) => player.name === kill.killer);
                const victim = round.players.find((player) => player.name === kill.victim);
                if (!killer || !victim) return null;
                const from = killer.frames[kill.frame];
                const to = victim.frames[kill.frame];
                return <g key={`${kill.frame}-${index}`}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#fb7185" strokeWidth="0.65" strokeDasharray="1.2 1.2" /><circle cx={to.x} cy={to.y} r="1.1" fill="none" stroke="#fb7185" strokeWidth="0.55" /></g>;
              })}
            </svg>
          )}

          {layers.grenades && activeGrenades.map((grenade, index) => <div key={`${grenade.frame}-${index}`} className="absolute z-20 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-violet-300/50 bg-violet-400/15 text-[8px] font-black text-violet-200 shadow-[0_0_24px_rgba(167,139,250,0.35)]" style={{ left: `${grenade.x}%`, top: `${grenade.y}%` }}>{grenade.kind}</div>)}
          {round.bomb && frameIndex >= round.bomb.frame && <div className="absolute z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-amber-300/70 bg-amber-400/20 text-[8px] font-black uppercase text-amber-200 shadow-[0_0_22px_rgba(251,191,36,0.3)]" style={{ left: `${round.bomb.x}%`, top: `${round.bomb.y}%` }}>C4</div>}

          {round.players.map((player) => {
            const frame = player.frames[frameIndex];
            const dead = deadPlayers.has(player.name);
            return (
              <div key={player.id} className={`absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-[8px] font-black shadow-lg transition-[left,top] duration-100 ${dead ? "border-slate-500 bg-slate-900 text-slate-400 opacity-55" : player.team === "a" ? "border-sky-200 bg-sky-500 text-white" : "border-amber-200 bg-amber-500 text-slate-950"}`} style={{ left: `${frame.x}%`, top: `${frame.y}%`, transform: `translate(-50%, -50%) rotate(${frame.yaw}deg)` }} title={`${player.number} ${player.name} · ${dead ? "阵亡" : "100 HP"}`}>
                <span style={{ transform: `rotate(${-frame.yaw}deg)` }}>{dead ? "×" : player.number}</span>
                {!dead && <i className={`absolute -top-2 h-2 w-0.5 origin-bottom ${player.team === "a" ? "bg-sky-200" : "bg-amber-200"}`} />}
              </div>
            );
          })}

          <div className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between rounded-lg border border-cs2-border bg-cs2-bg-page/90 px-3 py-2 text-[8px] text-cs2-text-muted backdrop-blur">
            <span>红色锚点 = 击杀 · 黄色锚点 = 下包</span>
            <span className="font-mono">Tick {Math.round(currentTick)}</span>
          </div>
        </div>

        <TeamRoster team="b" currentFrame={frameIndex} round={round} deadPlayers={deadPlayers} />
      </div>
    </section>
  );
}
