import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/api", () => ({
  default: {
    post: vi.fn(),
  },
}));

import API from "../api/api";
import { createReplayCacheKey, useReplayStore } from "./replayStore";

describe("replayStore", () => {
  beforeEach(() => {
    useReplayStore.setState({ entries: {}, activeKey: null });
    vi.clearAllMocks();
  });

  test("createReplayCacheKey is stable", () => {
    const a = createReplayCacheKey({
      demoPath: "x.dem",
      roundNumber: 1,
      startTick: 10,
      endTick: 20,
      fps: 8,
    });
    const b = createReplayCacheKey({
      demoPath: "x.dem",
      roundNumber: 1,
      startTick: 10,
      endTick: 20,
      fps: 8,
    });
    expect(a).toBe(b);
  });

  test("ensureReplay reuses in-flight promise", async () => {
    let resolvePost;
    API.post.mockReturnValueOnce(new Promise((resolve) => {
      resolvePost = resolve;
    }));
    const p1 = useReplayStore.getState().ensureReplay("k1", { path: "a.dem" });
    const p2 = useReplayStore.getState().ensureReplay("k1", { path: "a.dem" });
    expect(useReplayStore.getState().entries.k1.status).toBe("loading");
    expect(API.post).toHaveBeenCalledTimes(1);
    resolvePost({
      data: {
        frames: [{ tick: 1 }],
        map_transform: { scale: 5 },
        fps: 8,
        effect_tracks: [],
        cache: { frames: "parsed", parsed: true },
      },
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.frames).toHaveLength(1);
    expect(r2.frames).toHaveLength(1);
    expect(useReplayStore.getState().entries.k1.status).toBe("ready");
  });

  test("ensureReplay returns memory hit without second request", async () => {
    API.post.mockResolvedValueOnce({
      data: {
        frames: [{ tick: 1 }],
        map_transform: { scale: 5 },
        fps: 8,
        effect_tracks: [],
        cache: { frames: "parsed", parsed: true },
      },
    });
    await useReplayStore.getState().ensureReplay("k2", { path: "a.dem" });
    const again = await useReplayStore.getState().ensureReplay("k2", { path: "a.dem" });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(again.frames).toHaveLength(1);
  });
});
