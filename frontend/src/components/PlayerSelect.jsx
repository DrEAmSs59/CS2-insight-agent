import { Crosshair, Search, CheckSquare } from "lucide-react";

/**
 * CS2 社区梗标签（判断顺序不可打乱）
 * @param {number} k kills
 * @param {number} d deaths
 * @param {number} a assists（211 规则下不参与判定）
 */
/** 与 o / i / z 系列梗配套的追加标签 */
const TAG_CHIEF_RD = "👨‍🔬 首席研发工程师";

function getMemeTags(k, d, a) {
  void a; /* 助攻不参与梗判定，保留参数以符合接口 */
  if (k === 2 && d === 11) return ["🎓 211高材生"];
  if (k === 0) return [`🥚 o${d}`, TAG_CHIEF_RD];
  if (k === 1 && d === 18) return [`🗿 i${d}`, TAG_CHIEF_RD];
  if (k === 1) return [`👨‍💻 i${d}`, TAG_CHIEF_RD];
  if (k === 2) return [`💤 z${d}`, TAG_CHIEF_RD];
  return [];
}

function normalizePlayer(p) {
  if (typeof p === "string") {
    return { name: p, team: 0, kills: 0, deaths: 0, assists: 0, steam_id: null };
  }
  return {
    name: p.name ?? "",
    team: Number(p.team) || 0,
    kills: Number(p.kills) || 0,
    deaths: Number(p.deaths) || 0,
    assists: Number(p.assists) || 0,
    steam_id: p.steam_id != null && p.steam_id !== "" ? String(p.steam_id) : null,
  };
}

const MEME_BADGE_CLASS =
  "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-sm font-black tracking-tight text-white " +
  "bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-600 " +
  "shadow-[0_0_14px_rgba(236,72,153,0.85),0_0_28px_rgba(168,85,247,0.45)]";

/** selected: string[] — 已选玩家名称数组 */
function PlayerRow({ player, selected, onSelect }) {
  const { name, kills, deaths, assists } = player;
  const memeTags = getMemeTags(kills, deaths, assists);
  const isSelected = selected.includes(name);

  return (
    <button
      type="button"
      onClick={() => onSelect(name)}
      className={[
        "flex w-full flex-row items-center justify-between gap-3 rounded-md py-2 px-3 text-left transition-colors duration-150",
        "border-l-4",
        isSelected
          ? "border-l-cs2-orange bg-cs2-orange/10"
          : "border-l-transparent bg-[#161616] hover:bg-[#1c1c1c]",
      ].join(" ")}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* 多选指示器 */}
        <span
          className={[
            "flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors",
            isSelected
              ? "border-cs2-orange bg-cs2-orange"
              : "border-zinc-600 bg-transparent",
          ].join(" ")}
        >
          {isSelected && (
            <svg className="h-2.5 w-2.5 text-black" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span
          className={`truncate text-base font-bold tracking-tight ${
            isSelected ? "text-cs2-orange" : "text-white"
          }`}
        >
          {name}
        </span>
        {memeTags.length > 0 && (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {memeTags.map((tag) => (
              <span key={tag} className={MEME_BADGE_CLASS}>
                {tag}
              </span>
            ))}
          </span>
        )}
      </div>
      <span className="shrink-0 font-mono text-xs text-gray-400 tabular-nums sm:text-sm">
        K: {kills} / D: {deaths} / A: {assists}
      </span>
    </button>
  );
}

function TeamBlock({ title, players, selected, onSelect }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#121212]/90 p-2">
      <h3 className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
        {title}
      </h3>
      <div className="flex flex-col gap-0.5">
        {players.length === 0 ? (
          <p className="py-2 text-center text-[10px] text-zinc-600">暂无</p>
        ) : (
          players.map((p) => (
            <PlayerRow key={p.name} player={p} selected={selected} onSelect={onSelect} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * @param {{ players: any[], selected: string[], onSelect: (name: string) => void, onAnalyze: () => void, disabled: boolean }} props
 * `selected` 为已选玩家名称数组；`onSelect` 接收名称进行切换（toggle）。
 */
export default function PlayerSelect({ players, selected, onSelect, onAnalyze, disabled }) {
  const list = (players ?? []).map(normalizePlayer);
  const selectedArr = Array.isArray(selected) ? selected : (selected ? [selected] : []);

  const teamA = list.filter((p) => p.team === 3);
  const teamB = list.filter((p) => p.team === 2);
  const unknown = list.filter((p) => p.team !== 2 && p.team !== 3);

  const btnLabel =
    selectedArr.length === 0
      ? "请先选择玩家"
      : selectedArr.length === 1
      ? "解析当前场次"
      : `解析选中玩家 (${selectedArr.length})`;

  return (
    <div className="bg-cs2-bg-card rounded-xl border border-cs2-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <Crosshair className="h-4 w-4 shrink-0 text-cs2-orange" />
        <h2 className="text-sm font-bold uppercase tracking-wide">本场目标玩家</h2>
        {selectedArr.length > 0 && (
          <span className="ml-auto text-[11px] text-zinc-500">
            已选 <span className="font-bold text-cs2-orange">{selectedArr.length}</span> 人
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
        可多选玩家同时解析；仅在<strong className="text-zinc-400">当前这一场</strong>
        Demo 内生效，切换场次后请重新选择。解析进行中也可切换场次；正在解析的那一场会暂时锁定本按钮。
      </p>

      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <TeamBlock title="队伍 A" players={teamA} selected={selectedArr} onSelect={onSelect} />
        <TeamBlock title="队伍 B" players={teamB} selected={selectedArr} onSelect={onSelect} />
      </div>

      {unknown.length > 0 && (
        <div className="mb-3 rounded-lg border border-dashed border-zinc-700/50 bg-zinc-950/40 p-2">
          <p className="mb-1 px-1 text-[10px] font-semibold text-zinc-500">未识别队伍</p>
          <div className="flex flex-col gap-0.5">
            {unknown.map((p) => (
              <PlayerRow key={p.name} player={p} selected={selectedArr} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onAnalyze}
        disabled={!selectedArr.length || disabled}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-orange py-2.5 text-sm font-bold uppercase tracking-wider text-black shadow-lg shadow-cs2-orange/20 transition-colors hover:bg-cs2-orange-light disabled:cursor-not-allowed disabled:opacity-30"
      >
        {selectedArr.length > 1 ? (
          <CheckSquare className="h-4 w-4" />
        ) : (
          <Search className="h-4 w-4" />
        )}
        {btnLabel}
      </button>
    </div>
  );
}
