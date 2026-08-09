import { useCallback, useEffect, useMemo } from "react";

import {
  isFreezeToDeathCompilation,
  sliceFreezeToDeathClipForEnqueue,
} from "../../utils/freezeToDeathRoundFilter";
import { getPlayerClipScope } from "../../utils/playerClipScope";
import { queueItemClientUid } from "../../utils/recordingBatch";
import { buildTimelineEventClipData, buildTimelineRoundClipData } from "../../utils/timelineQueue";

/**
 * Converts analyzed clips into recording-queue items.
 *
 * This controller deliberately has no parsing, recording execution, OBS, or LiteCut state.
 * It owns only selection and queue-item construction at the Analysis -> Recording boundary.
 */
export function useClipQueueActions({
  t,
  locale,
  setProgressText,
  queue,
  addToQueue,
  removeByClientClipUid,
  uploadedDemos,
  parsedMatches,
  currentMatchIndex,
  currentParsed,
  currentActivePlayer,
  matchMeta,
  activePlayerTabs,
  selectedPlayers,
  clips,
  freezeToDeathDraft,
  selectedClientClipUids,
  setSelectedClientClipUids,
  currentDemoFilename,
}) {
  const queuedClientClipUidsForCurrentDemo = useMemo(() => {
    if (!currentDemoFilename) return new Set();
    const uids = new Set();
    for (const item of queue) {
      if (item.demoFilename !== currentDemoFilename) continue;
      uids.add(queueItemClientUid(item));
      if (item.sourceClientClipUid) uids.add(item.sourceClientClipUid);
    }
    return uids;
  }, [currentDemoFilename, queue]);

  const queuedClientClipUidsGlobal = useMemo(
    () => new Set(queue.map((item) => queueItemClientUid(item))),
    [queue],
  );

  useEffect(() => {
    setSelectedClientClipUids((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const uid of queuedClientClipUidsForCurrentDemo) {
        if (next.delete(uid)) changed = true;
      }
      return changed ? next : previous;
    });
  }, [queuedClientClipUidsForCurrentDemo, setSelectedClientClipUids]);

  const roundMontageCanEnqueue = (freezeToDeathDraft?.picked ?? []).length > 0;
  const regularSelectableTotal = useMemo(
    () => clips.filter((clip) => {
      if (clip.category === "meme_death" || !clip.client_clip_uid) return false;
      if (queuedClientClipUidsForCurrentDemo.has(clip.client_clip_uid)) return false;
      if (isFreezeToDeathCompilation(clip) && !roundMontageCanEnqueue) return false;
      return true;
    }).length,
    [clips, queuedClientClipUidsForCurrentDemo, roundMontageCanEnqueue],
  );
  const selectedRegularCount = useMemo(
    () => clips.filter((clip) => {
      if (clip.category === "meme_death" || !clip.client_clip_uid) return false;
      if (!selectedClientClipUids.has(clip.client_clip_uid)) return false;
      if (queuedClientClipUidsForCurrentDemo.has(clip.client_clip_uid)) return false;
      if (isFreezeToDeathCompilation(clip) && !roundMontageCanEnqueue) return false;
      return true;
    }).length,
    [
      clips,
      queuedClientClipUidsForCurrentDemo,
      roundMontageCanEnqueue,
      selectedClientClipUids,
    ],
  );

  const currentPlayerClipScope = useMemo(
    () => getPlayerClipScope(
      currentParsed?.players,
      currentActivePlayer,
      queuedClientClipUidsForCurrentDemo,
    ),
    [currentActivePlayer, currentParsed, queuedClientClipUidsForCurrentDemo],
  );
  const canAddCurrentPlayerHighlights = currentPlayerClipScope.queueableHighlights.length > 0;

  const queueItemMetaForPlayer = useCallback((index, playerName) => {
    const upload = uploadedDemos?.[index];
    const parsed = parsedMatches?.[index];
    const playerData = parsed?.players?.[playerName];
    const meta = playerData?.match_meta ?? upload?.match_meta ?? null;
    const steamId = meta?.target_steam_id != null && meta?.target_steam_id !== ""
      ? String(meta.target_steam_id)
      : null;
    return {
      demoFilename: parsed?.demo_filename ?? upload?.filename ?? "",
      demoPath: parsed?.demo_path ?? upload?.path ?? "",
      targetPlayer: meta?.target_player || playerName || null,
      targetPlayerUserId: meta?.target_player_user_id ?? null,
      targetSteamId: steamId,
    };
  }, [parsedMatches, uploadedDemos]);

  const queueItemMetaForIndex = useCallback((index) => {
    const activePlayer = activePlayerTabs[index]
      ?? Object.keys(parsedMatches?.[index]?.players ?? {})[0]
      ?? selectedPlayers[index]?.[0]
      ?? "";
    return queueItemMetaForPlayer(index, activePlayer);
  }, [activePlayerTabs, parsedMatches, queueItemMetaForPlayer, selectedPlayers]);

  const handleToggleClip = useCallback((clientClipUid) => {
    if (!clientClipUid || queuedClientClipUidsForCurrentDemo.has(clientClipUid)) return;
    const clip = clips.find((candidate) => candidate.client_clip_uid === clientClipUid);
    if (clip && isFreezeToDeathCompilation(clip) && !roundMontageCanEnqueue) return;
    setSelectedClientClipUids((previous) => {
      const next = new Set(previous);
      if (next.has(clientClipUid)) next.delete(clientClipUid);
      else next.add(clientClipUid);
      return next;
    });
  }, [
    clips,
    queuedClientClipUidsForCurrentDemo,
    roundMontageCanEnqueue,
    setSelectedClientClipUids,
  ]);

  const handleSelectAll = useCallback(() => {
    setSelectedClientClipUids((previous) => {
      const next = new Set(previous);
      clips
        .filter((clip) => {
          if (clip.category === "meme_death" || !clip.client_clip_uid) return false;
          if (queuedClientClipUidsForCurrentDemo.has(clip.client_clip_uid)) return false;
          if (isFreezeToDeathCompilation(clip) && !roundMontageCanEnqueue) return false;
          return true;
        })
        .forEach((clip) => next.add(clip.client_clip_uid));
      return next;
    });
  }, [clips, queuedClientClipUidsForCurrentDemo, roundMontageCanEnqueue, setSelectedClientClipUids]);

  const handleDeselectAll = useCallback(() => {
    setSelectedClientClipUids(new Set());
  }, [setSelectedClientClipUids]);

  const handleAddSelectedToQueue = useCallback(() => {
    if (!currentParsed || selectedClientClipUids.size === 0) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const pickedRounds = [...(freezeToDeathDraft?.picked ?? [])].sort((a, b) => a - b);
    const candidates = clips.filter(
      (clip) => clip.client_clip_uid && selectedClientClipUids.has(clip.client_clip_uid),
    );
    const queueItems = [];
    for (const clip of candidates) {
      const baseItem = {
        demoPath: meta.demoPath,
        demoFilename: meta.demoFilename,
        targetPlayer: meta.targetPlayer,
        targetPlayerUserId: meta.targetPlayerUserId,
        targetSteamId: meta.targetSteamId,
        clipId: clip.clip_id,
        clientClipUid: clip.client_clip_uid,
        clipData: { ...clip },
      };
      if (isFreezeToDeathCompilation(clip)) {
        const sliced = sliceFreezeToDeathClipForEnqueue(clip, pickedRounds);
        if (!sliced.ok) {
          setProgressText(t(sliced.errorKey));
          return;
        }
        queueItems.push({
          ...baseItem,
          clientClipUid: sliced.clip.client_clip_uid,
          sourceClientClipUid: clip.client_clip_uid,
          clipData: sliced.clip,
          freezeToDeathQueueRounds: [...pickedRounds],
        });
      } else {
        queueItems.push(baseItem);
      }
    }
    if (!queueItems.length) return;
    addToQueue(queueItems);
    setSelectedClientClipUids(new Set());
    const skippedCount = candidates.length - queueItems.length;
    const skippedHint = skippedCount > 0 ? t("app.enqueueSkippedHint", { n: skippedCount }) : "";
    setProgressText(t("app.enqueueAdded", { n: queueItems.length }) + skippedHint, {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [
    addToQueue,
    clips,
    currentMatchIndex,
    currentParsed,
    freezeToDeathDraft,
    queueItemMetaForIndex,
    selectedClientClipUids,
    setProgressText,
    setSelectedClientClipUids,
    t,
  ]);

  const handleAddCurrentPlayerHighlights = useCallback(() => {
    if (!currentParsed || !currentActivePlayer) return;
    const meta = queueItemMetaForPlayer(currentMatchIndex, currentActivePlayer);
    const queueItems = currentPlayerClipScope.queueableHighlights.map((clip) => ({
      demoPath: meta.demoPath,
      demoFilename: meta.demoFilename,
      targetPlayer: meta.targetPlayer,
      targetPlayerUserId: meta.targetPlayerUserId,
      targetSteamId: meta.targetSteamId,
      clipId: clip.clip_id,
      clientClipUid: clip.client_clip_uid,
      clipData: clip,
    }));
    if (!queueItems.length) {
      setProgressText(t("app.enqueuePlayerHighlightsEmpty", { player: currentActivePlayer }));
      return;
    }
    addToQueue(queueItems);
    setProgressText(t("app.enqueuePlayerHighlightsDone", {
      player: currentActivePlayer,
      n: queueItems.length,
    }), { autoDismissMs: 2000, queueLink: true });
  }, [
    addToQueue,
    currentActivePlayer,
    currentMatchIndex,
    currentParsed,
    currentPlayerClipScope,
    queueItemMetaForPlayer,
    setProgressText,
    t,
  ]);

  const addQueueItem = useCallback((clipData, meta) => {
    addToQueue({
      demoPath: meta.demoPath,
      demoFilename: meta.demoFilename,
      targetPlayer: meta.targetPlayer,
      targetPlayerUserId: meta.targetPlayerUserId,
      targetSteamId: meta.targetSteamId,
      clipId: clipData.clip_id,
      clientClipUid: clipData.client_clip_uid,
      clipData,
    });
  }, [addToQueue]);

  const isAlreadyQueued = useCallback((clipData, meta) => queuedClientClipUidsGlobal.has(
    queueItemClientUid({
      clientClipUid: clipData.client_clip_uid,
      clipData,
      demoFilename: meta.demoFilename,
      clipId: clipData.clip_id,
    }),
  ), [queuedClientClipUidsGlobal]);

  const handleAddTimelineEventToQueue = useCallback((event, roundRow) => {
    const hasWindow = (event?.suggested_clip && typeof event.suggested_clip === "object")
      || (event?.start_tick != null && event?.end_tick != null);
    if (!currentParsed || !hasWindow) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const clipData = buildTimelineEventClipData({
      event,
      mapName: matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      round: roundRow?.round ?? event?.round,
      t,
      locale,
    });
    if (isAlreadyQueued(clipData, meta)) {
      setProgressText(t("app.enqueueTimelineAlreadyIn"), { autoDismissMs: 2000 });
      return;
    }
    addQueueItem(clipData, meta);
    setProgressText(t("app.enqueueTimelineDone"), { autoDismissMs: 2000, queueLink: true });
  }, [
    addQueueItem,
    currentMatchIndex,
    currentParsed,
    isAlreadyQueued,
    locale,
    matchMeta,
    queueItemMetaForIndex,
    setProgressText,
    t,
  ]);

  const handleAddTimelineRoundToQueue = useCallback((roundRow) => {
    if (!currentParsed || !roundRow) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const clipData = buildTimelineRoundClipData({
      roundRow,
      mapName: matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      demoFilename: meta.demoFilename,
      t,
    });
    if (isAlreadyQueued(clipData, meta)) {
      setProgressText(t("app.enqueueRoundAlreadyIn"), { autoDismissMs: 2000 });
      return;
    }
    addQueueItem(clipData, meta);
    setProgressText(t("app.enqueueRoundDone"), { autoDismissMs: 2000, queueLink: true });
  }, [
    addQueueItem,
    currentMatchIndex,
    currentParsed,
    isAlreadyQueued,
    matchMeta,
    queueItemMetaForIndex,
    setProgressText,
    t,
  ]);

  const handleAddTimelineEventsBatchToQueue = useCallback((eventList) => {
    if (!currentParsed || !Array.isArray(eventList) || !eventList.length) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const queueItems = [];
    for (const event of eventList) {
      if (!event?.suggested_clip && (event?.start_tick == null || event?.end_tick == null)) continue;
      const clipData = buildTimelineEventClipData({
        event,
        mapName: matchMeta?.map_name || "",
        targetPlayer: meta.targetPlayer,
        round: event.round,
        t,
        locale,
      });
      if (isAlreadyQueued(clipData, meta)) continue;
      queueItems.push({
        demoPath: meta.demoPath,
        demoFilename: meta.demoFilename,
        targetPlayer: meta.targetPlayer,
        targetPlayerUserId: meta.targetPlayerUserId,
        targetSteamId: meta.targetSteamId,
        clipId: clipData.clip_id,
        clientClipUid: clipData.client_clip_uid,
        clipData,
      });
    }
    if (!queueItems.length) {
      setProgressText(t("app.enqueueTimelineBatchAllIn"), { autoDismissMs: 2000 });
      return;
    }
    addToQueue(queueItems);
    setProgressText(t("app.enqueueTimelineBatchDone", { n: queueItems.length }), {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [
    addToQueue,
    currentMatchIndex,
    currentParsed,
    isAlreadyQueued,
    locale,
    matchMeta,
    queueItemMetaForIndex,
    setProgressText,
    t,
  ]);

  const handleAddWeaponKillsToQueue = useCallback((clipData) => {
    if (!currentParsed || !clipData?.client_clip_uid || !clipData?.kill_ticks?.length) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    if (isAlreadyQueued(clipData, meta)) {
      setProgressText(t("app.enqueueTimelineAlreadyIn"), { autoDismissMs: 2000 });
      return;
    }
    addQueueItem(clipData, meta);
    setProgressText(t("app.enqueueWeaponKillsDone"), { autoDismissMs: 2000, queueLink: true });
  }, [
    addQueueItem,
    currentMatchIndex,
    currentParsed,
    isAlreadyQueued,
    queueItemMetaForIndex,
    setProgressText,
    t,
  ]);

  const handleDequeueClip = useCallback((clientClipUid) => {
    removeByClientClipUid(clientClipUid);
  }, [removeByClientClipUid]);

  const handleRemoveTimelineEventFromQueue = useCallback((event, roundRow) => {
    if (!currentParsed) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const clipData = buildTimelineEventClipData({
      event,
      mapName: matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      round: roundRow?.round ?? event?.round,
      t,
      locale,
    });
    removeByClientClipUid(clipData.client_clip_uid);
  }, [
    currentMatchIndex,
    currentParsed,
    locale,
    matchMeta,
    queueItemMetaForIndex,
    removeByClientClipUid,
    t,
  ]);

  const handleRemoveTimelineRoundFromQueue = useCallback((roundRow) => {
    if (!currentParsed || !roundRow) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const clipData = buildTimelineRoundClipData({
      roundRow,
      mapName: matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      demoFilename: meta.demoFilename,
      t,
    });
    removeByClientClipUid(clipData.client_clip_uid);
  }, [currentMatchIndex, currentParsed, matchMeta, queueItemMetaForIndex, removeByClientClipUid, t]);

  return {
    queuedClientClipUidsForCurrentDemo,
    regularSelectableTotal,
    selectedRegularCount,
    canAddCurrentPlayerHighlights,
    handleToggleClip,
    handleSelectAll,
    handleDeselectAll,
    handleAddSelectedToQueue,
    handleAddCurrentPlayerHighlights,
    handleAddTimelineEventToQueue,
    handleAddTimelineRoundToQueue,
    handleAddTimelineEventsBatchToQueue,
    handleAddWeaponKillsToQueue,
    handleDequeueClip,
    handleRemoveTimelineEventFromQueue,
    handleRemoveTimelineRoundFromQueue,
  };
}
