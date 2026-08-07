import { describe, expect, it } from "vitest";

import { playerDisplayName, playerIdentityKey, playerIdentitySuffix } from "./playerIdentity.js";

describe("player identity", () => {
  it("keeps identical display names distinct by SteamID", () => {
    const first = { name: "same", steam_id64: "76561198000000001" };
    const second = { name: "same", steam_id64: "76561198000000002" };

    expect(playerDisplayName(first)).toBe("same");
    expect(playerDisplayName(second)).toBe("same");
    expect(playerIdentityKey(first)).toBe("steamid:76561198000000001");
    expect(playerIdentityKey(second)).toBe("steamid:76561198000000002");
    expect(playerIdentitySuffix(first)).toBe("00000001");
    expect(playerIdentitySuffix(second)).toBe("00000002");
  });
});
