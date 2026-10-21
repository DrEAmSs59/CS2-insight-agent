import { newClientClipUid } from "./clipClientUid";
import { readRoundFacts, selectedRoundFacts, withoutLegacyRoundWindows } from "../recording/roundCompilation";

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

/**
 * Formats a list of selected rounds into a display string via i18n.
 * @param {number[]} rounds sorted round numbers
 * @param {(key: string, params?: object) => string} t
 */
function formatRoundListCompact(rounds, t) {
  if (!rounds.length) return t("ftd.wholeMatch");
  if (rounds.length <= 4) return rounds.map((r) => `R${r}`).join("·");
  return t("ftd.roundRange", { first: rounds[0], last: rounds[rounds.length - 1], n: rounds.length });
}

/**
 * 队列/检查器一行：回合死亡合集回合展示（勿用 clip.round，整局合辑常为 R1）。
 * @param {{ freezeToDeathQueueRounds?: number[] }} item
 * @param {any} clip
 * @param {(key: string, params?: object) => string} t
 */
export function freezeToDeathQueueRoundBadgeText(item, clip, t) {
  if (!isFreezeToDeathCompilation(clip)) return null;
  const fromClip = normalizePositiveIntRounds(clip.freeze_to_death_round_filter, 64);
  if (fromClip.length) {
    return formatRoundListCompact(fromClip, t);
  }
  const q = item?.freezeToDeathQueueRounds;
  const fromQ = normalizePositiveIntRounds(Array.isArray(q) ? q : [], 64);
  if (fromQ.length) {
    return formatRoundListCompact(fromQ, t);
  }
  return t("ftd.wholeMatch");
}

/** Keep round selection only. The backend computes all capture windows. */
export function sliceFreezeToDeathClipForEnqueue(clip, pickedSorted) {
  if (!isFreezeToDeathCompilation(clip)) return { ok: true, clip: { ...clip } };
  const picks = normalizePositiveIntRounds(pickedSorted, 64);
  if (!picks.length) return { ok: false, errorKey: "ftd.errorNeedsRound" };
  try {
    const facts = readRoundFacts(clip);
    const selected = selectedRoundFacts({ ...clip, freeze_to_death_round_filter: picks }, facts);
    return { ok: true, clip: {
      ...withoutLegacyRoundWindows(clip),
      round: selected[0].round,
      round_facts: facts,
      // Preserve read-only fallback metadata for old cached analyses only.
      ...(clip.freeze_to_death_round_windows ? { freeze_to_death_round_windows: clip.freeze_to_death_round_windows } : {}),
      freeze_to_death_round_filter: picks,
      client_clip_uid: newClientClipUid(),
    } };
  } catch (error) { return { ok: false, errorKey: error.translationKey || "ftd.errorNoWindows" }; }
}
