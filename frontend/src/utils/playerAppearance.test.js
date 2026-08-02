import { describe, expect, test } from "vitest";
import { playerAppearance, playerColorKey, steamIdForPlayer } from "./playerAppearance.js";

describe("playerAppearance", () => {
  test("normalizes Demo color names and numeric slots", () => {
    expect(playerColorKey({ player_color: "Purple" })).toBe("purple");
    expect(playerColorKey({ player_color: 1 })).toBe("green");
    expect(playerColorKey({ player_color: 9 })).toBe("");
  });

  test("uses Demo color before the team fallback", () => {
    expect(playerAppearance({ player_color: "orange" }, "blue")).toEqual({
      color: "var(--cs2-player-orange)",
      background: "var(--cs2-player-orange-soft)",
      source: "demo",
    });
    expect(playerAppearance({}, "amber").source).toBe("team");
  });

  test("only accepts plausible SteamID64 values", () => {
    expect(steamIdForPlayer({ steam_id64: "76561198000000001" })).toBe("76561198000000001");
    expect(steamIdForPlayer({ steam_id64: "17" })).toBe("");
  });
});
