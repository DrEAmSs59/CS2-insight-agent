import { useEffect, useMemo, useState } from "react";
import API from "../api/api";
import { steamIdForPlayer } from "../utils/playerAppearance.js";

function requestAvatars(requestKey) {
  return API.get("/steam/player-avatars", { params: { steam_ids: requestKey } })
    .then((response) => response?.data?.avatars || {})
    .catch(() => ({}));
}

export function useSteamPlayerAvatars(players) {
  const requestKey = useMemo(() => [...new Set(
    (Array.isArray(players) ? players : [])
      .map(steamIdForPlayer)
      .filter(Boolean),
  )].slice(0, 10).join(","), [players]);
  const [avatars, setAvatars] = useState({});

  useEffect(() => {
    if (!requestKey) {
      setAvatars({});
      return undefined;
    }
    let cancelled = false;
    requestAvatars(requestKey).then((next) => {
      if (!cancelled) setAvatars(next);
    });
    return () => { cancelled = true; };
  }, [requestKey]);

  return avatars;
}
