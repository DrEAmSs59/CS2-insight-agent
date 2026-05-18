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

/** 死后固定留白（与 demo_parser 默认 _FREEZE_TO_DEATH_POST_DEATH_SEC 2.0s 一致） */
const POST_DEATH_AFTER_DEATH_SEC = 2;

/**
 * 与 demo_parser `_FREEZE_TO_DEATH_PRE_FREEZE_SEC` / `CS2_INSIGHT_FREEZE_TO_DEATH_PRE_SEC` 默认 8s 一致。
 * 下回合 `start_tick` = 该回合 `freeze_end − pre`，仍在「下回合」时间线；有死亡回合再减 **一段 pre**：
 * `end <= next_start − pre − 1`。
 * **无死亡**回合在技术暂停 / 冻结期易出现 HUD 已切下回合而 tick 未到 `next_start`，再减 **一段 pre**：
 * `end <= next_start − 2*pre − 1`（仅当存在 `next_start` 时；仅有 `next_freeze_end` 时用 `fe − 3*pre − 1`）。
 */
const NEXT_ROUND_PRE_FREEZE_SEC = 8;

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
 * 按勾选从解析器下发的 `freeze_to_death_round_windows` 重建 source_ticks（精确 freeze 起点）。
 * 每个勾选回合独立一段，**不**合并连续回合，以便死亡回合在死后留白后 pause/seek 进入下一段。
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

  const allWindows = wins
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
        Number.isFinite(w.freeze_end_tick) &&
        Number.isFinite(w.start_tick) &&
        Number.isFinite(w.end_tick) &&
        w.end_tick > w.start_tick
    )
    .sort((a, b) => a.round - b.round);

  /** 下一真实回合的 start_tick（`freeze_end(N+1) − pre`，含未勾选回合） */
  const nextStartByRound = new Map();
  /** 下一真实回合的 freeze_end_tick（用于「freeze_end − 尾量」上界，比 start_tick 更贴近 HUD） */
  const nextFreezeEndByRound = new Map();
  for (let i = 0; i < allWindows.length - 1; i += 1) {
    const cur = allWindows[i];
    const next = allWindows[i + 1];
    if (cur && next && Number.isFinite(cur.round)) {
      if (Number.isFinite(next.start_tick)) {
        nextStartByRound.set(cur.round, next.start_tick);
      }
      if (Number.isFinite(next.freeze_end_tick)) {
        nextFreezeEndByRound.set(cur.round, next.freeze_end_tick);
      }
    }
  }

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

  const tickRate = Number(clip.tick_rate ?? clip.tickRate ?? 64) || 64;
  const postDeathTicks = Math.round(POST_DEATH_AFTER_DEATH_SEC * tickRate);
  const preFreezeTicks = Math.round(NEXT_ROUND_PRE_FREEZE_SEC * tickRate);

  const newTicks = [];
  const newSr = [];
  const newEr = [];
  const newKills = [];
  const newDeathTicks = [];
  let firstFreezeLo = null;

  for (const w of filtered) {
    const startTick = w.start_tick;
    const rawEndTick = w.end_tick;
    const deathTick = w.death_tick;

    let endTick = rawEndTick;
    if (deathTick != null && Number.isFinite(deathTick)) {
      endTick = Math.min(endTick, deathTick + postDeathTicks);
    }
    const hasDeath = deathTick != null && Number.isFinite(deathTick);
    const nextRoundStartTick = nextStartByRound.get(w.round);
    const nextFe = nextFreezeEndByRound.get(w.round);
    let crossRoundCap = null;
    if (Number.isFinite(nextRoundStartTick)) {
      const preMul = hasDeath ? 1 : 2;
      crossRoundCap = nextRoundStartTick - preMul * preFreezeTicks - 1;
    } else if (Number.isFinite(nextFe)) {
      const preMul = hasDeath ? 2 : 3;
      crossRoundCap = nextFe - preMul * preFreezeTicks - 1;
    }
    if (crossRoundCap != null && crossRoundCap > startTick) {
      endTick = Math.min(endTick, crossRoundCap);
    }

    if (!Number.isFinite(endTick)) continue;
    if (endTick <= startTick) continue;

    if (firstFreezeLo === null) firstFreezeLo = w.freeze_end_tick;

    const s0 = Math.floor(startTick);
    const e0 = Math.floor(endTick);
    if (e0 <= s0) continue;
    newTicks.push([s0, e0]);
    newSr.push(w.round);
    newEr.push(w.round);
    if (deathTick != null && Number.isFinite(deathTick)) {
      const dt = Math.floor(deathTick);
      newKills.push(dt);
      newDeathTicks.push(dt);
    }
  }

  if (!newTicks.length) {
    return { ok: false, error: "所选回合与合辑片段无交集，请调整勾选或重新解析。" };
  }

  const lastRoundNum = picks[picks.length - 1];
  const lastWin = filtered.find((w) => w.round === lastRoundNum);
  const lastSelectedDeathTick =
    lastWin != null &&
    lastWin.death_tick != null &&
    String(lastWin.death_tick).trim() !== "" &&
    Number.isFinite(lastWin.death_tick)
      ? Math.floor(lastWin.death_tick)
      : null;

  const maxSegEnd = newTicks.reduce((m, [, e]) => Math.max(m, e), 0);

  if (import.meta.env.DEV) {
    console.info("[freeze-to-death enqueue]", {
      pickedRounds: picks,
      nextStartByRound: Object.fromEntries(nextStartByRound),
      nextFreezeEndByRound: Object.fromEntries(nextFreezeEndByRound),
      preFreezeTicks,
      sourceTicks: newTicks,
      sourceRounds: newSr,
      sourceRoundEnds: newEr,
      deathTicks: newDeathTicks,
      killTicks: newKills,
      topLevelDeathTick: lastSelectedDeathTick,
    });
  }

  const newClip = {
    ...clip,
    source_ticks: newTicks,
    source_rounds: newSr,
    source_round_ends: newEr,
    kill_ticks: newKills,
    death_ticks: newDeathTicks,
    start_tick: newTicks[0][0],
    end_tick: newTicks[newTicks.length - 1][1],
    round: newSr[0],
    freeze_to_death_round_filter: [...picks],
    death_tick: lastSelectedDeathTick,
    clip_min_tick: firstFreezeLo ?? clip.clip_min_tick,
    clip_max_tick: maxSegEnd > 0 ? maxSegEnd : clip.clip_max_tick,
    fixed_segment_pacing: true,
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
