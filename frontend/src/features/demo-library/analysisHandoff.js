import { ensureClientClipUidsOnClips } from "../../utils/clipClientUid";
import { freezeToDeathDraftFromClipFilter } from "../../utils/freezeToDeathRoundFilter";
import { playerIdentityKey } from "../../utils/playerIdentity.js";

export function buildLoadedLibraryDemo(item, playersResult) {
  const cachedResult = item?.result || null;
  const cachedMeta = cachedResult?.match_meta || null;
  const orderedPlayers =
    Array.isArray(cachedResult?.analyzed_target_players) &&
    cachedResult.analyzed_target_players.length
      ? cachedResult.analyzed_target_players.filter(
          (name) => typeof name === "string" && name.trim(),
        )
      : null;
  const autoPlayer =
    orderedPlayers?.[0] ||
    cachedResult?.auto_target_player ||
    cachedMeta?.target_player ||
    playerIdentityKey(playersResult.players?.[0]) ||
    "";

  return {
    id: item.id,
    filename:
      (item.display_name && String(item.display_name).trim()) || item.filename,
    path: item.path,
    players: playersResult.players || [],
    match_meta: playersResult.match_meta || cachedMeta || null,
    cached_result: cachedResult,
    cached_auto_player: autoPlayer,
  };
}

function parsedMatchFromDemo(demo) {
  const result = demo.cached_result;
  if (!result) return null;

  const playerResults = result.players;
  if (playerResults && typeof playerResults === "object" && !Array.isArray(playerResults)) {
    const names = Object.keys(playerResults).filter((name) => String(name).trim());
    if (!names.length) return null;
    const players = {};
    for (const name of names) {
      const playerData = playerResults[name];
      if (!playerData || typeof playerData !== "object") continue;
      players[name] = {
        clips: ensureClientClipUidsOnClips(playerData.clips || []),
        match_meta: playerData.match_meta || result.match_meta || demo.match_meta || null,
        timeline: playerData.timeline ?? null,
        round_timeline: playerData.round_timeline ?? null,
      };
    }
    if (!Object.keys(players).length) return null;
    return {
      players,
      analysis_workspace: result.analysis_workspace ?? null,
      demo_path: demo.path,
      demo_filename: demo.filename,
    };
  }

  const autoPlayer = demo.cached_auto_player;
  if (!autoPlayer || !Array.isArray(result.clips)) return null;
  return {
    players: {
      [autoPlayer]: {
        clips: ensureClientClipUidsOnClips(result.clips || []),
        match_meta: result.match_meta || demo.match_meta || null,
        timeline: result.timeline ?? null,
        round_timeline: result.round_timeline ?? null,
      },
    },
    analysis_workspace: result.analysis_workspace ?? null,
    demo_path: demo.path,
    demo_filename: demo.filename,
  };
}

function selectedPlayersForDemo(demo, resolvedPlayers) {
  if (resolvedPlayers !== undefined) return resolvedPlayers ?? [];

  const result = demo.cached_result;
  if (result) {
    if (
      Array.isArray(result.analyzed_target_players) &&
      result.analyzed_target_players.length
    ) {
      return result.analyzed_target_players.filter(
        (name) => typeof name === "string" && name.trim(),
      );
    }
    if (result.players && typeof result.players === "object" && !Array.isArray(result.players)) {
      const names = Object.keys(result.players).filter((name) => String(name).trim());
      if (names.length) return names;
    }
    if (demo.cached_auto_player) return [demo.cached_auto_player];
  }

  return (demo.players || [])
    .map(playerIdentityKey)
    .filter((name) => typeof name === "string" && name.trim());
}

function freezeToDeathDraftForDemo(demo) {
  const result = demo.cached_result;
  if (!result) return null;

  let clips = null;
  const playerResults = result.players;
  if (playerResults && typeof playerResults === "object" && !Array.isArray(playerResults)) {
    const keys = Object.keys(playerResults).filter((key) => String(key).trim());
    const reference =
      typeof result.auto_target_player === "string" &&
      result.auto_target_player.trim() &&
      playerResults[result.auto_target_player]
        ? result.auto_target_player
        : keys[0];
    clips =
      reference && Array.isArray(playerResults[reference]?.clips)
        ? playerResults[reference].clips
        : null;
  } else {
    clips = result.clips;
  }
  if (!Array.isArray(clips)) return null;

  const compilation = clips.find(
    (clip) =>
      clip.category === "compilation" && clip.compilation_kind === "freeze_to_death",
  );
  if (!compilation) return null;
  const totalRounds = result.match_meta?.total_rounds ?? demo.match_meta?.total_rounds ?? 24;
  const maxRounds = Math.max(1, Math.min(64, Number(totalRounds) || 24));
  return freezeToDeathDraftFromClipFilter(
    compilation.freeze_to_death_round_filter,
    maxRounds,
  );
}

export function prepareLibraryAnalysisHandoff(loadedDemos, resolvedByDemoId) {
  const libraryDemoIdsByIndex = {};
  const selectedPlayers = {};
  const freezeToDeathRoundsByMatch = {};

  loadedDemos.forEach((demo, index) => {
    libraryDemoIdsByIndex[index] = demo.id;
    const hasResolvedPlayers =
      resolvedByDemoId && Object.prototype.hasOwnProperty.call(resolvedByDemoId, demo.id);
    selectedPlayers[index] = selectedPlayersForDemo(
      demo,
      hasResolvedPlayers ? resolvedByDemoId[demo.id] : undefined,
    );
    const freezeDraft = freezeToDeathDraftForDemo(demo);
    if (freezeDraft) freezeToDeathRoundsByMatch[index] = freezeDraft;
  });

  return {
    parsedMatches: loadedDemos.map(parsedMatchFromDemo),
    libraryDemoIdsByIndex,
    selectedPlayers,
    freezeToDeathRoundsByMatch,
  };
}
