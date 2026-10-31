import { useState } from "react";
import { ChevronDown, Layers, Skull, Sparkles } from "lucide-react";
import QueueAddButton from "../../components/QueueAddButton";
import RoundMontageRoundPicker from "../../components/RoundMontageRoundPicker";
import { useT } from "../../i18n/useT.js";
import { labelTag } from "../../utils/tagDescriptions.js";
import { isFreezeToDeathCompilation } from "../../utils/freezeToDeathRoundFilter";
import QueueActionCard from "./QueueActionCard";

const KILL_KINDS = new Set(["all_kills", "rival_kills", "weapon_kills"]);
const DEATH_KINDS = new Set(["all_deaths", "nemesis_deaths"]);
const PACK_ORDER = { all_kills: 10, all_deaths: 20, freeze_to_death: 30, rival_kills: 40, nemesis_deaths: 50 };
const LEADING_EMOJI = /^[\p{Extended_Pictographic}️‍\s]+/u;

function stripEmoji(text) {
  return String(text ?? "").replace(LEADING_EMOJI, "").trim();
}

function packTone(kind) {
  if (KILL_KINDS.has(kind)) return { icon: Sparkles, className: "bg-cs2-emerald-surface text-cs2-emerald-on-surface" };
  if (DEATH_KINDS.has(kind)) return { icon: Skull, className: "bg-cs2-rose-surface text-cs2-rose-on-surface" };
  return { icon: Layers, className: "bg-cs2-amber-surface text-cs2-amber-on-surface" };
}

/**
 * Full-match compilations as cards with an explicit "add to queue" action.
 * The round compilation opens its round picker first.
 */
export default function CompilationPacks({
  clips,
  locale,
  queuedClientClipUids,
  onAdd,
  onRemove,
  freezeToDeathDraft = { picked: [] },
  onFreezeToDeathDraftChange,
  matchTotalRounds = 24,
  disabled = false,
}) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const packs = [...clips].sort(
    (a, b) => (PACK_ORDER[a.compilation_kind] ?? 60) - (PACK_ORDER[b.compilation_kind] ?? 60),
  );
  if (!packs.length) return null;
  const picked = freezeToDeathDraft?.picked ?? [];
  const roundClip = packs.find((clip) => isFreezeToDeathCompilation(clip));
  const roundQueued = Boolean(roundClip && queuedClientClipUids?.has(roundClip.client_clip_uid));

  return (
    <section aria-labelledby="analysis-packs-title" data-testid="analysis-compilation-packs">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="analysis-packs-title" className="text-[13px] font-semibold text-cs2-text-primary">{t("analysis.packsTitle")}</h3>
        <span className="text-xs text-cs2-text-muted">{t("analysis.packsDesc")}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
        {packs.map((clip) => {
          const uid = clip.client_clip_uid;
          const queued = Boolean(uid && queuedClientClipUids?.has(uid));
          const tone = packTone(clip.compilation_kind);
          const isRounds = isFreezeToDeathCompilation(clip);
          const title = stripEmoji(labelTag(clip.context_tags?.[0], locale)) || t("analysis.packFallbackTitle");
          const subtitle = isRounds
            ? t("analysis.packRoundsDesc")
            : stripEmoji(labelTag(clip.context_tags?.[1], locale))
              || t("clip.segments", { n: Array.isArray(clip.source_ticks) ? clip.source_ticks.length : 0 });
          return (
            <QueueActionCard key={uid || clip.clip_id} category="compilation" icon={tone.icon} tone={tone.className} title={title} subtitle={subtitle}>
              {isRounds && !queued ? (
                <button
                  type="button"
                  aria-expanded={pickerOpen}
                  disabled={disabled}
                  onClick={() => setPickerOpen((open) => !open)}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-cs2-accent/60 text-xs font-semibold text-cs2-accent transition-colors hover:bg-cs2-accent-soft disabled:opacity-45"
                >
                  {t(pickerOpen ? "analysis.packRoundsClose" : "analysis.packRoundsOpen")}
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? "rotate-180" : ""}`} aria-hidden />
                </button>
              ) : (
                <QueueAddButton
                  queued={queued}
                  disabled={disabled}
                  onAdd={uid ? () => onAdd?.(uid) : undefined}
                  onRemove={uid && onRemove ? () => onRemove(uid) : undefined}
                />
              )}
            </QueueActionCard>
          );
        })}
      </div>

      {roundClip && pickerOpen && !roundQueued ? (
        <div className="mt-2 rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card p-3" data-testid="analysis-round-picker">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] font-semibold text-cs2-text-primary">{t("analysis.packRoundsPickTitle")}</p>
            <p className="text-xs text-cs2-text-muted">{t("analysis.packRoundsPickDesc")}</p>
          </div>
          <RoundMontageRoundPicker
            maxRounds={matchTotalRounds}
            picked={picked}
            disabled={disabled}
            onChange={(next) => onFreezeToDeathDraftChange?.(next)}
          />
          <div className="mt-3">
            <QueueAddButton
              solid
              disabled={disabled || picked.length === 0}
              label={t("analysis.packRoundsAdd", { n: picked.length })}
              onAdd={() => {
                onAdd?.(roundClip.client_clip_uid);
                setPickerOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
