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

function segmentOverlapsPicks(sr, er, pickSet) {
  const lo = Math.min(sr, er);
  const hi = Math.max(sr, er);
  for (let r = lo; r <= hi; r++) {
    if (pickSet.has(r)) return true;
  }
  return false;
}

function setsEqualSorted(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
 * 按勾选回合从整局/多段合辑中切出子 clip（与 main 行为一致：不必先重解析）。
 * 依赖 source_rounds + source_round_ends（新解析）；旧缓存无 ends 时按单回合段处理。
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
  const pickSet = new Set(picks);
  const rawTicks = Array.isArray(clip.source_ticks) ? clip.source_ticks : [];
  const roundsStart = Array.isArray(clip.source_rounds) ? clip.source_rounds : [];
  const roundsEnd = Array.isArray(clip.source_round_ends) ? clip.source_round_ends : [];
  if (!rawTicks.length) {
    return { ok: false, error: "合辑缺少 source_ticks，无法按回合筛选。" };
  }

  const indices = [];
  for (let i = 0; i < rawTicks.length; i++) {
    let sr = parseInt(String(roundsStart[i]), 10);
    if (!Number.isFinite(sr) || sr <= 0) sr = 1;
    let er = i < roundsEnd.length ? parseInt(String(roundsEnd[i]), 10) : NaN;
    if (!Number.isFinite(er) || er <= 0) er = sr;
    if (segmentOverlapsPicks(sr, er, pickSet)) indices.push(i);
  }

  if (!indices.length) {
    return { ok: false, error: "所选回合与合辑片段无交集，请调整勾选或重新解析。" };
  }

  if (rawTicks.length === 1 && indices.length === 1 && indices[0] === 0) {
    const i = 0;
    let sr = parseInt(String(roundsStart[i]), 10);
    if (!Number.isFinite(sr) || sr <= 0) sr = 1;
    let er = i < roundsEnd.length ? parseInt(String(roundsEnd[i]), 10) : NaN;
    if (!Number.isFinite(er) || er <= 0) er = sr;
    const lo = Math.min(sr, er);
    const hi = Math.max(sr, er);
    if (hi > lo) {
      const spanN = hi - lo + 1;
      const pickedInSpan = picks.filter((p) => p >= lo && p <= hi);
      const uniqPick = new Set(pickedInSpan);
      if (uniqPick.size > 0 && uniqPick.size < spanN) {
        return {
          ok: false,
          error:
            "该合辑为单段跨多回合数据，无法只入其中几回合。请重新解析该 Demo（新版解析器会为每段写入回合跨度）后再试。",
        };
      }
    }
  }

  const fullIdx = [...Array(rawTicks.length).keys()];
  const keptAllSegments =
    indices.length === fullIdx.length && indices.every((v, j) => v === fullIdx[j]);
  const filterNorm = normalizePositiveIntRounds(clip.freeze_to_death_round_filter, 64);
  const unionRounds = (() => {
    const s = new Set();
    for (let i = 0; i < rawTicks.length; i++) {
      let sr = parseInt(String(roundsStart[i]), 10);
      if (!Number.isFinite(sr) || sr <= 0) sr = 1;
      let er = i < roundsEnd.length ? parseInt(String(roundsEnd[i]), 10) : NaN;
      if (!Number.isFinite(er) || er <= 0) er = sr;
      const lo = Math.min(sr, er);
      const hi = Math.max(sr, er);
      for (let r = lo; r <= hi; r++) s.add(r);
    }
    return [...s].sort((a, b) => a - b);
  })();

  if (keptAllSegments) {
    if (filterNorm.length > 0 && setsEqualSorted(filterNorm, picks)) {
      return { ok: true, clip: { ...clip } };
    }
    if (clip.freeze_to_death_round_filter == null && setsEqualSorted(unionRounds, picks)) {
      return { ok: true, clip: { ...clip } };
    }
  }

  const newTicks = indices.map((i) => {
    const row = rawTicks[i];
    return [Number(row[0]), Number(row[1])];
  });
  const newSr = indices.map((i) => {
    const v = parseInt(String(roundsStart[i]), 10);
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const newEr = indices.map((i, j) => {
    const v = i < roundsEnd.length ? parseInt(String(roundsEnd[i]), 10) : NaN;
    if (Number.isFinite(v) && v > 0) return v;
    return newSr[j];
  });
  const ktls = Array.isArray(clip.kill_ticks) ? clip.kill_ticks : [];
  const newKills = indices.map((i) => {
    if (i < ktls.length) {
      const kt = Number(ktls[i]);
      if (Number.isFinite(kt)) return kt;
    }
    const seg = rawTicks[i];
    return Number(seg[0]);
  });

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
    death_tick: newKills.length ? newKills[newKills.length - 1] : clip.death_tick,
    client_clip_uid: newClientClipUid(),
  };
  return { ok: true, clip: newClip };
}
