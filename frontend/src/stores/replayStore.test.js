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

  test("keeps replay loading until sparse effects are ready", async () => {
    let resolveEffects;
    API.post
      .mockResolvedValueOnce({
        data: {
          frames: [{ tick: 1 }],
          fps: 32,
          effect_tracks: [],
          effects_pending: true,
          cache: { frames: "parquet_binary_hit", effects: "pending", parsed: false },
        },
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveEffects = resolve;
      }));
    const onEffects = vi.fn();

    const pendingReplay = useReplayStore.getState().ensureReplay(
      "binary-effects",
      { path: "a.dem" },
      { onEffects },
    );

    await vi.waitFor(() => expect(API.post).toHaveBeenCalledTimes(2));
    expect(useReplayStore.getState().entries["binary-effects"].status).toBe("loading");
    resolveEffects({
      data: {
        effect_tracks: [{ id: "smoke:1", type: "smoke" }],
        effect_capabilities: { smoke_voxels: true },
      },
    });
    const replay = await pendingReplay;

    expect(replay.frames).toHaveLength(1);
    expect(replay.effect_tracks).toHaveLength(1);
    expect(API.post).toHaveBeenNthCalledWith(
      1,
      "/demo/replay/binary",
      { path: "a.dem" },
      { responseType: "arraybuffer" },
    );
    expect(API.post).toHaveBeenNthCalledWith(2, "/demo/replay/effects", { path: "a.dem" });
    await vi.waitFor(() => {
      expect(useReplayStore.getState().entries["binary-effects"].effectTracks).toHaveLength(1);
    });
    expect(onEffects).toHaveBeenCalledWith(expect.objectContaining({
      effect_tracks: [{ id: "smoke:1", type: "smoke" }],
    }));
  });

  test("uses effects embedded in the binary packet without a sidecar request", async () => {
    API.post.mockResolvedValueOnce({
      data: {
        frames: [{ tick: 1 }],
        fps: 32,
        effect_tracks: [{ id: "inferno:1", type: "inferno" }],
        effect_capabilities: { inferno_cells: true },
        effects_pending: false,
      },
    });

    const replay = await useReplayStore.getState().ensureReplay("binary-complete", { path: "a.dem" });

    expect(replay.effect_tracks).toHaveLength(1);
    expect(API.post).toHaveBeenCalledTimes(1);
  });

  test("surfaces binary runtime failures without silently falling back to JSON", async () => {
    API.post.mockRejectedValueOnce({
      response: { status: 503, data: { detail: "Binary replay unavailable" } },
    });

    await expect(
      useReplayStore.getState().ensureReplay("binary-error", { path: "old.dem" }),
    ).rejects.toMatchObject({ response: { status: 503 } });

    expect(API.post).toHaveBeenCalledTimes(1);
    expect(API.post).toHaveBeenCalledWith(
      "/demo/replay/binary",
      { path: "old.dem" },
      { responseType: "arraybuffer" },
    );
  });
});
