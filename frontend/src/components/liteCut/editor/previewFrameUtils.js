import { transitionPreviewVisual } from "./transitionPreviewUtils.js";
import { normalizeVideoLayerTransform } from "./effectContract.js";

export function normalizePreviewLayerTransform(transform = {}, defaults = {}) {
  return normalizeVideoLayerTransform(transform, defaults);
}

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
  if (duration < 0.001) return transitionPreviewVisual("none", 1);
  const local = Math.max(0, Number(localTime) || 0);
  const start = Math.max(0, Number(spec.startLocalTime) || 0);
  const progress = spec.phase === "out"
    ? 1 - ((local - start) / duration)
    : (local - start) / duration;
  return transitionPreviewVisual(spec.type, progress);
}

export function promotedUnderlayForMain(previousUnderlays, previewClipId, streamUrl) {
  if (previewClipId == null || !streamUrl) return null;
  return (previousUnderlays || []).find(
    (layer) => String(layer?.id) === String(previewClipId) && String(layer?.streamUrl || "") === String(streamUrl),
  ) || null;
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

export function shouldPublishVideoTimeUpdate({ hasStream, freezePlayback, reversePlayback, awaitingHandoff }) {
  return Boolean(hasStream && !freezePlayback && !reversePlayback && !awaitingHandoff);
}

export const HANDOFF_MAX_WAIT_MS = 700;
export const HANDOFF_SEEK_RETRY_MS = 200;
export const HANDOFF_MAX_SEEK_LEAD_SEC = 0.6;

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
  handoffStartedAt,
  lastCorrectiveSeekAt,
  seeking,
  now,
}) {
  if (!awaitingHandoff) return { type: "present" };
  const tolerance = hasPromotedLayer ? 0.1 : 0.2;
  if (Math.abs(mediaTime - expectedMediaTime) <= tolerance) return { type: "present" };
  const startedAt = handoffStartedAt || now;
  if (now - startedAt > HANDOFF_MAX_WAIT_MS) return { type: "present" };
  const behind = expectedMediaTime - mediaTime;
  if (
    hasPromotedLayer
    && behind > tolerance
    && !seeking
    && now - (lastCorrectiveSeekAt || 0) >= HANDOFF_SEEK_RETRY_MS
  ) {
    // `behind` measures how far the promoted layer advanced during the last
    // seek, so reusing it as the lead lands the next seek near the live time.
    return { type: "seek", target: expectedMediaTime + Math.min(HANDOFF_MAX_SEEK_LEAD_SEC, behind), startedAt };
  }
  return { type: "wait", startedAt };
}
