import { create } from "zustand";

/**
 * @typedef {Object} PacingOverride
 * @property {number} [pre_first_sec]   击杀前预留（秒），每段首杀前回拨
 * @property {number} [post_last_sec]   击杀后预留（秒），每段末杀后收束（含智能跳剪中段）
 * @property {number} [max_gap_sec]     智能分段最大击杀间隔（秒）
 * @property {boolean} [victim_pov]     是否追加 POV（高光→受害者、失误→击杀者）
 * @property {number} [victim_pov_pre_sec]
 * @property {number} [victim_pov_post_sec]
 * @property {number} [killer_pov_pre_sec]
 * @property {number} [killer_pov_post_sec]
 */

/**
 * 全局节奏默认值，与后端 build_smart_jump_segments 的硬编码默认值保持一致：
 *   PRE_FIRST = 5.5s  POST_LAST = 3.0s  MAX_GAP = 12s；续段预滚同 PRE_FIRST；中段末杀后留白同 POST_LAST
 */
export const BACKEND_DEFAULT_PACING = {
  pre_first_sec: 5.5,
  post_last_sec: 3.0,
  max_gap_sec: 12,
};

/**
 * @typedef {Object} RecordingQueueItem
 * @property {string} id
 * @property {string} demoPath
 * @property {string} demoFilename
 * @property {string|null} targetPlayer
 * @property {number|null} targetPlayerUserId
 * @property {string|null} targetSteamId
 * @property {string} clipId
 * @property {string} clientClipUid 与列表里 clip.client_clip_uid 一致，用于入队/出队与 UI 同步
 * @property {Object} clipData
 * @property {number[]} [freezeToDeathQueueRounds] 回合合集入队时勾选的回合（仅展示）
 * @property {number} [clipData.score_own] 本回合开局目标方胜场
 * @property {number} [clipData.score_opp] 本回合开局对方胜场
 * @property {PacingOverride} [pacing_override] 单片段剪辑节奏覆写（优先级高于全局节奏）
 */

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** 与队列抽屉「受害者视角」资格判定一致：新入队时用于套用 default_victim_pov */
export function clipVictimPovEnqueueEligible(clipData) {
  if (!clipData || typeof clipData !== "object") return false;
  const victims = Array.isArray(clipData.victims) ? clipData.victims : [];
  const kind = clipData.compilation_kind;
  return (
    (clipData.category === "highlight" ||
      (clipData.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
    victims.some((v) => String(v ?? "").trim().length > 0)
  );
}

/** 与队列抽屉「击杀者视角」资格判定一致 */
export function clipKillerPovEnqueueEligible(clipData) {
  if (!clipData || typeof clipData !== "object") return false;
  // 回合时间线上的「被击杀」条目：主段已锚在死亡附近，自动追加击杀者 POV 会像又切到别人身上。
  if (
    String(clipData.timeline_source || "").trim() === "round_timeline_event" &&
    String(clipData.timeline_record_kind || "").trim() === "death"
  ) {
    return false;
  }
  const killers = Array.isArray(clipData.killers) ? clipData.killers : [];
  const hasKillerList = killers.some((v) => String(v ?? "").trim().length > 0);
  const kind = clipData.compilation_kind;
  return (
    (clipData.category === "compilation" &&
      ["nemesis_deaths", "all_deaths"].includes(kind) &&
      hasKillerList) ||
    (clipData.category === "fail" && String(clipData.killer_name ?? "").trim().length > 0)
  );
}

/**
 * 写入 recording_global_pacing 的「入队默认」开关不应参与片段 pacing_override 合并。
 * @param {Record<string, unknown>} gp
 */
export function stripGlobalPacingMetaKeys(gp) {
  if (!gp || typeof gp !== "object" || Array.isArray(gp)) return {};
  const { default_victim_pov, default_killer_pov, ...rest } = gp;
  return rest;
}

function applyEnqueuePovDefaults(item, globalPacing) {
  const gp = globalPacing && typeof globalPacing === "object" ? globalPacing : {};
  const dv = gp.default_victim_pov === true;
  const dk = gp.default_killer_pov === true;
  if (!dv && !dk) return item;
  const prev =
    item.pacing_override && typeof item.pacing_override === "object"
      ? { ...item.pacing_override }
      : {};
  let touched = false;
  if (dv && clipVictimPovEnqueueEligible(item.clipData)) {
    prev.victim_pov = true;
    touched = true;
  }
  if (dk && clipKillerPovEnqueueEligible(item.clipData)) {
    prev.killer_pov = true;
    touched = true;
  }
  if (!touched) return item;
  return { ...item, pacing_override: prev };
}

export const useRecordingQueue = create((set, get) => ({
  queue: /** @type {RecordingQueueItem[]} */ ([]),

  /**
   * 全局节奏参数，作用于所有未单独设置 pacing_override 的片段。
   * 仅存储用户**显式修改**过的字段；未修改字段由后端默认值接管。
   * @type {PacingOverride}
   */
  globalPacing: {},

  /** @param {RecordingQueueItem | RecordingQueueItem[]} itemOrItems */
  addToQueue(itemOrItems) {
    const arr = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    const gp = get().globalPacing || {};
    const normalized = arr.map((it) => {
      const base = {
        ...it,
        id: it.id || newId(),
        clientClipUid: it.clientClipUid || it.clipData?.client_clip_uid || "",
      };
      return applyEnqueuePovDefaults(base, gp);
    });
    set((s) => ({ queue: [...s.queue, ...normalized] }));
  },

  removeFromQueue(id) {
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  },

  /**
   * 拖拽重排：将 `fromIndex` 移至 `toIndex`（0-based，与列表渲染顺序一致）。
   * @param {number} fromIndex
   * @param {number} toIndex
   */
  reorderQueue(fromIndex, toIndex) {
    set((s) => {
      const n = s.queue.length;
      if (n <= 1) return s;
      const a = Math.floor(Number(fromIndex));
      const b = Math.floor(Number(toIndex));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return s;
      if (a < 0 || a >= n || b < 0 || b >= n || a === b) return s;
      const next = [...s.queue];
      const [item] = next.splice(a, 1);
      next.splice(b, 0, item);
      return { queue: next };
    });
  },

  clearQueue() {
    set({ queue: [] });
  },

  /**
   * 合并单片段剪辑节奏；可传部分字段。支持的键：
   * pre_first_sec, post_last_sec, max_gap_sec
   * @param {string} id
   * @param {PacingOverride} pacingConfig
   */
  updateItemPacing(id, pacingConfig) {
    if (!id || !pacingConfig || typeof pacingConfig !== "object") return;
    set((s) => ({
      queue: s.queue.map((q) => {
        if (q.id !== id) return q;
        const prev = q.pacing_override && typeof q.pacing_override === "object" ? q.pacing_override : {};
        return {
          ...q,
          pacing_override: {
            ...prev,
            ...pacingConfig,
          },
        };
      }),
    }));
  },

  /**
   * 更新全局节奏参数（部分更新，可仅传修改的字段）。
   * @param {PacingOverride} partial
   */
  setGlobalPacing(partial) {
    if (!partial || typeof partial !== "object") return;
    set((s) => ({
      globalPacing: { ...s.globalPacing, ...partial },
    }));
  },

  /**
   * 重置「智能分段」数值（击杀前预留 / 击杀后预留 / 防跳剪阈值），保留入队默认开关与 POV 时序默认值。
   */
  resetGlobalPacing() {
    set((s) => {
      const g = s.globalPacing || {};
      const next = {};
      const keep = new Set([
        "default_victim_pov",
        "default_killer_pov",
        "victim_pov_pre_sec",
        "victim_pov_post_sec",
        "killer_pov_pre_sec",
        "killer_pov_post_sec",
      ]);
      for (const k of Object.keys(g)) {
        if (keep.has(k)) next[k] = g[k];
      }
      return { globalPacing: next };
    });
  },

  /**
   * 从 data/cs2-insight.config.json / GET /api/config 一次性替换全局节奏（非合并）。
   * @param {Record<string, unknown>} obj
   */
  hydrateGlobalPacing(obj) {
    set({
      globalPacing:
        obj && typeof obj === "object" && !Array.isArray(obj) ? { ...obj } : {},
    });
  },

  /**
   * 队列中所有「高光且有受害者名单」的条目：若已全部开启 victim_pov 则一键关闭，否则一键开启。
   * 保留各条已有 pre/post 等覆写。
   */
  toggleVictimPovForAllHighlightsInQueue() {
    set((s) => {
      const isEligible = (q) => {
        const victims = Array.isArray(q.clipData?.victims) ? q.clipData.victims : [];
        const kind = q.clipData?.compilation_kind;
        return (
          (q.clipData?.category === "highlight" ||
            (q.clipData?.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
          victims.some((v) => String(v ?? "").trim().length > 0)
        );
      };
      const eligible = s.queue.filter(isEligible);
      if (eligible.length === 0) return s;
      const allOn = eligible.every((q) => Boolean(q.pacing_override?.victim_pov));
      const nextVal = !allOn;
      return {
        queue: s.queue.map((q) => {
          if (!isEligible(q)) return q;
          const prev = q.pacing_override && typeof q.pacing_override === "object" ? q.pacing_override : {};
          return {
            ...q,
            pacing_override: { ...prev, victim_pov: nextVal },
          };
        }),
      };
    });
  },

  toggleKillerPovForAllEligibleInQueue() {
    set((s) => {
      const isEligible = (q) => {
        const killers = Array.isArray(q.clipData?.killers) ? q.clipData.killers : [];
        const hasKillerList = killers.some((v) => String(v ?? "").trim().length > 0);
        const kind = q.clipData?.compilation_kind;
        return (
          (q.clipData?.category === "compilation" &&
            ["nemesis_deaths", "all_deaths"].includes(kind) &&
            hasKillerList) ||
          (q.clipData?.category === "fail" && String(q.clipData?.killer_name ?? "").trim().length > 0)
        );
      };
      const eligible = s.queue.filter(isEligible);
      if (eligible.length === 0) return s;
      const allOn = eligible.every((q) => Boolean(q.pacing_override?.killer_pov));
      const nextVal = !allOn;
      return {
        queue: s.queue.map((q) => {
          if (!isEligible(q)) return q;
          const prev = q.pacing_override && typeof q.pacing_override === "object" ? q.pacing_override : {};
          return {
            ...q,
            pacing_override: { ...prev, killer_pov: nextVal },
          };
        }),
      };
    });
  },
}));
