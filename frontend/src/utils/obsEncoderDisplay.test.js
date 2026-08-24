import { describe, expect, it } from "vitest";

import { formatObsEncoderLabel, obsEncoderIsConfigured, obsEncoderIsHardware } from "./obsEncoderDisplay.js";

describe("OBS encoder display", () => {
  it("formats current and simple NVIDIA encoder values", () => {
    expect(formatObsEncoderLabel("obs_nvenc_av1_tex")).toBe("NVIDIA NVENC AV1");
    expect(formatObsEncoderLabel("nvenc")).toBe("NVIDIA NVENC H.264");
  });

  it("formats AMD and Intel values without treating them as migration ids", () => {
    expect(formatObsEncoderLabel("h264_texture_amf")).toBe("AMD AMF H.264");
    expect(formatObsEncoderLabel("obs_qsv11_hevc")).toBe("Intel QSV HEVC");
  });

  it("treats empty and sentinel values as unconfigured", () => {
    expect(obsEncoderIsConfigured("none")).toBe(false);
    expect(formatObsEncoderLabel("none", "未知")).toBe("未知");
  });

  it("distinguishes software encoding from vendor hardware encoding", () => {
    expect(obsEncoderIsHardware("x264")).toBe(false);
    expect(obsEncoderIsHardware("nvenc")).toBe(true);
    expect(obsEncoderIsHardware("h264_texture_amf")).toBe(true);
    expect(obsEncoderIsHardware("obs_qsv11_v2")).toBe(true);
  });
});
