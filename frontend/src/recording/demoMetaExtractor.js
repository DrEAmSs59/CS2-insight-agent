export function extractDemoContext(demoPath, demoFilename, clips, matchMeta) {
  const tickRate = Number(clips?.[0]?.tick_rate) || 64;
  const mapName = matchMeta?.map_name || clips?.[0]?.map_name || "unknown";
  const finalRound = matchMeta?.total_rounds || 0;

  return {
    demo_path: demoPath,
    demo_filename: demoFilename,
    map_name: mapName,
    tick_rate: tickRate,
    first_tick: 0,
    demo_end_tick: deriveDemoEndTick(clips),
    final_round: finalRound,
    final_round_start_tick: deriveFinalRoundStartTick(clips, finalRound),
    final_round_end_tick: deriveFinalRoundEndTick(clips, finalRound),
  };
}

export function extractRoundTickMap(clips) {
  const roundMap = {};

  if (Array.isArray(clips)) {
    clips.forEach((clip) => {
      const roundNum = clip.round;
      if (roundNum != null) {
        const freezeEndTick = clip.clip_min_tick ?? 0;
        const clipMaxTick = clip.clip_max_tick ?? 0;

        if (!roundMap[roundNum]) {
          roundMap[roundNum] = { freeze_end_tick: freezeEndTick, clip_max_tick: clipMaxTick };
        } else {
          roundMap[roundNum].freeze_end_tick = Math.max(roundMap[roundNum].freeze_end_tick, freezeEndTick);
          roundMap[roundNum].clip_max_tick = Math.max(roundMap[roundNum].clip_max_tick, clipMaxTick);
        }
      }

      if (Array.isArray(clip.freeze_to_death_round_windows)) {
        clip.freeze_to_death_round_windows.forEach((window) => {
          const winRound = window.round;
          if (winRound != null) {
            const freezeEndTick = window.freeze_end_tick ?? 0;
            const endTick = window.end_tick ?? 0;

            if (!roundMap[winRound]) {
              roundMap[winRound] = { freeze_end_tick: freezeEndTick, clip_max_tick: endTick };
            } else {
              roundMap[winRound].freeze_end_tick = Math.max(roundMap[winRound].freeze_end_tick, freezeEndTick);
              roundMap[winRound].clip_max_tick = Math.max(roundMap[winRound].clip_max_tick, endTick);
            }
          }
        });
      }
    });
  }

  return roundMap;
}

export function extractTargetPlayer(matchMeta, fallbackName) {
  return {
    name: matchMeta?.target_player || fallbackName || "",
    steamid64: matchMeta?.target_steam_id || "",
  };
}

function deriveDemoEndTick(clips) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return 0;
  }

  const maxTick = Math.max(
    ...clips.map((c) => c.clip_max_tick || c.end_tick || 0)
  );

  return Math.max(maxTick, 0);
}

function deriveFinalRoundStartTick(clips, finalRound) {
  if (finalRound == null || !Array.isArray(clips) || clips.length === 0) {
    return 0;
  }

  for (const clip of clips) {
    if (clip.round === finalRound && clip.clip_min_tick > 0) {
      return clip.clip_min_tick;
    }
  }

  for (const clip of clips) {
    if (Array.isArray(clip.freeze_to_death_round_windows)) {
      const window = clip.freeze_to_death_round_windows.find((w) => w.round === finalRound);
      if (window && window.freeze_end_tick > 0) {
        return window.freeze_end_tick;
      }
    }
  }

  return 0;
}

function deriveFinalRoundEndTick(clips, finalRound) {
  if (finalRound == null || !Array.isArray(clips) || clips.length === 0) {
    return 0;
  }

  for (const clip of clips) {
    if (clip.round === finalRound && clip.clip_max_tick > 0) {
      return clip.clip_max_tick;
    }
  }

  for (const clip of clips) {
    if (Array.isArray(clip.freeze_to_death_round_windows)) {
      const window = clip.freeze_to_death_round_windows.find((w) => w.round === finalRound);
      if (window && window.end_tick > 0) {
        return window.end_tick;
      }
    }
  }

  return 0;
}
