import { useEffect, useMemo, useState } from "react";
import { Crosshair, Plus, X } from "lucide-react";
import KillfeedEventRow from "./timeline/KillfeedEventRow";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { buildTimelineEventClipData } from "../../utils/timelineQueue.js";
import {
  buildWeaponKillCompilationClipData,
  groupTimelineKillsByWeapon,
} from "../../utils/weaponKillCompilations.js";

/**
 * Group timeline kills by weapon and enqueue each weapon as one compilation.
 */
export default function WeaponKillsView({
  roundTimeline,
  focusedPlayer = "",
  demoFilename = "",
  mapName = "",
  queuedClientClipUids,
  onAdd,
  onRemove,
  onAddEvent,
  onRemoveEvent,
  suppressSummaryHeader = false,
}) {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const [activeWeaponKey, setActiveWeaponKey] = useState("");
  const groups = useMemo(
    () => groupTimelineKillsByWeapon(roundTimeline, locale),
    [roundTimeline, locale],
  );
  const clips = useMemo(
    () => groups.map((group) => ({
      group,
      clipData: buildWeaponKillCompilationClipData({
        events: group.events,
        weaponKey: group.weaponKey,
        weaponName: group.weaponName,
        mapName,
        targetPlayer: focusedPlayer,
        demoFilename,
        t,
        locale,
      }),
      eventItems: group.events.map((event) => ({
        event,
        clipData: buildTimelineEventClipData({
          event,
          mapName,
          targetPlayer: focusedPlayer,
          round: event?.round,
          t,
          locale,
        }),
      })),
    })).filter((item) => item.clipData),
    [groups, mapName, focusedPlayer, demoFilename, t, locale],
  );
  const totalKills = groups.reduce((sum, group) => sum + group.killCount, 0);
  const resolvedWeaponKey = clips.some((item) => item.group.weaponKey === activeWeaponKey)
    ? activeWeaponKey
    : clips[0]?.group.weaponKey || "";
  const activeClip = clips.find((item) => item.group.weaponKey === resolvedWeaponKey) || null;

  useEffect(() => {
    setActiveWeaponKey("");
  }, [focusedPlayer, demoFilename]);

  return (
    <div className="space-y-4">
      {!suppressSummaryHeader && (
        <div className="flex flex-wrap items-center gap-2">
          <Crosshair className="h-4 w-4 text-cs2-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wide">{t("weaponKills.title")}</h2>
          <span className="ml-auto text-[12px] font-mono text-cs2-text-secondary">
            {t("weaponKills.summary", { weapons: groups.length, kills: totalKills })}
          </span>
        </div>
      )}

      {clips.length ? (
        <>
          <div
            role="tablist"
            aria-label={t("weaponKills.title")}
            className="overflow-x-auto rounded-xl border border-cs2-border bg-cs2-bg-card p-1.5"
          >
            <div className="flex min-w-max items-center gap-1.5">
              {clips.map(({ group, clipData }) => {
                const active = group.weaponKey === resolvedWeaponKey;
                const queued = Boolean(queuedClientClipUids?.has(clipData.client_clip_uid));
                return (
                  <button
                    key={group.weaponKey}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveWeaponKey(group.weaponKey)}
                    className={[
                      "inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[12px] font-bold transition-colors",
                      active
                        ? "border-cs2-accent bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                        : "border-transparent bg-cs2-bg-hover text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary",
                    ].join(" ")}
                  >
                    <span>{group.weaponName}</span>
                    <span
                      className={[
                        "rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                        active
                          ? "bg-cs2-bg-card/30 text-cs2-text-on-accent"
                          : "bg-cs2-bg-active text-cs2-emerald-on-surface",
                      ].join(" ")}
                    >
                      {group.killCount}
                    </span>
                    {queued ? (
                      <span
                        className={active ? "h-1.5 w-1.5 rounded-full bg-cs2-text-on-accent" : "h-1.5 w-1.5 rounded-full bg-cs2-accent"}
                        title={t("weaponKills.queued")}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid items-start gap-5">
            {[activeClip].filter(Boolean).map(({ group, clipData, eventItems }) => {
              const queued = Boolean(queuedClientClipUids?.has(clipData.client_clip_uid));
              const victims = [...new Set(
                group.events.map((event) => String(event?.victim_name || "").trim()).filter(Boolean),
              )];
              return (
                <article
                  key={group.weaponKey}
                  className="overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm"
                >
                  <div className="flex items-start gap-3.5 border-b border-cs2-border px-5 py-4">
                    <div className="mt-0.5 rounded-lg border border-cs2-accent/30 bg-cs2-accent/10 p-2 text-cs2-accent">
                      <Crosshair className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-bold text-cs2-text-primary">{group.weaponName}</h3>
                        <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cs2-emerald-on-surface">
                          {t("weaponKills.killBadge", { n: group.killCount })}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-cs2-text-muted">
                        {t("weaponKills.groupMeta", { rounds: group.roundCount, victims: victims.length })}
                      </p>
                    </div>
                    {queued && onRemove ? (
                      <button
                        type="button"
                        onClick={() => onRemove?.(clipData.client_clip_uid)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cs2-accent/40 px-2.5 py-1.5 text-[11px] font-semibold text-cs2-accent transition-colors hover:border-rose-400/55 hover:text-rose-400"
                      >
                        {t("weaponKills.queued")}
                        <X className="h-3 w-3" />
                      </button>
                    ) : queued ? (
                      <span className="inline-flex shrink-0 items-center rounded-md border border-cs2-accent/40 px-2.5 py-1.5 text-[11px] font-semibold text-cs2-accent">
                        {t("weaponKills.queued")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onAdd?.(clipData)}
                        disabled={!onAdd}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-cs2-accent px-2.5 py-1.5 text-[11px] font-bold text-cs2-text-on-accent transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
                      >
                        <Plus className="h-3 w-3" />
                        {t("weaponKills.addGroup")}
                      </button>
                    )}
                  </div>

                  <div className="px-4 py-4">
                    <p className="mb-3 text-[12px] font-semibold text-cs2-text-secondary">
                      {t("weaponKills.singleKillHint")}
                    </p>
                    <div className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1.5">
                      {eventItems.map(({ event, clipData: eventClipData }) => {
                        const eventQueued = Boolean(
                          queuedClientClipUids?.has(eventClipData.client_clip_uid),
                        );
                        const roundRow = {
                          round: Number(event?.round) || 0,
                          round_number: Number(event?.round) || 0,
                        };
                        return (
                          <KillfeedEventRow
                            key={String(event?.id || `${event?.round}-${event?.tick}`)}
                            event={event}
                            focusedPlayer={focusedPlayer}
                            roundNumber={Number(event?.round)}
                            queued={eventQueued}
                            showAddAction
                            spacious
                            onRowClick={
                              !eventQueued && onAddEvent
                                ? () => onAddEvent(event, roundRow)
                                : undefined
                            }
                            onRowRemove={
                              eventQueued && onRemoveEvent
                                ? () => onRemoveEvent(event, roundRow)
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-cs2-border py-12 text-center text-[13px] text-cs2-text-muted">
          {t("weaponKills.empty")}
        </div>
      )}
    </div>
  );
}
