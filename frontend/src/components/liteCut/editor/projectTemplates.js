export const LITECUT_PROJECT_TEMPLATES = [
  { id: "highlight-16x9", label: "Highlight 16:9", detail: "1920 x 1080 · 60 fps" },
  { id: "shorts-9x16", label: "Shorts 9:16", detail: "1080 x 1920 · 60 fps" },
  { id: "review-multicam", label: "Multi-angle review", detail: "V1/V2 + A1/A2 · 1080p 60" },
];

function track(id, type, label) {
  return { id, type, label, locked: false, hidden: false, muted: false, solo: false, volume: 1, clips: [] };
}

export function projectBodyFromTemplate(templateId) {
  const id = String(templateId || "highlight-16x9");
  const vertical = id === "shorts-9x16";
  const multicam = id === "review-multicam";
  return {
    schema_version: 2,
    template_id: id,
    created_from_template: true,
    output: {
      dir: "",
      filename: "lite_cut_export.mp4",
      width: vertical ? 1080 : 1920,
      height: vertical ? 1920 : 1080,
      fps: 60,
      encoder: "auto",
      canvas_fit: vertical ? "cover" : "contain",
      background_color: "#000000",
      blur_amount: 24,
      range_mode: "full",
      range_start_sec: 0,
      range_end_sec: null,
    },
    tracks: [
      track("v1", "video", "V1"),
      ...(multicam ? [track("v2", "video", "V2")] : []),
      track("a1", "audio", "A1"),
      ...(multicam ? [track("a2", "audio", "A2")] : []),
    ],
    overlays: [],
    markers: [],
    audio: { master_volume: 1, bgm: null },
  };
}
