import { useCallback, useEffect, useState } from "react";
import { useLiteCutEditorStore } from "../state/editorStore.js";
import {
  cancelLiteCutExport,
  defaultLiteCutFilename,
  getLiteCutExportStatus,
  listLiteCutExports,
  startLiteCutExport,
} from "../state/exportUtils.js";
import { formatMontageApiError } from "../../../utils/formatMontageApiError.js";
import { messageFromApiCode } from "../../../utils/apiErrorMessages.js";

export function exportPollPhase(job, t) {
  if (job?.status === "done") return { terminal: true, phase: "done", error: null };
  if (job?.status === "cancelled") return { terminal: true, phase: "cancelled", error: null };
  if (job?.status === "error") {
    return {
      terminal: true,
      phase: "error",
      error: messageFromApiCode(job.error, t) || job.error || "导出失败",
    };
  }
  return { terminal: false, phase: "running", error: null };
}

export function useLiteCutExportController({
  body,
  dirty,
  exportableClipCount,
  onExportPhaseChange,
  outputDir,
  outputDirHint,
  outputFilename,
  patchOutput,
  projectId,
  projectName,
  saveProject,
  t,
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportJob, setExportJob] = useState(null);
  const [exportDialog, setExportDialog] = useState({ phase: "idle", result: null, error: "" });
  const [exportHistory, setExportHistory] = useState([]);

  const publishExportPhase = useCallback((phase, payload = null) => {
    setExportDialog({
      phase,
      result: phase === "error" ? null : payload,
      error: phase === "error" ? (payload?.error || "导出失败") : "",
    });
    onExportPhaseChange?.(phase, payload);
  }, [onExportPhaseChange]);

  const loadExportHistory = useCallback(async () => {
    try {
      const { items } = await listLiteCutExports({ projectId: projectId ?? null, limit: 8 });
      setExportHistory(Array.isArray(items) ? items : []);
    } catch {
      setExportHistory([]);
    }
  }, [projectId]);

  useEffect(() => {
    void loadExportHistory();
  }, [loadExportHistory]);

  const handleExport = useCallback(async () => {
    if (!body || exportableClipCount === 0) return;
    const dir = outputDir.trim() || outputDirHint;
    const filename = defaultLiteCutFilename({ output: { filename: outputFilename } }, projectName);
    if (!dir) {
      setExportError("请填写导出目录（绝对路径）");
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportJob(null);
    publishExportPhase("running", { progress: 0, stage: "queued" });
    try {
      if (dirty) await saveProject();
      const result = await startLiteCutExport({
        projectId,
        body: useLiteCutEditorStore.getState().body,
        outputDir: dir,
        filename,
      });
      setExportJob(result);
      setExportHistory((previous) => [
        result,
        ...previous.filter((item) => item.export_id !== result.export_id),
      ].slice(0, 8));
      patchOutput({ dir: outputDir.trim() || dir, filename });
      publishExportPhase("running", result);
    } catch (error) {
      const message = formatMontageApiError(error, t, error?.message || "导出失败");
      setExportError(message);
      publishExportPhase("error", { error: message });
      setExporting(false);
    }
  }, [
    body,
    dirty,
    exportableClipCount,
    outputDir,
    outputDirHint,
    outputFilename,
    patchOutput,
    projectId,
    projectName,
    publishExportPhase,
    saveProject,
    t,
  ]);

  useEffect(() => {
    if (!exporting || !exportJob?.export_id) return undefined;
    let stopped = false;
    let intervalId = null;
    const poll = async () => {
      try {
        const next = await getLiteCutExportStatus(exportJob.export_id);
        if (stopped) return;
        setExportJob(next);
        const state = exportPollPhase(next, t);
        if (state.terminal) {
          setExporting(false);
          setExportError(state.error);
          publishExportPhase(state.phase, state.error ? { ...next, error: state.error } : next);
          void loadExportHistory();
          return;
        }
        publishExportPhase("running", next);
      } catch (error) {
        if (stopped) return;
        const message = formatMontageApiError(error, t, error?.message || "导出状态读取失败");
        setExporting(false);
        setExportError(message);
        publishExportPhase("error", { error: message });
      }
    };
    void poll();
    intervalId = window.setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [exporting, exportJob?.export_id, loadExportHistory, publishExportPhase, t]);

  const handleCancelExport = useCallback(async () => {
    if (!exportJob?.export_id) return;
    try {
      const next = await cancelLiteCutExport(exportJob.export_id);
      setExportJob(next);
      publishExportPhase("running", next);
    } catch (error) {
      setExportError(formatMontageApiError(error, t, error?.message || "取消导出失败"));
    }
  }, [exportJob?.export_id, publishExportPhase, t]);

  const dismissExportDialog = useCallback(() => {
    setExportDialog({ phase: "idle", result: null, error: "" });
  }, []);

  return {
    exporting,
    exportError,
    exportJob,
    exportDialog,
    exportHistory,
    handleExport,
    handleCancelExport,
    dismissExportDialog,
    loadExportHistory,
  };
}
