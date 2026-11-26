import { posthumousOnly } from "./posthumousKills";

export function groupedReplayOption(clip) {
  if (clip?.timeline_source) return null;
  if (clip?.category === "highlight" && clip.kill_ticks?.length >= 2) return "group_victim_replays";
  if (clip?.category !== "compilation") return null;
  if (["all_kills", "weapon_kills", "rival_kills"].includes(clip.compilation_kind)) return "group_victim_replays";
  if (clip.compilation_kind === "all_deaths") return "group_killer_replays";
  return null;
}

export function usesGroupedReplays(item) {
  const option = groupedReplayOption(item?.clipData);
  const pacing = item?.pacing_override;
  if (!option || pacing?.[option] !== true || posthumousOnly(item.clipData)) return false;
  if (option === "group_killer_replays") return pacing.killer_pov === true;
  return pacing.victim_pov === true;
}
