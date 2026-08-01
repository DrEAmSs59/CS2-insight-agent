import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api/api.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import API from "../../api/api.js";
import { loadCustomSkinPlan, saveCustomSkinPlan } from "./saveCustomSkinPlan.js";

describe("saveCustomSkinPlan", () => {
  beforeEach(() => {
    API.get.mockReset();
    API.post.mockReset();
  });

  test("POSTs custom-plan with steamid and replacements for demoId", async () => {
    API.post.mockResolvedValue({
      data: { ok: true, plan: { steamid: "1", items: [] } },
    });

    await expect(
      saveCustomSkinPlan({
        demoId: 42,
        steamid: "1",
        replacements: { "id:10": { paint_index: 340 } },
      }),
    ).resolves.toEqual({ ok: true, plan: { steamid: "1", items: [] } });

    expect(API.post).toHaveBeenCalledWith("/demos/42/cosmetics/custom-plan", {
      steamid: "1",
      replacements: { "id:10": { paint_index: 340 } },
    });
  });

  test("GETs custom-plan for demoId and steamid", async () => {
    API.get.mockResolvedValue({ data: { ok: true, plan: null } });

    await expect(loadCustomSkinPlan({ demoId: 42, steamid: "1" }))
      .resolves.toEqual({ ok: true, plan: null });

    expect(API.get).toHaveBeenCalledWith("/demos/42/cosmetics/custom-plan", {
      params: { steamid: "1" },
    });
  });
});
