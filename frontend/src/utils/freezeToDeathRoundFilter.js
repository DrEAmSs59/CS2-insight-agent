/** @param {any} clip */
export function isFreezeToDeathCompilation(clip) {
  return clip?.category === "compilation" && clip?.compilation_kind === "freeze_to_death";
}

/**
 * 从解析结果片段上的 freeze_to_death_round_filter 还原勾选。
 * @param {number[]|null|undefined} filter
 * @param {number} [maxRounds] 用于旧数据 filter 为 null（表示整局）时展开为 1…maxRounds
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
  const picked = [
    ...new Set(
      filter
        .map((x) => parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x) && x > 0 && x <= n)
    ),
  ].sort((a, b) => a - b);
  return { picked };
}
