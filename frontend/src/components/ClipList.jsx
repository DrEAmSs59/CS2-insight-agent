import { useMemo } from "react";
import { Film, User } from "lucide-react";
import ClipCard from "./ClipCard";
import { useT } from "../i18n/useT.js";

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
 *   onDequeue?: (clientClipUid: string) => void,
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
  onDequeue,
}) {
  const t = useT();
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
          <Film className="h-4 w-4 text-cs2-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wide">{t("clip.detectedClips")}</h2>
          <span className="ml-auto text-right text-[12px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
            {t("clip.summaryTotal", { n: regularClips.length })} · {t("clip.summaryHighlights", { n: highlights.length })} ·{" "}
            {t("clip.summaryFails", { n: fails.length })}{compilations.length > 0 ? ` · ${t("clip.summaryCompilations", { n: compilations.length })}` : ""}
          </span>
        </div>
      )}

      {/* ── 玩家 Tab 栏（仅多玩家时显示） ── */}
      {showTabs && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-card p-2">
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
                    ? "bg-cs2-accent text-cs2-text-on-accent shadow-md shadow-cs2-accent/30"
                    : "bg-cs2-bg-hover text-cs2-text-secondary hover:bg-cs2-bg-active hover:text-cs2-text-primary",
                ].join(" ")}
              >
                <User className="h-3 w-3 shrink-0" />
                <span className="max-w-[120px] truncate">{name}</span>
                <span
                  className={[
                    "rounded px-1 font-mono text-[10px] tabular-nums",
                    isActive ? "bg-cs2-bg-input/30 text-cs2-text-on-accent/80" : "bg-cs2-bg-active text-cs2-text-muted",
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
        <div className="grid gap-4">
          {regularClips.map((clip) => (
            <ClipCard
              key={clip.client_clip_uid || clip.clip_id}
              clip={clip}
              targetPlayer={targetPlayer}
              selected={Boolean(clip.client_clip_uid && selectedIds.has(clip.client_clip_uid))}
              onToggle={onToggle}
              aiMode={aiMode}
              inQueue={Boolean(clip.client_clip_uid && queued.has(clip.client_clip_uid))}
              onDequeue={
                onDequeue && clip.client_clip_uid
                  ? () => onDequeue(clip.client_clip_uid)
                  : undefined
              }
              matchTotalRounds={matchTotalRounds}
              freezeToDeathDraft={freezeToDeathDraft}
              onFreezeToDeathDraftChange={onFreezeToDeathDraftChange}
              roundMontagePickerDisabled={roundMontagePickerDisabled}
            />
          ))}
        </div>
      ) : (
        showTabs && (
          <div className="rounded-lg border border-dashed border-cs2-border py-10 text-center text-[13px] text-cs2-text-muted">
            {t("clip.emptyPlayer")}
          </div>
        )
      )}
    </div>
  );
}
