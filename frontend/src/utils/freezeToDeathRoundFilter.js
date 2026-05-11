import { newClientClipUid } from "./clipClientUid";

/** @param {any} clip */
export function isFreezeToDeathCompilation(clip) {
  return clip?.category === "compilation" && clip?.compilation_kind === "freeze_to_death";
}

/** @param {unknown[]|null|undefined} arr @param {number} maxRounds */
function normalizePositiveIntRounds(arr, maxRounds = 64) {
  const n = Math.max(1, Math.min(64, Number(maxRounds) || 1));
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return [
    ...new Set(
      arr
        .map((x) => parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x) && x > 0 && x <= n)
    ),
  ].sort((a, b) => a - b);
}

/** 与后端 CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC 默认 0.45s 对齐（64 tick/s） */
const _FTD_CLIP_MAX_BUF_TICKS = Math.round(0.45 * 64);

/**
 * 从解析结果片段上的 freeze_to_death_round_filter 还原勾选。
 * @param {number[]|null|undefined} filter
 * @param {number} [maxRounds] filter 为 null（整局合辑）时展开为 1…maxRounds，与 main 一致：用户可「全选后取消勾选」再入队
 * @returns {{ picked: number[] }}
 */
export function freezeToDeathDraftFromClipFilter(filter, maxRounds = 24) {
  const n = Math.max(1, Math.min(64, Number(maxRounds) || 1));
  if (filter == null) {
    return { picked: Array.from({ length: n }, (_, i) => i + 1) };
  }
  if (!Array.isArray(filter) || filter.length === 0) {
    return { picked: [] };
  }
  return { picked: normalizePositiveIntRounds(filter, n) };
}

function formatRoundListCompact(rounds) {
  if (!rounds.length) return "整局";
  if (rounds.length <= 4) return rounds.map((r) => `R${r}`).join("·");
  return `R${rounds[0]}–R${rounds[rounds.length - 1]}（${rounds.length} 回合）`;
}

/**
 * 队列/检查器一行：回合死亡合集回合展示（勿用 clip.round，整局合辑常为 R1）。
 * @param {{ freezeToDeathQueueRounds?: number[] }} item
 * @param {any} clip
 */
export function freezeToDeathQueueRoundBadgeText(item, clip) {
  if (!isFreezeToDeathCompilation(clip)) return null;
  const fromClip = normalizePositiveIntRounds(clip.freeze_to_death_round_filter, 64);
  if (fromClip.length) {
    return formatRoundListCompact(fromClip);
  }
  const q = item?.freezeToDeathQueueRounds;
  const fromQ = normalizePositiveIntRounds(Array.isArray(q) ? q : [], 64);
  if (fromQ.length) {
    return formatRoundListCompact(fromQ);
  }
  return "整局";
}

/**
 * 按勾选从解析器下发的 `freeze_to_death_round_windows` 重建 source_ticks（精确 freeze 起点），
 * 连续回合合并为一段，与 demo_parser 段合并规则一致；无需重新解析。
 * @param {any} clip
 * @param {number[]} pickedSorted
 * @returns {{ ok: true, clip: any } | { ok: false, error: string }}
 */
export function sliceFreezeToDeathClipForEnqueue(clip, pickedSorted) {
  if (!isFreezeToDeathCompilation(clip)) {
    return { ok: true, clip: { ...clip } };
  }
  const picks = normalizePositiveIntRounds(pickedSorted, 64);
  if (!picks.length) {
    return { ok: false, error: "「回合合集」须至少勾选一个回合才能加入队列。" };
  }
  const wins = clip.freeze_to_death_round_windows;
  if (!Array.isArray(wins) || wins.length === 0) {
    return {
      ok: false,
      error: "该回合合集缺少 per-round 窗口数据，请重新解析本玩家一次后再入队。",
    };
  }

  const pickSet = new Set(picks);
  const filtered = wins
    .map((w) => ({
      round: parseInt(String(w.round), 10),
      freeze_end_tick: parseInt(String(w.freeze_end_tick), 10),
      start_tick: parseInt(String(w.start_tick), 10),
      end_tick: parseInt(String(w.end_tick), 10),
      death_tick:
        w.death_tick != null && String(w.death_tick).trim() !== ""
          ? parseInt(String(w.death_tick), 10)
          : null,
    }))
    .filter(
      (w) =>
        Number.isFinite(w.round) &&
        w.round > 0 &&
        pickSet.has(w.round) &&
        Number.isFinite(w.start_tick) &&
        Number.isFinite(w.end_tick) &&
        w.end_tick > w.start_tick &&
        Number.isFinite(w.freeze_end_tick)
    )
    .sort((a, b) => a.round - b.round);

  if (!filtered.length) {
    return { ok: false, error: "所选回合与合辑片段无交集，请调整勾选或重新解析。" };
  }

  /** @type {{ loR: number, hiR: number, s: number, e: number, death: number|null, freezeLo: number }[]} */
  const merged = [];
  let buf = null;
  for (const w of filtered) {
    if (!buf) {
      buf = {
        loR: w.round,
        hiR: w.round,
        s: w.start_tick,
        e: w.end_tick,
        death: Number.isFinite(w.death_tick) ? w.death_tick : null,
        freezeLo: w.freeze_end_tick,
      };
      continue;
    }
    if (w.round === buf.hiR + 1) {
      buf.hiR = w.round;
      buf.e = w.end_tick;
      if (Number.isFinite(w.death_tick)) buf.death = w.death_tick;
    } else {
      merged.push(buf);
      buf = {
        loR: w.round,
        hiR: w.round,
        s: w.start_tick,
        e: w.end_tick,
        death: Number.isFinite(w.death_tick) ? w.death_tick : null,
        freezeLo: w.freeze_end_tick,
      };
    }
  }
  if (buf) merged.push(buf);

  const newTicks = [];
  const newSr = [];
  const newEr = [];
  const newKills = [];
  for (const m of merged) {
    newTicks.push([m.s, m.e]);
    newSr.push(m.loR);
    newEr.push(m.hiR);
    const kt =
      m.death != null && Number.isFinite(m.death)
        ? m.death
        : Math.max(m.s, m.e - 1);
    newKills.push(kt);
  }

  let lastRealDeath = null;
  for (let i = merged.length - 1; i >= 0; i--) {
    const d = merged[i].death;
    if (d != null && Number.isFinite(d)) {
      lastRealDeath = d;
      break;
    }
  }

  const newClip = {
    ...clip,
    source_ticks: newTicks,
    source_rounds: newSr,
    source_round_ends: newEr,
    kill_ticks: newKills,
    start_tick: newTicks[0][0],
    end_tick: newTicks[newTicks.length - 1][1],
    round: newSr[0],
    freeze_to_death_round_filter: [...picks],
    death_tick: lastRealDeath != null ? lastRealDeath : clip.death_tick,
    clip_min_tick: merged[0].freezeLo,
    clip_max_tick:
      lastRealDeath != null ? lastRealDeath + _FTD_CLIP_MAX_BUF_TICKS : clip.clip_max_tick,
    client_clip_uid: newClientClipUid(),
    freeze_to_death_round_windows: clip.freeze_to_death_round_windows,
  };
  if (
    newClip.clip_max_tick != null &&
    Number.isFinite(newClip.clip_max_tick) &&
    newClip.end_tick > newClip.clip_max_tick
  ) {
    newClip.end_tick = newClip.clip_max_tick;
  }
  return { ok: true, clip: newClip };
}
