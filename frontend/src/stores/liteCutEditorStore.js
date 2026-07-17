import { create } from "zustand";
import API from "../api/api.js";
import { useLiteCutHistoryStore } from "./liteCut/historyStore.js";
import {
  clearLiteCutRecoveryDraft,
  forgetRememberedLiteCutProject,
  readLiteCutRecoveryDraft,
  recoveryDraftDiffers,
  rememberedLiteCutProjectId,
  rememberLiteCutProject,
  writeLiteCutRecoveryDraft,
} from "./liteCut/recoveryUtils.js";

const SESSION_PROJECT_KEY = "liteCut:projectId";
let activeSavePromise = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function patchProjectWithRetry(projectId, payload) {
  const delays = [0, 350, 900];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try {
      return await API.patch(`/lite-cut/projects/${projectId}`, payload);
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

export { mapRecordedClipRow } from "./liteCut/mediaUtils.js";

export function normalizeLiteCutBody(rawBody) {
  const body = rawBody && typeof rawBody === "object" ? structuredClone(rawBody) : {};
  let changed = false;
  if (!Array.isArray(body.tracks)) {
    body.tracks = [];
    changed = true;
  } else {
    body.tracks = body.tracks.map((track) => {
      if (!track || typeof track !== "object" || typeof track.solo === "boolean") return track;
      changed = true;
      return { ...track, solo: false };
    });
  }
  if (!body.output || typeof body.output !== "object") {
    body.output = {
      dir: "",
      filename: "lite_cut_export.mp4",
      width: 1920,
      height: 1080,
      fps: 60,
      encoder: "auto",
      range_mode: "full",
      range_start_sec: 0,
      range_end_sec: null,
    };
    changed = true;
  } else {
    const outputDefaults = { width: 1920, height: 1080, fps: 60 };
    for (const [key, fallback] of Object.entries(outputDefaults)) {
      const raw = Number(body.output[key]);
      if (!Number.isFinite(raw) || raw <= 0) {
        body.output[key] = fallback;
        changed = true;
      }
    }
    if (!["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"].includes(body.output.encoder)) {
      body.output.encoder = "auto";
      changed = true;
    }
    if (!["full", "custom"].includes(body.output.range_mode)) {
      body.output.range_mode = "full";
      changed = true;
    }
    const rawRangeStart = Number(body.output.range_start_sec);
    if (!Number.isFinite(rawRangeStart) || rawRangeStart < 0) {
      body.output.range_start_sec = 0;
      changed = true;
    }
  }
  if (!body.tracks.some((t) => t?.type === "video")) {
    body.tracks.unshift({
      id: "v1",
      type: "video",
      label: "V1",
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
      clips: [],
    });
    changed = true;
  }
  // Repair duplicate/missing video track labels left behind by older builds
  // that force-injected a second "V1" whenever the id "v1" was absent.
  const videoTrackLabels = body.tracks.filter((t) => t?.type === "video").map((t) => String(t?.label || ""));
  if (videoTrackLabels.some((label) => !label) || new Set(videoTrackLabels).size !== videoTrackLabels.length) {
    let nextVideoLabel = 1;
    for (const track of body.tracks) {
      if (track?.type === "video") track.label = `V${nextVideoLabel++}`;
    }
    changed = true;
  }
  if (!body.tracks.some((t) => t?.type === "audio")) {
    body.tracks.push({
      id: "a1",
      type: "audio",
      label: "A1",
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
      clips: [],
    });
    changed = true;
  }
  if (!Array.isArray(body.overlays)) {
    body.overlays = [];
    changed = true;
  }
  for (const overlay of body.overlays) {
    if (overlay?.type !== "text" || !overlay.text || typeof overlay.text !== "object") continue;
    if (!/^rajdhani(?:\s+bold)?$/i.test(String(overlay.text.font_family || ""))) continue;
    overlay.text.font_family = "微软雅黑";
    overlay.text.font_file = null;
    changed = true;
  }
  if (!Array.isArray(body.markers)) {
    body.markers = [];
    changed = true;
  } else {
    body.markers = body.markers
      .map((m) => ({
        id: String(m?.id || `marker-${globalThis.crypto?.randomUUID?.()?.slice?.(0, 10) || Date.now()}`),
        time_sec: Math.max(0, Number(m?.time_sec) || 0),
        label: String(m?.label || ""),
        color: /^#[0-9a-f]{6}$/i.test(String(m?.color || "")) ? m.color : "#f59e0b",
      }))
      .sort((a, b) => a.time_sec - b.time_sec);
  }
  if (!body.audio || typeof body.audio !== "object") {
    body.audio = { master_volume: 1 };
    changed = true;
  } else {
    const raw = Number(body.audio.master_volume);
    if (!Number.isFinite(raw)) {
      body.audio.master_volume = 1;
      changed = true;
    } else {
      const next = Math.max(0, Math.min(2, raw));
      if (next !== raw) {
        body.audio.master_volume = next;
        changed = true;
      }
    }
  }
  return { body, changed };
}

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
      const { data } = await API.get("/lite-cut/projects", { params: { limit: 50, offset: 0 } });
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
      if (Number.isFinite(storedId) && storedId > 0) {
        try {
          const { data } = await API.get(`/lite-cut/projects/${storedId}`);
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
        } catch {
          sessionStorage.removeItem(SESSION_PROJECT_KEY);
          forgetRememberedLiteCutProject(storedId);
        }
      }
      const { data } = await API.get("/lite-cut/projects", { params: { limit: 50, offset: 0 } });
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
      });
    } catch (e) {
      set({
        loading: false,
        error: e?.response?.data?.detail?.code || e?.message || "load_failed",
      });
    }
  },

  saveProject: async () => {
    if (activeSavePromise) return activeSavePromise;
    activeSavePromise = (async () => {
      for (let pass = 0; pass < 4; pass += 1) {
        const snapshot = get();
        const { projectId, projectName, body } = snapshot;
        if (!projectId || !body) return { ok: false };
        if (!snapshot.dirty && pass === 0) return { ok: true };
        set({ saving: true, error: null });
        try {
          const normalized = normalizeLiteCutBody(body);
          const { data } = await patchProjectWithRetry(projectId, {
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
              error: e?.response?.data?.detail?.code || e?.message || "save_failed",
            });
          }
          return { ok: false };
        }
      }
      set({ saving: false, dirty: true, error: "save_busy" });
      return { ok: false };
    })().finally(() => {
      activeSavePromise = null;
    });
    return activeSavePromise;
  },

  openProject: async (projectId) => {
    const id = Number(projectId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false };
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const { data } = await API.get(`/lite-cut/projects/${id}`);
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
        error: e?.response?.data?.detail?.code || e?.message || "open_failed",
      });
      return { ok: false };
    }
  },

  createNewProject: async (name = "未命名工程", body = null) => {
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const payload = body && typeof body === "object" ? { name, body } : { name };
      const { data } = await API.post("/lite-cut/projects", payload);
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
        error: e?.response?.data?.detail?.code || e?.message || "create_failed",
      });
      return { ok: false };
    }
  },

  importProject: async ({ name, body } = {}) => {
    if (!body || typeof body !== "object") return { ok: false, error: "invalid_project" };
    set({ loading: true, error: null });
    useLiteCutHistoryStore.getState().clear();
    try {
      const normalized = normalizeLiteCutBody(body).body;
      const importName = String(name || "Imported LiteCut Project").trim().slice(0, 240) || "Imported LiteCut Project";
      const { data } = await API.post("/lite-cut/projects", { name: importName, body: normalized });
      sessionStorage.setItem(SESSION_PROJECT_KEY, String(data.id));
      rememberLiteCutProject(data.id);
      clearLiteCutRecoveryDraft(data.id);
      set({
        projectId: data.id,
        projectName: data.name || importName,
        body: normalizeLiteCutBody(data.body).body,
        dirty: false,
        loading: false,
        projectUpdatedAt: data.updated_at || null,
        recoveryCandidate: null,
      });
      void get().listProjects();
      return { ok: true, project: data };
    } catch (e) {
      const error = e?.response?.data?.detail?.code || e?.message || "import_failed";
      set({ loading: false, error });
      return { ok: false, error };
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
        const { data } = await API.get(`/lite-cut/projects/${id}`);
        sourceName = data.name || sourceName;
        sourceBody = normalizeLiteCutBody(data.body).body;
      }
      const copyName = `${sourceName || "LiteCut"} Copy`;
      const { data } = await API.post("/lite-cut/projects", {
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
        error: e?.response?.data?.detail?.code || e?.message || "duplicate_failed",
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
      await API.delete(`/lite-cut/projects/${id}`);
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
        error: e?.response?.data?.detail?.code || e?.message || "delete_failed",
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
      const { data } = await API.post("/lite-cut/projects/batch-delete", { ids });
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
        error: e?.response?.data?.detail?.code || e?.message || "batch_delete_failed",
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
    set({
      body: { ...body, output: { ...(body.output || {}), ...patch } },
      dirty: true,
    });
  },

  patchAudio: (patch) => {
    const { body } = get();
    if (!body) return;
    set({
      body: { ...body, audio: { ...(body.audio || { master_volume: 1 }), ...patch } },
      dirty: true,
    });
  },
}));
