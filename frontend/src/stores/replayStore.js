import { create } from "zustand";
import API from "../api/api";

export const REPLAY_STORE_CACHE_VERSION = 11;
const MAX_READY_ENTRIES = 3;
const MAX_BYTES = 150 * 1024 * 1024;

function estimateSizeBytes(payload) {
  try {
    return JSON.stringify(payload).length * 2;
  } catch {
    return 0;
  }
}

function buildReplayCacheKey({
  demoPath,
  demoFingerprint = "",
  roundNumber,
  startTick,
  endTick,
  fps,
  transformVersion = 1,
}) {
  return [
    demoFingerprint || demoPath || "unknown",
    `v${REPLAY_STORE_CACHE_VERSION}`,
    `r${roundNumber}`,
    `t${startTick}-${endTick}`,
    `f${fps}`,
    `tv${transformVersion}`,
  ].join("|");
}

export function createReplayCacheKey(args) {
  return buildReplayCacheKey(args);
}

export const useReplayStore = create((set, get) => ({
  entries: {},
  activeKey: null,
  /** Per-map camera snapshot: { fitScale, userZoom, offsetX, offsetY } */
  camerasByMap: {},

  getCamera(mapKey) {
    const key = String(mapKey || "").trim().toLowerCase();
    if (!key) return null;
    return get().camerasByMap[key] || null;
  },

  setCamera(mapKey, camera) {
    const key = String(mapKey || "").trim().toLowerCase();
    if (!key || !camera || typeof camera !== "object") return;
    set({
      camerasByMap: {
        ...get().camerasByMap,
        [key]: {
          fitScale: Number(camera.fitScale) || 1,
          userZoom: Number(camera.userZoom) || 1,
          offsetX: Number(camera.offsetX) || 0,
          offsetY: Number(camera.offsetY) || 0,
        },
      },
    });
  },

  touch(key) {
    const entry = get().entries[key];
    if (!entry) return;
    set({
      entries: {
        ...get().entries,
        [key]: { ...entry, lastAccessAt: Date.now() },
      },
      activeKey: key,
    });
  },

  evictIfNeeded() {
    const entries = { ...get().entries };
    const ready = Object.entries(entries)
      .filter(([, e]) => e.status === "ready")
      .sort((a, b) => (a[1].lastAccessAt || 0) - (b[1].lastAccessAt || 0));
    let total = Object.values(entries).reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
    const activeKey = get().activeKey;
    while (
      ready.length
      && (ready.length > MAX_READY_ENTRIES || total > MAX_BYTES)
    ) {
      const [key, entry] = ready.shift();
      if (key === activeKey || entry.status === "loading") continue;
      total -= entry.sizeBytes || 0;
      delete entries[key];
    }
    set({ entries });
  },

  /**
   * Ensure a replay entry is loading or ready. Reuses in-flight Promise.
   * @returns {Promise<object>} resolved payload
   */
  async ensureReplay(cacheKey, requestBody, { onStatus } = {}) {
    const existing = get().entries[cacheKey];
    if (existing?.status === "ready" && existing.frames) {
      get().touch(cacheKey);
      onStatus?.({ source: existing.source || "memory", cache: existing.cache || null });
      return {
        frames: existing.frames,
        map_transform: existing.mapTransform,
        fps: existing.fps,
        effect_tracks: existing.effectTracks,
        effect_capabilities: existing.effectCapabilities,
        cache: existing.cache,
        demo_fingerprint: existing.demoFingerprint,
      };
    }
    if (existing?.status === "loading" && existing.promise) {
      onStatus?.({ source: "loading", shared: true });
      return existing.promise;
    }

    const promise = API.post("/demo/replay", requestBody)
      .then(({ data }) => {
        const frames = Array.isArray(data?.frames) ? data.frames : [];
        const mapTransform = data?.map_transform && typeof data.map_transform === "object"
          ? data.map_transform
          : null;
        const fps = Math.max(1, Number(data?.fps) || 8);
        const effectTracks = Array.isArray(data?.effect_tracks) ? data.effect_tracks : [];
        const effectCapabilities = data?.effect_capabilities && typeof data.effect_capabilities === "object"
          ? data.effect_capabilities
          : null;
        const sizeBytes = estimateSizeBytes({ frames, effectTracks, mapTransform });
        const source = data?.cache?.frames === "disk_hit" || data?.cache?.frames === "memory_hit"
          ? (data.cache.frames === "memory_hit" ? "memory" : "disk")
          : (data?.cache?.parsed ? "parsed" : "parsed");
        set({
          entries: {
            ...get().entries,
            [cacheKey]: {
              status: "ready",
              promise: null,
              frames,
              effectTracks,
              effectCapabilities,
              mapTransform,
              fps,
              error: null,
              source,
              cache: data?.cache || null,
              demoFingerprint: data?.demo_fingerprint || null,
              createdAt: Date.now(),
              lastAccessAt: Date.now(),
              sizeBytes,
            },
          },
          activeKey: cacheKey,
        });
        get().evictIfNeeded();
        onStatus?.({ source, cache: data?.cache || null });
        return data;
      })
      .catch((error) => {
        set({
          entries: {
            ...get().entries,
            [cacheKey]: {
              status: "error",
              promise: null,
              frames: null,
              effectTracks: null,
              effectCapabilities: null,
              mapTransform: null,
              fps: null,
              error: error?.response?.data?.detail || error?.message || "2D 回放加载失败",
              source: null,
              cache: null,
              demoFingerprint: null,
              createdAt: Date.now(),
              lastAccessAt: Date.now(),
              sizeBytes: 0,
            },
          },
        });
        throw error;
      });

    set({
      entries: {
        ...get().entries,
        [cacheKey]: {
          status: "loading",
          promise,
          frames: null,
          effectTracks: null,
          effectCapabilities: null,
          mapTransform: null,
          fps: null,
          error: null,
          source: null,
          cache: null,
          demoFingerprint: null,
          createdAt: Date.now(),
          lastAccessAt: Date.now(),
          sizeBytes: 0,
        },
      },
      activeKey: cacheKey,
    });
    onStatus?.({ source: "parsed", shared: false });
    return promise;
  },

  getEntry(cacheKey) {
    return get().entries[cacheKey] || null;
  },
}));
