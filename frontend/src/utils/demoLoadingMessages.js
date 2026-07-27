export const COMMON_DEMO_LOADING_MESSAGE_KEYS = Object.freeze([
  "demoLoading.validatingHeader",
  "demoLoading.indexingTicks",
  "demoLoading.aligningRoundClocks",
  "demoLoading.rebuildingScoreboard",
  "demoLoading.identifyingSides",
  "demoLoading.mappingSteamIds",
  "demoLoading.unpackingRustEvents",
  "demoLoading.warmingParser",
  "demoLoading.decodingSmokeVoxels",
  "demoLoading.tracingSmokeEdges",
  "demoLoading.mappingGrenades",
  "demoLoading.calculatingTrajectories",
  "demoLoading.restoringBombState",
  "demoLoading.scanningOpeningDuels",
  "demoLoading.markingTrades",
  "demoLoading.findingMultikills",
  "demoLoading.sortingKillfeed",
  "demoLoading.connectingAssists",
  "demoLoading.filteringWarmup",
  "demoLoading.calibratingRadar",
  "demoLoading.buildingReplay",
  "demoLoading.compressingFrames",
  "demoLoading.buildingHeatmap",
  "demoLoading.inspectingEconomy",
  "demoLoading.locatingMomentum",
  "demoLoading.labelingTactics",
  "demoLoading.collectingHighlights",
  "demoLoading.organizingPov",
  "demoLoading.summarizingRounds",
  "demoLoading.countingWeapons",
  "demoLoading.verifyingCache",
  "demoLoading.polishingReport",
]);

export const DESKTOP_DEMO_LOADING_MESSAGE_KEYS = Object.freeze([
  "demoLoading.renderingTauriFrontend",
  "demoLoading.syncingRustShell",
]);

export const AI_DEMO_LOADING_MESSAGE_KEYS = Object.freeze([
  "demoLoading.loadingOpenAiModel",
  "demoLoading.briefingAiReviewer",
]);

export function getDemoLoadingMessageKeys({ aiEnabled = false, desktop = false } = {}) {
  return [
    ...COMMON_DEMO_LOADING_MESSAGE_KEYS,
    ...(desktop ? DESKTOP_DEMO_LOADING_MESSAGE_KEYS : []),
    ...(aiEnabled ? AI_DEMO_LOADING_MESSAGE_KEYS : []),
  ];
}

export function pickNextDemoLoadingMessageKey(keys, currentKey = "", random = Math.random) {
  if (!Array.isArray(keys) || keys.length === 0) return "";
  if (keys.length === 1) return keys[0];

  const currentIndex = keys.indexOf(currentKey);
  if (currentIndex < 0) {
    return keys[Math.floor(random() * keys.length) % keys.length];
  }

  // Choose an offset instead of another absolute index so the same line can
  // never appear twice in a row, even with deterministic or mocked randomness.
  const offset = 1 + (Math.floor(random() * (keys.length - 1)) % (keys.length - 1));
  return keys[(currentIndex + offset) % keys.length];
}
