import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { liteCutClient } from "../api/liteCutClient.js";

export const DEFAULT_PREVIEW_SEGMENT_STEP_SEC = 4;
export const BACKGROUND_PREVIEW_IDLE_DELAY_MS = 3000;
export const BACKGROUND_PREVIEW_SEGMENT_GAP_MS = 750;
const READY_PREVIEW_SEGMENT_CACHE_LIMIT = 128;
const readyPreviewSegmentCache = new Map();

export function clearSegmentedPreviewMemoryCache() {
  readyPreviewSegmentCache.clear();
}

function readySegmentCacheKey(assetId, directStreamUrl, segmentIndex) {
  return `${Number(assetId)}|${String(directStreamUrl || "")}|${Number(segmentIndex)}`;
}

function rememberReadySegment(assetId, directStreamUrl, segment) {
  if (!segment?.url) return segment;
  const key = readySegmentCacheKey(assetId, directStreamUrl, segment.segmentIndex);
  readyPreviewSegmentCache.delete(key);
  readyPreviewSegmentCache.set(key, segment);
  while (readyPreviewSegmentCache.size > READY_PREVIEW_SEGMENT_CACHE_LIMIT) {
    readyPreviewSegmentCache.delete(readyPreviewSegmentCache.keys().next().value);
  }
  return segment;
}

function cachedReadySegment(assetId, directStreamUrl, segmentIndex) {
  return readyPreviewSegmentCache.get(readySegmentCacheKey(assetId, directStreamUrl, segmentIndex)) || null;
}

function readySegmentFromResponse(assetId, data) {
  if (!data?.segment_url) return null;
  return {
    assetId: Number(assetId),
    segmentIndex: Number(data.requested_segment) || 0,
    startSec: Math.max(0, Number(data.segment_start_sec) || 0),
    endSec: Math.max(0, Number(data.segment_end_sec) || 0),
    url: data.segment_url,
  };
}

export function backgroundPreviewSegmentOrder({
  sourceDurationSec,
  segmentStepSec = DEFAULT_PREVIEW_SEGMENT_STEP_SEC,
  foregroundSegment = 0,
  foregroundLookAheadSec = 12,
}) {
  const step = Math.max(0.25, Number(segmentStepSec) || DEFAULT_PREVIEW_SEGMENT_STEP_SEC);
  const duration = Number(sourceDurationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const totalSegments = Math.max(0, Math.ceil(duration / step));
  if (totalSegments <= 0) return [];
  const current = Math.max(0, Math.min(totalSegments - 1, Math.floor(Number(foregroundSegment) || 0)));
  const foregroundCount = Math.max(1, Math.ceil(Math.max(0, Number(foregroundLookAheadSec) || 0) / step) + 1);
  const start = (current + foregroundCount) % totalSegments;
  return Array.from({ length: totalSegments }, (_unused, offset) => (start + offset) % totalSegments);
}

export function previewSegmentIndexAt(timeSec, stepSec = DEFAULT_PREVIEW_SEGMENT_STEP_SEC) {
  const step = Math.max(0.25, Number(stepSec) || DEFAULT_PREVIEW_SEGMENT_STEP_SEC);
  return Math.max(0, Math.floor(Math.max(0, Number(timeSec) || 0) / step));
}

export function shouldUseSegmentedPreview(asset, clip) {
  if (clip?.source_type !== "file" || clip?.meta?.asset_id == null) return false;
  if (asset) return Boolean(asset.preview_proxy_required && asset.preview_proxy_mode === "segmented");
  return Boolean(clip.meta?.preview_proxy_required && clip.meta?.preview_proxy_mode === "segmented");
}

function previewRequestErrorMessage(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object" && typeof detail.message === "string") return detail.message;
  return error?.message || "无法生成分段预览";
}

/**
 * Resolve the short MP4 that covers the active source time.  The previous
 * segment remains mounted while a far seek is pending so the preview can hold
 * its last decoded frame instead of tearing down the whole canvas.
 */
export function useSegmentedPreviewSource({
  assetId,
  directStreamUrl,
  enabled,
  isPlaying,
  segmentStepSec = DEFAULT_PREVIEW_SEGMENT_STEP_SEC,
  sourceDurationSec = 0,
  sourceTime,
}) {
  const desiredSegment = previewSegmentIndexAt(sourceTime, segmentStepSec);
  const [active, setActive] = useState(null);
  const [preload, setPreload] = useState(null);
  const [requestState, setRequestState] = useState({ status: enabled ? "idle" : "direct", error: "" });
  const [retryNonce, setRetryNonce] = useState(0);
  const requestEpochRef = useRef(0);

  useEffect(() => {
    requestEpochRef.current += 1;
    setActive(null);
    setPreload(null);
    setRetryNonce(0);
    setRequestState({ status: enabled ? "idle" : "direct", error: "" });
  }, [assetId, directStreamUrl, enabled]);

  const retry = useCallback(() => {
    setRequestState({ status: "queued", error: "" });
    setRetryNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled || assetId == null) return undefined;
    const epoch = ++requestEpochRef.current;
    const controller = new AbortController();
    let pollTimer = null;
    let startTimer = null;

    const cached = cachedReadySegment(assetId, directStreamUrl, desiredSegment);
    if (cached) {
      setActive(cached);
      setRequestState({ status: "ready", error: "" });
      return () => controller.abort();
    }

    // Sequential playback can promote the already requested and browser-
    // preloaded next segment without another request at the exact boundary.
    // `preload` is intentionally read from this render without being an
    // effect dependency: receiving a future segment must not restart the
    // current interactive request.
    if (
      preload?.assetId === Number(assetId)
      && preload.segmentIndex === desiredSegment
      && preload.url
    ) {
      setActive(preload);
      setRequestState({ status: "ready", error: "" });
      return () => controller.abort();
    }

    const request = async () => {
      if (controller.signal.aborted || requestEpochRef.current !== epoch) return;
      try {
        const data = await liteCutClient.requestAssetPreview({
          assetId,
          timeSec: desiredSegment * Math.max(0.25, Number(segmentStepSec) || DEFAULT_PREVIEW_SEGMENT_STEP_SEC),
          lookAheadSec: 12,
          priority: "interactive",
          retry: retryNonce > 0,
          signal: controller.signal,
        });
        if (controller.signal.aborted || requestEpochRef.current !== epoch) return;
        if (data?.status === "ready" && data.segment_url) {
          const segment = readySegmentFromResponse(assetId, data);
          rememberReadySegment(assetId, directStreamUrl, segment);
          setActive(segment);
          setRequestState({ status: "ready", error: "" });
          return;
        }
        if (data?.status === "failed") {
          setRequestState({ status: "failed", error: data.error || "分段预览生成失败" });
          return;
        }
        setRequestState({ status: data?.status || "queued", error: "" });
        pollTimer = window.setTimeout(request, 250);
      } catch (error) {
        if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        setRequestState({
          status: "failed",
          error: previewRequestErrorMessage(error),
        });
      }
    };

    // Playing through a boundary must not wait for scrub debounce.  Paused
    // seeks are coalesced so dragging across a long timeline does not queue a
    // segment for every transient position.
    startTimer = window.setTimeout(request, isPlaying ? 0 : 160);
    return () => {
      controller.abort();
      if (startTimer != null) window.clearTimeout(startTimer);
      if (pollTimer != null) window.clearTimeout(pollTimer);
    };
  }, [assetId, desiredSegment, directStreamUrl, enabled, isPlaying, retryNonce, segmentStepSec]);

  useEffect(() => {
    if (!enabled || assetId == null || !active?.url) return undefined;
    if (active.assetId !== Number(assetId) || active.segmentIndex !== desiredSegment) return undefined;
    const nextSegment = active.segmentIndex + 1;
    const controller = new AbortController();
    let pollTimer = null;
    let startTimer = null;

    const requestNext = async () => {
      if (controller.signal.aborted) return;
      try {
        const data = await liteCutClient.requestAssetPreview({
          assetId,
          timeSec: nextSegment * Math.max(0.25, Number(segmentStepSec) || DEFAULT_PREVIEW_SEGMENT_STEP_SEC),
          lookAheadSec: 12,
          priority: "prefetch",
          retry: false,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const requestedSegment = Number(data?.requested_segment);
        if (data?.status === "ready") {
          if (requestedSegment === nextSegment && data.segment_url) {
            const segment = readySegmentFromResponse(assetId, data);
            rememberReadySegment(assetId, directStreamUrl, segment);
            setPreload(segment);
          }
          return;
        }
        if (data?.status === "failed") return;
        pollTimer = window.setTimeout(requestNext, 400);
      } catch (error) {
        if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        // Prefetch is opportunistic. The interactive request remains the
        // authoritative path if the next segment cannot be warmed early.
      }
    };

    startTimer = window.setTimeout(requestNext, 120);
    return () => {
      controller.abort();
      if (startTimer != null) window.clearTimeout(startTimer);
      if (pollTimer != null) window.clearTimeout(pollTimer);
    };
  }, [active?.assetId, active?.segmentIndex, active?.url, assetId, desiredSegment, directStreamUrl, enabled, segmentStepSec]);

  useEffect(() => {
    if (isPlaying || !enabled || assetId == null || !active?.url) return undefined;
    if (active.assetId !== Number(assetId) || active.segmentIndex !== desiredSegment) return undefined;
    const currentSourceTime = Math.max(0, Number(sourceTime) || 0);
    if (currentSourceTime < active.startSec - 0.02 || currentSourceTime > active.endSec - 0.02) return undefined;
    const order = backgroundPreviewSegmentOrder({
      sourceDurationSec,
      segmentStepSec,
      foregroundSegment: desiredSegment,
    });
    if (order.length === 0) return undefined;

    const controller = new AbortController();
    const step = Math.max(0.25, Number(segmentStepSec) || DEFAULT_PREVIEW_SEGMENT_STEP_SEC);
    let cursor = 0;
    let timer = null;

    const schedule = (callback, delayMs) => {
      timer = window.setTimeout(callback, delayMs);
    };
    const fillNext = async () => {
      if (controller.signal.aborted || cursor >= order.length) return;
      const segmentIndex = order[cursor];
      try {
        const data = await liteCutClient.requestAssetPreview({
          assetId,
          timeSec: segmentIndex * step,
          lookAheadSec: 0,
          priority: "prefetch",
          retry: false,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (data?.status === "ready" || data?.status === "failed") {
          if (data?.status === "ready" && data.segment_url) {
            rememberReadySegment(assetId, directStreamUrl, readySegmentFromResponse(assetId, data));
          }
          cursor += 1;
          if (cursor < order.length) schedule(fillNext, BACKGROUND_PREVIEW_SEGMENT_GAP_MS);
          return;
        }
        schedule(fillNext, 500);
      } catch (error) {
        if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        // A temporary backend/network interruption should not turn idle cache
        // completion into a visible editor error. Retry gently while paused.
        schedule(fillNext, 1500);
      }
    };

    schedule(fillNext, BACKGROUND_PREVIEW_IDLE_DELAY_MS);
    return () => {
      controller.abort();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [active?.assetId, active?.endSec, active?.segmentIndex, active?.startSec, active?.url, assetId, desiredSegment, directStreamUrl, enabled, isPlaying, segmentStepSec, sourceDurationSec, sourceTime]);

  return useMemo(() => {
    if (!enabled) {
      return {
        streamUrl: directStreamUrl,
        mediaTimeOffset: 0,
        segmented: false,
        pending: false,
        status: "direct",
        error: "",
        preloadStreamUrl: null,
        retry,
      };
    }
    const currentSourceTime = Math.max(0, Number(sourceTime) || 0);
    const activeCoversCurrentTime = active?.assetId === Number(assetId)
      && currentSourceTime >= active.startSec - 0.02
      && currentSourceTime <= active.endSec - 0.02;
    const effectiveActive = activeCoversCurrentTime
      ? active
      : cachedReadySegment(assetId, directStreamUrl, desiredSegment);
    const activeCoversSourceTime = effectiveActive?.assetId === Number(assetId)
      && currentSourceTime >= effectiveActive.startSec - 0.02
      && currentSourceTime <= effectiveActive.endSec - 0.02;
    return {
      streamUrl: effectiveActive?.url || null,
      mediaTimeOffset: Math.max(0, Number(effectiveActive?.startSec) || 0),
      segmented: true,
      pending: !activeCoversSourceTime,
      status: effectiveActive ? "ready" : requestState.status,
      error: requestState.error,
      preloadStreamUrl: preload?.url || null,
      retry,
    };
  }, [active, assetId, desiredSegment, directStreamUrl, enabled, preload?.url, requestState.error, requestState.status, retry, sourceTime]);
}
