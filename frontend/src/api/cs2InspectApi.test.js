import { beforeEach, describe, expect, test, vi } from "vitest";

const apiPostMock = vi.hoisted(() => vi.fn());
const desktopLaunchMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", () => ({
  default: { post: apiPostMock },
}));

vi.mock("../desktop/desktopBridge.js", () => ({
  desktopBridge: { launchCs2Inspect: desktopLaunchMock },
}));

import { launchCs2InspectOnHost } from "./cs2InspectApi.js";

describe("launchCs2InspectOnHost", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    desktopLaunchMock.mockReset();
  });

  test("uses the local backend first so browser development can launch Steam", async () => {
    apiPostMock.mockResolvedValueOnce({ data: { ok: true } });

    await expect(launchCs2InspectOnHost("00AABBCCDDEE")).resolves.toEqual({ ok: true });

    expect(apiPostMock).toHaveBeenCalledWith("/cs2/inspect", { hex: "00AABBCCDDEE" });
    expect(desktopLaunchMock).not.toHaveBeenCalled();
  });

  test("falls back to the desktop command if the local backend is unavailable", async () => {
    apiPostMock.mockRejectedValueOnce(new Error("backend unavailable"));
    desktopLaunchMock.mockResolvedValueOnce();

    await expect(launchCs2InspectOnHost("00AABBCCDDEE")).resolves.toEqual({ ok: true });

    expect(desktopLaunchMock).toHaveBeenCalledWith("00AABBCCDDEE");
  });
});
