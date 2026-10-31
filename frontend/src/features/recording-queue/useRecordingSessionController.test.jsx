import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../../api/api";
import { useRecordingSessionController } from "./useRecordingSessionController.js";

vi.mock("../../api/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../utils/recordingBatch", () => ({
  buildRecordingQueueRequestsFromQueue: (queue) => queue.map((item) => ({
    request_id: item.id, source_ref: { queue_item_id: item.id },
    demo: { demo_path: `/${item.id}.dem`, demo_filename: `${item.id}.dem` },
  })),
  applySessionObsTransitionToRequests: (requests) => requests,
}));

describe("recording queue result persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockResolvedValue({ data: { restore_required: false } });
    API.post.mockImplementation(async (url) => ({
      data: url === "/obs/config-check" ? { connected: true } : [],
    }));
  });

  it("keeps the queue when recording completed but library registration failed", async () => {
    const failed = {
      request_id: "demo-a", success: false, output_path: "finished.mp4",
      error: "Recording finished, but saving it to the library failed",
    };
    API.post.mockImplementation(async (url) => ({
      data: url === "/obs/config-check" ? { connected: true } : [failed],
    }));
    const options = {
      t: (key) => key, setProgressText: vi.fn(), setQueueDrawerOpen: vi.fn(),
      queue: [{ id: "demo-a" }], clearQueue: vi.fn(), obsConfig: {},
      uploadedDemos: [], parsedMatches: {}, demoLibraryItems: [],
    };
    const { result } = renderHook(() => useRecordingSessionController(options));
    await act(async () => { await result.current.openBatchWarmup(); });
    await act(async () => { await result.current.handleWarmupConfirm({ experimental_pov_enabled: false }); });
    expect(options.clearQueue).not.toHaveBeenCalled();
    expect(result.current.batchRecording).toBe(false);
  });

});
