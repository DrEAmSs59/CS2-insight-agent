const EMPTY_PLAYER_DATA = Object.freeze({});
const EMPTY_CLIPS = Object.freeze([]);
const EMPTY_QUEUED = new Set();

/**
 * Resolve every clip action to the player currently shown in the result view.
 * Keeping this boundary in one place prevents a per-player tab from silently
 * selecting or queueing clips owned by the other analyzed players.
 */
export function getPlayerClipScope(
  parsedPlayers,
  playerName,
  queuedClientClipUids = EMPTY_QUEUED,
) {
  const playerData = parsedPlayers?.[playerName];
  const safePlayerData = playerData && typeof playerData === "object"
    ? playerData
    : EMPTY_PLAYER_DATA;
  const clips = Array.isArray(safePlayerData.clips) ? safePlayerData.clips : EMPTY_CLIPS;
  const queued = queuedClientClipUids instanceof Set ? queuedClientClipUids : EMPTY_QUEUED;
  const selectableClips = clips.filter(
    (clip) =>
      clip?.client_clip_uid &&
      clip.category !== "meme_death" &&
      !queued.has(clip.client_clip_uid),
  );
  const queueableHighlights = selectableClips.filter((clip) => clip.category === "highlight");

  return {
    playerData: safePlayerData,
    clips,
    selectableClips,
    queueableHighlights,
  };
}
