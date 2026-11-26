import { posthumousOnly } from "./posthumousKills";

export function isAllKillsCompilation(clip) {
  return clip?.category === "compilation" && clip.compilation_kind === "all_kills";
}

export function usesGroupedKillReplays(item) {
  return isAllKillsCompilation(item?.clipData) && !posthumousOnly(item.clipData) &&
    item.pacing_override?.victim_pov === true && item.pacing_override.group_victim_replays === true;
}
