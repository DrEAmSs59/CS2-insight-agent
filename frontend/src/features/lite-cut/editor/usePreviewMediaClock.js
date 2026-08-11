import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  handoffFrameAction,
  previewFrameTimes,
  shouldApplyPreviewSeek,
  shouldPublishPreviewClock,
} from "./previewFrameUtils.js";

export function usePreviewFrameClock({
  clipLocalTime,
  freezePlayback,
  hasStream,
  inputLocalTime,
  inputTimelineTime,
  isPlaying,
  mediaIdentity,
  onPlayheadChange,
  playheadSec,
  previewClipId,
  reversePlayback,
  safePlaybackRate,
  setHeldSwitchFrame,
  streamUrl,
  underlayVideoRefs,
  videoRef,
}) {
  const [previewClock, setPreviewClock] = useState(() => ({
    sourceTime: Math.max(0, Number(playheadSec) || 0),
    timelineTime: inputTimelineTime,
    clipLocalTime: inputLocalTime,
  }));
  const frameAnchorRef = useRef({
    sourceTime: Math.max(0, Number(playheadSec) || 0),
    timelineTime: inputTimelineTime,
    clipLocalTime: inputLocalTime,
    playbackRate: safePlaybackRate,
  });
  const clockClipRef = useRef(previewClipId);
  const previewClipIdRef = useRef(previewClipId);
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const presentedStreamRef = useRef(null);
  const lastPreviewClockAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastGlobalClockAtRef = useRef(0);
  const retainedPromotionLayerRef = useRef(null);
  const handoffStartedAtRef = useRef(0);
  const handoffSeekAtRef = useRef(0);
  const [, forcePromotionRender] = useState(0);

  const releasePromotedUnderlay = useCallback(() => {
    if (!retainedPromotionLayerRef.current) return;
    retainedPromotionLayerRef.current = null;
    forcePromotionRender((version) => version + 1);
  }, []);

  const promotedPlaybackTime = useCallback((fallback) => {
    const promoted = retainedPromotionLayerRef.current;
    const promotedElement = promoted ? underlayVideoRefs.current.get(String(promoted.id)) : null;
    return promotedElement?.readyState >= 2 && Number.isFinite(promotedElement.currentTime)
      ? promotedElement.currentTime
      : fallback;
  }, [underlayVideoRefs]);

  useLayoutEffect(() => {
    onPlayheadChangeRef.current = onPlayheadChange;
    previewClipIdRef.current = previewClipId;
    const clipChanged = clockClipRef.current !== previewClipId;
    clockClipRef.current = previewClipId;
    const nextClock = {
      sourceTime: Math.max(0, Number(playheadSec) || 0),
      timelineTime: inputTimelineTime,
      clipLocalTime: inputLocalTime,
    };
    frameAnchorRef.current = { ...nextClock, playbackRate: safePlaybackRate };
    if (!isPlaying || clipChanged || reversePlayback || freezePlayback) setPreviewClock(nextClock);
  }, [clipLocalTime, freezePlayback, inputLocalTime, inputTimelineTime, isPlaying, onPlayheadChange, playheadSec, previewClipId, reversePlayback, safePlaybackRate]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !hasStream || !isPlaying || reversePlayback || freezePlayback) return undefined;
    lastPreviewClockAtRef.current = Number.NEGATIVE_INFINITY;
    let cancelled = false;
    let videoFrameId = null;
    let animationFrameId = null;

    const publishFrame = (now, mediaTime) => {
      if (cancelled || !Number.isFinite(mediaTime) || element.readyState < 2) return;
      const hasPromotedLayer = Boolean(retainedPromotionLayerRef.current);
      const action = handoffFrameAction({
        mediaTime,
        expectedMediaTime: promotedPlaybackTime(frameAnchorRef.current.sourceTime),
        awaitingHandoff: hasPromotedLayer || presentedStreamRef.current !== mediaIdentity,
        hasPromotedLayer,
        keepPromotedFrameUntilCaughtUp: Boolean(retainedPromotionLayerRef.current?.prewarm),
        handoffStartedAt: handoffStartedAtRef.current,
        lastCorrectiveSeekAt: handoffSeekAtRef.current,
        seeking: Boolean(element.seeking),
        now,
      });
      if (action.type !== "present") {
        handoffStartedAtRef.current = action.startedAt;
        if (action.type === "seek") {
          handoffSeekAtRef.current = now;
          try {
            element.currentTime = action.target;
          } catch {
            // A transient decoder failure is retried on the next frame.
          }
        }
        return;
      }
      handoffStartedAtRef.current = 0;
      const frame = previewFrameTimes(frameAnchorRef.current, mediaTime);
      if (shouldPublishPreviewClock(now, lastPreviewClockAtRef.current)) {
        lastPreviewClockAtRef.current = now;
        setPreviewClock((previous) => (
          Math.abs(previous.sourceTime - frame.sourceTime) < 0.0005
          && Math.abs(previous.timelineTime - frame.timelineTime) < 0.0005
            ? previous
            : frame
        ));
      }
      releasePromotedUnderlay();
      if (presentedStreamRef.current !== mediaIdentity) {
        presentedStreamRef.current = mediaIdentity;
        setHeldSwitchFrame(null);
      }
      if (now - lastGlobalClockAtRef.current >= 45) {
        lastGlobalClockAtRef.current = now;
        onPlayheadChangeRef.current?.(mediaTime, {
          clipId: previewClipIdRef.current,
          timelineSec: frame.timelineTime,
        });
      }
    };

    if (typeof element.requestVideoFrameCallback === "function") {
      const requestNext = () => {
        videoFrameId = element.requestVideoFrameCallback((now, metadata) => {
          publishFrame(now, Number(metadata?.mediaTime ?? element.currentTime));
          if (!cancelled) requestNext();
        });
      };
      requestNext();
    } else {
      const requestNext = (now) => {
        publishFrame(now, Number(element.currentTime));
        if (!cancelled) animationFrameId = window.requestAnimationFrame(requestNext);
      };
      animationFrameId = window.requestAnimationFrame(requestNext);
    }
    return () => {
      cancelled = true;
      if (videoFrameId != null && typeof element.cancelVideoFrameCallback === "function") element.cancelVideoFrameCallback(videoFrameId);
      if (animationFrameId != null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [freezePlayback, hasStream, isPlaying, mediaIdentity, previewClipId, promotedPlaybackTime, releasePromotedUnderlay, reversePlayback, setHeldSwitchFrame, streamUrl, videoRef]);

  return {
    previewClock,
    frameAnchorRef,
    previewClipIdRef,
    onPlayheadChangeRef,
    presentedStreamRef,
    retainedPromotionLayerRef,
    handoffStartedAtRef,
    handoffSeekAtRef,
    releasePromotedUnderlay,
    promotedPlaybackTime,
  };
}

export function usePreviewSeekGuard({
  backgroundVideoRef,
  fitMode,
  freezePlayback,
  hasStream,
  isPlaying,
  mainReverse,
  mediaIdentity,
  playheadSec,
  promotedPlaybackTime,
  resolvedUnderlayLayers,
  retainedPromotionLayerRef,
  underlayLayerSignature,
  underlaySeekSignature,
  underlayVideoRefs,
  userSeekToken,
  videoRef,
}) {
  const appliedUserSeekTokenRef = useRef(0);
  const reverseSeekTargetRef = useRef(null);

  useEffect(() => {
    const shouldSeek = shouldApplyPreviewSeek({
      isPlaying,
      reversePlayback: mainReverse,
      freezePlayback,
      userSeekToken,
      appliedUserSeekToken: appliedUserSeekTokenRef.current,
    });
    if (!shouldSeek) return undefined;
    const pendingUserSeek = Number(userSeekToken) > 0 && userSeekToken !== appliedUserSeekTokenRef.current;
    const applySeek = (element) => {
      try {
        const fallback = Math.max(0, playheadSec);
        const seekTo = element === videoRef.current ? promotedPlaybackTime(fallback) : fallback;
        const tolerance = element === videoRef.current && retainedPromotionLayerRef.current ? 0.04 : 0.15;
        if (Math.abs(element.currentTime - seekTo) > tolerance) element.currentTime = seekTo;
      } catch {
        // Metadata can still be unavailable during a stream handoff.
      }
    };
    const cleanup = [];
    let seekScheduled = false;
    for (const element of [videoRef.current, backgroundVideoRef.current]) {
      if (!element || !hasStream) continue;
      seekScheduled = true;
      const onLoaded = () => applySeek(element);
      if (element.readyState >= 1) applySeek(element);
      else {
        element.addEventListener("loadedmetadata", onLoaded, { once: true });
        cleanup.push(() => element.removeEventListener("loadedmetadata", onLoaded));
      }
    }
    if (pendingUserSeek && seekScheduled) appliedUserSeekTokenRef.current = userSeekToken;
    return () => cleanup.forEach((release) => release());
  }, [backgroundVideoRef, fitMode, freezePlayback, hasStream, isPlaying, mainReverse, mediaIdentity, playheadSec, promotedPlaybackTime, retainedPromotionLayerRef, userSeekToken, videoRef]);

  useEffect(() => {
    if (!hasStream || !isPlaying || !mainReverse || freezePlayback) {
      reverseSeekTargetRef.current = null;
      return;
    }
    const element = videoRef.current;
    const target = Math.max(0, Number(playheadSec) || 0);
    reverseSeekTargetRef.current = target;
    if (!element || element.readyState < 1 || element.seeking || Math.abs(element.currentTime - target) <= 0.012) return;
    try {
      element.currentTime = target;
    } catch {
      // The latest target stays queued and handleVideoSeeked retries it.
    }
  }, [freezePlayback, hasStream, isPlaying, mainReverse, mediaIdentity, playheadSec, videoRef]);

  useEffect(() => {
    const cleanup = [];
    for (const layer of resolvedUnderlayLayers) {
      const element = underlayVideoRefs.current.get(String(layer.id));
      if (!element) continue;
      const seekTo = Math.max(0, Number(layer.sourceTime) || 0);
      const applySeek = () => {
        try {
          if (Math.abs(element.currentTime - seekTo) > 0.15) element.currentTime = seekTo;
        } catch {
          // Ignore a seek before metadata is available.
        }
      };
      if (element.readyState >= 1) applySeek();
      else {
        element.addEventListener("loadedmetadata", applySeek, { once: true });
        cleanup.push(() => element.removeEventListener("loadedmetadata", applySeek));
      }
    }
    return () => cleanup.forEach((release) => release());
  }, [isPlaying, underlayLayerSignature, underlaySeekSignature, underlayVideoRefs]);

  return { reverseSeekTargetRef };
}
