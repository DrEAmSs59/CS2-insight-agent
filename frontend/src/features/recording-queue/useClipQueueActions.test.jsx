/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useClipQueueActions } from "./useClipQueueActions.js";

describe("useClipQueueActions player fail batching", () => {
  it("queues and removes whole rounds independently across players and same-named demos", () => {
    let queue = [];
    const addToQueue = (item) => { queue = [...queue, item]; };
    const removeByClientClipUid = (uid) => { queue = queue.filter((item) => item.clientClipUid !== uid); };
    const { result, rerender } = renderHook(({ player, path }) => {
      const parsed = { demo_filename: "match.dem", demo_path: path, players: {
        A: { match_meta: { target_player: "A", target_steam_id: "111" } },
        B: { match_meta: { target_player: "B", target_steam_id: "222" } },
      } };
      return useClipQueueActions({
        t: (key) => key, locale: "zh", setProgressText: vi.fn(), queue, addToQueue, removeByClientClipUid,
        uploadedDemos: [{ filename: "match.dem", path }], parsedMatches: [parsed], currentMatchIndex: 0,
        currentParsed: parsed, currentActivePlayer: player, matchMeta: {}, activePlayerTabs: [player],
        selectedPlayers: [[player]], clips: [], freezeToDeathDraft: { picked: [] },
        selectedClientClipUids: new Set(), setSelectedClientClipUids: vi.fn(), currentDemoFilename: "match.dem",
      });
    }, { initialProps: { player: "A", path: "D:/first/match.dem" } });
    const round = { round_number: 1, start_tick: 100, end_tick: 3000 };
    act(() => result.current.handleAddTimelineRoundToQueue(round));
    rerender({ player: "B", path: "D:/first/match.dem" });
    act(() => result.current.handleAddTimelineRoundToQueue(round));
    rerender({ player: "B", path: "D:/second/match.dem" });
    act(() => result.current.handleAddTimelineRoundToQueue(round));
    expect(queue).toHaveLength(3);
    rerender({ player: "B", path: "D:/second/match.dem" });
    act(() => result.current.handleAddTimelineRoundToQueue(round));
    expect(queue).toHaveLength(3);
    act(() => result.current.handleRemoveTimelineRoundFromQueue(round));
    expect(queue.map((item) => [item.demoPath, item.targetSteamId])).toEqual([
      ["D:/first/match.dem", "111"], ["D:/first/match.dem", "222"],
    ]);
  });

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

  it("adds one clip straight from its card and refuses an empty round compilation", () => {
    const highlight = { clip_id: "h1", client_clip_uid: "h1", category: "highlight" };
    const rounds = { clip_id: "r", client_clip_uid: "r", category: "compilation", compilation_kind: "freeze_to_death", round_facts: [] };
    const parsed = { demo_filename: "match.dem", players: { player: { clips: [highlight, rounds], match_meta: {} } } };
    const addToQueue = vi.fn();
    const setProgressText = vi.fn();
    const setSelectedClientClipUids = vi.fn();
    const { result } = renderHook(() => useClipQueueActions({
      t: (key) => key, locale: "zh", setProgressText, queue: [], addToQueue, removeByClientClipUid: vi.fn(),
      uploadedDemos: [{ filename: "match.dem" }], parsedMatches: [parsed], currentMatchIndex: 0,
      currentParsed: parsed, currentActivePlayer: "player", matchMeta: {},
      activePlayerTabs: ["player"], selectedPlayers: [["player"]], clips: [highlight, rounds],
      freezeToDeathDraft: { picked: [] }, selectedClientClipUids: new Set(["h1"]),
      setSelectedClientClipUids, currentDemoFilename: "match.dem",
    }));

    act(() => result.current.handleAddClipToQueue("h1"));
    expect(addToQueue).toHaveBeenCalledTimes(1);
    expect(addToQueue.mock.calls[0][0][0]).toMatchObject({ clientClipUid: "h1", demoFilename: "match.dem" });
    expect(setSelectedClientClipUids).toHaveBeenCalled();

    act(() => result.current.handleAddClipToQueue("r"));
    expect(addToQueue).toHaveBeenCalledTimes(1);
    expect(setProgressText).toHaveBeenLastCalledWith("ftd.errorNeedsRound");
  });
});
