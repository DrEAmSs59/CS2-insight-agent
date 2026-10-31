import { playerIdentityKey } from "../../../utils/playerIdentity.js";

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

// Keep in sync with MATCH_WORKSPACE_ALGORITHM_VERSION in match_workspace.py.
// Keep this cache check aligned with the Free backend workspace version.
export const DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION = "match-workspace-2026.09.19-keyboard-input-v2";

export function hasCurrentDemoAnalysisVersion(result) {
  const workspace = result?.analysis_workspace;
  return Boolean(
    workspace?.version
    && workspace.algorithm_version === DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION,
  );
}

export function demoAnalysisRoster(demo) {
  const seen = new Set();
  const names = [];
  for (const player of Array.isArray(demo?.players) ? demo.players : []) {
    const name = playerIdentityKey(player);
    const key = normalizedName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function hasCompleteCachedDemoAnalysis(demo) {
  const roster = demoAnalysisRoster(demo);
  if (!roster.length) return false;

  const result = demo?.cached_result;
  const cachedPlayers = result?.players;
  const workspace = result?.analysis_workspace;
  if (
    !cachedPlayers
    || typeof cachedPlayers !== "object"
    || Array.isArray(cachedPlayers)
    || !workspace
    || typeof workspace !== "object"
    || !hasCurrentDemoAnalysisVersion(result)
    || !Array.isArray(workspace.rounds)
    || !workspace.rounds.length
  ) {
    return false;
  }

  const cachedNames = new Set(
    Object.entries(cachedPlayers)
      .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
      .map(([name]) => normalizedName(name))
      .filter(Boolean),
  );
  return roster.every((name) => cachedNames.has(normalizedName(name)));
}

export function buildPendingDemoAnalysisSpecs(demos) {
  return (Array.isArray(demos) ? demos : [])
    .map((demo, index) => ({ index, players: demoAnalysisRoster(demo) }))
    .filter((spec) => spec.players.length > 0 && !hasCompleteCachedDemoAnalysis(demos[spec.index]));
}
