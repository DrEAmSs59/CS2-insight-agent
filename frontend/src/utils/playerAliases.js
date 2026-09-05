/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Temporarily hide the playback/recording entry points until the packaged
// demo-player-aliases sidecar is shipped again. Keep the editor and payload
// helpers intact so restoring the feature is a single flag change.
export const PLAYER_ALIAS_ENTRY_VISIBLE = false;

export function playerAliasError(name) {
  if (!name.trim()) return "";
  if (/[\p{Cc}\p{Cs}]/u.test(name)) return "playerAliases.controlError";
  if (name.length > 32 || new TextEncoder().encode(name).length > 127) return "playerAliases.lengthError";
  return "";
}

export function playerAliasMaps(editor) {
  if (!editor?.enabled) return {};
  const result = {};
  for (const [demo, aliases] of Object.entries(editor.drafts || {})) {
    const values = {};
    for (const [id, name] of Object.entries(aliases)) {
      if (playerAliasError(name)) throw new Error("playerAliases.invalid");
      if (name.trim()) values[id] = name;
    }
    if (Object.keys(values).length) result[demo] = values;
  }
  return result;
}

export function hasInvalidPlayerAliases(editor) {
  try { playerAliasMaps(editor); return false; } catch { return true; }
}

export function recordingAliasDemoTargets(requests) {
  return [...new Map(requests.map(({ demo }) => {
    const key = demo.demo_path || demo.demo_filename;
    return [key, { key, path: key, label: demo.demo_filename || key }];
  })).values()];
}

export function applyRecordingPlayerAliases(requests, maps) {
  return requests.map((request) => {
    const aliases = maps?.[request.demo.demo_path || request.demo.demo_filename];
    return aliases && Object.keys(aliases).length ? { ...request, player_aliases: aliases } : request;
  });
}
