import { useEffect, useLayoutEffect, useRef } from "react";
import { releaseMediaElement } from "./previewMediaElementUtils.js";

let previewAudioContext = null;
const previewAudioNodes = new WeakMap();

export function previewAudioSourceDiscontinuity(previous, { sourceTime, nowMs, playbackRate, isPlaying }) {
  if (!isPlaying || !previous?.isPlaying) return true;
  const elapsedSec = Math.max(0, (Number(nowMs) - Number(previous.nowMs || 0)) / 1000);
  const sourceDelta = Number(sourceTime) - Number(previous.sourceTime || 0);
  const expectedDelta = elapsedSec * Math.max(0.25, Math.min(4, Number(playbackRate) || 1));
  return sourceDelta < -0.2 || sourceDelta - expectedDelta > Math.max(0.75, expectedDelta * 2);
}

export function correctedPreviewAudioRate(baseRate, driftSec) {
  const rate = Math.max(0.25, Math.min(4, Number(baseRate) || 1));
  const drift = Number(driftSec) || 0;
  if (Math.abs(drift) <= 0.06) return rate;
  const correction = Math.max(-0.05, Math.min(0.05, drift * 0.08));
  return Math.max(0.25, Math.min(4, rate * (1 + correction)));
}

function audioContextForPreview() {
  if (previewAudioContext) return previewAudioContext;
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return null;
  previewAudioContext = new Context();
  return previewAudioContext;
}

function gainNodeForElement(element) {
  const existing = previewAudioNodes.get(element);
  if (existing) {
    existing.source.connect(existing.gain);
    existing.gain.connect(existing.context.destination);
    return existing;
  }
  const context = audioContextForPreview();
  if (!context) return null;
  try {
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    const nodes = { context, source, gain };
    previewAudioNodes.set(element, nodes);
    return nodes;
  } catch {
    return null;
  }
}

export default function PreviewAudioItem({ item, isPlaying, userSeekToken = 0 }) {
  const audioRef = useRef(null);
  const sourceTime = Math.max(0, Number(item?.sourceTime) || 0);
  const safeRate = Math.max(0.25, Math.min(4, Number(item?.playbackRate) || 1));
  const safeVolume = Math.max(0, Math.min(20, Number(item?.volume) || 0));
  const preloadOnly = Boolean(item?.preloadOnly);
  const muted = Boolean(preloadOnly || item?.muted || safeVolume <= 0);
  const reversePlayback = Boolean(item?.reversePlayback);
  const preservePitch = item?.preservePitch !== false;
  const gainNodesRef = useRef(null);
  const syncSampleRef = useRef(null);
  const userSeekTokenRef = useRef(userSeekToken);

  useLayoutEffect(() => {
    const element = audioRef.current;
    syncSampleRef.current = null;
    gainNodesRef.current = element ? gainNodeForElement(element) : null;
    return () => {
      try {
        gainNodesRef.current?.source?.disconnect();
        gainNodesRef.current?.gain?.disconnect();
      } catch {
        // The graph may already be disconnected by the browser.
      }
      gainNodesRef.current = null;
      releaseMediaElement(element);
    };
  }, [item?.src]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src) return;
    element.playbackRate = safeRate;
    element.preservesPitch = preservePitch;
    if ("webkitPreservesPitch" in element) element.webkitPreservesPitch = preservePitch;
    const gainNodes = gainNodesRef.current;
    if (gainNodes) {
      gainNodes.gain.gain.value = preloadOnly ? 0 : safeVolume;
      element.volume = 1;
    } else {
      element.volume = preloadOnly ? 0 : Math.min(1, safeVolume);
    }
    element.muted = muted;
  }, [item?.src, muted, preloadOnly, preservePitch, safeRate, safeVolume]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src) return undefined;
    const nowMs = globalThis.performance?.now?.() ?? Date.now();
    const previous = syncSampleRef.current;
    const explicitUserSeek = userSeekToken !== userSeekTokenRef.current;
    userSeekTokenRef.current = userSeekToken;
    const discontinuity = explicitUserSeek || previewAudioSourceDiscontinuity(previous, {
      sourceTime,
      nowMs,
      playbackRate: safeRate,
      isPlaying,
    });
    syncSampleRef.current = { sourceTime, nowMs, isPlaying };

    const hardSync = () => {
      try {
        element.playbackRate = safeRate;
        if (Math.abs(element.currentTime - sourceTime) > 0.08) element.currentTime = sourceTime;
      } catch {
        // Metadata may not be available yet.
      }
    };

    // Metadata becoming available is the initial synchronization point. After
    // that, only explicit playhead discontinuities may seek. Continuously
    // writing currentTime for a large MP4 cancels its Range request on every
    // timeline update and eventually starves WebView2's audio decoder.
    if (element.readyState < 1) {
      element.addEventListener("loadedmetadata", hardSync, { once: true });
      return () => element.removeEventListener("loadedmetadata", hardSync);
    }
    if (discontinuity) hardSync();
    else if (!element.seeking && element.readyState >= 3) {
      element.playbackRate = correctedPreviewAudioRate(safeRate, sourceTime - element.currentTime);
    }
    return undefined;
  }, [isPlaying, item?.src, safeRate, sourceTime, userSeekToken]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src) return;
    if (isPlaying && !preloadOnly && !muted && !reversePlayback) {
      void gainNodesRef.current?.context?.resume?.().catch(() => {});
      void element.play().catch(() => {});
    }
    else element.pause();
  }, [isPlaying, item?.src, muted, preloadOnly, reversePlayback]);

  return item?.src ? <audio ref={audioRef} crossOrigin="anonymous" src={item.src} preload="auto" aria-hidden="true" /> : null;
}
