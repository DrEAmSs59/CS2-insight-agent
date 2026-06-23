import { Monitor, Settings, Eye } from "lucide-react";
import {
  PacingMicroPanel,
  PovSection,
  GlobalPacingPanel,
  killBadgeColorClass,
} from "../RecordingQueueDrawer";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore";
import { labelTag } from "../../utils/tagDescriptions";
import { weaponUsedTokens } from "../../i18n/weaponNames.js";
import { AiScoreBadge } from "../ClipCard";
import {
  getMontageBlockShortLabel,
  blockShortLabelI18nKey,
  isClipPacingAndPovLocked,
  isRoundTimelineRoundClip,
  isTimelineSourceClip,
} from "../../utils/montageUtils";
import {
  freezeToDeathQueueRoundBadgeText,
  isFreezeToDeathCompilation,
} from "../../utils/freezeToDeathRoundFilter";
import { estimateItemRecordSeconds } from "../../utils/recordingQueueDerive";

function FieldGroup({ icon: Icon, title, children }) {
  return (
    <div className="overflow-hidden rounded border border-cs2-border bg-cs2-bg-input/30">
      <div className="flex items-center gap-1.5 border-b border-cs2-border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
        {Icon ? <Icon className="h-3 w-3 text-cs2-text-muted" /> : null}
        <span>{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

/**
 * @param {{
 *   selectedId: string | null,
 *   selectedItem: import("../../stores/recordingQueueStore").RecordingQueueItem | null,
 *   queue: import("../../stores/recordingQueueStore").RecordingQueueItem[],
 * }} props
 */
export default function QueueInspectorPanel({ selectedId: _selectedId, selectedItem, queue }) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const updateItemPacing = useRecordingQueue((s) => s.updateItemPacing);
  const toggleVictimPov = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPov = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);

  const globalPanel = (
    <GlobalPacingPanel
      globalPacing={globalPacing}
      setGlobalPacing={setGlobalPacing}
      resetGlobalPacing={resetGlobalPacing}
      queue={queue}
      onToggleAllVictimPov={toggleVictimPov}
      onToggleAllKillerPov={toggleKillerPov}
    />
  );

  if (!selectedItem) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="shrink-0">{globalPanel}</div>
        <div className="shrink-0 border-b border-cs2-border px-2 py-1.5">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-cs2-text-muted">{t("queue.inspectorTitle")}</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
          <Monitor className="mb-2 h-8 w-8 text-cs2-text-muted" />
          <p className="text-[12px] font-semibold text-cs2-text-secondary">{t("queue.inspectorSelectPrompt")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
            {t("queue.inspectorSelectHint")}
          </p>
        </div>
      </div>
    );
  }

  const cd = selectedItem.clipData || {};
  const hideQueueAi = isTimelineSourceClip(cd) || cd.category === "compilation";
  const killBadge = t(blockShortLabelI18nKey(getMontageBlockShortLabel(cd)));
  const playerName = String(selectedItem.targetPlayer || cd.player_name || "—").trim() || "—";
  const round = cd.round != null && Number.isFinite(Number(cd.round)) ? Number(cd.round) : null;
  const ftdRoundBadge = freezeToDeathQueueRoundBadgeText(selectedItem, cd, t);
  const own = cd.score_own != null ? Number(cd.score_own) : null;
  const opp = cd.score_opp != null ? Number(cd.score_opp) : null;
  const hasScorePair = own != null && opp != null && Number.isFinite(own) && Number.isFinite(opp);
  const mapName = String(cd.map_name || cd.map || "").trim();
  const aiScore = cd.ai_score;
  const weaponPrimary = weaponUsedTokens(cd.weapon_used, locale)[0];
  const tags = Array.isArray(cd.context_tags) ? cd.context_tags.slice(0, 5) : [];
  const estSec = estimateItemRecordSeconds(selectedItem, globalPacing);
  const victimsCount = Array.isArray(cd.victims) ? cd.victims.length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0">{globalPanel}</div>

      <div className="shrink-0 border-b border-cs2-border px-2 py-1.5">
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-cs2-text-muted">{t("queue.inspectorTitle")}</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {/* 片段摘要卡 */}
        <div className="flex items-start gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input/40 p-3">
          {killBadge ? (
            <div
              className={`flex h-12 w-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded-md border text-[10px] font-bold leading-tight ${killBadgeColorClass(cd)}`}
              title={killBadge}
            >
              <span className="break-all text-center">{killBadge}</span>
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-cs2-text-primary">
                {playerName}
              </span>
              <div className="ml-auto shrink-0">
                {hideQueueAi ? null : <AiScoreBadge score={aiScore} />}
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {hasScorePair ? (
                <>
                  <span className="rounded bg-sky-500/15 px-1.5 py-px font-mono text-[11px] font-semibold text-sky-200">
                    CT {own}
                  </span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-px font-mono text-[11px] font-semibold text-cs2-amber-on-surface">
                    T {opp}
                  </span>
                </>
              ) : null}
              {isFreezeToDeathCompilation(cd) && ftdRoundBadge ? (
                <span className="rounded border border-cs2-border bg-cs2-bg-input/50 px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
                  {ftdRoundBadge}
                </span>
              ) : round != null ? (
                <span className="rounded border border-cs2-border bg-cs2-bg-input/50 px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
                  R{round}
                </span>
              ) : null}
              {mapName ? (
                <span className="truncate text-[11px] text-cs2-text-muted" title={mapName}>
                  {mapName}
                </span>
              ) : null}
            </div>
            {(weaponPrimary || tags.length > 0) && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {weaponPrimary ? (
                  <span className="rounded border border-cs2-border bg-zinc-800/60 px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
                    {weaponPrimary}
                  </span>
                ) : null}
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded border border-cs2-border bg-zinc-800/40 px-1.5 py-px text-[11px] text-cs2-text-secondary"
                  >
                    {labelTag(tag, locale)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stat 卡 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-cs2-border bg-cs2-bg-input/40 px-2 py-1.5">
            <p className="text-[11px] text-cs2-text-muted">{t("queue.statEstDuration")}</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cs2-accent">
              {Number.isFinite(estSec) ? `${Number(estSec).toFixed(0)}s` : "—"}
            </p>
          </div>
          <div className="rounded border border-cs2-border bg-cs2-bg-input/40 px-2 py-1.5">
            <p className="text-[11px] text-cs2-text-muted">{t("queue.statPlaybackViews")}</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cyan-300">
              {victimsCount}
            </p>
          </div>
        </div>

        {/* 节奏面板 */}
        <FieldGroup icon={Settings} title={t("queue.fieldPacing")}>
          {isClipPacingAndPovLocked(cd) ? (
            <p className="rounded border border-amber-500/20 bg-cs2-amber-surface px-2 py-1.5 text-[11px] text-cs2-amber-on-surface">
              {isRoundTimelineRoundClip(cd)
                ? t("queue.pacingLockedTimeline")
                : t("queue.pacingLockedCompilation")}
            </p>
          ) : (
            <PacingMicroPanel
              item={selectedItem}
              updateItemPacing={updateItemPacing}
            />
          )}
        </FieldGroup>

        {/* POV panel */}
        <FieldGroup icon={Eye} title={t("queue.fieldPov")}>
          <PovSection item={selectedItem} updateItemPacing={updateItemPacing} />
        </FieldGroup>
      </div>
    </div>
  );
}
