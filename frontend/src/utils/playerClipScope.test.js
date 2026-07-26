import { describe, expect, it } from "vitest";
import { getPlayerClipScope } from "./playerClipScope";

const players = {
  sh1ro: {
    clips: [
      { client_clip_uid: "sh1ro-h1", category: "highlight" },
      { client_clip_uid: "sh1ro-f1", category: "fail" },
      { client_clip_uid: "sh1ro-m1", category: "meme_death" },
    ],
  },
  donk: {
    clips: [
      { client_clip_uid: "donk-h1", category: "highlight" },
      { client_clip_uid: "donk-h2", category: "highlight" },
    ],
  },
};

describe("getPlayerClipScope", () => {
  it("never leaks other analyzed players into the active player scope", () => {
    const scope = getPlayerClipScope(players, "sh1ro");

    expect(scope.clips.map((clip) => clip.client_clip_uid)).toEqual([
      "sh1ro-h1",
      "sh1ro-f1",
      "sh1ro-m1",
    ]);
    expect(scope.selectableClips.map((clip) => clip.client_clip_uid)).toEqual([
      "sh1ro-h1",
      "sh1ro-f1",
    ]);
    expect(scope.queueableHighlights.map((clip) => clip.client_clip_uid)).toEqual([
      "sh1ro-h1",
    ]);
  });

  it("recomputes the selection and highlight scope when the active tab changes", () => {
    const scope = getPlayerClipScope(players, "donk", new Set(["donk-h1"]));

    expect(scope.selectableClips.map((clip) => clip.client_clip_uid)).toEqual(["donk-h2"]);
    expect(scope.queueableHighlights.map((clip) => clip.client_clip_uid)).toEqual(["donk-h2"]);
  });

  it("returns an empty scope for a player without cached results", () => {
    const scope = getPlayerClipScope(players, "missing");

    expect(scope.clips).toEqual([]);
    expect(scope.selectableClips).toEqual([]);
    expect(scope.queueableHighlights).toEqual([]);
  });
});
