import { describe, expect, it } from "vitest";
import {
  HANDOFF_MAX_WAIT_MS,
  HANDOFF_SEEK_RETRY_MS,
  handoffFrameAction,
  isHandoffFrameReady,
  previewMediaIdentity,
  previewUnderlayOpacity,
  previewUnderlayPlaybackStateKey,
  previewUnderlaySyncKey,
  previewFrameTimes,
  promotedUnderlayForMain,
  shouldApplyPreviewSeek,
  shouldPrewarmNextClip,
  shouldPublishPreviewClock,
  shouldPublishVideoTimeUpdate,
  shouldUseMediaPreviewClock,
  transitionVisualAtLocalTime,
} from "./previewFrameUtils.js";

describe("previewMediaIdentity", () => {
  it.each(["mp4", "m4v", "mov", "mkv", "avi", "gif", "webm"])(
    "distinguishes consecutive %s clips that reuse the same media URL",
    (extension) => {
      const streamUrl = `/api/assets/7/stream?format=${extension}`;
      expect(previewMediaIdentity("clip-a", streamUrl)).not.toBe(previewMediaIdentity("clip-b", streamUrl));
    },
  );
});

describe("preview underlay playback state", () => {
  const layer = {
    id: "clip-b",
    streamUrl: "/b.mp4",
    playbackRate: 1,
    sourceTime: 4,
    mediaTimeOffset: 0,
  };

  it("restarts media control when a companion leaves prewarm or freeze state", () => {
    expect(previewUnderlayPlaybackStateKey({ ...layer, prewarm: true }))
      .not.toBe(previewUnderlayPlaybackStateKey({ ...layer, freezePlayback: true }));
    expect(previewUnderlayPlaybackStateKey({ ...layer, freezePlayback: true }))
      .not.toBe(previewUnderlayPlaybackStateKey(layer));
  });

  it("does not reschedule seeks for every forward-playing scene frame", () => {
    expect(previewUnderlaySyncKey(layer, true))
      .toBe(previewUnderlaySyncKey({ ...layer, sourceTime: 4.4 }, true));
  });

  it("keeps paused, frozen, and reverse layers synchronized to explicit time", () => {
    expect(previewUnderlaySyncKey(layer, false))
      .not.toBe(previewUnderlaySyncKey({ ...layer, sourceTime: 4.4 }, false));
    expect(previewUnderlaySyncKey({ ...layer, freezePlayback: true }, true))
      .not.toBe(previewUnderlaySyncKey({ ...layer, freezePlayback: true, sourceTime: 4.4 }, true));
    expect(previewUnderlaySyncKey({ ...layer, reversePlayback: true }, true))
      .not.toBe(previewUnderlaySyncKey({ ...layer, reversePlayback: true, sourceTime: 4.4 }, true));
  });
});

describe("previewFrameTimes", () => {
  it("maps decoded media time to timeline time at the active playback rate", () => {
    expect(previewFrameTimes({ sourceTime: 10, timelineTime: 4, clipLocalTime: 1, playbackRate: 2 }, 10.5)).toEqual({
      sourceTime: 10.5,
      timelineTime: 4.25,
      clipLocalTime: 1.25,
    });
  });
});

describe("transitionVisualAtLocalTime", () => {
  it("advances an incoming transition from the local frame clock", () => {
    expect(transitionVisualAtLocalTime({ type: "fade", phase: "in", duration: 1, startLocalTime: 0 }, 0.4)?.mainOpacity).toBeCloseTo(0.4);
  });

  it("reverses progress for an outgoing transition", () => {
    expect(transitionVisualAtLocalTime({ type: "fade", phase: "out", duration: 1, startLocalTime: 2 }, 2.75)?.mainOpacity).toBeCloseTo(0.25);
  });
});

describe("handoffFrameAction", () => {
  const base = {
    awaitingHandoff: true,
    hasPromotedLayer: true,
    handoffStartedAt: 0,
    lastCorrectiveSeekAt: 0,
    seeking: false,
    now: 1000,
  };

  it("presents immediately when no handoff is pending", () => {
    expect(handoffFrameAction({ ...base, awaitingHandoff: false, mediaTime: 0, expectedMediaTime: 9 })).toEqual({ type: "present" });
  });

  it("presents once the frame is within the handoff tolerance", () => {
    expect(handoffFrameAction({ ...base, mediaTime: 5.05, expectedMediaTime: 5 })).toEqual({ type: "present" });
  });

  it("issues a corrective seek with a latency-compensating lead when trailing the promoted layer", () => {
    const action = handoffFrameAction({ ...base, mediaTime: 5, expectedMediaTime: 5.3 });
    expect(action.type).toBe("seek");
    expect(action.target).toBeCloseTo(5.6);
    expect(action.startedAt).toBe(1000);
  });

  it("caps the corrective seek lead", () => {
    const action = handoffFrameAction({ ...base, mediaTime: 2, expectedMediaTime: 4 });
    expect(action.type).toBe("seek");
    expect(action.target).toBeCloseTo(4.6);
  });

  it("waits instead of re-seeking while a seek is in flight or recently issued", () => {
    expect(handoffFrameAction({ ...base, mediaTime: 5, expectedMediaTime: 5.3, seeking: true }).type).toBe("wait");
    expect(
      handoffFrameAction({ ...base, mediaTime: 5, expectedMediaTime: 5.3, lastCorrectiveSeekAt: 1000 - HANDOFF_SEEK_RETRY_MS + 50 }).type,
    ).toBe("wait");
  });

  it("waits without seeking when the frame runs ahead of the promoted layer", () => {
    expect(handoffFrameAction({ ...base, mediaTime: 5.5, expectedMediaTime: 5.2 }).type).toBe("wait");
  });

  it("cuts over after the handoff deadline instead of stalling the clock", () => {
    const action = handoffFrameAction({
      ...base,
      mediaTime: 5,
      expectedMediaTime: 6,
      handoffStartedAt: 1000 - HANDOFF_MAX_WAIT_MS - 1,
    });
    expect(action).toEqual({ type: "present" });
  });

  it("keeps a prewarmed cut frame visible after the deadline until the new player catches up", () => {
    const action = handoffFrameAction({
      ...base,
      mediaTime: 5,
      expectedMediaTime: 6,
      keepPromotedFrameUntilCaughtUp: true,
      handoffStartedAt: 1000 - HANDOFF_MAX_WAIT_MS - 1,
    });
    expect(action).toEqual({ type: "seek", target: 6.6, startedAt: 299 });
  });

  it("anchors the handoff start time on the first gated frame", () => {
    const action = handoffFrameAction({ ...base, mediaTime: 5, expectedMediaTime: 6, seeking: true });
    expect(action).toEqual({ type: "wait", startedAt: 1000 });
  });

  it("does not reveal a segmented handoff while its frame is behind", () => {
    const action = handoffFrameAction({
      ...base,
      hasPromotedLayer: false,
      mediaTime: 4.04,
      expectedMediaTime: 4.1,
      preventBackwardPresentation: true,
      toleranceSec: 1 / 30,
    });
    expect(action).toEqual({ type: "seek", target: 4.1, startedAt: 1000 });
  });

  it("never falls through the deadline to a backward segmented frame", () => {
    const action = handoffFrameAction({
      ...base,
      hasPromotedLayer: false,
      mediaTime: 4,
      expectedMediaTime: 4.2,
      handoffStartedAt: 1000 - HANDOFF_MAX_WAIT_MS - 1,
      lastCorrectiveSeekAt: 1000,
      preventBackwardPresentation: true,
      toleranceSec: 1 / 30,
    });
    expect(action).toEqual({ type: "wait", startedAt: 299 });
  });
});

describe("shouldPrewarmNextClip", () => {
  it("opens a bounded prewarm window before a contiguous cut", () => {
    expect(shouldPrewarmNextClip({
      currentClipEnd: 20,
      nextClipStart: 20,
      playheadSec: 14,
      isPlaying: true,
    })).toBe(true);
    expect(shouldPrewarmNextClip({
      currentClipEnd: 20,
      nextClipStart: 20,
      playheadSec: 13.9,
      isPlaying: true,
    })).toBe(false);
  });

  it("does not prewarm while paused or across an intentional gap", () => {
    expect(shouldPrewarmNextClip({ currentClipEnd: 20, nextClipStart: 20, playheadSec: 18, isPlaying: false })).toBe(false);
    expect(shouldPrewarmNextClip({ currentClipEnd: 20, nextClipStart: 22, playheadSec: 18, isPlaying: true })).toBe(false);
  });
});

describe("isHandoffFrameReady", () => {
  it("accepts an on-time or forward segmented frame but rejects a visible rewind", () => {
    expect(isHandoffFrameReady({ mediaTime: 4.2, expectedMediaTime: 4.1, toleranceSec: 1 / 30, preventBackwardPresentation: true })).toBe(true);
    expect(isHandoffFrameReady({ mediaTime: 4.08, expectedMediaTime: 4.1, toleranceSec: 1 / 30, preventBackwardPresentation: true })).toBe(true);
    expect(isHandoffFrameReady({ mediaTime: 4.04, expectedMediaTime: 4.1, toleranceSec: 1 / 30, preventBackwardPresentation: true })).toBe(false);
  });
});

describe("promotedUnderlayForMain", () => {
  it("keeps the already-playing lower layer when it becomes the main layer", () => {
    const lower = { id: "clip-v2", streamUrl: "/media/base.mp4", sourceTime: 3 };
    expect(promotedUnderlayForMain([lower], "clip-v2", "/media/base.mp4")).toBe(lower);
  });

  it("does not retain an unrelated lower layer", () => {
    expect(promotedUnderlayForMain([{ id: "other", streamUrl: "/media/other.mp4" }], "clip-v2", "/media/base.mp4")).toBeNull();
  });

  it("retains the same clip's direct underlay while its segmented main URL is pending", () => {
    const lower = { id: "clip-v2", streamUrl: "/media/original.mp4", sourceTime: 3 };
    expect(promotedUnderlayForMain([lower], "clip-v2", null)).toBe(lower);
    expect(promotedUnderlayForMain([lower], "clip-v2", "/preview/segment-0.mp4")).toBe(lower);
  });

  it("keeps a prewarm invisible before the cut and reveals it only after promotion", () => {
    const prewarm = { id: "clip-v2", prewarm: true, opacity: 0 };
    expect(previewUnderlayOpacity(prewarm)).toBe(0);
    expect(previewUnderlayOpacity(prewarm, "clip-v2")).toBe(1);
  });
});

describe("shouldApplyPreviewSeek", () => {
  it("ignores ordinary playhead publications during forward playback", () => {
    expect(shouldApplyPreviewSeek({
      isPlaying: true,
      reversePlayback: false,
      freezePlayback: false,
      userSeekToken: 10,
      appliedUserSeekToken: 10,
    })).toBe(false);
  });

  it("allows a new user timeline seek while playback continues", () => {
    expect(shouldApplyPreviewSeek({
      isPlaying: true,
      reversePlayback: false,
      freezePlayback: false,
      userSeekToken: 11,
      appliedUserSeekToken: 10,
    })).toBe(true);
  });

  it("leaves reverse playback seeks to the coalesced frame scheduler", () => {
    expect(shouldApplyPreviewSeek({
      isPlaying: true,
      reversePlayback: true,
      freezePlayback: false,
      userSeekToken: 11,
      appliedUserSeekToken: 10,
    })).toBe(false);
  });
});

describe("shouldUseMediaPreviewClock", () => {
  it("uses the decoded video clock during ordinary forward playback", () => {
    expect(shouldUseMediaPreviewClock({
      hasStream: true,
      isPlaying: true,
      reversePlayback: false,
      freezePlayback: false,
    })).toBe(true);
  });

  it("falls back to the timeline clock when an image overlay plays without a video stream", () => {
    expect(shouldUseMediaPreviewClock({
      hasStream: false,
      isPlaying: true,
      reversePlayback: false,
      freezePlayback: false,
    })).toBe(false);
  });
});

describe("shouldPublishVideoTimeUpdate", () => {
  it("keeps the timeline timer authoritative during reverse preview seeks", () => {
    expect(shouldPublishVideoTimeUpdate({ hasStream: true, freezePlayback: false, reversePlayback: true, awaitingHandoff: false })).toBe(false);
    expect(shouldPublishVideoTimeUpdate({ hasStream: true, freezePlayback: false, reversePlayback: false, awaitingHandoff: false })).toBe(true);
  });
});

describe("shouldPublishPreviewClock", () => {
  it("caps React preview-clock publications near 30 Hz for high-fps sources", () => {
    expect(shouldPublishPreviewClock(100, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(shouldPublishPreviewClock(104, 100)).toBe(false);
    expect(shouldPublishPreviewClock(132, 100)).toBe(false);
    expect(shouldPublishPreviewClock(133, 100)).toBe(true);
  });
});
