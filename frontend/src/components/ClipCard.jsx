import { Flame, Skull, Check, Clapperboard, Film, X } from "lucide-react";
import RoundMontageRoundPicker from "./RoundMontageRoundPicker";
import { describeTag, labelTag } from "../utils/tagDescriptions";
import { isFreezeToDeathCompilation } from "../utils/freezeToDeathRoundFilter";
import { isTimelineSourceClip } from "../utils/montageUtils";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore";
import { weaponUsedTokens } from "../i18n/weaponNames.js";

export const CLIP_CATEGORY_CONFIG = {
  highlight: {
    icon: Flame,
    color: "text-cs2-highlight",
    bgColor: "bg-cs2-highlight/10",
    borderColor: "border-cs2-highlight/30",
    labelKey: "clip.catHighlight",
  },
  fail: {
    icon: Skull,
    color: "text-cs2-fail",
    bgColor: "bg-cs2-fail/10",
    borderColor: "border-cs2-fail/30",
    labelKey: "clip.catFail",
  },
  meme_death: {
    icon: Clapperboard,
    color: "text-cs2-fuchsia-on-surface",
    bgColor: "bg-cs2-fuchsia-surface",
    borderColor: "border-cs2-fuchsia-surface",
    labelKey: "clip.catMemeDeath",
  },
  compilation: {
    icon: Film,
    color: "text-cs2-compilation",
    bgColor: "bg-cs2-compilation/10",
    borderColor: "border-cs2-compilation/35",
    labelKey: "clip.catCompilation",
  },
};

function normalizeAiScore(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 右上角抢眼的 AI 分数：>85 金橙发光；40–85 绿/灰；<40 紫红小丑 */
export function AiScoreBadge({ score }) {
  const t = useT();
  const n = normalizeAiScore(score);
  if (n == null) return null;

  const rounded = Math.round(n);

  if (n > 85) {
    return (
      <div
        className="pointer-events-none select-none border-l-2 border-amber-400 bg-amber-500/10 px-2 py-1"
        aria-label={t("clip.aiScoreLabel", { n: rounded })}
      >
        <span className="whitespace-nowrap text-[10px] font-black tracking-tight text-cs2-amber-on-surface">
          {t("clip.scoreHigh", { n: rounded })}
        </span>
      </div>
    );
  }

  if (n >= 40) {
    return (
      <div
        className="pointer-events-none select-none border-l-2 border-emerald-500 bg-cs2-emerald-surface/60 px-2 py-1"
        aria-label={t("clip.aiScoreLabel", { n: rounded })}
      >
        <span className="whitespace-nowrap font-mono text-[10px] font-bold tabular-nums text-cs2-emerald-on-surface">
          {t("clip.scoreMid", { n: rounded })}
        </span>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none select-none border-l-2 border-rose-500 bg-cs2-rose-surface/70 px-2 py-1"
      aria-label={t("clip.aiScoreLabel", { n: rounded })}
    >
      <span className="whitespace-nowrap text-[10px] font-black tracking-tight text-cs2-rose-on-surface">
        {t("clip.scoreLow", { n: rounded })}
      </span>
    </div>
  );
}

export default function ClipCard({
  clip,
  targetPlayer = "",
  selected,
  onToggle,
  aiMode = false,
  inQueue = false,
  onDequeue,
  matchTotalRounds = 24,
  freezeToDeathDraft = { picked: [] },
  onFreezeToDeathDraftChange,
  roundMontagePickerDisabled = false,
}) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);

  const isRoundMontage = isFreezeToDeathCompilation(clip);
  const ftdPicked = freezeToDeathDraft?.picked || [];
  const ftdEnqueueBlocked = isRoundMontage && ftdPicked.length === 0;

  const cat = CLIP_CATEGORY_CONFIG[clip.category] || CLIP_CATEGORY_CONFIG.highlight;
  const Icon = cat.icon;

  const _killerStr = String(clip.killer_name ?? "").trim().toLowerCase();
  const showKillerBadge =
    clip.category === "fail" &&
    _killerStr !== "" &&
    _killerStr !== "nan" &&
    _killerStr !== "null" &&
    _killerStr !== "undefined";

  const victimsList = Array.isArray(clip.victims) ? clip.victims.filter(Boolean) : [];
  const showVictimsBadge = clip.category === "highlight" && victimsList.length > 0;

  const suppressAiRuiPing =
    clip.category === "compilation" || isTimelineSourceClip(clip);
  const showAiUi = Boolean(aiMode) && !suppressAiRuiPing;

  const aiCommentary = [clip.ai_commentary, clip.ai_comment]
    .map((x) => String(x ?? "").trim())
    .find(Boolean);
  const hasAiScore = normalizeAiScore(clip.ai_score) != null;

  const hasScore = clip.score_own != null && clip.score_opp != null;
  const weaponTokens = weaponUsedTokens(clip.weapon_used, locale);
  const hasSecondaryMeta = Boolean(
    clip.context_tags?.length || showKillerBadge || showVictimsBadge,
  );

  // 若 context_tags 已包含对应杀数词，则不再单独显示数字徽章（避免「双杀」+「2 杀」重复）
  const KILL_COUNT_TAGS = new Set(["双杀", "三杀", "四杀", "五杀 (ACE)"]);
  const killCountInTags = clip.context_tags?.some((tag) => KILL_COUNT_TAGS.has(tag)) ?? false;

  return (
    <article
      data-category={clip.category || "highlight"}
      data-selected={selected ? "true" : "false"}
      data-disabled={inQueue || ftdEnqueueBlocked ? "true" : "false"}
      onClick={(event) => {
        if (event.target.closest("button, input, select, textarea, [role='button']")) return;
        if (inQueue || ftdEnqueueBlocked || !clip.client_clip_uid) return;
        onToggle(clip.client_clip_uid);
      }}
      className={`analysis-clip-row group ${
        inQueue
          ? "cursor-not-allowed opacity-[0.72]"
          : ftdEnqueueBlocked
            ? "cursor-not-allowed opacity-[0.85]"
            : "cursor-pointer"
      }`}
    >
      {showAiUi && hasAiScore && (
        <div className="absolute right-11 top-3 z-10 max-w-[calc(100%-5.5rem)] sm:right-12">
          <AiScoreBadge score={clip.ai_score} />
        </div>
      )}

      {/* Selection / 队列状态 */}
      {inQueue && onDequeue ? (
        <button
          type="button"
          aria-label={t("clip.dequeue")}
          onClick={(e) => { e.stopPropagation(); onDequeue(); }}
          className="absolute right-3 top-3 z-10 flex min-h-6 items-center gap-1 rounded-[4px] border border-cs2-border bg-cs2-bg-elevated px-2 text-[9px] font-bold uppercase tracking-wide text-cs2-text-secondary transition-colors hover:border-rose-500/60 hover:text-rose-400"
        >
          {t("clip.inQueue")}<X className="h-2.5 w-2.5" />
        </button>
      ) : (
        <button
          type="button"
          disabled={inQueue || ftdEnqueueBlocked || !clip.client_clip_uid}
          aria-label={inQueue ? t("clip.inQueue") : selected ? t("clip.deselect") : t("clip.select")}
          aria-pressed={inQueue || selected}
          onClick={(event) => {
            event.stopPropagation();
            if (!inQueue && !ftdEnqueueBlocked && clip.client_clip_uid) onToggle(clip.client_clip_uid);
          }}
          className={`absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-[4px] border transition-colors ${selected ? "border-cs2-accent bg-cs2-accent text-cs2-text-on-accent" : "border-cs2-border bg-cs2-bg-input text-cs2-text-muted hover:border-cs2-accent/55"}`}
        >
          {inQueue ? (
            <Check className="h-3 w-3" />
          ) : ftdEnqueueBlocked ? (
            <span className="px-0.5 text-[8px] font-bold leading-none text-cs2-amber-on-surface/90">—</span>
          ) : selected ? (
            <Check className="h-3 w-3" />
          ) : null}
        </button>
      )}

      <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-4 py-3.5">
        <div className="flex flex-col items-center gap-1 border-r border-cs2-border-subtle pr-3 pt-0.5">
          <Icon className={`h-4.5 w-4.5 ${cat.color}`} />
          <span className={`text-[8px] font-bold tracking-[0.12em] ${cat.color}`}>{t(cat.labelKey)}</span>
        </div>

        <div className="min-w-0 pr-7 sm:pr-9">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {clip.category !== "compilation" && (
              <>
                <span className="font-mono text-xs font-bold text-cs2-accent">{t("clip.roundLabel", { n: clip.round })}</span>
                {clip.round_won != null && (
                  <span
                    className={`text-[9px] font-black uppercase tracking-wide ${clip.round_won ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`}
                    title={clip.round_won ? t("clip.roundWonTitle") : t("clip.roundLostTitle")}
                  >
                    {clip.round_won ? t("clip.roundWon") : t("clip.roundLost")}
                  </span>
                )}
                {hasScore && (
                  <span
                    className="inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold tabular-nums"
                    title={t("clip.scoreTitle")}
                  >
                    <span className="text-cs2-emerald-on-surface">{clip.score_own}</span>
                    <span className="text-cs2-text-secondary">:</span>
                    <span className="text-cs2-rose-on-surface">{clip.score_opp}</span>
                  </span>
                )}
              </>
            )}
            {clip.category === "compilation" && (
              <>
                {Array.isArray(clip.source_ticks) && clip.source_ticks.length > 0 && (
                  <span
                    className="font-mono text-[10px] font-bold text-cs2-text-primary"
                    title={t("clip.segmentsTitle")}
                  >
                    {t("clip.segments", { n: clip.source_ticks.length })}
                  </span>
                )}
              </>
            )}
            {weaponTokens.map((weapon) => (
              <span
                key={weapon}
                className="inline-flex items-center rounded border border-cs2-accent/35 bg-cs2-accent/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-bold text-cs2-text-primary"
              >
                {weapon}
              </span>
            ))}
            {clip.kill_count > 0 && (clip.category === "compilation" || !killCountInTags) && (
              <span className="text-[10px] font-bold text-cs2-text-secondary">
                {t("clip.kills", { n: clip.kill_count })}
              </span>
            )}
          </div>

          {hasSecondaryMeta ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {clip.context_tags?.map((tag, ti) => {
                const desc = describeTag(tag, locale);
                const flashNames = tag === "🤝 好闪配好人" && clip.flash_assisters?.length
                  ? t("clip.flashAssisters", { names: clip.flash_assisters.join("、") })
                  : null;
                const title = [desc, flashNames].filter(Boolean).join("\n") || undefined;
                return (
                  <span
                    key={`${ti}-${tag}`}
                    title={title}
                    className={`analysis-meta-token ${cat.color} ${title ? "cursor-help" : ""}`}
                  >
                    {labelTag(tag, locale)}
                  </span>
                );
              })}
              {showKillerBadge && (
                <span className="analysis-meta-token text-cs2-rose-on-surface">
                  {t("clip.killerBadge", { name: clip.killer_name })}
                </span>
              )}
              {showVictimsBadge && (
                <span className="analysis-meta-token text-cs2-emerald-on-surface">
                  {t("clip.victimsBadge", { names: victimsList.join(", ") })}
                </span>
              )}
            </div>
          ) : null}

          <div className="font-mono text-[9px] text-cs2-text-muted">
            tick {clip.start_tick.toLocaleString()} → {clip.end_tick.toLocaleString()}
          </div>

          {isRoundMontage && typeof onFreezeToDeathDraftChange === "function" && (
            <div
              className="mt-2"
              role="presentation"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <RoundMontageRoundPicker
                maxRounds={matchTotalRounds}
                picked={ftdPicked}
                disabled={roundMontagePickerDisabled || inQueue}
                onChange={onFreezeToDeathDraftChange}
              />
            </div>
          )}

          {showAiUi && aiCommentary ? (
            <div className="mt-3 border-l-2 border-cs2-accent/55 bg-cs2-bg-elevated/55 px-3 py-2">
              <p className="min-w-0 break-words text-[11px] leading-relaxed text-cs2-text-primary">
                <span className="mr-1.5 select-none" aria-hidden>🎙️</span>
                <span className="font-semibold text-cs2-text-muted">{t("clip.aiCommentaryLabel")}</span>
                <span className="italic text-cs2-text-primary/95">{aiCommentary}</span>
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
