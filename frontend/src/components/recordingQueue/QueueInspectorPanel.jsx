import { Monitor, ScanSearch, Settings, Eye } from "lucide-react";
import {
  PacingMicroPanel,
  PovSection,
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
    <div className="overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-input/30">
      <div className="flex items-center gap-1.5 border-b border-cs2-border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
        {Icon ? <Icon className="h-3 w-3 text-cs2-text-muted" /> : null}
        <span>{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function InspectorHeader({ title }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-cs2-border px-3 py-2">
      <ScanSearch className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted" />
      <h2 className="text-[11px] font-semibold leading-4 text-cs2-text-primary">{title}</h2>
    </div>
  );
}

/**
 * @param {{
 *   selectedId: string | null,
 *   selectedItem: import("../../stores/recordingQueueStore").RecordingQueueItem | null,
 * }} props
 */
export default function QueueInspectorPanel({ selectedId: _selectedId, selectedItem }) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const updateItemPacing = useRecordingQueue((s) => s.updateItemPacing);

  if (!selectedItem) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <InspectorHeader title={t("queue.inspectorTitle")} />
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
      <InspectorHeader title={t("queue.inspectorTitle")} />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {/* 片段摘要卡 */}
        <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 p-3">
          <div className="flex min-w-0 items-center gap-2">
            {killBadge ? (
              <span
                className={`inline-flex h-6 min-w-[42px] max-w-[72px] shrink-0 items-center justify-center truncate rounded-md border px-2 text-[10px] font-semibold leading-none ${killBadgeColorClass(cd)}`}
                title={killBadge}
              >
                {killBadge}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold leading-6 text-cs2-text-primary">
              {playerName}
            </span>
            <div className="ml-auto shrink-0">
              {hideQueueAi ? null : <AiScoreBadge score={aiScore} />}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {hasScorePair ? (
                <>
                  <span className="rounded bg-cs2-cyan-surface px-1.5 py-px font-mono text-[11px] font-semibold text-cs2-cyan-on-surface">
                    CT {own}
                  </span>
                  <span className="rounded bg-cs2-amber-surface px-1.5 py-px font-mono text-[11px] font-semibold text-cs2-amber-on-surface">
                    T {opp}
                  </span>
                </>
              ) : null}
              {isFreezeToDeathCompilation(cd) && ftdRoundBadge ? (
                <span className="rounded border border-cs2-border bg-cs2-bg-hover px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
                  {ftdRoundBadge}
                </span>
              ) : round != null ? (
                <span className="rounded border border-cs2-border bg-cs2-bg-hover px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
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
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {weaponPrimary ? (
                <span className="rounded border border-cs2-border bg-cs2-bg-hover px-1.5 py-px font-mono text-[11px] text-cs2-text-secondary">
                  {weaponPrimary}
                </span>
              ) : null}
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded border border-cs2-border bg-cs2-bg-hover px-1.5 py-px text-[11px] text-cs2-text-secondary"
                >
                  {labelTag(tag, locale)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Stat 卡 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-2 py-1.5">
            <p className="text-[11px] text-cs2-text-muted">{t("queue.statEstDuration")}</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cs2-accent">
              {Number.isFinite(estSec) ? `${Number(estSec).toFixed(0)}s` : "—"}
            </p>
          </div>
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-2 py-1.5">
            <p className="text-[11px] text-cs2-text-muted">{t("queue.statPlaybackViews")}</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cs2-cyan-on-surface">
              {victimsCount}
            </p>
          </div>
        </div>

        {/* 节奏面板 */}
        <FieldGroup icon={Settings} title={t("queue.fieldPacing")}>
          {isClipPacingAndPovLocked(cd) ? (
            <p className="rounded-lg border border-amber-500/20 bg-cs2-amber-surface px-2 py-1.5 text-[11px] text-cs2-amber-on-surface">
              {isRoundTimelineRoundClip(cd)
                ? t("queue.pacingLockedTimeline")
                : t("queue.pacingLockedCompilation")}
            </p>
          ) : (
            <PacingMicroPanel
              embedded
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
