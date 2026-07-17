import { useEffect, useLayoutEffect, useRef } from "react";
import { releaseMediaElement } from "./previewMediaElementUtils.js";

export default function PreviewAudioItem({ item, isPlaying }) {
  const audioRef = useRef(null);
  const sourceTime = Math.max(0, Number(item?.sourceTime) || 0);
  const safeRate = Math.max(0.25, Math.min(4, Number(item?.playbackRate) || 1));
  const safeVolume = Math.max(0, Math.min(1, Number(item?.volume) || 0));
  const muted = Boolean(item?.muted || safeVolume <= 0);
  const reversePlayback = Boolean(item?.reversePlayback);

  useLayoutEffect(() => {
    const element = audioRef.current;
    return () => releaseMediaElement(element);
  }, [item?.src]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !item?.src) return;
    element.playbackRate = safeRate;
    element.volume = safeVolume;
    element.muted = muted;
  }, [item?.src, muted, safeRate, safeVolume]);

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
    if (isPlaying && !muted && !reversePlayback) void element.play().catch(() => {});
    else element.pause();
  }, [isPlaying, item?.src, muted, reversePlayback]);

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
