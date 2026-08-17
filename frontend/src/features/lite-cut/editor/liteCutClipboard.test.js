import { describe, expect, it, vi } from "vitest";

import { writeLiteCutClipboardText } from "./liteCutClipboard.js";

describe("writeLiteCutClipboardText", () => {
  it("prefers the native desktop bridge in packaged builds", async () => {
    const bridge = { writeClipboardText: vi.fn().mockResolvedValue(undefined) };
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

    await expect(writeLiteCutClipboardText("C:\\exports\\clip.mp4", { bridge, clipboard })).resolves.toBe(true);

    expect(bridge.writeClipboardText).toHaveBeenCalledWith("C:\\exports\\clip.mp4");
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("uses the browser clipboard when no desktop bridge is present", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

    await expect(writeLiteCutClipboardText("/tmp/clip.mp4", { bridge: null, clipboard })).resolves.toBe(true);

    expect(clipboard.writeText).toHaveBeenCalledWith("/tmp/clip.mp4");
  });
});
