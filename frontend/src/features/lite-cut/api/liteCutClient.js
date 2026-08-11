import API, {
  getLiteCutAssetStreamUrl,
  getRecordedClipStreamUrl,
} from "../../../api/api.js";

const responseData = (response) => response?.data;
const idPart = (value) => encodeURIComponent(String(value));

/**
 * The single HTTP boundary for LiteCut.  Feature code receives decoded bodies;
 * axios response envelopes and endpoint details stay in this adapter.
 */
export function createLiteCutClient(transport = API) {
  return {
    listProjects: ({ limit = 50, offset = 0 } = {}) =>
      transport.get("/lite-cut/projects", { params: { limit, offset } }).then(responseData),
    getProject: (projectId) => transport.get(`/lite-cut/projects/${idPart(projectId)}`).then(responseData),
    createProject: (payload) => transport.post("/lite-cut/projects", payload).then(responseData),
    updateProject: (projectId, payload) =>
      transport.patch(`/lite-cut/projects/${idPart(projectId)}`, payload).then(responseData),
    deleteProject: (projectId) => transport.delete(`/lite-cut/projects/${idPart(projectId)}`).then(responseData),
    deleteProjects: (ids) => transport.post("/lite-cut/projects/batch-delete", { ids }).then(responseData),

    listAssets: ({ projectId = null, limit = 500, offset = 0 } = {}) => {
      const params = { limit, offset };
      if (projectId != null) params.project_id = projectId;
      return transport.get("/lite-cut/assets", { params }).then(responseData);
    },
    validateAssets: (body) => transport.post("/lite-cut/assets/validate", { body }).then(responseData),
    uploadAsset: ({ file, projectId = null, clientDurationSec = null, signal, onUploadProgress } = {}) => {
      const form = new FormData();
      form.append("file", file);
      const params = new URLSearchParams();
      if (projectId != null) params.set("project_id", String(projectId));
      if (clientDurationSec != null) params.set("client_duration_sec", String(clientDurationSec));
      const query = params.toString();
      return transport.post(`/lite-cut/assets/upload${query ? `?${query}` : ""}`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
        onUploadProgress,
      }).then(responseData);
    },
    deleteAsset: (assetId) => transport.delete(`/lite-cut/assets/${idPart(assetId)}`).then(responseData),
    retryAssetProxy: (assetId) =>
      transport.post(`/lite-cut/assets/${idPart(assetId)}/proxy/retry`).then(responseData),
    getAssetMetadata: (assetId) =>
      transport.get(`/lite-cut/assets/${idPart(assetId)}/metadata`).then(responseData),

    listPresets: ({ limit = 200 } = {}) =>
      transport.get("/lite-cut/presets", { params: { limit } }).then(responseData),
    createPreset: (payload) => transport.post("/lite-cut/presets", payload).then(responseData),
    applyPreset: (presetId, payload) =>
      transport.post(`/lite-cut/presets/${idPart(presetId)}/apply`, payload).then(responseData),
    deletePreset: (presetId) => transport.delete(`/lite-cut/presets/${idPart(presetId)}`).then(responseData),

    startExport: (payload) => transport.post("/lite-cut/export/start", payload).then(responseData),
    getExport: (exportId) => transport.get(`/lite-cut/exports/${idPart(exportId)}`).then(responseData),
    cancelExport: (exportId) =>
      transport.post(`/lite-cut/exports/${idPart(exportId)}/cancel`).then(responseData),
    listExports: ({ projectId = null, limit = 8, offset = 0 } = {}) => {
      const params = { limit, offset };
      if (projectId != null) params.project_id = projectId;
      return transport.get("/lite-cut/exports", { params }).then(responseData);
    },

    getProxyCache: () => transport.get("/lite-cut/proxy-cache").then(responseData),
    updateProxySettings: (resolution) =>
      transport.patch("/lite-cut/proxy-cache/settings", { resolution }).then(responseData),
    regenerateProxyCache: () => transport.post("/lite-cut/proxy-cache/regenerate", {}).then(responseData),
    cleanupProxyCache: () => transport.post("/lite-cut/proxy-cache/cleanup").then(responseData),
    listSnapshots: (projectId) =>
      transport.get(`/lite-cut/projects/${idPart(projectId)}/snapshots`).then(responseData),
    restoreSnapshot: (projectId, snapshotId) =>
      transport.post(`/lite-cut/projects/${idPart(projectId)}/snapshots/${idPart(snapshotId)}/restore`).then(responseData),

    getPortableJob: (jobId) =>
      transport.get(`/lite-cut/portable-package/jobs/${idPart(jobId)}`).then(responseData),
    cancelPortableJob: (jobId) =>
      transport.delete(`/lite-cut/portable-package/jobs/${idPart(jobId)}`).then(responseData),
    startPortablePackage: (projectId, destination) =>
      transport.post(`/lite-cut/projects/${idPart(projectId)}/portable-package/start`, { destination }).then(responseData),
    importPortableProject: (file) => {
      const form = new FormData();
      form.append("file", file);
      return transport.post("/lite-cut/projects/portable-import", form, {
        headers: { "Content-Type": "multipart/form-data" },
      }).then(responseData);
    },

    patchRecordedClipDuration: (clipId, duration) =>
      transport.patch(`/recorded-clips/${idPart(clipId)}/duration`, { duration_sec: duration }).then(responseData),
    purgeMissingRecordedClips: () => transport.post("/recorded-clips/purge-missing").then(responseData),
    listRecordedClips: ({ limit = 500, offset = 0 } = {}) =>
      transport.get("/recorded-clips", { params: { limit, offset } }).then(responseData),
    checkFfmpeg: () => transport.get("config/ffmpeg-check").then(responseData),
    detectEncoder: () => transport.post("/config/detect-encoder").then(responseData),
    revealFile: (path) => transport.post("/reveal-file-in-explorer", { path }).then(responseData),
  };
}

export const liteCutClient = createLiteCutClient();
export { getLiteCutAssetStreamUrl, getRecordedClipStreamUrl };
