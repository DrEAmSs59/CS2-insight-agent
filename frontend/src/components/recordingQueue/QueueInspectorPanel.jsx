import { AlertTriangle, ChevronDown, ChevronUp, Info, Monitor, Trash2 } from "lucide-react";
import { BACKEND_DEFAULT_PACING, useRecordingQueue } from "../../stores/recordingQueueStore";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore";
import { weaponUsedTokens } from "../../i18n/weaponNames.js";
import { AiScoreBadge } from "../ClipCard";
import {
  friendlyClipTitleForQueue,
  isRoundTimelineRoundClip,
  isTimelineSourceClip,
} from "../../utils/montageUtils";
import {
  freezeToDeathQueueRoundBadgeText,
  isFreezeToDeathCompilation,
} from "../../utils/freezeToDeathRoundFilter";
import { estimateItemRecordSeconds } from "../../utils/recordingQueueDerive";
import { queueItemPovCapabilities } from "../../utils/queueItemPov";
import { useRoundCompilationPlan } from "../../recording/useRoundCompilationPlans";
import { MAX_RECORDING_MERGE_GAP_SECONDS } from "../../utils/recordingPacing.js";
import RoundCompilationTiming from "./RoundCompilationTiming";
import QueuePlanStrip from "./QueuePlanStrip";
import {
  Chip,
  NumberInput,
  Segmented,
  SettingsBadge,
  SettingsButton,
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  Switch,
} from "../../pages/settings/SettingsControls.jsx";

const PACE_FIELDS = [
  { key: "pre_first_sec", labelKey: "settings.presetPreLabel", descKey: "settings.presetPreDesc", min: 0, max: 20, step: 0.1 },
  { key: "post_last_sec", labelKey: "settings.presetPostLabel", descKey: "settings.presetPostDesc", min: 0, max: 10, step: 0.1 },
  { key: "max_gap_sec", labelKey: "settings.presetGapLabel", descKey: "settings.presetGapDesc", min: 2, max: MAX_RECORDING_MERGE_GAP_SECONDS, step: 0.5 },
];

const MAX_NAME_CHIPS = 8;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Category key and badge tone shared by the queue row and the editor header. */
export function queueItemCategory(clip) {
  if (isTimelineSourceClip(clip)) return { key: "queue.rowCatTimeline", tone: "cyan" };
  switch (clip?.category) {
    case "highlight": return { key: "queue.rowCatHighlight", tone: "emerald" };
    case "fail": return { key: "queue.rowCatFail", tone: "rose" };
    case "meme_death": return { key: "queue.rowCatMemeDeath", tone: "neutral" };
    case "compilation": return { key: "queue.rowCatCompilation", tone: "amber" };
    default: return { key: "queue.rowCatDefault", tone: "neutral" };
  }
}

/** "第 12 回合 · 7:5" style label; round compilations list their picked rounds. */
export function queueItemRoundLabel(item, clip, t) {
  if (isFreezeToDeathCompilation(clip)) return freezeToDeathQueueRoundBadgeText(item, clip, t) || "";
  if (clip?.round == null) return "";
  const round = t("queue.roundLabel", { n: clip.round });
  return clip.score_own != null && clip.score_opp != null ? `${round} · ${clip.score_own}:${clip.score_opp}` : round;
}

/** True when the item overrides any of the clip pacing values. */
export function queueItemHasPacingOverride(item) {
  const po = item?.pacing_override || {};
  return PACE_FIELDS.some((field) => finite(po[field.key]) !== undefined);
}

function NameChips({ names, tone }) {
  const shown = names.slice(0, MAX_NAME_CHIPS);
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {shown.map((name, index) => (
        <span
          key={`${name}-${index}`}
          className={`inline-flex h-6 items-center rounded-[5px] px-2 text-xs font-medium ${
            tone === "killer" ? "bg-cs2-amber-surface text-cs2-amber-on-surface" : "bg-cs2-cyan-surface text-cs2-cyan-on-surface"
          }`}
        >
          {name}
        </span>
      ))}
      {names.length > shown.length ? <Chip>+{names.length - shown.length}</Chip> : null}
    </span>
  );
}

/**
 * Editor for the selected queue item: preview of the recording order, pacing
 * that can be overridden per clip, and replay (POV) choices.
 *
 * @param {{
 *   selectedItem: import("../../stores/recordingQueueStore").RecordingQueueItem | null,
 *   onPrev?: () => void,
 *   onNext?: () => void,
 *   onRemove?: () => void,
 *   hasPrev?: boolean,
 *   hasNext?: boolean,
 *   disabled?: boolean,
 * }} props
 */
export default function QueueInspectorPanel({
  selectedItem,
  onPrev,
  onNext,
  onRemove,
  hasPrev = false,
  hasNext = false,
  disabled = false,
}) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const updateItemPacing = useRecordingQueue((s) => s.updateItemPacing);
  const clearItemPacingKeys = useRecordingQueue((s) => s.clearItemPacingKeys);
  const roundPlan = useRoundCompilationPlan(selectedItem);

  if (!selectedItem) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
        <Monitor className="mb-2 h-8 w-8 text-cs2-text-muted" aria-hidden />
        <p className="text-[13px] font-semibold text-cs2-text-secondary">{t("queue.inspectorSelectPrompt")}</p>
        <p className="mt-1 text-xs text-cs2-text-muted">{t("queue.inspectorSelectHint")}</p>
      </div>
    );
  }

  const item = selectedItem;
  const clip = item.clipData || {};
  const po = item.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const gp = globalPacing || {};
  const category = queueItemCategory(clip);
  const playerName = String(item.targetPlayer || clip.player_name || "").trim();
  const mapName = String(clip.map_name || clip.map || "").trim();
  const weapon = weaponUsedTokens(clip.weapon_used, locale)[0];
  const meta = [playerName, mapName, queueItemRoundLabel(item, clip, t), weapon].filter(Boolean).join(" · ");
  const hideAi = isTimelineSourceClip(clip) || clip.category === "compilation";
  const estSec = estimateItemRecordSeconds(item, gp, roundPlan);
  const roundCompilation = isFreezeToDeathCompilation(clip);
  const wholeRound = isRoundTimelineRoundClip(clip);
  const pov = queueItemPovCapabilities(clip);
  const commit = (partial) => updateItemPacing(item.id, partial);

  const victimOn = pov.canVictimPov && Boolean(po.victim_pov);
  const killerOn = pov.canKillerPov && Boolean(po.killer_pov);
  const vicPre = finite(po.victim_pov_pre_sec) ?? finite(gp.victim_pov_pre_sec) ?? 1.5;
  const vicPost = finite(po.victim_pov_post_sec) ?? finite(gp.victim_pov_post_sec) ?? 1.5;
  const killPre = finite(po.killer_pov_pre_sec) ?? finite(gp.killer_pov_pre_sec) ?? vicPre;
  const killPost = finite(po.killer_pov_post_sec) ?? finite(gp.killer_pov_post_sec) ?? vicPost;
  const killerDesc = pov.canKillerPov
    ? pov.isDeathCompilation
      ? t("queue.killerPovRowDescDeaths")
      : t("queue.killerPovRowDesc", { name: pov.killers[0] })
    : pov.noKillerSource
      ? t("queue.noKillerPovReason")
      : t("queue.killerPovRowUnavailable");

  const timingRow = (deaths) => (
    <SettingsRow indent label={t("queue.povTimingLabel")} description={t(po.pov_interleaved ? "queue.povTimingEachDesc" : "queue.povTimingBatchDesc")}>
      <Segmented
        ariaLabel={t("queue.povTimingLabel")}
        value={Boolean(po.pov_interleaved)}
        disabled={disabled}
        onChange={(value) => commit({ pov_interleaved: value })}
        options={[
          { value: true, label: t(deaths ? "queue.povTimingEachDeath" : "queue.povTimingEachKill") },
          { value: false, label: t(deaths ? "queue.povTimingAfterDeaths" : "queue.povTimingAfterKills") },
        ]}
      />
    </SettingsRow>
  );

  const holdRow = (preKey, postKey, pre, post, preLabelKey, postLabelKey) => (
    <SettingsRow indent label={t("settings.presetHoldLabel")} description={t("queue.povHoldDesc")}>
      <NumberInput
        key={`${item.id}:${preKey}`}
        ariaLabel={t(preLabelKey)}
        min={0}
        max={5}
        step={0.1}
        unit={t("settings.unitSeconds")}
        value={pre}
        defaultValue={finite(gp[preKey]) ?? (preKey === "killer_pov_pre_sec" ? vicPre : 1.5)}
        disabled={disabled}
        onChange={(n) => typeof n === "number" && commit({ [preKey]: clamp(n, 0, 5) })}
      />
      <NumberInput
        key={`${item.id}:${postKey}`}
        ariaLabel={t(postLabelKey)}
        min={0}
        max={5}
        step={0.1}
        unit={t("settings.unitSeconds")}
        value={post}
        defaultValue={finite(gp[postKey]) ?? (postKey === "killer_pov_post_sec" ? vicPost : 1.5)}
        disabled={disabled}
        onChange={(n) => typeof n === "number" && commit({ [postKey]: clamp(n, 0, 5) })}
      />
    </SettingsRow>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="queue-task-editor">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-cs2-border-subtle px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-bold text-cs2-text-primary">
            <SettingsBadge tone={category.tone}>{t(category.key)}</SettingsBadge>
            <span className="min-w-0 break-words">{friendlyClipTitleForQueue(clip, t)}</span>
          </h2>
          {meta ? <p className="mt-1 text-xs text-cs2-text-muted">{meta}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hideAi ? null : <AiScoreBadge score={clip.ai_score} />}
          <SettingsButton iconOnly icon={ChevronUp} aria-label={t("queue.editorPrev")} title={t("queue.editorPrev")} disabled={!hasPrev} onClick={onPrev} />
          <SettingsButton iconOnly icon={ChevronDown} aria-label={t("queue.editorNext")} title={t("queue.editorNext")} disabled={!hasNext} onClick={onNext} />
          <SettingsButton variant="danger" icon={Trash2} disabled={disabled} onClick={onRemove}>
            {t("queue.editorRemove")}
          </SettingsButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5" style={{ scrollbarGutter: "stable" }}>
        {item.demoHasPlayerKeyboardInput === false ? (
          <div className="mb-7 overflow-hidden rounded-[10px] border border-cs2-border-subtle" data-testid="queue-input-hud-warning-detail">
            <SettingsNote tone="amber" icon={AlertTriangle}>
              <p className="font-semibold">{t("queue.inputHudMissingTitle")}</p>
              <p>{t("queue.inputHudMissingBody")} · {t("queue.inputHudMissingHint")}</p>
            </SettingsNote>
          </div>
        ) : null}

        <SettingsGroup title={t("queue.editorPreviewTitle")} description={t("queue.editorPreviewDesc")} padded={false} bodyClassName="overflow-hidden rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card">
          <QueuePlanStrip item={item} globalPacing={gp} roundPlan={roundPlan} estimateSec={estSec} />
        </SettingsGroup>

        {roundCompilation ? (
          <SettingsGroup title={t("queue.editorRoundPacingTitle")} description={t("queue.editorRoundPacingDesc")} padded>
            <RoundCompilationTiming item={item} updateItemPacing={updateItemPacing} />
          </SettingsGroup>
        ) : wholeRound ? null : (
          <SettingsGroup title={t("queue.editorPacingTitle")} description={t("queue.editorPacingDesc")}>
            {PACE_FIELDS.map((field) => {
              const own = finite(po[field.key]);
              const fallback = finite(gp[field.key]) ?? BACKEND_DEFAULT_PACING[field.key];
              const edited = own !== undefined;
              return (
                <SettingsRow key={field.key} label={t(field.labelKey)} description={t(field.descKey)}>
                  <span className={`whitespace-nowrap text-[11px] ${edited ? "text-cs2-accent" : "text-cs2-text-muted"}`}>
                    {edited ? t("queue.paceEdited", { value: fallback }) : t("queue.paceInherited")}
                  </span>
                  {edited ? (
                    <SettingsButton variant="ghost" disabled={disabled} onClick={() => clearItemPacingKeys(item.id, [field.key])}>
                      {t("queue.paceReset")}
                    </SettingsButton>
                  ) : null}
                  <NumberInput
                    key={`${item.id}:${field.key}`}
                    clampOnBlur
                    ariaLabel={t(field.labelKey)}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    unit={t("settings.unitSeconds")}
                    value={own ?? fallback}
                    defaultValue={fallback}
                    disabled={disabled}
                    onChange={(n) => {
                      if (typeof n === "number" && Number.isFinite(n)) commit({ [field.key]: clamp(n, field.min, field.max) });
                    }}
                  />
                </SettingsRow>
              );
            })}
          </SettingsGroup>
        )}

        <SettingsGroup title={t("queue.editorPovTitle")} description={t("queue.editorPovDesc")} testId="queue-editor-pov">
          {pov.locked ? (
            <SettingsNote icon={Info}>
              {t(wholeRound ? "queue.povLockedWholeRound" : "queue.povLockedRounds")}
            </SettingsNote>
          ) : (
            <>
              <SettingsRow
                label={t("queue.victimPovRow")}
                description={pov.canVictimPov ? t("queue.victimPovRowDesc") : t("queue.victimPovRowUnavailable")}
                disabled={!pov.canVictimPov}
              >
                <Switch
                  ariaLabel={t("queue.victimPovRow")}
                  checked={victimOn}
                  disabled={disabled || !pov.canVictimPov}
                  onChange={(on) => commit({ victim_pov: on })}
                />
              </SettingsRow>
              {victimOn ? (
                <>
                  <SettingsRow indent label={t("queue.povVictimsLabel")}>
                    <NameChips names={pov.victims} tone="victim" />
                  </SettingsRow>
                  {timingRow(false)}
                  {holdRow("victim_pov_pre_sec", "victim_pov_post_sec", vicPre, vicPost, "queue.victimHoldBefore", "queue.victimHoldAfter")}
                </>
              ) : null}

              <SettingsRow label={t("queue.killerPovRow")} description={killerDesc} disabled={!pov.canKillerPov}>
                <Switch
                  ariaLabel={t("queue.killerPovRow")}
                  checked={killerOn}
                  disabled={disabled || !pov.canKillerPov}
                  onChange={(on) => commit({ killer_pov: on })}
                />
              </SettingsRow>
              {killerOn ? (
                <>
                  <SettingsRow indent label={t("queue.povKillersLabel")}>
                    <NameChips names={pov.killers} tone="killer" />
                  </SettingsRow>
                  {pov.isDeathCompilation ? timingRow(true) : null}
                  {holdRow("killer_pov_pre_sec", "killer_pov_post_sec", killPre, killPost, "queue.killerHoldBefore", "queue.killerHoldAfter")}
                </>
              ) : null}
            </>
          )}
        </SettingsGroup>
      </div>
    </div>
  );
}
