import { Flame, Skull, Check, Clapperboard, Film } from "lucide-react";
import RoundMontageRoundPicker from "./RoundMontageRoundPicker";
import QueueAddButton from "./QueueAddButton";
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
    borderColor: "border-cs2-fuchsia-border",
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
        className="pointer-events-none select-none border-l-2 border-amber-400 bg-cs2-amber-surface px-2 py-1"
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
  onEnqueue,
  onTagClick,
  activeTag = "",
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

  const selectable = !inQueue && !ftdEnqueueBlocked && Boolean(clip.client_clip_uid);

  return (
    <article
      data-category={clip.category || "highlight"}
      data-selected={selected ? "true" : "false"}
      data-disabled={inQueue || ftdEnqueueBlocked ? "true" : "false"}
      onClick={(event) => {
        if (event.target.closest("button, input, select, textarea, [role='button']")) return;
        if (!selectable) return;
        onToggle(clip.client_clip_uid);
      }}
      className={`analysis-clip-row group ${selectable ? "cursor-pointer" : ""}`}
    >
      <div className="grid grid-cols-[24px_40px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3.5 py-3 sm:grid-cols-[24px_40px_minmax(0,1fr)_auto]">
        <button
          type="button"
          role="checkbox"
          disabled={!selectable}
          aria-checked={inQueue || selected}
          aria-label={selected ? t("clip.deselect") : t("clip.select")}
          onClick={(event) => {
            event.stopPropagation();
            if (selectable) onToggle(clip.client_clip_uid);
          }}
          className={`flex h-5 w-5 items-center justify-center rounded-[5px] border-[1.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            selected ? "border-cs2-accent bg-cs2-accent text-black" : "border-cs2-border bg-transparent hover:border-cs2-accent/60"
          }`}
        >
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </button>

        <div className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-[9px] ${cat.bgColor} ${cat.color}`}>
          <Icon className="h-4 w-4" aria-hidden />
          <span className="text-[10px] font-semibold leading-none">{t(cat.labelKey)}</span>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {clip.category !== "compilation" && (
              <>
                <span className="text-[13px] font-bold text-cs2-text-primary">{t("clip.roundLabel", { n: clip.round })}</span>
                {clip.round_won != null && (
                  <span
                    className={`text-[11.5px] font-semibold ${clip.round_won ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`}
                    title={clip.round_won ? t("clip.roundWonTitle") : t("clip.roundLostTitle")}
                  >
                    {clip.round_won ? t("clip.roundWon") : t("clip.roundLost")}
                  </span>
                )}
                {hasScore && (
                  <span
                    className="inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold tabular-nums"
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
                {isRoundMontage ? <span className="text-[12px] text-cs2-text-primary">
                  {t("ftd.selectedRounds", { n: ftdPicked.length })}
                </span> : Array.isArray(clip.source_ticks) && clip.source_ticks.length > 0 && (
                  <span
                    className="font-mono text-[11px] font-bold text-cs2-text-primary"
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
                className="inline-flex items-center rounded border border-cs2-accent/35 bg-cs2-accent/[0.07] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-cs2-text-primary"
              >
                {weapon}
              </span>
            ))}
            {clip.kill_count > 0 && (clip.category === "compilation" || !killCountInTags) && (
              <span className="text-[11px] font-semibold text-cs2-text-secondary">
                {t("clip.kills", { n: clip.kill_count })}
              </span>
            )}
          </div>

          {hasSecondaryMeta ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {clip.context_tags?.map((tag, ti) => {
                const desc = describeTag(tag, locale);
                const flashNames = tag === "🤝 好闪配好人" && clip.flash_assisters?.length
                  ? t("clip.flashAssisters", { names: clip.flash_assisters.join("、") })
                  : null;
                const title = [desc, flashNames].filter(Boolean).join("\n");
                return onTagClick ? (
                  <button
                    key={`${ti}-${tag}`}
                    type="button"
                    aria-pressed={activeTag === tag}
                    data-active={activeTag === tag ? "true" : "false"}
                    title={[title, t("analysis.tagFilterHint", { tag: labelTag(tag, locale) })].filter(Boolean).join("\n")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTagClick(tag);
                    }}
                    className="analysis-tag-chip analysis-tag-chip--mini"
                  >
                    {labelTag(tag, locale)}
                  </button>
                ) : (
                  <span
                    key={`${ti}-${tag}`}
                    title={title || undefined}
                    className={`analysis-meta-token ${cat.color} ${title ? "cursor-help" : ""}`}
                  >
                    {labelTag(tag, locale)}
                  </span>
                );
              })}
              {showKillerBadge && (
                <span className="text-[11.5px] text-cs2-text-muted">
                  {t("clip.killerLine")} <span className="font-medium text-[#e8c56a]">{clip.killer_name}</span>
                </span>
              )}
              {showVictimsBadge && (
                <span className="text-[11.5px] text-cs2-text-muted">
                  {t("clip.victimsLine")} <span className="font-medium text-[#b8d9f6]">{victimsList.join("、")}</span>
                </span>
              )}
            </div>
          ) : null}

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
            <div className="mt-2.5 border-l-2 border-cs2-accent/55 bg-cs2-bg-elevated/55 px-3 py-2">
              <p className="min-w-0 break-words text-[11.5px] leading-relaxed text-cs2-text-primary">
                <span className="font-semibold text-cs2-text-muted">{t("clip.aiCommentaryLabel")}</span>
                <span className="italic text-cs2-text-primary/95">{aiCommentary}</span>
              </p>
            </div>
          ) : null}
        </div>

        <div className="col-start-3 flex flex-wrap items-center gap-2 sm:col-start-auto sm:flex-col sm:items-end">
          {showAiUi && hasAiScore ? <AiScoreBadge score={clip.ai_score} /> : null}
          {onEnqueue || inQueue ? (
            <QueueAddButton
              queued={inQueue}
              disabled={ftdEnqueueBlocked || !clip.client_clip_uid}
              onAdd={onEnqueue && clip.client_clip_uid ? () => onEnqueue(clip.client_clip_uid) : undefined}
              onRemove={onDequeue}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}
