import { AUDIO_MASTER_GAIN, AUDIO_TRACK_GAIN } from "../domain/audioContract.js";
import {
  LITE_CUT_OUTPUT_DEFAULTS,
  LITE_CUT_PROJECT_SCHEMA_VERSION,
  projectContract,
} from "../state/projectContract.js";

const TEMPLATE_FPS = LITE_CUT_OUTPUT_DEFAULTS.fps;

export const LITECUT_PROJECT_TEMPLATES = [
  { id: "highlight-16x9", label: "Highlight 16:9", detail: `1920 x 1080 · ${TEMPLATE_FPS} fps` },
  { id: "shorts-9x16", label: "Shorts 9:16", detail: `1080 x 1920 · ${TEMPLATE_FPS} fps` },
  { id: "review-multicam", label: "Multi-angle review", detail: `V1/V2 + A1/A2 · 1080p ${TEMPLATE_FPS}` },
];

function track(id, type, label) {
  return { id, type, label, locked: false, hidden: false, muted: false, solo: false, volume: AUDIO_TRACK_GAIN.default, clips: [] };
}

export function projectBodyFromTemplate(templateId) {
  const id = String(templateId || "highlight-16x9");
  const vertical = id === "shorts-9x16";
  const multicam = id === "review-multicam";
  return {
    schema_version: LITE_CUT_PROJECT_SCHEMA_VERSION,
    template_id: id,
    created_from_template: true,
    output: {
      ...LITE_CUT_OUTPUT_DEFAULTS,
      width: vertical ? 1080 : 1920,
      height: vertical ? 1920 : 1080,
      canvas_fit: vertical ? "cover" : "contain",
    },
    tracks: [
      track("v1", "video", "V1"),
      ...(multicam ? [track("v2", "video", "V2")] : []),
      track("a1", "audio", "A1"),
      ...(multicam ? [track("a2", "audio", "A2")] : []),
    ],
    overlays: [],
    transition_model_version: Number(projectContract.transition_events?.version) || 1,
    transitions: [],
    overlay_tracks: [],
    markers: [],
    audio: { master_volume: AUDIO_MASTER_GAIN.default, bgm: null },
  };
}
