import { useMemo } from "react";
import { Film, User } from "lucide-react";
import ClipCard from "./ClipCard";

const NO_QUEUED = new Set();
const COMPILATION_ORDER = {
  rival_kills: 10,
  nemesis_deaths: 20,
  all_kills: 90,
  all_deaths: 100,
  freeze_to_death: 110,
};

/**
 * @param {{
 *   clips: any[],
 *   targetPlayer: string,
 *   selectedIds: Set<string>,
 *   onToggle: (uid: string) => void,
 *   aiMode: boolean,
 *   queuedClientClipUids?: Set<string>,
 *   playerTabs?: string[],
 *   activePlayerTab?: string,
 *   onPlayerTabChange?: (name: string) => void,
 *   parsedPlayers?: Record<string, { clips: any[], match_meta: any }>,
 *   matchTotalRounds?: number,
 *   freezeToDeathDraft?: { picked: number[] },
 *   onFreezeToDeathDraftChange?: (next: { picked: number[] }) => void,
 *   roundMontagePickerDisabled?: boolean,
 *   suppressSummaryHeader?: boolean,
 * }} props
 */
export default function ClipList({
  clips,
  targetPlayer = "",
  selectedIds,
  onToggle,
  aiMode,
  queuedClientClipUids,
  playerTabs = [],
  activePlayerTab = "",
  onPlayerTabChange,
  parsedPlayers = {},
  matchTotalRounds = 24,
  freezeToDeathDraft = { picked: [] },
  onFreezeToDeathDraftChange,
  roundMontagePickerDisabled = false,
  suppressSummaryHeader = false,
}) {
  const queued = queuedClientClipUids ?? NO_QUEUED;
  // 顺序：高光 / 下饭 / 坐牢（已在上游过滤掉）按原顺序混排，合集永远排最后
  const regularClips = useMemo(() => {
    const base = clips.filter((c) => c.category !== "meme_death");
    const nonComp = base.filter((c) => c.category !== "compilation");
    const comp = base
      .filter((c) => c.category === "compilation")
      .sort((a, b) => {
        const oa = COMPILATION_ORDER[a.compilation_kind] ?? 50;
        const ob = COMPILATION_ORDER[b.compilation_kind] ?? 50;
        if (oa !== ob) return oa - ob;
        return (a.start_tick ?? 0) - (b.start_tick ?? 0);
      });
    return [...nonComp, ...comp];
  }, [clips]);

  const highlights = regularClips.filter((c) => c.category === "highlight");
  const fails = regularClips.filter((c) => c.category === "fail");
  const compilations = regularClips.filter((c) => c.category === "compilation");

  const showTabs = playerTabs.length > 1;

  return (
    <div className="space-y-4">
      {!suppressSummaryHeader && (
        <div className="flex items-center gap-2">
          <Film className="h-4 w-4 text-cs2-orange" />
          <h2 className="text-sm font-bold uppercase tracking-wide">检测到的片段</h2>
          <span className="ml-auto text-right text-[11px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
            共 <span className="text-zinc-300">{regularClips.length}</span> 条 · {highlights.length} 高光 ·{" "}
            {fails.length} 下饭{compilations.length > 0 ? ` · ${compilations.length} 合集` : ""}
          </span>
        </div>
      )}

      {/* ── 玩家 Tab 栏（仅多玩家时显示） ── */}
      {showTabs && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-white/8 bg-cs2-bg-card/60 p-1.5">
          {playerTabs.map((name) => {
            const pd = parsedPlayers[name];
            const cnt = (pd?.clips ?? []).filter((c) => c.category !== "meme_death").length;
            const isActive = name === activePlayerTab;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onPlayerTabChange?.(name)}
                className={[
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-all duration-150",
                  isActive
                    ? "bg-cs2-orange text-black shadow-md shadow-cs2-orange/30"
                    : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200",
                ].join(" ")}
              >
                <User className="h-3 w-3 shrink-0" />
                <span className="max-w-[120px] truncate">{name}</span>
                <span
                  className={[
                    "rounded px-1 font-mono text-[10px] tabular-nums",
                    isActive ? "bg-black/20 text-black/80" : "bg-white/8 text-zinc-500",
                  ].join(" ")}
                >
                  {cnt}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── 片段卡片列表 ── */}
      {regularClips.length > 0 ? (
        <div className="grid gap-3">
          {regularClips.map((clip) => (
            <ClipCard
              key={clip.client_clip_uid || clip.clip_id}
              clip={clip}
              targetPlayer={targetPlayer}
              selected={Boolean(clip.client_clip_uid && selectedIds.has(clip.client_clip_uid))}
              onToggle={onToggle}
              aiMode={aiMode}
              inQueue={Boolean(clip.client_clip_uid && queued.has(clip.client_clip_uid))}
              matchTotalRounds={matchTotalRounds}
              freezeToDeathDraft={freezeToDeathDraft}
              onFreezeToDeathDraftChange={onFreezeToDeathDraftChange}
              roundMontagePickerDisabled={roundMontagePickerDisabled}
            />
          ))}
        </div>
      ) : (
        showTabs && (
          <div className="rounded-lg border border-dashed border-white/10 py-10 text-center text-[13px] text-zinc-600">
            该玩家暂无片段
          </div>
        )
      )}
    </div>
  );
}
