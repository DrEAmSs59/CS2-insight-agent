/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { TextEncoder } from "node:util";
import { applyRecordingPlayerAliases, hasInvalidPlayerAliases, playerAliasError, playerAliasMaps, recordingAliasDemoTargets } from "./playerAliases.js";
globalThis.TextEncoder ||= TextEncoder;

describe("player aliases", () => {
  it("preserves Unicode, spacing, duplicate names and precision-safe identities", () => {
    const value = { enabled: true, drafts: { a: { "76561199032006224": " 京介 🦋 ", "76561199032006225": " 京介 🦋 ", "1": "" } } };
    expect(playerAliasMaps(value)).toEqual({ a: { "76561199032006224": " 京介 🦋 ", "76561199032006225": " 京介 🦋 " } });
    expect(playerAliasMaps({ ...value, enabled: false })).toEqual({});
    for (const name of ['<name>&"', "Умри", "中文", "🦋".repeat(16), "a".repeat(32)]) expect(playerAliasError(name)).toBe("");
  });
  it("rejects control chars, lone surrogates and oversized names", () => {
    for (const name of ["a\0b", "a\nb", "a\tb", "\ud800", "a".repeat(33), "🦋".repeat(17)]) expect(playerAliasError(name)).not.toBe("");
    expect(hasInvalidPlayerAliases({ enabled: true, drafts: { a: { "1": "x\ny" } } })).toBe(true);
  });
  it("isolates each demo and leaves source DTOs untouched", () => {
    const requests = ["/a/match.dem", "/b/match.dem", "/a/match.dem"].map((path) => ({ demo: { demo_path: path, demo_filename: "match.dem" } }));
    expect(recordingAliasDemoTargets(requests)).toHaveLength(2);
    const next = applyRecordingPlayerAliases(requests, { "/a/match.dem": { "1": "甲" } });
    expect(next[0].player_aliases).toEqual({ "1": "甲" });
    expect(next[2].player_aliases).toEqual(next[0].player_aliases);
    expect(next[1]).not.toHaveProperty("player_aliases");
    expect(requests[0]).not.toHaveProperty("player_aliases");
  });
  it("adds team names and stable player sides to display targets without changing recording requests", () => {
    const requests = [{ demo: { demo_path: "/a.dem", demo_filename: "a.dem" }, source_ref: { queue_item_id: "q1" } }];
    const queue = [{ id: "q1", matchMeta: { team_a_name: "Vitality", team_b_name: "NAVI", all_players: [
      { steamid64: "76561199032006224", team_num: 2 },
      { steamid64: "76561199032006225", team_num: 3 },
    ] } }];
    const [target] = recordingAliasDemoTargets(requests, queue);
    expect(target.teamNames).toEqual({ 2: "Vitality", 3: "NAVI" });
    expect(target.playerTeams).toEqual({ "76561199032006224": 2, "76561199032006225": 3 });
    expect(requests[0].demo).toEqual({ demo_path: "/a.dem", demo_filename: "a.dem" });
    expect(recordingAliasDemoTargets(requests)[0]).not.toHaveProperty("teamNames");
  });
});
