export function normalizeWaveformBuckets(samples, bucketCount = 72) {
  const count = Math.max(8, Math.min(240, Math.floor(Number(bucketCount) || 72)));
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
