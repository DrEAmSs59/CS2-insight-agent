import { create } from "zustand";

/**
 * @typedef {Object} PacingOverride
 * @property {number} [pre_first_sec]   首杀前预滚（秒）
 * @property {number} [post_last_sec]   末杀后留白（秒）
 * @property {number} [max_gap_sec]     智能分段最大击杀间隔（秒）
 * @property {number} [post_mid_sec]    中间击杀后停顿（秒），闪切前保留
 * @property {number} [pre_cont_sec]    跳跃后切入缓冲（秒），闪切后至下次开枪
 * @property {boolean} [victim_pov]     是否追加 POV（高光→受害者、失误→击杀者）
 * @property {number} [victim_pov_pre_sec]
 * @property {number} [victim_pov_post_sec]
 */

/**
 * 全局节奏默认值，与后端 build_smart_jump_segments 的硬编码默认值保持一致：
 *   PRE_FIRST = 5.5s  POST_LAST = 3.0s  MAX_GAP = 12s  POST_MID = 1.5s  PRE_CONT = 5.0s
 */
export const BACKEND_DEFAULT_PACING = {
  pre_first_sec: 5.5,
  post_last_sec: 3.0,
  max_gap_sec: 12,
  post_mid_sec: 2,
  pre_cont_sec: 5.0,
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
 * @property {number} [clipData.score_own] 本回合开局目标方胜场
 * @property {number} [clipData.score_opp] 本回合开局对方胜场
 * @property {PacingOverride} [pacing_override] 单片段剪辑节奏覆写（优先级高于全局节奏）
 */

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export const useRecordingQueue = create((set) => ({
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
    const normalized = arr.map((it) => ({
      ...it,
      id: it.id || newId(),
      clientClipUid: it.clientClipUid || it.clipData?.client_clip_uid || "",
    }));
    set((s) => ({ queue: [...s.queue, ...normalized] }));
  },

  removeFromQueue(id) {
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  },

  clearQueue() {
    set({ queue: [] });
  },

  /**
   * 合并单片段剪辑节奏；可传部分字段。支持的键：
   * pre_first_sec, post_last_sec, max_gap_sec, post_mid_sec, pre_cont_sec
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

  /** 重置全局节奏到后端默认值（清空覆写，让后端默认值生效） */
  resetGlobalPacing() {
    set({ globalPacing: {} });
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
