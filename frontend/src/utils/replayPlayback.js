/**
 * Absolute replay clock + tick-bracket interpolation for 8Hz samples → ~60FPS visuals.
 */

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerpNumber(start, end, ratio) {
  const left = Number(start);
  const right = Number(end);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return start;
  return left + (right - left) * ratio;
}

/** Shortest-path yaw lerp in degrees. */
export function lerpAngle(start, end, ratio) {
  const left = Number(start);
  const right = Number(end);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return start;
  const delta = ((right - left + 540) % 360) - 180;
  const value = left + delta * ratio;
  return ((value % 360) + 360) % 360;
}

/**
 * Absolute playback clock. Avoids truncated-delta drift.
 * playheadSeconds = offset + (now - startPerf) / 1000 * rate
 */
export function createReplayClock({
  offsetSeconds = 0,
  rate = 1,
  now = () => performance.now(),
} = {}) {
  let playStartPerf = now();
  let playStartOffsetSeconds = Number(offsetSeconds) || 0;
  let playbackRate = Number(rate) || 1;
  let playing = false;

  function getPlayheadSeconds(at = now()) {
    if (!playing) return playStartOffsetSeconds;
    return playStartOffsetSeconds + ((at - playStartPerf) / 1000) * playbackRate;
  }

  function play(at = now()) {
    if (playing) return;
    playStartPerf = at;
    playing = true;
  }

  function pause(at = now()) {
    if (!playing) return;
    playStartOffsetSeconds = getPlayheadSeconds(at);
    playing = false;
  }

  function seek(seconds) {
    playStartOffsetSeconds = Math.max(0, Number(seconds) || 0);
    playStartPerf = now();
  }

  function setRate(rateValue, at = now()) {
    if (playing) {
      playStartOffsetSeconds = getPlayheadSeconds(at);
      playStartPerf = at;
    }
    playbackRate = Number(rateValue) || 1;
  }

  function isPlaying() {
    return playing;
  }

  return {
    getPlayheadSeconds,
    play,
    pause,
    seek,
    setRate,
    isPlaying,
  };
}

/**
 * Binary search: largest index with frame.tick <= playheadTick.
 * Falls back to time_sec when ticks are missing.
 */
export function findPreviousFrameIndex(frames, playheadTick, playheadSeconds = null) {
  if (!frames?.length) return 0;
  const useTick = Number.isFinite(Number(playheadTick));
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const frame = frames[mid];
    const value = useTick ? Number(frame?.tick) : Number(frame?.time_sec);
    const target = useTick ? Number(playheadTick) : Number(playheadSeconds);
    if (!Number.isFinite(value)) {
      lo = mid + 1;
      continue;
    }
    if (value <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function frameBracket(frames, playheadTick, playheadSeconds = null) {
  if (!frames?.length) return { index: 0, previous: null, next: null, ratio: 0 };
  const index = findPreviousFrameIndex(frames, playheadTick, playheadSeconds);
  const previous = frames[index];
  const next = frames[Math.min(frames.length - 1, index + 1)];
  if (!previous || previous === next) {
    return { index, previous, next: previous, ratio: 0 };
  }
  const prevTick = Number(previous.tick);
  const nextTick = Number(next.tick);
  let ratio = 0;
  if (Number.isFinite(prevTick) && Number.isFinite(nextTick) && nextTick > prevTick && Number.isFinite(Number(playheadTick))) {
    ratio = (Number(playheadTick) - prevTick) / (nextTick - prevTick);
  } else {
    const prevTime = Number(previous.time_sec);
    const nextTime = Number(next.time_sec);
    if (Number.isFinite(prevTime) && Number.isFinite(nextTime) && nextTime > prevTime && Number.isFinite(Number(playheadSeconds))) {
      ratio = (Number(playheadSeconds) - prevTime) / (nextTime - prevTime);
    } else {
      ratio = 0;
    }
  }
  return { index, previous, next, ratio: clamp(ratio, 0, 1) };
}

export function playerKey(player) {
  return String(player?.steamid64 || player?.steam_id64 || player?.name || "").trim().toLowerCase();
}

/**
 * Linear position + shortest-path yaw between adjacent 8Hz samples.
 * HP / inventory / weapon stay stepped (no numeric blend).
 */
export function interpolateReplayPlayers(previous, next, ratio) {
  const upperPlayers = new Map((next?.players || []).map((player) => [playerKey(player), player]));
  return (previous?.players || []).map((player) => {
    const other = upperPlayers.get(playerKey(player));
    if (!other) return player;
    const t = clamp(Number(ratio) || 0, 0, 1);
    return {
      ...player,
      x: lerpNumber(player.x, other.x, t),
      y: lerpNumber(player.y, other.y, t),
      z: lerpNumber(player.z, other.z, t),
      yaw: lerpAngle(player.yaw, other.yaw, t),
      weapon: t >= 0.5 ? (other.weapon || player.weapon) : (player.weapon || other.weapon),
      inventory: t >= 0.5 ? (other.inventory || player.inventory) : (player.inventory || other.inventory),
    };
  });
}

export function interpolateReplayFrame(frames, playheadTick, playheadSeconds = null) {
  if (!frames?.length) {
    return { players: [], tick: playheadTick, time_sec: playheadSeconds || 0 };
  }
  const { previous, next, ratio, index } = frameBracket(frames, playheadTick, playheadSeconds);
  if (!previous) return frames[0];
  if (previous === next || ratio <= 0) {
    return { ...previous, _sampleIndex: index };
  }
  return {
    ...previous,
    players: interpolateReplayPlayers(previous, next, ratio),
    tick: lerpNumber(previous.tick, next.tick, ratio),
    time_sec: lerpNumber(previous.time_sec, next.time_sec, ratio),
    _sampleIndex: index,
    _interpRatio: ratio,
  };
}

/** Map playhead seconds → tick using first/last frame span (uniform fallback). */
export function playheadSecondsToTick(frames, playheadSeconds) {
  if (!frames?.length) return 0;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const t0 = Number(first.time_sec);
  const t1 = Number(last.time_sec);
  const tick0 = Number(first.tick);
  const tick1 = Number(last.tick);
  if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 && Number.isFinite(tick0) && Number.isFinite(tick1)) {
    const ratio = clamp((Number(playheadSeconds) - t0) / (t1 - t0), 0, 1);
    return tick0 + (tick1 - tick0) * ratio;
  }
  return tick0;
}

/**
 * External store so rAF can advance the playhead without setState on the React root.
 * Scene layers subscribe via useSyncExternalStore; toolbar uses sample-boundary callbacks.
 */
export function createPlayheadStore(initial = { position: 0, seconds: 0, tick: 0, sampleIndex: 0 }) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(partial) {
      state = { ...state, ...partial };
      listeners.forEach((listener) => listener());
    },
  };
}
