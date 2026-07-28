/** World grid size for fire occupancy, not a painted bloom radius. */
export const INFERNO_CELL_SIZE_WORLD = 36;
export const DEFAULT_SMOKE_CELL_SIZE = 20;

const EFFECT_PALETTES = {
  T: {
    smokeSoft: [180, 164, 126],
    smokeCore: [226, 211, 174],
    fire: [
      [255, 247, 214],
      [251, 191, 36],
      [249, 115, 22],
      [153, 27, 27],
    ],
  },
  CT: {
    smokeSoft: [112, 151, 174],
    smokeCore: [186, 216, 232],
    fire: [
      [239, 246, 255],
      [125, 211, 252],
      [56, 189, 248],
      [30, 64, 175],
    ],
  },
  unknown: {
    smokeSoft: [148, 163, 184],
    smokeCore: [203, 213, 225],
    fire: [
      [254, 243, 199],
      [251, 146, 60],
      [249, 115, 22],
      [194, 65, 12],
    ],
  },
};

export function effectPalette(side) {
  return EFFECT_PALETTES[String(side || "").toUpperCase()] || EFFECT_PALETTES.unknown;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashUnit(seed) {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

/** Binary search keeps per-frame selection cheap even for long effect journals. */
export function selectSamplePair(track, currentTick, hideAfterTick = null) {
  if (!track || !Array.isArray(track.samples) || !track.samples.length) {
    return { active: null, next: null, activeIndex: -1 };
  }
  const tick = Number(currentTick);
  if (!Number.isFinite(tick) || tick < Number(track.start_tick)) {
    return { active: null, next: null, activeIndex: -1 };
  }
  if (Number.isFinite(Number(hideAfterTick)) && Number(hideAfterTick) > 0 && tick > Number(hideAfterTick)) {
    return { active: null, next: null, activeIndex: -1 };
  }
  if (Number.isFinite(Number(track.end_tick)) && tick > Number(track.end_tick)) {
    return { active: null, next: null, activeIndex: -1 };
  }

  let low = 0;
  let high = track.samples.length - 1;
  let activeIndex = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (Number(track.samples[mid]?.tick) <= tick) {
      activeIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (activeIndex < 0) return { active: null, next: null, activeIndex: -1 };
  return {
    active: track.samples[activeIndex],
    next: track.samples[activeIndex + 1] || null,
    activeIndex,
  };
}

export function selectActiveSample(track, currentTick, hideAfterTick = null) {
  return selectSamplePair(track, currentTick, hideAfterTick).active;
}

export function buildActiveEffectLayers({
  tracks,
  currentTick,
  hideAfterTick,
  enabled,
  capabilities,
}) {
  if (!enabled || !Array.isArray(tracks) || !tracks.length) return [];
  const layers = [];
  for (const track of tracks) {
    if (track?.type === "smoke" && capabilities && capabilities.smoke_voxels === false) continue;
    if (track?.type === "inferno" && capabilities && capabilities.inferno_cells === false) continue;
    const pair = selectSamplePair(track, currentTick, hideAfterTick);
    if (!pair.active?.cells?.length) continue;
    layers.push({
      id: String(track.id || `${track.type}:${track.entity_id}`),
      type: track.type,
      side: String(track.side || "").toUpperCase(),
      cellSize: Number(
        pair.active.cell_size
        || track.cell_size
        || (track.type === "inferno" ? INFERNO_CELL_SIZE_WORLD : DEFAULT_SMOKE_CELL_SIZE),
      ),
      activeSample: pair.active,
      nextSample: track.type === "smoke" ? pair.next : null,
      detonation: track.stable_origin
        || pair.active.detonation_pos
        || pair.active.detonation
        || null,
    });
  }
  return layers;
}

export function activeEffectLayerSignature(layers) {
  return (layers || []).map((layer) => [
    layer.id,
    layer.type,
    Number(layer.activeSample?.tick),
    Number(layer.nextSample?.tick),
    layer.activeSample?.cells?.length || 0,
    layer.nextSample?.cells?.length || 0,
  ].join(":"))
    .join("|");
}

/**
 * Analytic, divergence-free curl field evaluated from absolute demo time.
 * It has no accumulated state, so seeking back to a tick is bit-for-bit stable.
 */
export function smokeParticleState(trackSeed, particleIndex, currentTick, base, radius, tickRate = 64) {
  const seed = (Number(trackSeed) + Math.imul(particleIndex + 1, 0x9e3779b1)) >>> 0;
  const u = hashUnit(seed);
  const v = hashUnit(seed ^ 0xa511e9b3);
  const phase = hashUnit(seed ^ 0x63d83595) * Math.PI * 2;
  const time = (Number(currentTick) || 0) / Math.max(1, Number(tickRate) || 64);
  const nx = (Number(base?.cx) || 0) * 0.035 + u * 4.2;
  const ny = (Number(base?.cy) || 0) * 0.035 + v * 4.2;

  // psi = sin(kx*x+a)*sin(ky*y+b); v = (dpsi/dy, -dpsi/dx).
  const a0 = nx + time * 0.42 + phase;
  const b0 = ny - time * 0.31 + phase * 0.73;
  const a1 = nx * 1.91 - time * 0.68 + phase * 1.37;
  const b1 = ny * 1.67 + time * 0.55 - phase * 0.41;
  const flowX = Math.sin(a0) * Math.cos(b0) + 0.42 * Math.sin(a1) * Math.cos(b1);
  const flowY = -(Math.cos(a0) * Math.sin(b0) + 0.48 * Math.cos(a1) * Math.sin(b1));
  const orbit = time * (0.18 + u * 0.12) + phase;
  const spread = radius * (0.38 + 0.48 * v);
  return {
    x: (Number(base?.cx) || 0) + Math.cos(orbit) * spread + flowX * radius * 0.42,
    y: (Number(base?.cy) || 0) + Math.sin(orbit) * spread + flowY * radius * 0.42,
    radius: radius * (0.55 + 0.42 * hashUnit(seed ^ 0xe91aaa35))
      * (0.94 + 0.06 * Math.sin(time * 1.7 + phase)),
    alpha: 0.34 + 0.28 * hashUnit(seed ^ 0x94d049bb),
  };
}

export function infernoFlameGeometry(item, currentTick, halfExtentPx) {
  const tick = Number(currentTick) || 0;
  const seed = Number.isFinite(Number(item?.seed))
    ? Number(item.seed)
    : Number(item?.cx || 0) * 0.071 + Number(item?.cy || 0) * 0.053;
  const slow = tick * 0.09 + seed;
  const quick = tick * 0.17 + seed * 1.73;
  const pulse = 0.92 + 0.08 * Math.sin(slow);
  const angle = quick * 0.43 + seed;
  const flameStrength = 0.5 + 0.5 * Math.sin(seed * 1.37 + 0.4);
  return {
    jitterX: halfExtentPx * 0.08 * Math.cos(angle),
    jitterY: halfExtentPx * 0.08 * Math.sin(angle),
    outerRadius: halfExtentPx * (1.12 + 0.08 * Math.sin(slow * 0.71)),
    middleRadius: halfExtentPx * (0.92 + 0.04 * Math.sin(slow * 0.83)),
    coreRadius: halfExtentPx * (0.28 + 0.04 * Math.cos(quick)),
    sparkX: halfExtentPx * 0.62 * Math.cos(angle * 1.31),
    sparkY: halfExtentPx * 0.62 * Math.sin(angle * 1.31),
    sparkRadius: Math.max(0.8, halfExtentPx * (0.08 + 0.05 * flameStrength)),
    flameStrength,
    pulse,
  };
}
