/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Playback, OBS and HLAE use session-owned demo copies for player nicknames.
export const PLAYER_ALIAS_ENTRY_VISIBLE = true;

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

export function recordingAliasDemoTargets(requests, queue = []) {
  const items = new Map(queue.map(item => [item.id, item]));
  return [...new Map(requests.map(({ demo, source_ref }) => {
    const key = demo.demo_path || demo.demo_filename;
    const meta = items.get(source_ref?.queue_item_id)?.matchMeta;
    const target = { key, path: key, label: demo.demo_filename || key };
    if (meta) {
      // Display-only metadata stays out of recording DTOs and alias mappings.
      target.teamNames = { 2: meta.team_a_name, 3: meta.team_b_name };
      target.playerTeams = Object.fromEntries((meta.all_players || []).flatMap(player => {
        const id = String(player.steamid64 || "");
        const team = Number(player.team_num);
        return id && [2, 3].includes(team) ? [[id, team]] : [];
      }));
    }
    return [key, target];
  })).values()];
}

export function applyRecordingPlayerAliases(requests, maps) {
  return requests.map((request) => {
    const aliases = maps?.[request.demo.demo_path || request.demo.demo_filename];
    return aliases && Object.keys(aliases).length ? { ...request, player_aliases: aliases } : request;
  });
}
