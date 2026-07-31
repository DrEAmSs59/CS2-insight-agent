import { describe, expect, test } from "vitest";
import { saveCustomSkinPlan } from "./saveCustomSkinPlan.js";

test("saveCustomSkinPlan returns stub success", async () => {
  await expect(saveCustomSkinPlan({ steamid: "1", replacements: {} }))
    .resolves.toEqual({ ok: true, stub: true });
});
