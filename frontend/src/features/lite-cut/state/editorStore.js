import { create } from "zustand";
import { liteCutClient } from "../api/liteCutClient.js";
import { useLiteCutHistoryStore } from "./historyStore.js";
import { normalizeLiteCutBody } from "./projectCodec.js";
import { AUDIO_MASTER_GAIN } from "../domain/audioContract.js";
import {
  clearLiteCutRecoveryDraft,
  forgetRememberedLiteCutProject,
  readLiteCutRecoveryDraft,
  recoveryDraftDiffers,
  rememberedLiteCutProjectId,
  rememberLiteCutProject,
  writeLiteCutRecoveryDraft,
} from "./recoveryUtils.js";

const SESSION_PROJECT_KEY = "liteCut:projectId";
const activeSavePromises = new Map();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function projectErrorCode(error, fallback) {
  return error?.response?.data?.detail?.code || error?.code || error?.message || fallback;
}

async function patchProjectWithRetry(projectId, payload) {
  const delays = [0, 350, 900];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try {
      return await liteCutClient.updateProject(projectId, payload);
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status) || 0;
      if (status && status < 500 && status !== 429) throw error;
    }
  }
  throw lastError;
}

function recoveryCandidateForProject(data, normalizedBody) {
  const draft = readLiteCutRecoveryDraft(data?.id);
  if (!draft) return null;
  if (!recoveryDraftDiffers(draft, data?.name, normalizedBody)) {
    clearLiteCutRecoveryDraft(data.id);
    return null;
  }
  return { ...draft, body: normalizeLiteCutBody(draft.body).body };
}

// Compatibility facade for callers that still import the codec from the store.
export { normalizeLiteCutBody } from "./projectCodec.js";

export const useLiteCutEditorStore = create((set, get) => ({
  projectId: null,
  projectName: "未命名工程",
  body: null,
  dirty: false,
  loading: false,
  saving: false,
  error: null,
  mediaCache: {},
  projectList: [],
  projectListLoading: false,
  projectUpdatedAt: null,
  recoveryCandidate: null,

  listProjects: async () => {
    set({ projectListLoading: true });
    try {
      const data = await liteCutClient.listProjects({ limit: 50, offset: 0 });
      set({ projectList: data.items || [], projectListLoading: false });
      return data.items || [];
    } catch {
      set({ projectListLoading: false });
      return [];
    }
  },

  setMediaCache: (items) => {
    const m = {};
    for (const it of items || []) m[it.id] = it;
    set({ mediaCache: m });
  },

  loadOrCreateProject: async () => {
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const stored = sessionStorage.getItem(SESSION_PROJECT_KEY);
      const rememberedId = rememberedLiteCutProjectId();
      const rememberedHasDraft = rememberedId ? Boolean(readLiteCutRecoveryDraft(rememberedId)) : false;
      if (rememberedId && !rememberedHasDraft) forgetRememberedLiteCutProject(rememberedId);
      const storedId = stored ? Number(stored) : rememberedHasDraft ? rememberedId : null;
      let startupError = null;
      if (Number.isFinite(storedId) && storedId > 0) {
        try {
          const data = await liteCutClient.getProject(storedId);
          const normalizedBody = normalizeLiteCutBody(data.body).body;
          rememberLiteCutProject(data.id);
          set({
            projectId: data.id,
            projectName: data.name || "未命名工程",
            body: normalizedBody,
            dirty: false,
            loading: false,
            projectUpdatedAt: data.updated_at || null,
            recoveryCandidate: recoveryCandidateForProject(data, normalizedBody),
          });
          void get().listProjects();
          return;
        } catch (error) {
          startupError = projectErrorCode(error, "open_failed");
          sessionStorage.removeItem(SESSION_PROJECT_KEY);
          forgetRememberedLiteCutProject(storedId);
        }
      }
      const data = await liteCutClient.listProjects({ limit: 50, offset: 0 });
      set({
        projectId: null,
        projectName: "",
        body: null,
        dirty: false,
        loading: false,
        mediaCache: {},
        projectList: data.items || [],
        projectListLoading: false,
        projectUpdatedAt: null,
        recoveryCandidate: null,
        error: startupError,
      });
    } catch (e) {
      set({
        loading: false,
        error: projectErrorCode(e, "load_failed"),
      });
    }
  },

  saveProject: async () => {
    const saveProjectId = Number(get().projectId);
    if (!Number.isFinite(saveProjectId) || saveProjectId <= 0) return { ok: false };
    if (activeSavePromises.has(saveProjectId)) return activeSavePromises.get(saveProjectId);
    const savePromise = (async () => {
      for (let pass = 0; pass < 4; pass += 1) {
        const snapshot = get();
        const { projectId, projectName, body } = snapshot;
        if (Number(projectId) !== saveProjectId) return { ok: true };
        if (!projectId || !body) return { ok: false };
        if (!snapshot.dirty && pass === 0) return { ok: true };
        set({ saving: true, error: null });
        try {
          const normalized = normalizeLiteCutBody(body);
          const data = await patchProjectWithRetry(projectId, {
            name: projectName,
            body: normalized.body,
          });
          const current = get();
          if (Number(current.projectId) !== Number(projectId)) return { ok: true };
          if (current.body === body && current.projectName === projectName) {
            set({
              projectName: data.name || projectName,
              body: normalizeLiteCutBody(data.body).body,
              dirty: false,
              saving: false,
              projectUpdatedAt: data.updated_at || null,
              recoveryCandidate: null,
            });
            clearLiteCutRecoveryDraft(projectId);
            rememberLiteCutProject(projectId);
            void get().listProjects();
            return { ok: true };
          }
          // Edits arrived while the request was in flight. Keep the current
          // body untouched and immediately persist the newer snapshot.
          set({ saving: false, dirty: true });
        } catch (e) {
          if (Number(get().projectId) === Number(projectId)) {
            set({
              saving: false,
              dirty: true,
              error: projectErrorCode(e, "save_failed"),
            });
          }
          return { ok: false };
        }
      }
      set({ saving: false, dirty: true, error: "save_busy" });
      return { ok: false };
    })().finally(() => {
      if (activeSavePromises.get(saveProjectId) === savePromise) {
        activeSavePromises.delete(saveProjectId);
      }
    });
    activeSavePromises.set(saveProjectId, savePromise);
    return savePromise;
  },

  openProject: async (projectId) => {
    const id = Number(projectId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false };
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const data = await liteCutClient.getProject(id);
      sessionStorage.setItem(SESSION_PROJECT_KEY, String(data.id));
      rememberLiteCutProject(data.id);
      const normalizedBody = normalizeLiteCutBody(data.body).body;
      set({
        projectId: data.id,
        projectName: data.name || "未命名工程",
        body: normalizedBody,
        dirty: false,
        loading: false,
        projectUpdatedAt: data.updated_at || null,
        recoveryCandidate: recoveryCandidateForProject(data, normalizedBody),
      });
      void get().listProjects();
      return { ok: true };
    } catch (e) {
      set({
        loading: false,
        error: projectErrorCode(e, "open_failed"),
      });
      return { ok: false };
    }
  },

  createNewProject: async (name = "未命名工程", body = null) => {
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const payload = body && typeof body === "object" ? { name, body } : { name };
      const data = await liteCutClient.createProject(payload);
      sessionStorage.setItem(SESSION_PROJECT_KEY, String(data.id));
      rememberLiteCutProject(data.id);
      clearLiteCutRecoveryDraft(data.id);
      set({
        projectId: data.id,
        projectName: data.name || name,
        body: normalizeLiteCutBody(data.body).body,
        dirty: false,
        loading: false,
        mediaCache: {},
        projectUpdatedAt: data.updated_at || null,
        recoveryCandidate: null,
      });
      void get().listProjects();
      return { ok: true, project: data };
    } catch (e) {
      set({
        loading: false,
        error: projectErrorCode(e, "create_failed"),
      });
      return { ok: false };
    }
  },

  duplicateProject: async (sourceProjectId = null) => {
    const { projectId, projectName, body } = get();
    const id = Number(sourceProjectId ?? projectId);
    let sourceName = projectName;
    let sourceBody = body;
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      if (Number.isFinite(id) && id > 0 && id !== Number(projectId)) {
        const data = await liteCutClient.getProject(id);
        sourceName = data.name || sourceName;
        sourceBody = normalizeLiteCutBody(data.body).body;
      }
      const copyName = `${sourceName || "LiteCut"} Copy`;
      const data = await liteCutClient.createProject({
        name: copyName,
        body: normalizeLiteCutBody(sourceBody).body,
      });
      sessionStorage.setItem(SESSION_PROJECT_KEY, String(data.id));
      rememberLiteCutProject(data.id);
      clearLiteCutRecoveryDraft(data.id);
      set({
        projectId: data.id,
        projectName: data.name || copyName,
        body: normalizeLiteCutBody(data.body).body,
        dirty: false,
        loading: false,
        projectUpdatedAt: data.updated_at || null,
        recoveryCandidate: null,
      });
      void get().listProjects();
      return { ok: true, project: data };
    } catch (e) {
      set({
        loading: false,
        error: projectErrorCode(e, "duplicate_failed"),
      });
      return { ok: false };
    }
  },

  deleteProject: async (targetProjectId) => {
    const id = Number(targetProjectId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false };
    const isCurrent = Number(id) === Number(get().projectId);
    const currentSnapshot = isCurrent
      ? {
          projectId: get().projectId,
          projectName: get().projectName,
          body: get().body,
          dirty: get().dirty,
          mediaCache: get().mediaCache,
        }
      : null;
    if (isCurrent) {
      sessionStorage.removeItem(SESSION_PROJECT_KEY);
      forgetRememberedLiteCutProject(id);
      set({ projectId: null, projectName: "", body: null, dirty: false, mediaCache: {}, loading: true, error: null, recoveryCandidate: null, projectUpdatedAt: null });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      set({ error: null });
    }
    try {
      await liteCutClient.deleteProject(id);
      clearLiteCutRecoveryDraft(id);
      if (isCurrent) {
        useLiteCutHistoryStore.getState().clear();
      }
      await get().listProjects();
      set({ loading: false });
      return { ok: true };
    } catch (e) {
      if (currentSnapshot) {
        sessionStorage.setItem(SESSION_PROJECT_KEY, String(currentSnapshot.projectId));
        rememberLiteCutProject(currentSnapshot.projectId);
      }
      set({
        ...(currentSnapshot || {}),
        loading: false,
        error: projectErrorCode(e, "delete_failed"),
      });
      return { ok: false };
    }
  },

  deleteProjects: async (targetProjectIds) => {
    const ids = [...new Set((targetProjectIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return { ok: false, deleted: 0 };
    const deletesCurrent = ids.includes(Number(get().projectId));
    const currentSnapshot = deletesCurrent
      ? {
          projectId: get().projectId,
          projectName: get().projectName,
          body: get().body,
          dirty: get().dirty,
          mediaCache: get().mediaCache,
        }
      : null;
    if (deletesCurrent) {
      sessionStorage.removeItem(SESSION_PROJECT_KEY);
      forgetRememberedLiteCutProject(get().projectId);
      set({ projectId: null, projectName: "", body: null, dirty: false, mediaCache: {}, loading: true, error: null, recoveryCandidate: null, projectUpdatedAt: null });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      set({ error: null });
    }
    try {
      const data = await liteCutClient.deleteProjects(ids);
      for (const id of ids) clearLiteCutRecoveryDraft(id);
      if (deletesCurrent) {
        useLiteCutHistoryStore.getState().clear();
      }
      await get().listProjects();
      set({ loading: false });
      return { ok: true, deleted: Number(data?.deleted) || 0, ids: data?.ids || [] };
    } catch (e) {
      if (currentSnapshot) {
        sessionStorage.setItem(SESSION_PROJECT_KEY, String(currentSnapshot.projectId));
        rememberLiteCutProject(currentSnapshot.projectId);
      }
      set({
        ...(currentSnapshot || {}),
        loading: false,
        error: projectErrorCode(e, "batch_delete_failed"),
      });
      return { ok: false, deleted: 0 };
    }
  },

  setProjectName: (name) => set({ projectName: name, dirty: true }),
  markDirty: () => set({ dirty: true }),

  persistRecoveryDraft: () => {
    const state = get();
    if (!state.projectId || !state.body || !state.dirty) return false;
    return writeLiteCutRecoveryDraft(state);
  },

  restoreRecoveryDraft: () => {
    const candidate = get().recoveryCandidate;
    if (!candidate?.body || Number(candidate.projectId) !== Number(get().projectId)) return false;
    useLiteCutHistoryStore.getState().clear();
    set({
      projectName: candidate.projectName || get().projectName,
      body: normalizeLiteCutBody(candidate.body).body,
      dirty: true,
      recoveryCandidate: null,
      error: null,
    });
    return true;
  },

  discardRecoveryDraft: () => {
    const projectId = get().recoveryCandidate?.projectId ?? get().projectId;
    if (projectId) clearLiteCutRecoveryDraft(projectId);
    set({ recoveryCandidate: null });
  },

  patchOutput: (patch) => {
    const { body } = get();
    if (!body) return;
    const nextOutput = { ...(body.output || {}), ...patch };
    set({
      body: { ...body, output: nextOutput },
      dirty: true,
    });
  },

  patchAudio: (patch) => {
    const { body } = get();
    if (!body) return;
    set({
      body: { ...body, audio: { ...(body.audio || { master_volume: AUDIO_MASTER_GAIN.default }), ...patch } },
      dirty: true,
    });
  },
}));
