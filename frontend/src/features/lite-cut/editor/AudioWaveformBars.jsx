import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  MAX_WAVEFORM_BUCKETS,
  normalizeWaveformBuckets,
  waveformBarCountForWidth,
  waveformPeaksForSourceTimes,
} from "../state/audioWaveformUtils.js";

const WAVEFORM_MEMORY_CACHE_LIMIT = 256;
const waveformCache = new Map();
const waveformPendingRequests = new Map();
const waveformSourceRequestTails = new Map();
const waveformRequestConsumers = new Map();

function waveformQueryNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Number(number.toFixed(6)));
}

function cachedWaveform(url) {
  const value = waveformCache.get(url) || null;
  if (!value) return null;
  waveformCache.delete(url);
  waveformCache.set(url, value);
  return value;
}

function rememberWaveform(url, value) {
  waveformCache.delete(url);
  waveformCache.set(url, value);
  while (waveformCache.size > WAVEFORM_MEMORY_CACHE_LIMIT) {
    waveformCache.delete(waveformCache.keys().next().value);
  }
}

export function clearWaveformMemoryCache() {
  waveformCache.clear();
  waveformPendingRequests.clear();
  waveformSourceRequestTails.clear();
  waveformRequestConsumers.clear();
}

function retainWaveformRequest(cacheKey) {
  waveformRequestConsumers.set(cacheKey, (waveformRequestConsumers.get(cacheKey) || 0) + 1);
}

function releaseWaveformRequest(cacheKey) {
  const next = (waveformRequestConsumers.get(cacheKey) || 0) - 1;
  if (next > 0) waveformRequestConsumers.set(cacheKey, next);
  else waveformRequestConsumers.delete(cacheKey);
}

function loadWaveform(waveformUrl, cacheKey, sourceKey) {
  const cached = cachedWaveform(cacheKey);
  if (cached) return Promise.resolve(cached);
  const pending = waveformPendingRequests.get(cacheKey);
  if (pending) return pending;
  const previous = waveformSourceRequestTails.get(sourceKey) || Promise.resolve();
  const request = previous
    .catch(() => undefined)
    .then(async () => {
      const afterWait = cachedWaveform(cacheKey);
      if (afterWait) return afterWait;
      if (!waveformRequestConsumers.has(cacheKey)) throw new Error("waveform tile no longer visible");
      const response = await fetch(waveformUrl);
      if (!response.ok) throw new Error("waveform fetch failed");
      const next = await response.json();
      rememberWaveform(cacheKey, next);
      return next;
    });
  waveformPendingRequests.set(cacheKey, request);
  const tail = request
    .catch(() => undefined)
    .finally(() => {
      if (waveformSourceRequestTails.get(sourceKey) === tail) waveformSourceRequestTails.delete(sourceKey);
    });
  waveformSourceRequestTails.set(sourceKey, tail);
  void request.finally(() => {
    if (waveformPendingRequests.get(cacheKey) === request) waveformPendingRequests.delete(cacheKey);
  }).catch(() => undefined);
  return request;
}

export function waveformUrlForMediaStream(sourceUrl, { bars = 72, startSec = 0, endSec = null } = {}) {
  const source = String(sourceUrl || "");
  const queryIndex = source.indexOf("?");
  const path = queryIndex >= 0 ? source.slice(0, queryIndex) : source;
  if (!/\/api\/(?:lite-cut\/assets|recorded-clips)\/[^/]+\/stream$/.test(path)) return null;
  const params = new URLSearchParams({
    buckets: String(Math.max(8, Math.min(MAX_WAVEFORM_BUCKETS, Math.round(Number(bars) || 72)))),
    start_sec: waveformQueryNumber(Math.max(0, Number(startSec) || 0)),
  });
  if (Number.isFinite(Number(endSec)) && Number(endSec) > Number(startSec)) {
    params.set("end_sec", waveformQueryNumber(endSec));
  }
  return `${path.replace(/\/stream$/, "/waveform")}?${params.toString()}`;
}

function drawWaveform(canvas, values) {
  if (!canvas || typeof window === "undefined" || typeof window.CanvasRenderingContext2D === "undefined") return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const ratio = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
  const bitmapWidth = Math.max(1, Math.round(width * ratio));
  const bitmapHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(canvas).color || "#f59e0b";
  context.globalAlpha = 0.68;
  const count = Math.max(1, values.length);
  const step = width / count;
  const barWidth = Math.max(1, Math.min(3, step * 0.68));
  for (let index = 0; index < count; index += 1) {
    const peak = Math.max(0.08, Math.min(1, Number(values[index]) || 0.08));
    const barHeight = Math.max(2, peak * Math.max(2, height - 4));
    const x = index * step + (step - barWidth) / 2;
    const y = (height - barHeight) / 2;
    context.fillRect(x, y, barWidth, barHeight);
  }
  context.globalAlpha = 1;
}

export default function AudioWaveformBars({
  sourceUrl = null,
  bars = null,
  startSec = 0,
  endSec = null,
  sampleSourceTimes = null,
  className = "",
  style = null,
}) {
  const canvasRef = useRef(null);
  const [autoBars, setAutoBars] = useState(72);
  const resolvedBars = bars == null
    ? autoBars
    : Math.max(8, Math.min(MAX_WAVEFORM_BUCKETS, Math.round(Number(bars) || 72)));
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const waveformUrl = waveformUrlForMediaStream(sourceUrl, { bars: resolvedBars, startSec, endSec });
  const waveformCacheKey = waveformUrl ? `${String(sourceUrl || "")}|${waveformUrl}` : null;

  useLayoutEffect(() => {
    if (bars != null) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const update = () => {
      const next = waveformBarCountForWidth(canvas.getBoundingClientRect().width);
      setAutoBars((current) => (current === next ? current : next));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(canvas);
    return () => observer?.disconnect();
  }, [bars]);

  useEffect(() => {
    let active = true;
    if (!waveformUrl) {
      setPayload(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    retainWaveformRequest(waveformCacheKey);
    const load = async () => {
      setPayload(null);
      setLoading(true);
      try {
        const next = await loadWaveform(waveformUrl, waveformCacheKey, String(sourceUrl || waveformUrl));
        if (active) setPayload(next);
      } catch {
        if (active) setPayload(null);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      releaseWaveformRequest(waveformCacheKey);
    };
  }, [sourceUrl, waveformCacheKey, waveformUrl]);

  const values = useMemo(() => {
    const normalized = normalizeWaveformBuckets(payload?.peaks || [], resolvedBars);
    if (!sampleSourceTimes?.length || !payload) return normalized;
    return waveformPeaksForSourceTimes(normalized, {
      rangeStartSec: payload.start_sec ?? startSec,
      rangeEndSec: payload.end_sec ?? endSec,
      sourceTimes: sampleSourceTimes,
    });
  }, [endSec, payload, resolvedBars, sampleSourceTimes, startSec]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const render = () => drawWaveform(canvas, values);
    render();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(render);
    observer?.observe(canvas);
    return () => observer?.disconnect();
  }, [values]);

  return (
    <canvas
      ref={canvasRef}
      className={`block overflow-hidden bg-cs2-bg-input text-cs2-accent ${className}`}
      style={style || undefined}
      aria-label="音频波形"
      aria-busy={loading}
      data-waveform-canvas
      data-waveform-buckets={resolvedBars}
      data-waveform-start-sec={waveformQueryNumber(startSec)}
      data-waveform-end-sec={endSec == null ? "" : waveformQueryNumber(endSec)}
    />
  );
}
