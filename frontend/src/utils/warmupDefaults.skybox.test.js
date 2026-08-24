import { describe, expect, it } from "vitest";

import { splitRecordWarmupConfirmPayload } from "./warmupDefaults.js";

describe("recording dialog skybox override", () => {
  it("keeps the skybox in session settings instead of warmup commands", () => {
    const result = splitRecordWarmupConfirmPayload({
      recording_skybox: "yinhezhanjian",
      tv_nochat: true,
    });

    expect(result.warmupForApi).toEqual({ tv_nochat: true });
    expect(result.session.recording_skybox).toBe("yinhezhanjian");
  });

  it("falls back to the original sky for an invalid session value", () => {
    expect(splitRecordWarmupConfirmPayload({ recording_skybox: "unknown" }).session)
      .toMatchObject({ recording_skybox: "default" });
  });
});
