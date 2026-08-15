// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestAssetPreview } = vi.hoisted(() => ({ requestAssetPreview: vi.fn() }));

vi.mock("../api/liteCutClient.js", () => ({
  liteCutClient: { requestAssetPreview },
}));

import {
  BACKGROUND_PREVIEW_IDLE_DELAY_MS,
  backgroundPreviewSegmentOrder,
  clearSegmentedPreviewMemoryCache,
  previewSegmentIndexAt,
  shouldUseSegmentedPreview,
  useSegmentedPreviewSource,
} from "./useSegmentedPreviewSource.js";

describe("segmented preview source", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestAssetPreview.mockReset();
    clearSegmentedPreviewMemoryCache();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("maps source time to fixed playhead segments", () => {
    expect(previewSegmentIndexAt(0)).toBe(0);
    expect(previewSegmentIndexAt(3.999)).toBe(0);
    expect(previewSegmentIndexAt(4)).toBe(1);
    expect(previewSegmentIndexAt(37.25)).toBe(9);
  });

  it("fills beyond the foreground window and wraps until the whole source is covered", () => {
    expect(backgroundPreviewSegmentOrder({
      sourceDurationSec: 40,
      segmentStepSec: 4,
      foregroundSegment: 2,
      foregroundLookAheadSec: 12,
    })).toEqual([6, 7, 8, 9, 0, 1, 2, 3, 4, 5]);
  });

  it("only enables segmented mode for file clips marked by backend policy", () => {
    const clip = { source_type: "file", meta: { asset_id: 12 } };
    expect(shouldUseSegmentedPreview({ preview_proxy_required: true, preview_proxy_mode: "segmented" }, clip)).toBe(true);
    expect(shouldUseSegmentedPreview({ preview_proxy_required: false, preview_proxy_mode: "direct" }, clip)).toBe(false);
    expect(shouldUseSegmentedPreview(null, { ...clip, source_type: "recorded_clip" })).toBe(false);
  });

  it("debounces a paused seek, polls until ready, and exposes the segment offset", async () => {
    requestAssetPreview
      .mockResolvedValueOnce({ status: "running", requested_segment: 2 })
      .mockResolvedValueOnce({
        status: "ready",
        requested_segment: 2,
        segment_start_sec: 8,
        segment_end_sec: 12.5,
        segment_url: "/api/lite-cut/assets/12/preview/segments/2?request=abc",
      });

    const { result } = renderHook(() => useSegmentedPreviewSource({
      assetId: 12,
      directStreamUrl: "/api/lite-cut/assets/12/stream",
      enabled: true,
      isPlaying: false,
      sourceTime: 9.1,
    }));

    act(() => vi.advanceTimersByTime(159));
    expect(requestAssetPreview).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(requestAssetPreview).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 12,
      timeSec: 8,
      lookAheadSec: 12,
      priority: "interactive",
    }));
    expect(result.current.pending).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({
      streamUrl: "/api/lite-cut/assets/12/preview/segments/2?request=abc",
      mediaTimeOffset: 8,
      segmented: true,
      pending: false,
      status: "ready",
    });
  });

  it("keeps an overlapping old segment playable while the next one is requested", async () => {
    requestAssetPreview.mockResolvedValue({
      status: "ready",
      requested_segment: 2,
      segment_start_sec: 8,
      segment_end_sec: 12.5,
      segment_url: "/segment-2.mp4",
    });
    const props = {
      assetId: 12,
      directStreamUrl: "/source.mp4",
      enabled: true,
      isPlaying: false,
      sourceTime: 9,
    };
    const { result, rerender } = renderHook(
      ({ sourceTime }) => useSegmentedPreviewSource({ ...props, sourceTime }),
      { initialProps: { sourceTime: 9 } },
    );
    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
    });

    act(() => rerender({ sourceTime: 12.2 }));
    expect(result.current.streamUrl).toBe("/segment-2.mp4");
    expect(result.current.pending).toBe(false);

    act(() => rerender({ sourceTime: 12.49 }));
    expect(result.current.pending).toBe(true);
  });

  it("prefetches and promotes the next sequential segment without a boundary request", async () => {
    requestAssetPreview
      .mockResolvedValueOnce({
        status: "ready",
        requested_segment: 0,
        segment_start_sec: 0,
        segment_end_sec: 4.5,
        segment_url: "/segment-0.mp4?v=source",
      })
      .mockResolvedValueOnce({
        status: "ready",
        requested_segment: 1,
        segment_start_sec: 4,
        segment_end_sec: 8.5,
        segment_url: "/segment-1.mp4?v=source",
      });
    const { result, rerender } = renderHook(
      ({ sourceTime }) => useSegmentedPreviewSource({
        assetId: 12,
        directStreamUrl: "/source.mp4",
        enabled: true,
        isPlaying: true,
        sourceTime,
      }),
      { initialProps: { sourceTime: 1 } },
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(requestAssetPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      timeSec: 4,
      priority: "prefetch",
    }));
    expect(result.current.preloadStreamUrl).toBe("/segment-1.mp4?v=source");

    act(() => rerender({ sourceTime: 4.1 }));
    expect(result.current).toMatchObject({
      streamUrl: "/segment-1.mp4?v=source",
      mediaTimeOffset: 4,
      pending: false,
    });
    expect(requestAssetPreview).toHaveBeenCalledTimes(2);
  });

  it("shares a prewarmed segment with the main preview hook at a clip boundary", async () => {
    requestAssetPreview.mockResolvedValue({
      status: "ready",
      requested_segment: 0,
      segment_start_sec: 0,
      segment_end_sec: 4.5,
      segment_url: "/shared-next-clip-segment.mp4?v=fixture",
    });
    const props = {
      assetId: 91,
      directStreamUrl: "/asset-91.mp4?preview=v1",
      enabled: true,
      isPlaying: true,
      sourceTime: 0,
    };
    const prewarm = renderHook(() => useSegmentedPreviewSource(props));
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(prewarm.result.current).toMatchObject({
      streamUrl: "/shared-next-clip-segment.mp4?v=fixture",
      pending: false,
    });
    prewarm.unmount();
    const requestCount = requestAssetPreview.mock.calls.length;

    const main = renderHook(() => useSegmentedPreviewSource(props));
    expect(main.result.current).toMatchObject({
      streamUrl: "/shared-next-clip-segment.mp4?v=fixture",
      pending: false,
      status: "ready",
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(requestAssetPreview).toHaveBeenCalledTimes(requestCount);
  });

  it("starts gentle whole-source completion only after the preview stays paused", async () => {
    requestAssetPreview.mockImplementation(async ({ timeSec }) => {
      const segmentIndex = Math.floor(Number(timeSec) / 4);
      return {
        status: "ready",
        requested_segment: segmentIndex,
        segment_start_sec: segmentIndex * 4,
        segment_end_sec: segmentIndex * 4 + 4.5,
        segment_url: `/segment-${segmentIndex}.mp4?v=source`,
      };
    });
    const { rerender } = renderHook(
      ({ isPlaying }) => useSegmentedPreviewSource({
        assetId: 12,
        directStreamUrl: "/source.mp4",
        enabled: true,
        isPlaying,
        sourceDurationSec: 40,
        sourceTime: 9,
      }),
      { initialProps: { isPlaying: false } },
    );

    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(BACKGROUND_PREVIEW_IDLE_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(requestAssetPreview).not.toHaveBeenCalledWith(expect.objectContaining({ lookAheadSec: 0 }));

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(requestAssetPreview).toHaveBeenCalledWith(expect.objectContaining({
      timeSec: 24,
      lookAheadSec: 0,
      priority: "prefetch",
    }));

    const backgroundCalls = () => requestAssetPreview.mock.calls.filter(([options]) => options.lookAheadSec === 0).length;
    expect(backgroundCalls()).toBe(1);
    act(() => rerender({ isPlaying: true }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(backgroundCalls()).toBe(1);
  });

  it("retries a terminal segment failure only after the user asks", async () => {
    requestAssetPreview
      .mockResolvedValueOnce({ status: "failed", error: "encoder failed" })
      .mockResolvedValueOnce({
        status: "ready",
        requested_segment: 1,
        segment_start_sec: 4,
        segment_end_sec: 8.5,
        segment_url: "/segment-1.mp4",
      });
    const { result } = renderHook(() => useSegmentedPreviewSource({
      assetId: 12,
      directStreamUrl: "/source.mp4",
      enabled: true,
      isPlaying: true,
      sourceTime: 5,
    }));

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ status: "failed", error: "encoder failed", pending: true });
    expect(requestAssetPreview).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(requestAssetPreview).toHaveBeenLastCalledWith(expect.objectContaining({ retry: true }));
    expect(result.current).toMatchObject({ status: "ready", streamUrl: "/segment-1.mp4", pending: false });
  });
});
