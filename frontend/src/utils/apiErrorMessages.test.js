import { describe, expect, it } from "vitest";

import { translate } from "../i18n/translate.js";
import { messageFromApiCode } from "./apiErrorMessages.js";

const zh = (key, params) => translate("zh", key, params);

describe("messageFromApiCode", () => {
  it("uses the selected-clip fallback instead of leaking a missing name placeholder", () => {
    const message = messageFromApiCode("MONTAGE_FFPROBE_FAILED", zh, {});

    expect(message).toContain("所选片段");
    expect(message).not.toContain("{name}");
  });

  it("preserves a concrete failed clip name", () => {
    const message = messageFromApiCode("MONTAGE_FFPROBE_FAILED", zh, { name: "clip.mp4" });

    expect(message).toContain("clip.mp4");
  });

  it("shows a direct reminder when the configured executable has no FrameMeld route", () => {
    const message = messageFromApiCode("MONTAGE_FRAMEMELD_REQUIRED", zh, {});

    expect(message).toContain("FrameMeld");
    expect(message).toContain("ffmpeg.exe");
  });
});
