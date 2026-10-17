import { describe, expect, it } from "vitest";

import { translate } from "../i18n/translate.js";
import { messageFromApiCode } from "./apiErrorMessages.js";

const zh = (key, params) => translate("zh", key, params);

describe("messageFromApiCode", () => {
  it("shows a truncation update reminder for background jobs without error parameters", () => {
    const message = messageFromApiCode("MONTAGE_OUTPUT_INCOMPLETE", zh);
    expect(message).toContain("截断");
    expect(message).toContain("9.0.2");
    expect(message).toContain("FrameMeld");
    expect(message).not.toContain("{expected_seconds}");
  });
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

  it("explains how to recover from an oversized Windows export command", () => {
    const message = messageFromApiCode("MONTAGE_COMMAND_LINE_TOO_LONG", zh, {});

    expect(message).toContain("拆成两部分");
    expect(message).toContain("Windows");
  });
});
