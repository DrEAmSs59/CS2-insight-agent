const MAGIC = "CS2RPL01";
const VERSION = 1;
const PLAYER_CACHE_FRAMES = 160;
const textDecoder = new TextDecoder("utf-8");

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function safeText(value) {
  const text = String(value ?? "").trim();
  return !text || ["nan", "nat", "none", "null", "undefined"].includes(text.toLowerCase())
    ? ""
    : text;
}

function safeWeapon(value) {
  const text = safeText(value).replace(/^weapon_/i, "");
  if (!text || /^\d+(?:\.0+)?$/.test(text)) return "";
  return text;
}

function isUtilityWeapon(value) {
  const key = safeText(value).toLowerCase().replaceAll("-", "").replaceAll(" ", "");
  return /knife|bayonet|smoke|flash|hegrenade|molotov|incendiary|incgrenade|decoy|taser|c4|defuser|healthshot/.test(key);
}

function resolveWeapon(activeName, activeWeapon, inventory) {
  const direct = safeWeapon(activeName) || safeWeapon(activeWeapon);
  if (direct) return direct;
  const primary = inventory.find((item) => !isUtilityWeapon(item));
  if (primary) return primary;
  return inventory.find((item) => /knife|bayonet|karambit/i.test(item)) || "";
}

function colorSlot(value) {
  const text = safeText(value).toLowerCase();
  const named = { blue: 0, green: 1, yellow: 2, orange: 3, purple: 4 };
  if (Object.hasOwn(named, text)) return named[text];
  const number = Number(text);
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : -1;
}

function nearestFrameIndex(ticks, target) {
  let lo = 0;
  let hi = ticks.length - 1;
  let insertion = ticks.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] >= target) {
      insertion = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const candidates = [insertion - 1, insertion]
    .filter((index) => index >= 0 && index < ticks.length);
  if (!candidates.length) return -1;
  return candidates.reduce((best, index) => (
    Math.abs(ticks[index] - target) < Math.abs(ticks[best] - target) ? index : best
  ), candidates[0]);
}

class ReplayFrameView {
  constructor(owner, index) {
    this.tick = owner.ticks[index];
    this.time_sec = index / owner.fps;
    Object.defineProperties(this, {
      players: {
        enumerable: true,
        get: () => owner.playersAt(index),
      },
      shots: {
        enumerable: true,
        get: () => owner.shotsByFrame[index],
      },
    });
  }
}

class ReplayBinaryTable {
  constructor(buffer, metadata, columns) {
    this.buffer = buffer;
    this.metadata = metadata;
    this.fps = Math.max(0.001, Number(metadata.fps) || 8);
    this.strings = Array.isArray(metadata.strings) ? metadata.strings : [""];
    this.ticks = columns.ticks;
    this.offsets = columns.offsets;
    this.columns = columns;
    this.frameViews = new Array(columns.ticks.length);
    this.playerCache = new Map();
    this.inventoryCache = new Map();
    this.sourceFrame = new Int32Array(columns.ticks.length);
    let previous = -1;
    for (let index = 0; index < columns.ticks.length; index += 1) {
      if (columns.offsets[index + 1] > columns.offsets[index]) previous = index;
      this.sourceFrame[index] = previous;
    }
    this.shotsByFrame = new Array(columns.ticks.length);
    for (const shot of metadata.shots || []) {
      const index = nearestFrameIndex(columns.ticks, Number(shot?.tick) || 0);
      if (index < 0) continue;
      (this.shotsByFrame[index] ||= []).push(shot);
    }
  }

  text(id) {
    return safeText(this.strings[Number(id)] || "");
  }

  inventory(id) {
    const key = Number(id) || 0;
    if (this.inventoryCache.has(key)) return this.inventoryCache.get(key);
    let raw = [];
    try {
      const parsed = JSON.parse(this.text(key) || "[]");
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = [];
    }
    const value = raw
      .map((item) => safeWeapon(item) || safeText(item))
      .filter(Boolean);
    this.inventoryCache.set(key, value);
    return value;
  }

  playersAt(frameIndex) {
    if (this.playerCache.has(frameIndex)) {
      const hit = this.playerCache.get(frameIndex);
      this.playerCache.delete(frameIndex);
      this.playerCache.set(frameIndex, hit);
      return hit;
    }
    const source = this.sourceFrame[frameIndex];
    if (source < 0) return [];
    const start = this.offsets[source];
    const end = this.offsets[source + 1];
    const povSid = safeText(this.metadata.pov_steamid64);
    const povName = safeText(this.metadata.pov_player_name).toLowerCase();
    let povTeam = null;
    for (let row = start; row < end; row += 1) {
      const sid = this.columns.steamid[row] ? this.columns.steamid[row].toString() : "";
      const name = this.text(this.columns.nameId[row]).toLowerCase();
      if ((povSid && sid === povSid) || (povName && name === povName)) {
        povTeam = this.columns.teamNum[row];
        break;
      }
    }
    const players = [];
    for (let row = start; row < end; row += 1) {
      const teamNum = this.columns.teamNum[row];
      if (teamNum !== 2 && teamNum !== 3) continue;
      const sid = this.columns.steamid[row] ? this.columns.steamid[row].toString() : null;
      const name = this.text(this.columns.nameId[row]);
      const inventory = this.inventory(this.columns.inventoryId[row]);
      const inventoryKeys = new Set(inventory.map((item) => (
        item.toLowerCase().replace(/^weapon_/, "").replaceAll(" ", "_")
      )));
      const flags = this.columns.flags[row];
      const activeWeapon = this.text(this.columns.activeWeaponId[row]);
      const activeWeaponName = this.text(this.columns.activeWeaponNameId[row]);
      players.push({
        steamid64: sid,
        name,
        team: teamNum === 3 ? "CT" : "T",
        x: this.columns.x[row],
        y: this.columns.y[row],
        z: this.columns.z[row],
        yaw: this.columns.yaw[row],
        is_alive: Boolean(flags & 1),
        health: this.columns.health[row],
        armor: this.columns.armor[row],
        has_helmet: Boolean(flags & 2),
        money: Math.max(0, this.columns.balance[row]),
        equipment_value: Math.max(0, this.columns.equipmentValue[row]),
        inventory,
        weapon: resolveWeapon(activeWeaponName, activeWeapon, inventory),
        has_defuser: Boolean(flags & 4),
        has_c4: Boolean(flags & 8) || inventoryKeys.has("c4") || inventoryKeys.has("c4_explosive"),
        flash_duration: Math.max(0, this.columns.flashDuration[row]),
        is_pov: Boolean((povSid && sid === povSid) || (povName && name.toLowerCase() === povName)),
        is_teammate: povTeam !== null && teamNum === povTeam,
        slot_color_index: colorSlot(this.text(this.columns.playerColorId[row])),
      });
    }
    this.playerCache.set(frameIndex, players);
    while (this.playerCache.size > PLAYER_CACHE_FRAMES) {
      this.playerCache.delete(this.playerCache.keys().next().value);
    }
    return players;
  }

  frameAt(index) {
    if (index < 0 || index >= this.ticks.length) return undefined;
    return (this.frameViews[index] ||= new ReplayFrameView(this, index));
  }
}

function numericIndex(property) {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return null;
  return Number(property);
}

function replayFrameArray(table) {
  const target = new Array(table.ticks.length);
  Object.defineProperties(target, {
    binaryByteLength: { value: table.buffer.byteLength, enumerable: false },
    replayMetadata: { value: table.metadata, enumerable: false },
    isBinaryReplayFrames: { value: true, enumerable: false },
  });
  return new Proxy(target, {
    get(array, property, receiver) {
      const index = numericIndex(property);
      if (index !== null) return table.frameAt(index);
      return Reflect.get(array, property, receiver);
    },
    has(array, property) {
      const index = numericIndex(property);
      if (index !== null) return index >= 0 && index < table.ticks.length;
      return Reflect.has(array, property);
    },
  });
}

function requireBytes(buffer, offset, bytes) {
  if (offset < 0 || bytes < 0 || offset + bytes > buffer.byteLength) {
    throw new Error("回放二进制数据不完整");
  }
}

export function decodeReplayBinary(input) {
  const buffer = input instanceof ArrayBuffer
    ? input
    : ArrayBuffer.isView(input)
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : null;
  if (!buffer) throw new TypeError("回放二进制响应不是 ArrayBuffer");
  requireBytes(buffer, 0, 16);
  const bytes = new Uint8Array(buffer);
  const magic = textDecoder.decode(bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`未知回放二进制格式：${magic}`);
  const view = new DataView(buffer);
  const version = view.getUint16(8, true);
  if (version !== VERSION) throw new Error(`不支持的回放二进制版本：${version}`);
  const headerLength = view.getUint32(12, true);
  requireBytes(buffer, 16, headerLength);
  const metadata = JSON.parse(textDecoder.decode(bytes.subarray(16, 16 + headerLength)));
  const frameCount = Number(metadata.frame_count);
  const rowCount = Number(metadata.row_count);
  if (!Number.isSafeInteger(frameCount) || frameCount < 0 || frameCount > 40_000) {
    throw new Error(`非法回放帧数：${frameCount}`);
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 500_000) {
    throw new Error(`非法回放玩家行数：${rowCount}`);
  }
  let offset = align(16 + headerLength, 4);
  const take = (Type, count, boundary = Type.BYTES_PER_ELEMENT) => {
    offset = align(offset, boundary);
    const byteLength = count * Type.BYTES_PER_ELEMENT;
    requireBytes(buffer, offset, byteLength);
    const array = new Type(buffer, offset, count);
    offset += byteLength;
    return array;
  };
  const ticks = take(Int32Array, frameCount);
  const offsets = take(Uint32Array, frameCount + 1);
  offset = align(offset, 8);
  const columns = {
    ticks,
    offsets,
    steamid: take(BigUint64Array, rowCount, 8),
    nameId: take(Uint32Array, rowCount),
    teamNum: take(Int8Array, rowCount),
    flags: take(Uint8Array, rowCount),
    health: take(Uint16Array, rowCount, 2),
    armor: take(Uint16Array, rowCount, 2),
    balance: take(Int32Array, rowCount),
    equipmentValue: take(Int32Array, rowCount),
    x: take(Float32Array, rowCount),
    y: take(Float32Array, rowCount),
    z: take(Float32Array, rowCount),
    yaw: take(Float32Array, rowCount),
    flashDuration: take(Float32Array, rowCount),
    inventoryId: take(Uint32Array, rowCount),
    activeWeaponId: take(Uint32Array, rowCount),
    activeWeaponNameId: take(Uint32Array, rowCount),
    playerColorId: take(Uint32Array, rowCount),
  };
  if (offsets.length && offsets[offsets.length - 1] !== rowCount) {
    throw new Error("回放二进制帧索引与玩家行数不一致");
  }
  const table = new ReplayBinaryTable(buffer, metadata, columns);
  const frames = replayFrameArray(table);
  return {
    frames,
    map_transform: metadata.map_transform || null,
    fps: Math.max(1, Number(metadata.fps) || 8),
    effect_tracks: Array.isArray(metadata.effect_tracks) ? metadata.effect_tracks : [],
    effect_capabilities: metadata.effect_capabilities || null,
    effect_warnings: metadata.effect_warnings || [],
    effects_pending: metadata.effects_pending === true,
    demo_fingerprint: metadata.demo_fingerprint || null,
    cache: metadata.cache || { frames: "parquet_binary_hit", effects: "pending", parsed: false },
    binary_bytes: buffer.byteLength,
    protocol: metadata.protocol,
  };
}

export function isReplayFrameCollection(value) {
  return Array.isArray(value);
}
