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
});
