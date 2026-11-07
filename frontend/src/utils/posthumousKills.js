import { create } from "zustand";

export const usePosthumousChoices = create((set) => ({
  choices: {},
  choose: (key, mode) => set((state) => ({ choices: { ...state.choices, [key]: mode === "victim" ? "victim" : "skip" } })),
}));

export const posthumousKey = (clip) => clip?.posthumous_choice_key || clip?.client_clip_uid || clip?.id || clip?.clip_id || "";
export const posthumousRows = (clip) => Array.isArray(clip?.posthumous_kills) ? clip.posthumous_kills : [];
export function posthumousOnly(clip) {
  if (clip?.posthumous && (clip.record_type || clip.type) === "kill") return true;
  const rows = posthumousRows(clip);
  return rows.length > 0 && clip.kill_ticks?.length > 0 && clip.kill_ticks.every((tick) => rows.some((row) => row.tick === tick));
}
export function posthumousMode(clip, choices) {
  return choices[posthumousKey(clip)] === "victim" ? "victim" : "skip";
}
export function canQueuePosthumous(clip, choices) {
  return !posthumousOnly(clip) || posthumousMode(clip, choices) === "victim";
}
export function withPosthumousChoice(clip, choices) {
  return { ...clip, posthumous_mode: posthumousMode(clip, choices) };
}
