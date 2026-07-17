/** Map recorded_clips API rows → LiteCut media bin items. */

const CAT_LABEL = {
  highlight: "高光",
  fail: "下饭",
  compilation: "合集",
  timeline: "时间线",
  meme_death: "梗死亡",
};

function buildClipTitle(row) {
  const category = String(row.category || row.workbench_clip_kind || "").toLowerCase();
  const map = String(row.map_name || row.map || "").trim();
  const player = String(row.player_name || row.player || "").trim();
  const round = row.round;
  const parts = [];
  if (CAT_LABEL[category]) parts.push(CAT_LABEL[category]);
  if (map) parts.push(map.replace(/^de_/, ""));
  if (round != null && round !== "") parts.push(`R${round}`);
  if (player) parts.push(player);
  if (parts.length) return parts.join(" · ");
  const out = String(row.output_path || "").trim();
  if (out) {
    const base = out.split(/[/\\]/).pop() || out;
    return base.replace(/\.[^.]+$/, "") || base;
  }
  const demo = String(row.demo_filename || row.demo_path || "").trim();
  if (demo) return demo.replace(/\.dem$/i, "");
  return `Clip #${row.id}`;
}

export function mapRecordedClipRow(row) {
  if (!row || typeof row !== "object") return null;
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  const category = String(row.category || row.workbench_clip_kind || "highlight").toLowerCase();
  const map = String(row.map_name || row.map || "").trim() || "—";
  const player = String(row.player_name || row.player || "—").trim();
  const title = buildClipTitle({ ...row, id });
  const duration = Number(row.duration_sec);
  return {
    id,
    mediaKind: "recorded",
    title,
    player,
    map,
    category,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    round: row.round ?? null,
    score: row.ai_score ?? null,
    ai: row.ai_comment || row.ai_commentary || null,
    tags: Array.isArray(row.context_tags)
      ? row.context_tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
      : [],
    _raw: row,
  };
}

export function reconcileRecordedClipDuration(items, clipId, durationSec) {
  const id = Number(clipId);
  const duration = Number(durationSec);
  if (!Number.isFinite(id) || !Number.isFinite(duration) || duration <= 0.05) return items;
  let changed = false;
  const next = (items || []).map((item) => {
    if (Number(item?.id) !== id || Math.abs((Number(item?.duration) || 0) - duration) <= 0.05) return item;
    changed = true;
    return {
      ...item,
      duration,
      _raw: { ...(item._raw || {}), duration_sec: duration },
    };
  });
  return changed ? next : items;
}
