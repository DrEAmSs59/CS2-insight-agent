import { useCallback, useEffect, useRef, useState } from "react";

import API from "../../api/api";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { messageFromApiCode } from "../../utils/apiErrorMessages";
import { formatRecordingApiError, parseRecordingApiError } from "../../utils/formatRecordingApiError";
import {
  recordingAbortToastKind,
  recordingQueueHadUnexpectedCs2Exit,
  recordingQueueWasAborted,
  unexpectedCs2ExitRecoveryMessageKey,
} from "../../utils/recordingAbort";
import {
  applySessionKbOverlayToRequests,
  applySessionObsTransitionToRequests,
  buildRecordingQueueRequestsFromQueue,
} from "../../utils/recordingBatch";
import { splitRecordWarmupConfirmPayload } from "../../utils/warmupDefaults";
import { normalizePovVoiceMode } from "../../utils/povVoiceMode.js";

/** Owns one recording session from preflight through recovery and result reporting. */
export function useRecordingSessionController({
  t,
  setProgressText,
  setQueueDrawerOpen,
  queue,
  clearQueue,
  obsConfig,
  uploadedDemos,
  parsedMatches,
  demoLibraryItems,
}) {
  const [batchRecording, setBatchRecording] = useState(false);
  const [recordingAbortRequested, setRecordingAbortRequested] = useState(false);
  const recordingAbortRequestedRef = useRef(false);
  const [recordingResults, setRecordingResults] = useState(null);
  const [recordingResultModalOpen, setRecordingResultModalOpen] = useState(false);
  const [recordingBlockedMessage, setRecordingBlockedMessage] = useState("");
  const [recordingBlockedCode, setRecordingBlockedCode] = useState(null);
  const [recordingRecoveryPrompt, setRecordingRecoveryPrompt] = useState({
    configRecoveryNeeded: null,
    povRecoveryNeeded: false,
  });
  const [recordWarmupOpen, setRecordWarmupOpen] = useState(false);
  const [warmupIntent, setWarmupIntent] = useState(null);
  const [configBackupStatus, setConfigBackupStatus] = useState(null);
  const [configBackupLoading, setConfigBackupLoading] = useState(false);

  const refreshConfigBackupStatus = useCallback(async () => {
    setConfigBackupLoading(true);
    try {
      const { data } = await API.get("/config-backup/status");
      const nextStatus = data && typeof data === "object" ? data : null;
      setConfigBackupStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      const failedStatus = {
        fetch_failed: true,
        message: formatRecordingApiError(error, t, t("app.backendConnectFail")),
      };
      setConfigBackupStatus(failedStatus);
      return failedStatus;
    } finally {
      setConfigBackupLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshConfigBackupStatus();
  }, [refreshConfigBackupStatus]);

  const openBatchWarmup = useCallback(async () => {
    if (!queue.length) return;
    setProgressText(t("app.checkingPlayerConfig"), { loading: true });
    try {
      const { data: status } = await API.get("/config-backup/status");
      setConfigBackupStatus(status && typeof status === "object" ? status : null);
      if (status?.restore_required) {
        setProgressText("");
        setRecordingBlockedMessage(t("app.recordBlockedConfigNotRestored"));
        setRecordingBlockedCode("RECORDING_CONFIG_RESTORE_REQUIRED");
        return;
      }
    } catch {
      if (configBackupStatus?.restore_required) {
        setProgressText("");
        setRecordingBlockedMessage(t("app.recordBlockedConfigNotRestored"));
        setRecordingBlockedCode("RECORDING_CONFIG_RESTORE_REQUIRED");
        return;
      }
    }

    setProgressText(t("app.checkingObsConnection"), { loading: true });
    try {
      const { data } = await API.post("/obs/config-check", obsConfig);
      if (!data?.connected) {
        setProgressText(t("app.obsConnectFail"), { isError: true });
        return;
      }
    } catch (error) {
      setProgressText(t("app.obsCheckFail", {
        msg: error.response?.data?.detail || error.message,
      }), { isError: true });
      return;
    }
    setQueueDrawerOpen(false);
    setWarmupIntent("batch");
    setRecordWarmupOpen(true);
    setProgressText("");
  }, [configBackupStatus, obsConfig, queue.length, setProgressText, setQueueDrawerOpen, t]);

  const handleWarmupConfirm = useCallback(async (warmupPayload) => {
    const intent = warmupIntent;
    const { warmupForApi, session } = splitRecordWarmupConfirmPayload(warmupPayload);
    setRecordWarmupOpen(false);
    if (intent !== "batch") {
      setWarmupIntent(null);
      return;
    }

    setWarmupIntent(null);
    if (!queue.length) return;
    recordingAbortRequestedRef.current = false;
    setRecordingAbortRequested(false);
    setRecordingRecoveryPrompt({ configRecoveryNeeded: null, povRecoveryNeeded: false });
    setRecordingResults(null);
    setRecordingResultModalOpen(false);
    setBatchRecording(true);
    setProgressText(t("common.preparingMapResources"), { loading: true });

    const overlayPrebuildEnabled = session.kb_overlay_enabled || session.kill_fx_enabled;
    let overlayPollTimer = null;
    if (overlayPrebuildEnabled) {
      overlayPollTimer = setInterval(async () => {
        if (recordingAbortRequestedRef.current) return;
        try {
          const { data: status } = await API.get("recording/kb-prebuild-status");
          if (recordingAbortRequestedRef.current) return;
          if (status?.active) {
            setProgressText(t("app.overlayPrebuildProgress", {
              done: status.done,
              total: status.total,
            }), { loading: true });
          } else if (status?.done > 0) {
            setProgressText(t("app.overlayPrebuildReady"), { loading: true });
          }
        } catch {
          // Prebuild progress is advisory; recording remains the source of truth.
        }
      }, 1000);
    }

    let openResultsAfterRecording = false;
    try {
      let requests = buildRecordingQueueRequestsFromQueue(
        queue,
        useRecordingQueue.getState().globalPacing,
        uploadedDemos,
        parsedMatches,
        demoLibraryItems,
      );
      if (!requests.length) {
        setProgressText(t("app.queueNoRecordableClips"));
        return;
      }
      requests = applySessionObsTransitionToRequests(requests, session);
      requests = applySessionKbOverlayToRequests(requests, session);
      const povHud = session.experimental_pov_enabled
        ? {
            enabled: true,
            radar_mode: 0,
            teamcounter_numeric: Boolean(warmupForApi?.pov_teamcounter_numeric),
            voice_mode: normalizePovVoiceMode(warmupForApi?.pov_voice_mode),
            input_hud_enabled: session.input_hud_enabled !== false,
            input_hud_display_mode: session.input_hud_display_mode,
            input_audio_enabled: session.input_audio_enabled !== false,
          }
        : undefined;
      const body = {
        requests,
        warmup: warmupForApi,
        obs: obsConfig,
        cs2_extra_launch_args: session.cs2_extra_launch_args,
        record_inject_console_lines: session.record_inject_console_lines,
        skybox: { id: session.recording_skybox },
        map_material: { id: session.recording_map_material },
        ...(povHud ? { pov_hud: povHud } : {}),
      };
      if (!recordingAbortRequestedRef.current) {
        setProgressText(t("common.preparingMapResources"), { loading: true });
      }
      const { data } = await API.post("recording/queue", body);
      const results = Array.isArray(data) ? data : [];

      const requestQueueItems = {};
      requests.forEach((request) => {
        const queueItemId = request.source_ref?.queue_item_id;
        if (!queueItemId) return;
        const queueItem = queue.find((item) => item.id === queueItemId);
        if (queueItem) requestQueueItems[request.request_id] = queueItem;
      });
      const annotatedResults = results.map((result, index) => ({
        ...result,
        _queueItem: requestQueueItems[result?.request_id] ?? null,
        _index: index,
      }));
      if (results.length > 0 && results.every((result) => result?.success)) clearQueue();
      setRecordingResults(annotatedResults);
      openResultsAfterRecording = true;

      const unexpectedCs2Exit = recordingQueueHadUnexpectedCs2Exit(results);
      const aborted = recordingQueueWasAborted(results, recordingAbortRequestedRef.current);
      if (unexpectedCs2Exit) {
        const unexpectedExitResult = results.find(
          (item) => item?.error_code === "RECORDING_CS2_EXITED"
            || String(item?.error || "").toLowerCase() === "cs2_exited_unexpectedly",
        );
        const reportedRecovery = unexpectedExitResult?.recovery;
        const backupStatus = await refreshConfigBackupStatus();
        let povStatus = null;
        if (session.experimental_pov_enabled) {
          try {
            const { data: nextPovStatus } = await API.get("experimental/pov/status");
            povStatus = nextPovStatus && typeof nextPovStatus === "object"
              ? nextPovStatus
              : { fetch_failed: true };
          } catch {
            povStatus = { fetch_failed: true };
          }
        }
        const configRecoveryNeeded = reportedRecovery?.player_config_restore_verified
          ? reportedRecovery.player_config_restored !== true
          : Boolean(backupStatus?.restore_required || backupStatus?.fetch_failed);
        const povRecoveryNeeded = !session.experimental_pov_enabled
          ? false
          : reportedRecovery?.pov_restore_verified
            ? reportedRecovery.pov_restored !== true
            : Boolean(povStatus?.needs_restore || povStatus?.fetch_failed);
        setRecordingRecoveryPrompt({ configRecoveryNeeded, povRecoveryNeeded });
        setRecordingBlockedMessage(t(unexpectedCs2ExitRecoveryMessageKey({
          configRecoveryNeeded,
          povEnabled: session.experimental_pov_enabled,
          povRecoveryNeeded,
          povRecoveryMode: reportedRecovery?.pov_restore?.verification_mode,
        })));
        setRecordingBlockedCode("RECORDING_CS2_EXITED");
        setProgressText(t("app.unexpectedCs2ExitToast"), { isError: true });
      } else if (aborted) {
        const backupStatus = await refreshConfigBackupStatus();
        const toastKind = recordingAbortToastKind(backupStatus, results);
        if (toastKind === "restore_pending") {
          setProgressText(t("app.abortRestorePending"), { isError: true });
        } else if (toastKind === "unverified") {
          setProgressText(t("app.abortRestoreUnverified"), { isError: true });
        } else if (toastKind === "not_needed") {
          setProgressText(t("app.abortConfigNotModified"), { autoDismissMs: 5000 });
        } else {
          setProgressText(t("app.abortCompleted"), { autoDismissMs: 5000 });
        }
      } else {
        setProgressText("", { autoDismissMs: 100 });
      }
    } catch (error) {
      const { text: detail, code: blockedCode } = parseRecordingApiError(
        error,
        t,
        t("common.requestFail"),
      );
      if (error.response?.status === 409 || error.response?.status === 422) {
        setRecordingBlockedMessage(detail || t("app.recordStartFailed"));
        setRecordingBlockedCode(blockedCode);
      }
      const toastKey = recordingAbortRequestedRef.current ? "app.abortFail" : "app.batchRecordFail";
      setProgressText(t(toastKey, { msg: detail }), { isError: true });
    } finally {
      if (overlayPollTimer) clearInterval(overlayPollTimer);
      recordingAbortRequestedRef.current = false;
      setRecordingAbortRequested(false);
      setBatchRecording(false);
      if (openResultsAfterRecording) {
        setRecordingResultModalOpen(true);
      }
      void refreshConfigBackupStatus();
    }
  }, [
    clearQueue,
    demoLibraryItems,
    obsConfig,
    parsedMatches,
    queue,
    refreshConfigBackupStatus,
    setProgressText,
    t,
    uploadedDemos,
    warmupIntent,
  ]);

  const handleRestorePlayerConfig = useCallback(async () => {
    setProgressText(t("app.restoringPlayerConfig"), { loading: true });
    try {
      const { data } = await API.post("/config-backup/restore");
      const message = data?.ok
        ? messageFromApiCode(data?.code, t) || t("app.playerConfigRestored")
        : messageFromApiCode(data?.code, t) || t("app.playerConfigRestorePartial");
      setProgressText(message, { autoDismissMs: data?.ok ? 3000 : 4000 });
      await refreshConfigBackupStatus();
    } catch (error) {
      const detail = error.response?.data?.detail;
      if (error.response?.status === 409 && detail?.code === "CS2_RUNNING") {
        setRecordingBlockedMessage(t("app.restoreBlockedCs2Running"));
        setRecordingBlockedCode("CS2_RUNNING");
      } else {
        setProgressText(t("app.restoreFail", {
          msg: formatRecordingApiError(error, t, t("common.requestFail")),
        }), { autoDismissMs: 5000, isError: true });
      }
      await refreshConfigBackupStatus();
    }
  }, [refreshConfigBackupStatus, setProgressText, t]);

  const handleOpenConfigBackupDir = useCallback(async () => {
    try {
      const { data } = await API.post("/config-backup/open-dir");
      if (data && data.ok === false && data.backup_dir) {
        setProgressText(
          `${messageFromApiCode(data?.code, t) || t("app.openDirManual")} ${data.backup_dir}`,
        );
      }
    } catch (error) {
      setProgressText(t("app.openBackupDirFail", {
        msg: formatRecordingApiError(error, t, t("common.requestFail")),
      }), { isError: true });
    }
  }, [setProgressText, t]);

  const handleAbortBatchRecording = useCallback(async () => {
    if (recordingAbortRequestedRef.current) return;
    try {
      const { data } = await API.post("recording/abort");
      if (data?.status === "idle") {
        setProgressText(t("app.abortNoActive"), { autoDismissMs: 3000 });
        return;
      }
      recordingAbortRequestedRef.current = true;
      setRecordingAbortRequested(true);
      setProgressText(t("app.abortingRecording"), { loading: true });
    } catch (error) {
      setProgressText(t("app.abortFail", {
        msg: formatRecordingApiError(error, t, t("common.requestFail")),
      }), { isError: true });
    }
  }, [setProgressText, t]);

  const dismissWarmup = useCallback(() => {
    setRecordWarmupOpen(false);
    setWarmupIntent(null);
  }, []);

  const closeRecordingResults = useCallback(() => {
    setRecordingResultModalOpen(false);
  }, []);

  const clearRecordingResultsAndQueue = useCallback(() => {
    clearQueue();
    setRecordingResultModalOpen(false);
  }, [clearQueue]);

  const clearRecordingBlock = useCallback(() => {
    setRecordingBlockedMessage("");
    setRecordingBlockedCode(null);
    setRecordingRecoveryPrompt({ configRecoveryNeeded: null, povRecoveryNeeded: false });
  }, []);

  return {
    batchRecording,
    recordingAbortRequested,
    recordingResults,
    recordingResultModalOpen,
    recordingBlockedMessage,
    recordingBlockedCode,
    recordingRecoveryPrompt,
    recordWarmupOpen,
    configBackupStatus,
    configBackupLoading,
    refreshConfigBackupStatus,
    openBatchWarmup,
    handleWarmupConfirm,
    handleRestorePlayerConfig,
    handleOpenConfigBackupDir,
    handleAbortBatchRecording,
    dismissWarmup,
    closeRecordingResults,
    clearRecordingResultsAndQueue,
    clearRecordingBlock,
  };
}
