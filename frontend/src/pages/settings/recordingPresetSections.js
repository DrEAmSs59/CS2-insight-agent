/** 录制预设页的小节锚点：左侧菜单与预设内容共用同一份 id 和标题。 */
export const RECORDING_PRESET_SECTIONS = [
  { id: "rp-pacing", labelKey: "settings.preset.pacing" },
  { id: "rp-replay", labelKey: "settings.preset.replay" },
  { id: "rp-camera", labelKey: "settings.preset.camera" },
  { id: "rp-experimental", labelKey: "settings.preset.experimental" },
  { id: "rp-hud", labelKey: "settings.preset.hud" },
  { id: "rp-canvas", labelKey: "settings.preset.canvas" },
  { id: "rp-launch", labelKey: "settings.preset.launch" },
];

// Per-recording settings inherit pacing and replay decisions from the queue.
export const RECORDING_SESSION_SECTIONS = RECORDING_PRESET_SECTIONS
  .filter(section => !["rp-pacing", "rp-replay"].includes(section.id))
  .map(section => ({ ...section, id: section.id.replace("rp-", "rw-") }));
