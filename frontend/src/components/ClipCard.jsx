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
        className="pointer-events-none select-none rounded-md border border-amber-400/50 bg-gradient-to-br from-amber-500/25 via-orange-500/15 to-amber-600/10 px-2 py-1 shadow-lg"
        aria-label={t("clip.aiScoreLabel", { n: rounded })}
      >
        <span className="whitespace-nowrap text-[11px] font-black tracking-tight text-cs2-amber-on-surface drop-shadow-[0_0_8px_rgba(251,191,36,0.9)]">
          {t("clip.scoreHigh", { n: rounded })}
        </span>
      </div>
    );
  }

  if (n >= 40) {
    return (
      <div
        className="pointer-events-none select-none rounded-md border border-cs2-emerald-surface bg-cs2-emerald-surface px-2 py-1"
        aria-label={t("clip.aiScoreLabel", { n: rounded })}
      >
        <span className="whitespace-nowrap font-mono text-[11px] font-bold tabular-nums text-cs2-emerald-on-surface">
          {t("clip.scoreMid", { n: rounded })}
        </span>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none select-none rounded-md border border-cs2-rose-surface bg-gradient-to-br from-cs2-rose-surface via-cs2-fuchsia-surface to-cs2-red-surface px-2 py-1 shadow-lg"
      aria-label={t("clip.aiScoreLabel", { n: rounded })}
    >
      <span className="whitespace-nowrap text-[11px] font-black tracking-tight text-cs2-rose-on-surface drop-shadow-[0_0_6px_rgba(244,63,94,0.5)]">
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

  // 若 context_tags 已包含对应杀数词，则不再单独显示数字徽章（避免「双杀」+「2 杀」重复）
  const KILL_COUNT_TAGS = new Set(["双杀", "三杀", "四杀", "五杀 (ACE)"]);
  const killCountInTags = clip.context_tags?.some((tag) => KILL_COUNT_TAGS.has(tag)) ?? false;

  return (
    <div
      role="button"
      aria-disabled={inQueue || ftdEnqueueBlocked}
      tabIndex={inQueue || ftdEnqueueBlocked ? -1 : 0}
      onClick={() => {
        if (inQueue || ftdEnqueueBlocked || !clip.client_clip_uid) return;
        onToggle(clip.client_clip_uid);
      }}
      onKeyDown={(e) => {
        if (inQueue || ftdEnqueueBlocked || !clip.client_clip_uid) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(clip.client_clip_uid);
        }
      }}
      className={`group relative rounded-xl border transition-all duration-200 bg-cs2-bg-card ${
        inQueue
          ? "cursor-not-allowed border-cs2-border opacity-[0.72]"
          : ftdEnqueueBlocked
            ? "cursor-not-allowed border-amber-500/20 opacity-[0.85]"
            : `cursor-pointer hover:shadow-lg ${
                selected
                  ? "border-cs2-accent shadow-lg shadow-cs2-accent/10"
                  : "border-cs2-border hover:border-cs2-border"
              }`
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
          className="absolute right-3 top-3 z-10 flex min-h-[1.25rem] items-center gap-0.5 rounded-md border border-cs2-border bg-cs2-bg-elevated px-1 text-[9px] font-bold uppercase tracking-wide text-cs2-text-secondary transition-colors hover:border-rose-500/60 hover:text-rose-400"
        >
          {t("clip.inQueue")}<X className="h-2.5 w-2.5" />
        </button>
      ) : (
        <div
          className={`absolute right-3 top-3 z-10 flex min-h-[1.25rem] min-w-[1.25rem] items-center justify-center rounded-md px-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
            inQueue
              ? "border border-cs2-border bg-cs2-bg-elevated text-cs2-text-secondary"
              : selected
                ? "bg-cs2-accent"
                : "border border-cs2-border bg-cs2-bg-input group-hover:border-cs2-accent/40"
          }`}
        >
          {inQueue ? (
            t("clip.inQueue")
          ) : ftdEnqueueBlocked ? (
            <span className="px-0.5 text-[8px] font-bold leading-none text-cs2-amber-on-surface/90">—</span>
          ) : selected ? (
            <Check className="h-3 w-3 text-cs2-text-on-accent" />
          ) : null}
        </div>
      )}

      <div className="p-5 pt-4">
        <div className="flex items-start gap-4">
          {/* Category badge */}
          <div className={`flex flex-col items-center gap-1 rounded-lg px-3 py-2 ${cat.bgColor}`}>
            <Icon className={`h-5 w-5 ${cat.color}`} />
            <span className={`text-[9px] font-bold tracking-widest ${cat.color}`}>{t(cat.labelKey)}</span>
          </div>

          {/* Details */}
          <div className="min-w-0 flex-1 pr-6 sm:pr-8">
            {clip.category !== "compilation" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold text-cs2-accent">{t("clip.roundLabel", { n: clip.round })}</span>
                {clip.round_won != null && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                      clip.round_won
                        ? "bg-cs2-emerald-surface text-cs2-emerald-on-surface"
                        : "bg-cs2-rose-surface text-cs2-rose-on-surface"
                    }`}
                    title={clip.round_won ? t("clip.roundWonTitle") : t("clip.roundLostTitle")}
                  >
                    {clip.round_won ? t("clip.roundWon") : t("clip.roundLost")}
                  </span>
                )}
                {hasScore && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums"
                    title={t("clip.scoreTitle")}
                  >
                    <span className="text-cs2-emerald-on-surface">{clip.score_own}</span>
                    <span className="text-cs2-text-secondary">:</span>
                    <span className="text-cs2-rose-on-surface">{clip.score_opp}</span>
                  </span>
                )}
                {clip.kill_count > 0 && !killCountInTags && (
                  <span className="rounded bg-cs2-bg-input px-2 py-0.5 text-[10px] font-bold text-cs2-text-primary">
                    {t("clip.kills", { n: clip.kill_count })}
                  </span>
                )}
              </div>
            )}
            {clip.category === "compilation" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {Array.isArray(clip.source_ticks) && clip.source_ticks.length > 0 && (
                  <span
                    className="rounded bg-cs2-bg-input px-2 py-0.5 font-mono text-[10px] font-bold text-cs2-text-primary"
                    title={t("clip.segmentsTitle")}
                  >
                    {t("clip.segments", { n: clip.source_ticks.length })}
                  </span>
                )}
                {clip.kill_count > 0 && (
                  <span className="rounded bg-cs2-bg-input px-2 py-0.5 text-[10px] font-bold text-cs2-text-primary">
                    {t("clip.kills", { n: clip.kill_count })}
                  </span>
                )}
              </div>
            )}

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
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
                    className={`rounded border px-2 py-0.5 text-[10px] font-bold tracking-wide ${cat.bgColor} ${cat.borderColor} ${cat.color} ${title ? "cursor-help" : ""}`}
                  >
                    {labelTag(tag, locale)}
                  </span>
                );
              })}
              {weaponUsedTokens(clip.weapon_used, locale).map((w) => (
                  <span
                    key={w}
                    className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-0.5 font-mono text-[10px] text-cs2-text-secondary"
                  >
                    {w}
                  </span>
                ))}
              {showKillerBadge && (
                <span className="rounded border border-cs2-rose-surface bg-cs2-rose-surface px-2 py-0.5 text-[10px] font-bold tracking-wide text-cs2-rose-on-surface">
                  {t("clip.killerBadge", { name: clip.killer_name })}
                </span>
              )}
              {showVictimsBadge && (
                <span className="rounded border border-cs2-emerald-surface bg-cs2-emerald-surface px-2 py-0.5 text-[10px] font-bold tracking-wide text-cs2-emerald-on-surface">
                  {t("clip.victimsBadge", { names: victimsList.join(", ") })}
                </span>
              )}
            </div>

            <div className="font-mono text-[11px] text-cs2-text-secondary">
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
          </div>
        </div>

        {showAiUi && aiCommentary ? (
          <div className="relative mt-4 min-w-0 overflow-hidden rounded-lg bg-cs2-bg-elevated pl-3.5 pr-3 py-2.5 ring-1 ring-cs2-border-subtle">
            <div
              className="pointer-events-none absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-gradient-to-b from-cs2-accent via-cs2-fuchsia-on-surface/80 to-cs2-cyan-on-surface/40 opacity-90"
              aria-hidden
            />
            <p className="min-w-0 break-words pl-2 text-[13px] leading-relaxed text-cs2-text-primary">
              <span className="mr-1.5 inline-block select-none not-italic" aria-hidden>
                🎙️
              </span>
              <span className="font-semibold not-italic text-cs2-text-muted">{t("clip.aiCommentaryLabel")}</span>
              <span className="italic text-cs2-text-primary/95">{aiCommentary}</span>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
