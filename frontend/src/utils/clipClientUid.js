/** 前端片段实例 id：与后端 clip_id 解耦，用于列表选中态与录制队列双向绑定 */

function newClientClipUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `cc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function ensureClientClipUidsOnClips(clips) {
  if (!Array.isArray(clips)) return [];
  return clips.map((c) => {
    if (!c || typeof c !== "object") return c;
    if (c.client_clip_uid) return c;
    return { ...c, client_clip_uid: newClientClipUid() };
  });
}

/** 发往后端录制 / 解析 API 时去掉前端字段 */
export function stripClientClipUid(clip) {
  if (!clip || typeof clip !== "object") return clip;
  const { client_clip_uid, ...rest } = clip;
  return rest;
}
