import { Trophy } from "lucide-react";

/**
 * 全局计分板 — 与 PlayerSelect 列顺序一致：
 * 左「队伍 A」= 玩家列表左列 (team_num 3) → 后端 team_b_score (winner==3)
 * 右「队伍 B」= 玩家列表右列 (team_num 2) → 后端 team_a_score (winner==2)
 */
export default function MatchScoreboard({ matchMeta }) {
  if (!matchMeta) return null;

  const mapName = matchMeta.map_name?.trim() || "—";
  const durationMins = Number(matchMeta.duration_mins) || 0;
  const totalRounds = Number(matchMeta.total_rounds) || 0;
  const leftScore = Number(matchMeta.team_b_score) || 0;
  const rightScore = Number(matchMeta.team_a_score) || 0;
  const winner =
    leftScore > rightScore ? "left" : rightScore > leftScore ? "right" : "tie";

  return (
    <div
      className={[
        "relative overflow-hidden rounded-xl border border-white/[0.08]",
        "bg-cs2-bg-card shadow-[0_8px_32px_rgba(0,0,0,0.45),0_0_0_1px_rgba(255,255,255,0.03)_inset]",
      ].join(" ")}
    >
      {/* 顶栏电竞渐变条 */}
      <div
        className="h-1 w-full bg-gradient-to-r from-sky-500 via-violet-500/80 to-amber-500 opacity-90"
        aria-hidden
      />

      <div className="px-4 pb-2.5 pt-2 sm:px-6 sm:pb-3 sm:pt-2.5">
        <div className="mb-0.5 flex items-center justify-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500">
            Match Scoreboard
          </span>
        </div>

        {/* 核心三列：队 A | 比分 | 队 B */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
          {/* 左队 A — 冷蓝 */}
          <div className="flex min-w-0 flex-col items-end text-right sm:pr-2">
            <div className="mb-0.5 flex items-center gap-1">
              {winner === "left" && (
                <Trophy className="h-3.5 w-3.5 shrink-0 text-sky-400 drop-shadow-[0_0_8px_rgba(56,189,248,0.6)]" />
              )}
              <span className="truncate text-[11px] font-bold uppercase tracking-wider text-sky-300/90 drop-shadow-[0_0_12px_rgba(125,211,252,0.25)]">
                队伍 A
              </span>
            </div>
          </div>

          {/* 中间巨分 */}
          <div className="flex shrink-0 items-center justify-center gap-1.5 sm:gap-2">
            <span
              className={[
                "select-none text-4xl font-black tabular-nums leading-none tracking-tight sm:text-5xl",
                "bg-gradient-to-b from-sky-100 via-sky-300 to-sky-600 bg-clip-text text-transparent",
                "drop-shadow-[0_0_20px_rgba(56,189,248,0.35)]",
              ].join(" ")}
            >
              {leftScore}
            </span>
            <span
              className={[
                "select-none text-3xl font-black text-zinc-600 sm:text-4xl",
                "drop-shadow-[0_0_12px_rgba(255,255,255,0.08)]",
              ].join(" ")}
            >
              :
            </span>
            <span
              className={[
                "select-none text-4xl font-black tabular-nums leading-none tracking-tight sm:text-5xl",
                "bg-gradient-to-b from-amber-100 via-amber-400 to-orange-600 bg-clip-text text-transparent",
                "drop-shadow-[0_0_20px_rgba(251,191,36,0.35)]",
              ].join(" ")}
            >
              {rightScore}
            </span>
          </div>

          {/* 右队 B — 暖橙 */}
          <div className="flex min-w-0 flex-col items-start text-left sm:pl-2">
            <div className="mb-0.5 flex items-center gap-1">
              <span className="truncate text-[11px] font-bold uppercase tracking-wider text-amber-300/90 drop-shadow-[0_0_12px_rgba(251,191,36,0.25)]">
                队伍 B
              </span>
              {winner === "right" && (
                <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
              )}
            </div>
          </div>
        </div>

        {/* 元数据（无可靠真实开赛时间，不展示日期） */}
        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-white/[0.06] pt-2 font-mono text-xs text-cs2-text-secondary sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4 sm:gap-y-1">
          <span className="tabular-nums">
            🎯 回合: <span className="text-zinc-300">{totalRounds}</span>
          </span>
          <span className="tabular-nums">
            ⏱️ 时长: <span className="text-zinc-400">{durationMins}</span> 分钟
          </span>
          <span className="min-w-0 truncate sm:max-w-none">
            🗺️ 地图: <span className="text-zinc-300">{mapName}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
