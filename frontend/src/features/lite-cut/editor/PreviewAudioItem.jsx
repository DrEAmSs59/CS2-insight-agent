import { useEffect, useLayoutEffect, useRef } from "react";
import { releaseMediaElement } from "./previewMediaElementUtils.js";

let previewAudioContext = null;
const previewAudioNodes = new WeakMap();

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

export default function PreviewAudioItem({ item, isPlaying }) {
  const audioRef = useRef(null);
  const sourceTime = Math.max(0, Number(item?.sourceTime) || 0);
  const safeRate = Math.max(0.25, Math.min(4, Number(item?.playbackRate) || 1));
  const safeVolume = Math.max(0, Math.min(20, Number(item?.volume) || 0));
  const preloadOnly = Boolean(item?.preloadOnly);
  const muted = Boolean(preloadOnly || item?.muted || safeVolume <= 0);
  const reversePlayback = Boolean(item?.reversePlayback);
  const preservePitch = item?.preservePitch !== false;
  const gainNodesRef = useRef(null);

  useLayoutEffect(() => {
    const element = audioRef.current;
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
    const seek = () => {
      try {
        if (Math.abs(element.currentTime - sourceTime) > 0.18) element.currentTime = sourceTime;
      } catch {
        // Metadata may not be available yet.
      }
    };
    if (element.readyState >= 1) seek();
    else {
      element.addEventListener("loadedmetadata", seek, { once: true });
      return () => element.removeEventListener("loadedmetadata", seek);
    }
    return undefined;
  }, [item?.src, sourceTime]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src) return;
    if (isPlaying && !preloadOnly && !muted && !reversePlayback) {
      void gainNodesRef.current?.context?.resume?.().catch(() => {});
      void element.play().catch(() => {});
    }
    else element.pause();
  }, [isPlaying, item?.src, muted, preloadOnly, reversePlayback]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src || isPlaying) return;
    try {
      if (Math.abs(element.currentTime - sourceTime) > 0.25) element.currentTime = sourceTime;
    } catch {
      // Metadata may not be available yet.
    }
  }, [isPlaying, item?.src, sourceTime]);

  return item?.src ? <audio ref={audioRef} src={item.src} preload="auto" aria-hidden="true" /> : null;
}
