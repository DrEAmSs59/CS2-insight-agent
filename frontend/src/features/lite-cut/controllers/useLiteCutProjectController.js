import { useCallback, useEffect } from "react";
import { liteCutClient } from "../api/liteCutClient.js";
import { desktopBridge } from "../../../desktop/desktopBridge.js";
import { useLiteCutEditorStore } from "../state/editorStore.js";
import { useLiteCutHistoryStore } from "../state/historyStore.js";
import {
  LITE_CUT_AUTOSAVE_DELAY_MS,
  LITE_CUT_AUTOSAVE_FLUSH_EVENTS,
  shouldFlushLiteCutAutosave,
  shouldScheduleLiteCutAutosave,
} from "../state/autosaveUtils.js";
import { projectBodyFromTemplate } from "../editor/projectTemplates.js";

function resetTimeline(setPlayhead, clearSelection) {
  setPlayhead(0);
  clearSelection();
}

export function useLiteCutProjectSessionController({
  body,
  dirty,
  ffmpegBlocked,
  ffmpegLoading,
  loadOrCreateProject,
  loading,
  persistRecoveryDraft,
  projectId,
  projectName,
  saveProject,
  saving,
}) {
  useEffect(() => {
    if (ffmpegLoading || ffmpegBlocked) return;
    void loadOrCreateProject();
  }, [ffmpegBlocked, ffmpegLoading, loadOrCreateProject]);

  useEffect(() => {
    if (dirty && projectId && body) persistRecoveryDraft();
  }, [body, dirty, persistRecoveryDraft, projectId, projectName]);

  useEffect(() => {
    const stateAtSchedule = useLiteCutEditorStore.getState();
    if (!shouldScheduleLiteCutAutosave(stateAtSchedule)) return undefined;
    const projectIdAtSchedule = stateAtSchedule.projectId;
    const timer = window.setTimeout(() => {
      const state = useLiteCutEditorStore.getState();
      if (
        shouldScheduleLiteCutAutosave({
          projectId: state.projectId,
          body: state.body,
          dirty: state.dirty,
          loading: state.loading,
          saving: state.saving,
        })
        && Number(state.projectId) === Number(projectIdAtSchedule)
      ) {
        void saveProject();
      }
    }, LITE_CUT_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [body, dirty, loading, projectId, projectName, saveProject, saving]);

  useEffect(() => {
    const flushAutosave = (event) => {
      if (shouldFlushLiteCutAutosave(event, useLiteCutEditorStore.getState())) {
        void saveProject();
        if (event.type === "beforeunload") {
          event.preventDefault();
          event.returnValue = "";
        }
      }
    };
    for (const eventName of LITE_CUT_AUTOSAVE_FLUSH_EVENTS) window.addEventListener(eventName, flushAutosave);
    return () => {
      for (const eventName of LITE_CUT_AUTOSAVE_FLUSH_EVENTS) window.removeEventListener(eventName, flushAutosave);
    };
  }, [saveProject]);
}

export function useLiteCutProjectController({
  clearSelection,
  createNewProject,
  deleteProject,
  deleteProjects,
  dirty,
  duplicateProject,
  listProjects,
  openProject,
  projectId,
  projectName,
  saveProject,
  saving,
  setPlaying,
  setPlayhead,
  t,
}) {
  const handleNewProject = useCallback(async (template = null) => {
    if (dirty || saving) await saveProject();
    if (template?.isCustomProject) {
      const customBody = projectBodyFromTemplate("highlight-16x9");
      customBody.output = {
        ...(customBody.output || {}),
        width: template.width,
        height: template.height,
        fps: template.fps,
      };
      const result = await createNewProject(template.name, customBody);
      if (result?.ok) resetTimeline(setPlayhead, clearSelection);
      return result;
    }
    const stamp = new Date();
    const prefix = template?.label ? `LiteCut ${template.label}` : "LiteCut";
    const name = `${prefix} ${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}`;
    const result = await createNewProject(name, template?.id ? projectBodyFromTemplate(template.id) : null);
    resetTimeline(setPlayhead, clearSelection);
    return result;
  }, [clearSelection, createNewProject, dirty, saveProject, saving, setPlayhead]);

  const handleExportProject = useCallback(async () => {
    if (!projectId) return { cancelled: true };
    if (dirty || saving) {
      const saved = await saveProject();
      if (!saved?.ok) return { cancelled: true };
    }
    let destination = "";
    if (desktopBridge?.chooseDirectory) {
      destination = await desktopBridge.chooseDirectory("");
      if (!destination) return { cancelled: true };
    }
    const data = await liteCutClient.exportProjectFile(projectId, destination);
    if (!data.saved_path && data.download_url && typeof document !== "undefined") {
      const anchor = document.createElement("a");
      anchor.href = data.download_url;
      anchor.download = data.filename || "LiteCut.litecut";
      anchor.click();
    }
    return { ok: true, data };
  }, [dirty, projectId, saveProject, saving]);

  const handleImportProject = useCallback(async (file) => {
    try {
      if (dirty || saving) {
        const saved = await saveProject();
        if (!saved?.ok) return { ok: false };
      }
      const data = await liteCutClient.importProjectFile(file);
      await listProjects?.();
      await openProject(data.id);
      resetTimeline(setPlayhead, clearSelection);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  }, [clearSelection, dirty, listProjects, openProject, saveProject, saving, setPlayhead]);

  const handleOpenProject = useCallback(async (nextProjectId) => {
    if (Number(nextProjectId) === Number(projectId)) return;
    if (dirty || saving) await saveProject();
    await openProject(nextProjectId);
    resetTimeline(setPlayhead, clearSelection);
  }, [clearSelection, dirty, openProject, projectId, saveProject, saving, setPlayhead]);

  const handleDuplicateProject = useCallback(async (sourceProjectId) => {
    if (Number(sourceProjectId) === Number(projectId) && (dirty || saving)) await saveProject();
    await duplicateProject(sourceProjectId);
    resetTimeline(setPlayhead, clearSelection);
  }, [clearSelection, dirty, duplicateProject, projectId, saveProject, saving, setPlayhead]);

  const handleDeleteProject = useCallback(async (targetProjectId, confirmed = false) => {
    const id = Number(targetProjectId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!confirmed && typeof window !== "undefined" && !window.confirm(t("liteCut.project.deleteIdConfirm", { id }))) return;
    if (id === Number(projectId)) {
      setPlaying(false);
      if (saving) await saveProject();
    }
    await deleteProject(id);
    resetTimeline(setPlayhead, clearSelection);
  }, [clearSelection, deleteProject, projectId, saveProject, saving, setPlaying, setPlayhead, t]);

  const handleDeleteProjects = useCallback(async (targetProjectIds) => {
    if ((targetProjectIds || []).map(Number).includes(Number(projectId))) {
      setPlaying(false);
      if (saving) await saveProject();
    }
    const result = await deleteProjects(targetProjectIds);
    if (result?.ok) resetTimeline(setPlayhead, clearSelection);
    return result;
  }, [clearSelection, deleteProjects, projectId, saveProject, saving, setPlaying, setPlayhead]);

  const handleRestoreSnapshot = useCallback(async (snapshotId) => {
    if (!projectId) return { ok: false };
    if (dirty || saving) await saveProject();
    const current = useLiteCutEditorStore.getState().body;
    const data = await liteCutClient.restoreSnapshot(projectId, snapshotId);
    if (current) useLiteCutHistoryStore.getState().push(current);
    useLiteCutEditorStore.setState({
      projectName: data.name || projectName,
      body: data.body,
      dirty: false,
      projectUpdatedAt: data.updated_at || null,
      recoveryCandidate: null,
    });
    setPlaying(false);
    resetTimeline(setPlayhead, clearSelection);
    return { ok: true };
  }, [clearSelection, dirty, projectId, projectName, saveProject, saving, setPlaying, setPlayhead]);

  return {
    handleNewProject,
    handleExportProject,
    handleImportProject,
    handleOpenProject,
    handleDuplicateProject,
    handleDeleteProject,
    handleDeleteProjects,
    handleRestoreSnapshot,
  };
}
