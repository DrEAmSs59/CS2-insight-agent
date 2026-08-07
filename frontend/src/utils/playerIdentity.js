import { steamIdForPlayer } from "./playerAppearance.js";

export function playerDisplayName(player) {
  if (typeof player === "string") return player.trim();
  return String(player?.display_name || player?.name || player?.player_name || "").trim();
}

export function playerIdentityKey(player) {
  if (typeof player === "string") return player.trim();
  const explicit = String(player?.player_key || "").trim();
  if (explicit) return explicit;
  const steamid = steamIdForPlayer(player);
  if (steamid) return `steamid:${steamid}`;
  const userId = String(player?.user_id ?? "").trim();
  if (userId) return `userid:${userId}`;
  return playerDisplayName(player);
}

export function playerIdentitySuffix(player) {
  const steamid = steamIdForPlayer(player);
  if (steamid) return steamid.slice(-8);
  const key = playerIdentityKey(player);
  return key.startsWith("userid:") ? key.slice("userid:".length) : "";
}
