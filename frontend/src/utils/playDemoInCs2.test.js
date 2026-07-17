import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/api.js", () => ({
  default: {
    post: vi.fn(),
  },
}));

import API from "../api/api.js";
import { playDemoErrorLabel, playDemoInCs2 } from "./playDemoInCs2.js";

describe("playDemoInCs2", () => {
  beforeEach(() => {
    API.post.mockReset();
  });

  it("prefers library id over path", async () => {
    API.post.mockResolvedValue({ data: { ok: true } });
    await playDemoInCs2({ id: 42, path: "C:/tmp/a.dem" });
    expect(API.post).toHaveBeenCalledWith("/demos/42/play");
  });

  it("posts path when id is missing", async () => {
    API.post.mockResolvedValue({ data: { ok: true } });
    await playDemoInCs2({ path: "C:/tmp/a.dem" });
    expect(API.post).toHaveBeenCalledWith("/demo/play", { path: "C:/tmp/a.dem" });
  });

  it("rejects when neither id nor path", async () => {
    await expect(playDemoInCs2({})).rejects.toThrow(/缺少可播放/);
  });
});

describe("playDemoErrorLabel", () => {
  it("reads string detail", () => {
    expect(playDemoErrorLabel({ response: { data: { detail: "no cs2" } } })).toBe("no cs2");
  });
});
