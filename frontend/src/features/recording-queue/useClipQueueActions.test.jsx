/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useClipQueueActions } from "./useClipQueueActions.js";

describe("useClipQueueActions player fail batching", () => {
  it("keeps raw round neighbours and the selected player's match metadata when queuing", () => {
    const clip = { clip_id: "round", client_clip_uid: "round", category: "compilation", compilation_kind: "freeze_to_death",
      round_facts: [
        { round: 1, round_start_tick: 100, freeze_end_tick: 1000, round_end_tick: 5000, death_tick: 4000 },
        { round: 2, round_start_tick: 6000, freeze_end_tick: 7000, round_end_tick: 9000, death_tick: null },
      ] };
    const meta = { total_rounds: 2, demo_end_tick: 9500, target_player: "Display name", target_steam_id: "123" };
    const parsed = { demo_filename: "match.dem", players: { playerKey: { clips: [clip], match_meta: meta } } };
    const addToQueue = vi.fn();
    const { result } = renderHook(() => useClipQueueActions({
      t: (key) => key, locale: "zh", setProgressText: vi.fn(), queue: [], addToQueue, removeByClientClipUid: vi.fn(),
      uploadedDemos: [{ filename: "match.dem" }], parsedMatches: [parsed], currentMatchIndex: 0,
      currentParsed: parsed, currentActivePlayer: "playerKey", matchMeta: meta,
      activePlayerTabs: ["playerKey"], selectedPlayers: [["playerKey"]], clips: [clip],
      freezeToDeathDraft: { picked: [1] }, selectedClientClipUids: new Set(["round"]),
      setSelectedClientClipUids: vi.fn(), currentDemoFilename: "match.dem",
    }));
    act(() => result.current.handleAddSelectedToQueue());
    const queued = addToQueue.mock.calls[0][0][0];
    expect(queued.matchMeta).toEqual(meta);
    expect(queued.clipData.round_facts).toHaveLength(2);
    expect(queued.clipData.freeze_to_death_round_filter).toEqual([1]);
    expect(queued.clipData).not.toHaveProperty("source_ticks");
  });
  it("queues only unqueued fail clips from the active player", () => {
    const highlight = { clip_id: "h1", client_clip_uid: "player-h1", category: "highlight" };
    const fail = { clip_id: "f1", client_clip_uid: "player-f1", category: "fail" };
    const queuedFail = { clip_id: "f2", client_clip_uid: "player-f2", category: "fail" };
    const otherPlayerFail = { clip_id: "f3", client_clip_uid: "other-f1", category: "fail" };
    const parsed = {
      demo_filename: "match.dem",
      demo_path: "D:\\demos\\match.dem",
      has_player_keyboard_input: false,
      players: {
        player: {
          clips: [highlight, fail, queuedFail],
          match_meta: { target_player: "Player", target_steam_id: "76561198000000001" },
        },
        other: { clips: [otherPlayerFail] },
      },
    };
    const addToQueue = vi.fn();
    const setProgressText = vi.fn();

    const { result } = renderHook(() => useClipQueueActions({
      t: (key) => key,
      locale: "zh",
      setProgressText,
      queue: [{
        demoFilename: "match.dem",
        clientClipUid: "player-f2",
        clipData: queuedFail,
      }],
      addToQueue,
      removeByClientClipUid: vi.fn(),
      uploadedDemos: [{ filename: "match.dem", path: "D:\\demos\\match.dem" }],
      parsedMatches: [parsed],
      currentMatchIndex: 0,
      currentParsed: parsed,
      currentActivePlayer: "player",
      matchMeta: {},
      activePlayerTabs: ["player"],
      selectedPlayers: [["player"]],
      clips: parsed.players.player.clips,
      freezeToDeathDraft: { picked: [] },
      selectedClientClipUids: new Set(),
      setSelectedClientClipUids: vi.fn(),
      currentDemoFilename: "match.dem",
    }));

    expect(result.current.canAddCurrentPlayerFails).toBe(true);
    act(() => result.current.handleAddCurrentPlayerFails());

    expect(addToQueue).toHaveBeenCalledTimes(1);
    const queued = addToQueue.mock.calls[0][0];
    expect(queued.map((item) => item.clientClipUid)).toEqual(["player-f1"]);
    expect(queued[0].targetPlayer).toBe("Player");
    expect(queued[0].demoHasPlayerKeyboardInput).toBe(false);
    expect(setProgressText).toHaveBeenCalledWith(
      "app.enqueuePlayerFailsDone",
      { autoDismissMs: 2000, queueLink: true },
    );
  });
});
