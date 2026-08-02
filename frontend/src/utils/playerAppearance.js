const PLAYER_COLORS = new Set(["blue", "green", "yellow", "orange", "purple"]);

export function steamIdForPlayer(player) {
  const value = String(
    player?.steam_id64
      ?? player?.steamid64
      ?? player?.steam_id
      ?? player?.steamid
      ?? "",
  ).trim();
  return /^\d{15,20}$/.test(value) ? value : "";
}

export function playerColorKey(player) {
  const raw = String(player?.player_color ?? player?.playerColor ?? "").trim().toLowerCase();
  if (PLAYER_COLORS.has(raw)) return raw;
  if (!raw) return "";
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 && index <= 4
    ? ["blue", "green", "yellow", "orange", "purple"][index]
    : "";
}

export function playerAppearance(player, fallbackTone = "blue") {
  const color = playerColorKey(player);
  if (color) {
    return {
      color: `var(--cs2-player-${color})`,
      background: `var(--cs2-player-${color}-soft)`,
      source: "demo",
    };
  }
  const teamTone = fallbackTone === "amber" ? "amber" : "blue";
  return {
    color: `var(--cs2-team-${teamTone})`,
    background: `var(--cs2-team-${teamTone}-soft)`,
    source: "team",
  };
}
