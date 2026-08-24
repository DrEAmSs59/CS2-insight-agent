import { describe, expect, it } from "vitest";

import { obsConfigHasIssues } from "./obsConfigHealth.js";

function healthyStatus(encoder = "nvenc") {
  return {
    obs_connected: true,
    monitor: { width: 1920, height: 1080 },
    video: {
      base_width: 1920,
      base_height: 1080,
      output_width: 1920,
      output_height: 1080,
    },
    scene: {
      dedicated_scene_exists: true,
      capture_source_exists: true,
      source_fit_to_canvas: true,
    },
    recording: {
      output_mode: "Simple",
      encoder,
      format: "hybrid_mp4",
      rec_quality: "Small",
      recommended_encoder: { id: "nvenc_h264", label: "NVIDIA NVENC H.264" },
    },
  };
}

describe("OBS config health", () => {
  it("accepts the configured hardware encoder", () => {
    expect(obsConfigHasIssues(healthyStatus())).toBe(false);
  });

  it("recommends hardware when recording currently uses x264", () => {
    expect(obsConfigHasIssues(healthyStatus("x264"))).toBe(true);
  });

  it("keeps x264 healthy when no hardware recommendation is available", () => {
    const status = healthyStatus("x264");
    status.recording.recommended_encoder = null;
    expect(obsConfigHasIssues(status)).toBe(false);
  });
});
