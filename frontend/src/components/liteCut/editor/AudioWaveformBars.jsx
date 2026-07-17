import { useEffect, useState } from "react";
import { normalizeWaveformBuckets } from "../../../stores/liteCut/audioWaveformUtils.js";

const waveformCache = new Map();

export function waveformUrlForMediaStream(sourceUrl, { bars = 72, startSec = 0, endSec = null } = {}) {
  const source = String(sourceUrl || "");
  const path = source.split("?", 1)[0];
  if (!/\/api\/(?:lite-cut\/assets|recorded-clips)\/[^/]+\/stream$/.test(path)) return null;
  const params = new URLSearchParams({
    buckets: String(Math.max(8, Math.min(512, Math.round(Number(bars) || 72)))),
    start_sec: String(Math.max(0, Number(startSec) || 0)),
  });
  if (Number.isFinite(Number(endSec)) && Number(endSec) > Number(startSec)) params.set("end_sec", String(Number(endSec)));
  return `${path.replace(/\/stream$/, "/waveform")}?${params.toString()}`;
}

export default function AudioWaveformBars({ sourceUrl = null, bars = 72, startSec = 0, endSec = null, className = "" }) {
  const [values, setValues] = useState(() => normalizeWaveformBuckets([], bars));
  const [loading, setLoading] = useState(false);
  const waveformUrl = waveformUrlForMediaStream(sourceUrl, { bars, startSec, endSec });

  useEffect(() => {
    let active = true;
    if (!waveformUrl) {
      setValues(normalizeWaveformBuckets([], bars));
      setLoading(false);
      return () => {
        active = false;
      };
    }
    const cached = waveformCache.get(waveformUrl);
    if (cached) {
      setValues(cached);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(waveformUrl);
        if (!response.ok) throw new Error("waveform fetch failed");
        const payload = await response.json();
        const next = normalizeWaveformBuckets(payload?.peaks || [], bars);
        waveformCache.set(waveformUrl, next);
        if (active) setValues(next);
      } catch {
        if (active) setValues(normalizeWaveformBuckets([], bars));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [bars, waveformUrl]);

  return (
    <div className={`flex items-center gap-px overflow-hidden bg-cs2-bg-input px-1 ${className}`} aria-label="音频波形" aria-busy={loading}>
      {values.map((value, index) => (
        <span
          key={index}
          className="min-w-px flex-1 rounded-sm bg-cs2-accent/65"
          style={{ height: `${Math.max(8, value * 100)}%` }}
        />
      ))}
    </div>
  );
}
