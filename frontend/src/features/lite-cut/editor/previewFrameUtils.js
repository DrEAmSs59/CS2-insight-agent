import { boundaryTransitionPreviewVisual } from "./transitionPreviewUtils.js";

export function previewFrameTimes(anchor, mediaTime) {
  const sourceTime = Math.max(0, Number(mediaTime) || 0);
  const anchorSource = Math.max(0, Number(anchor?.sourceTime) || 0);
  const playbackRate = Math.max(0.25, Math.min(4, Number(anchor?.playbackRate) || 1));
  const timelineDelta = (sourceTime - anchorSource) / playbackRate;
  return {
    sourceTime,
    timelineTime: Math.max(0, (Number(anchor?.timelineTime) || 0) + timelineDelta),
    clipLocalTime: Math.max(0, (Number(anchor?.clipLocalTime) || 0) + timelineDelta),
  };
}

export function transitionVisualAtLocalTime(spec, localTime) {
  if (!spec?.type) return null;
  const duration = Math.max(0, Number(spec.duration) || 0);
  if (duration < 0.001) return boundaryTransitionPreviewVisual("none", 1);
  const local = Math.max(0, Number(localTime) || 0);
  const start = Math.max(0, Number(spec.startLocalTime) || 0);
  const progress = spec.phase === "out"
    ? 1 - ((local - start) / duration)
    : (local - start) / duration;
  return boundaryTransitionPreviewVisual(spec.type, progress);
}

export function promotedUnderlayForMain(previousUnderlays, previewClipId, streamUrl) {
  if (previewClipId == null) return null;
  const matchingClipLayers = (previousUnderlays || []).filter(
    (layer) => String(layer?.id) === String(previewClipId) && Boolean(layer?.streamUrl),
  );
  if (!matchingClipLayers.length) return null;
  // Prefer the exact proxy URL when it is already mounted. If the segmented
  // main source is still pending, retain the direct underlay for the same clip
  // so a layer promotion never exposes the black canvas.
  return matchingClipLayers.find(
    (layer) => streamUrl && String(layer.streamUrl) === String(streamUrl),
  ) || matchingClipLayers[0];
}

export function previewUnderlayOpacity(layer, promotedLayerId = null) {
  if (layer?.prewarm && promotedLayerId != null && String(layer.id) === String(promotedLayerId)) return 1;
  return Math.max(0, Math.min(1, Number(layer?.opacity) || 0));
}

export function previewUnderlayPlaybackStateKey(layer) {
  return [
    String(layer?.id ?? ""),
    String(layer?.streamUrl || ""),
    Number(layer?.playbackRate) || 1,
    layer?.reversePlayback ? "reverse" : "forward",
    layer?.freezePlayback ? "frozen" : "live",
    layer?.prewarm ? "prewarm" : "active",
  ].join(":");
}

export function previewUnderlaySyncKey(layer, isPlaying) {
  const continuousForwardPlayback = Boolean(
    isPlaying
    && !layer?.reversePlayback
    && !layer?.freezePlayback
    && !layer?.prewarm,
  );
  // A live forward decoder owns its clock after the initial synchronization.
  // Keeping sourceTime out of this key prevents every scene-clock frame from
  // scheduling another seek while the video is already playing normally.
  const sourceToken = continuousForwardPlayback
    ? "media-clock"
    : (Number(layer?.sourceTime) || 0).toFixed(6);
  return `${previewUnderlayPlaybackStateKey(layer)}:${sourceToken}:${(Number(layer?.mediaTimeOffset) || 0).toFixed(6)}`;
}

export function previewMediaIdentity(clipId, streamUrl) {
  return `${clipId == null ? "none" : String(clipId)}:${String(streamUrl || "")}`;
}

export function shouldApplyPreviewSeek({
  isPlaying,
  reversePlayback,
  freezePlayback,
  userSeekToken,
  appliedUserSeekToken,
}) {
  const pendingUserSeek = Number(userSeekToken) > 0 && userSeekToken !== appliedUserSeekToken;
  // Reverse preview has its own coalesced seek scheduler. Letting ordinary
  // React playhead updates seek here as well causes overlapping decoder seeks.
  if (isPlaying && reversePlayback) return false;
  return pendingUserSeek || !isPlaying || reversePlayback || freezePlayback;
}

export function shouldUseMediaPreviewClock({
  hasStream,
  isPlaying,
  reversePlayback,
  freezePlayback,
}) {
  return Boolean(hasStream && isPlaying && !reversePlayback && !freezePlayback);
}

export const NEXT_CLIP_PREWARM_LEAD_SEC = 6;

export function shouldPrewarmNextClip({
  currentClipEnd,
  isPlaying,
  nextClipStart,
  playheadSec,
  leadSec = NEXT_CLIP_PREWARM_LEAD_SEC,
}) {
  if (!isPlaying) return false;
  const currentEnd = Number(currentClipEnd);
  const nextStart = Number(nextClipStart);
  const playhead = Number(playheadSec);
  if (![currentEnd, nextStart, playhead].every(Number.isFinite)) return false;
  if (Math.abs(nextStart - currentEnd) > 0.05) return false;
  const secondsToCut = currentEnd - playhead;
  return secondsToCut >= -0.02 && secondsToCut <= Math.max(0.25, Number(leadSec) || NEXT_CLIP_PREWARM_LEAD_SEC);
}

export function shouldPublishVideoTimeUpdate({ hasStream, freezePlayback, reversePlayback, awaitingHandoff }) {
  return Boolean(hasStream && !freezePlayback && !reversePlayback && !awaitingHandoff);
}

export function shouldPublishPreviewClock(now, lastPublishedAt, intervalMs = 33) {
  const current = Number(now);
  const previous = Number(lastPublishedAt);
  if (!Number.isFinite(current)) return false;
  if (!Number.isFinite(previous)) return true;
  return current - previous >= Math.max(1, Number(intervalMs) || 33);
}

export const HANDOFF_MAX_WAIT_MS = 700;
export const HANDOFF_SEEK_RETRY_MS = 200;
export const HANDOFF_MAX_SEEK_LEAD_SEC = 0.6;
export const SEGMENT_HANDOFF_TOLERANCE_SEC = 1 / 30;

export function isHandoffFrameReady({
  mediaTime,
  expectedMediaTime,
  toleranceSec,
  preventBackwardPresentation = false,
}) {
  const tolerance = Math.max(0, Number(toleranceSec) || 0);
  if (preventBackwardPresentation) return mediaTime + tolerance >= expectedMediaTime;
  return Math.abs(mediaTime - expectedMediaTime) <= tolerance;
}

/**
 * Decide how to treat a presented main-video frame while a stream handoff
 * (clip switch) is pending. The promoted lower layer keeps playing during the
 * switch, so slow-seeking sources (e.g. .mov) can trail it by a constant
 * offset forever. A corrective seek with a latency-compensating lead — and
 * ultimately a deadline — keeps the switch converging instead of stalling the
 * preview clock.
 */
export function handoffFrameAction({
  mediaTime,
  expectedMediaTime,
  awaitingHandoff,
  hasPromotedLayer,
  keepPromotedFrameUntilCaughtUp = false,
  handoffStartedAt,
  lastCorrectiveSeekAt,
  preventBackwardPresentation = false,
  seeking,
  toleranceSec,
  now,
}) {
  if (!awaitingHandoff) return { type: "present" };
  const tolerance = Math.max(0, Number(toleranceSec) || (hasPromotedLayer ? 0.1 : 0.2));
  if (isHandoffFrameReady({
    mediaTime,
    expectedMediaTime,
    toleranceSec: tolerance,
    preventBackwardPresentation,
  })) return { type: "present" };
  const startedAt = handoffStartedAt || now;
  // A prewarmed next clip is the visible frame at a plain cut.  Replacing it
  // with a newly mounted player that is still behind produces a visible jump
  // backwards. Keep that prewarm on screen until the new player catches up.
  // Existing lower-layer/transition handoffs retain the historical deadline.
  if (!keepPromotedFrameUntilCaughtUp && !preventBackwardPresentation && now - startedAt > HANDOFF_MAX_WAIT_MS) return { type: "present" };
  const behind = expectedMediaTime - mediaTime;
  if (
    (hasPromotedLayer || preventBackwardPresentation)
    && behind > tolerance
    && !seeking
    && now - (lastCorrectiveSeekAt || 0) >= HANDOFF_SEEK_RETRY_MS
  ) {
    // `behind` measures how far the promoted layer advanced during the last
    // seek, so reusing it as the lead lands the next seek near the live time.
    const target = hasPromotedLayer
      ? expectedMediaTime + Math.min(HANDOFF_MAX_SEEK_LEAD_SEC, behind)
      : expectedMediaTime;
    return { type: "seek", target, startedAt };
  }
  return { type: "wait", startedAt };
}
