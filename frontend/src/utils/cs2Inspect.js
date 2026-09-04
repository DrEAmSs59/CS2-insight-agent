/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CEconItemPreviewDataBlock } from "@ianlucas/cs2-lib-inspect/dist/Protobufs/cstrike15_gcmessages.js";

const CS2_INSPECT_URL_PREFIX = "steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20";
const CS2_INSPECT_COMMAND_PREFIX = "csgo_econ_action_preview ";
const INSPECT_HEX_PATTERN = /^[0-9a-f]+$/i;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function requiredInteger(value, label, { min = 0, max = 0xffffffff } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return number;
}

function optionalInteger(value, { min = 0, max = 0xffffffff } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

function floatToUint32(value) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeInspectHex(attributes) {
  const payload = CEconItemPreviewDataBlock.toBinary(attributes);
  const encoded = new Uint8Array(payload.length + 5);
  encoded[0] = 0;
  encoded.set(payload, 1);
  const crc = crc32(encoded.subarray(0, payload.length + 1));
  const checksum = ((crc & 0xffff) ^ Math.imul(payload.length, crc)) >>> 0;
  new DataView(encoded.buffer).setUint32(payload.length + 1, checksum, false);
  return Array.from(encoded, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function inspectSticker(sticker, fallbackSlot) {
  const stickerId = optionalInteger(
    sticker?.paint_index ?? sticker?.sticker_id ?? sticker?.stickerId ?? sticker?.kit_id,
    { min: 1 },
  );
  if (stickerId === undefined) return null;
  const result = {
    slot: optionalInteger(sticker?.slot, { min: 0 }) ?? fallbackSlot,
    stickerId,
  };
  const wear = finiteNumber(sticker?.wear);
  const scale = finiteNumber(sticker?.scale);
  const rotation = finiteNumber(sticker?.rotation);
  const offsetX = finiteNumber(sticker?.x ?? sticker?.offset_x ?? sticker?.offset?.x);
  const offsetY = finiteNumber(sticker?.y ?? sticker?.offset_y ?? sticker?.offset?.y);
  if (wear !== undefined && wear >= 0 && wear <= 1) result.wear = wear;
  if (scale !== undefined) result.scale = scale;
  if (rotation !== undefined) result.rotation = rotation;
  if (offsetX !== undefined) result.offsetX = offsetX;
  if (offsetY !== undefined) result.offsetY = offsetY;
  return result;
}

function inspectKeychain(keychain) {
  if (!keychain) return null;
  const stickerId = optionalInteger(
    keychain?.definition_id ?? keychain?.definitionId ?? keychain?.paint_index ?? keychain?.sticker_id,
    { min: 1 },
  );
  if (stickerId === undefined) return null;
  const result = {
    slot: optionalInteger(keychain?.slot, { min: 0 }) ?? 0,
    stickerId,
  };
  const offsetX = finiteNumber(keychain?.x ?? keychain?.offset_x ?? keychain?.offset?.x);
  const offsetY = finiteNumber(keychain?.y ?? keychain?.offset_y ?? keychain?.offset?.y);
  const offsetZ = finiteNumber(keychain?.z ?? keychain?.offset_z ?? keychain?.offset?.z);
  const pattern = optionalInteger(keychain?.seed ?? keychain?.pattern, { min: 0 });
  if (offsetX !== undefined) result.offsetX = offsetX;
  if (offsetY !== undefined) result.offsetY = offsetY;
  if (offsetZ !== undefined) result.offsetZ = offsetZ;
  if (pattern !== undefined) result.pattern = pattern;
  return result;
}

/** Build Valve's modern self-contained CS2 preview URL directly from item fields. */
export function buildCs2InspectLink(item) {
  if (item?.finish_known === false) {
    throw new Error("The Demo does not contain a trustworthy paint kit for this item.");
  }
  const defindex = requiredInteger(item?.def_index ?? item?.def, "def_index", { min: 1 });
  const paintindex = requiredInteger(item?.paint_index ?? item?.index ?? 0, "paint_index");
  const wear = finiteNumber(item?.paint_wear ?? item?.wear) ?? 0;
  const seed = Math.trunc(finiteNumber(item?.paint_seed ?? item?.seed) ?? 0);
  if (wear < 0 || wear > 1) throw new Error("paint_wear must be between 0 and 1.");
  if (seed < 0 || seed > 1000) throw new Error("paint_seed must be between 0 and 1000.");

  const stickers = (Array.isArray(item?.stickers) ? item.stickers : [])
    .slice(0, 5)
    .map(inspectSticker)
    .filter(Boolean);
  const keychain = inspectKeychain(item?.keychain ?? item?.keychains?.[0]);
  const attributes = {
    defindex,
    paintindex,
    paintwear: floatToUint32(wear),
    paintseed: seed,
    stickers,
    keychains: keychain ? [keychain] : [],
  };
  if (typeof item?.custom_name === "string" && item.custom_name) {
    attributes.customname = item.custom_name;
  }
  const statTrak = optionalInteger(item?.stat_trak ?? item?.stattrak, { min: 0 });
  if (statTrak !== undefined) {
    attributes.killeaterscoretype = 0;
    attributes.killeatervalue = statTrak;
    attributes.quality = 9;
  }
  return `${CS2_INSPECT_URL_PREFIX}${encodeInspectHex(attributes)}`;
}

export function buildCs2ViewerUrl(item) {
  const id = Number(item?.catalog_id);
  if (!Number.isInteger(id)) return "";
  const viewerItem = { id };
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  if (wear !== undefined) viewerItem.wear = Number(wear.toFixed(6));
  if (seed !== undefined) viewerItem.seed = Math.trunc(seed);
  if (typeof item?.custom_name === "string" && item.custom_name) {
    viewerItem.nameTag = item.custom_name;
  }
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  if (stickers.length) {
    viewerItem.stickers = Object.fromEntries(stickers.flatMap((sticker, index) => {
      const stickerId = Number(sticker?.catalog_id);
      if (!Number.isInteger(stickerId)) return [];
      return [[String(sticker?.slot ?? index), {
        id: stickerId,
        wear: finiteNumber(sticker?.wear),
      }]];
    }));
  }
  const url = new URL("https://3d.cstrike.app/view");
  url.searchParams.set("halfRotation", "1");
  url.searchParams.set("bg", "0");
  url.searchParams.set("item", JSON.stringify(viewerItem));
  return url.toString();
}

export function inspectHexFromValue(value) {
  let decoded = String(value || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original value so the validation below reports one format error.
  }
  const match = decoded.match(/csgo_econ_action_preview\s+([0-9a-f]+)/i);
  const hex = String(match?.[1] || "").trim();
  if (!hex || hex.length % 2 !== 0 || !INSPECT_HEX_PATTERN.test(hex)) {
    throw new Error("The CS2 inspect payload is invalid.");
  }
  return hex.toUpperCase();
}

export function isCs2SteamInspectUrl(value) {
  return /^steam:\/\/(?:run|rungame)\/730\//i.test(String(value || ""));
}

/** Launch CS2 with a validated self-contained preview payload. */
export async function launchCs2Inspect(
  item,
  { launchInspect, openExternal, writeClipboardText } = {},
) {
  const inspectValue = buildCs2InspectLink(item);
  const hex = inspectHexFromValue(inspectValue);
  let launchError = null;

  if (typeof launchInspect === "function") {
    try {
      await launchInspect(hex);
      return { status: "launched", value: inspectValue };
    } catch (error) {
      launchError = error;
    }
  }

  if (typeof openExternal === "function") {
    try {
      await openExternal(inspectValue);
      return { status: "launched", value: inspectValue };
    } catch (error) {
      launchError = error;
    }
  }

  if (typeof writeClipboardText === "function") {
    const command = `${CS2_INSPECT_COMMAND_PREFIX}${hex}`;
    await writeClipboardText(command);
    return { status: "command-copied", value: command };
  }

  throw launchError || new Error("CS2 inspect launcher is unavailable.");
}
