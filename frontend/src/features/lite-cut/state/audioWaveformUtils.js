export const MAX_WAVEFORM_BUCKETS = 512;

export function normalizeWaveformBuckets(samples, bucketCount = 72) {
  const count = Math.max(8, Math.min(MAX_WAVEFORM_BUCKETS, Math.floor(Number(bucketCount) || 72)));
  const source = ArrayBuffer.isView(samples) || Array.isArray(samples) ? samples : [];
  if (!source.length) return Array.from({ length: count }, () => 0.08);

  const bucketSize = Math.max(1, Math.ceil(source.length / count));
  const values = Array.from({ length: count }, (_, index) => {
    const start = index * bucketSize;
    const end = Math.min(source.length, start + bucketSize);
    let peak = 0;
    for (let cursor = start; cursor < end; cursor += 1) peak = Math.max(peak, Math.abs(Number(source[cursor]) || 0));
    return peak;
  });
  const max = Math.max(...values, 0.0001);
  return values.map((value) => Math.max(0.08, Math.min(1, value / max)));
}

export function waveformBarCountForWidth(pixelWidth, {
  pixelsPerBar = 3,
  minBars = 16,
  maxBars = MAX_WAVEFORM_BUCKETS,
} = {}) {
  const width = Math.max(1, Number(pixelWidth) || 1);
  const spacing = Math.max(1, Number(pixelsPerBar) || 3);
  const minimum = Math.max(8, Math.floor(Number(minBars) || 16));
  const maximum = Math.max(minimum, Math.min(MAX_WAVEFORM_BUCKETS, Math.floor(Number(maxBars) || MAX_WAVEFORM_BUCKETS)));
  return Math.max(minimum, Math.min(maximum, Math.ceil(width / spacing)));
}

export function waveformPeaksForSourceTimes(peaks, {
  rangeStartSec = 0,
  rangeEndSec = rangeStartSec,
  sourceTimes = [],
} = {}) {
  const source = ArrayBuffer.isView(peaks) || Array.isArray(peaks) ? Array.from(peaks, (value) => Math.max(0.08, Math.min(1, Number(value) || 0))) : [];
  const times = ArrayBuffer.isView(sourceTimes) || Array.isArray(sourceTimes) ? Array.from(sourceTimes, Number) : [];
  if (!times.length) return source;
  if (!source.length) return Array.from({ length: times.length }, () => 0.08);
  const start = Number(rangeStartSec) || 0;
  const end = Number(rangeEndSec);
  const duration = Number.isFinite(end) && end > start ? end - start : 0.001;
  const sourceIndex = (time, round) => {
    const ratio = Math.max(0, Math.min(1, ((Number(time) || start) - start) / duration));
    return Math.max(0, Math.min(source.length - 1, round(ratio * source.length)));
  };
  return times.map((time, index) => {
    const previous = index > 0 ? times[index - 1] : time - ((times[index + 1] ?? time) - time);
    const next = index < times.length - 1 ? times[index + 1] : time + (time - (times[index - 1] ?? time));
    const edgeA = (previous + time) / 2;
    const edgeB = (time + next) / 2;
    const left = sourceIndex(Math.min(edgeA, edgeB), Math.floor);
    const right = sourceIndex(Math.max(edgeA, edgeB), Math.ceil);
    let peak = 0.08;
    for (let cursor = left; cursor <= right; cursor += 1) peak = Math.max(peak, source[cursor] || 0.08);
    return peak;
  });
}

export function waveformFromAudioBuffer(audioBuffer, bucketCount = 72) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== "function" || !audioBuffer.length) {
    return normalizeWaveformBuckets([], bucketCount);
  }
  const channels = Math.max(1, Number(audioBuffer.numberOfChannels) || 1);
  const merged = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < merged.length; index += 1) merged[index] += Math.abs(data[index] || 0) / channels;
  }
  return normalizeWaveformBuckets(merged, bucketCount);
}
