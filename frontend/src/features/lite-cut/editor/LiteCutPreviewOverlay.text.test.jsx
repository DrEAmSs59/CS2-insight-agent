import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PreviewOverlayItem from "./LiteCutPreviewOverlay.jsx";

function textOverlay(align) {
  return {
    id: `text-${align}`,
    type: "text",
    timeline_start: 0,
    duration: 3,
    transform: { x: 0.5, y: 0.5, width: 0.6, height: 0.3, scale: 1, rotation: 0, opacity: 1 },
    text: {
      content: "CLUTCH\nI",
      font_family: "Noto Sans SC",
      font_size: 64,
      font_weight: 700,
      line_height: 1.2,
      letter_spacing: 0,
      align,
      preset_id: "clutch",
    },
  };
}

describe("LiteCut preview text layout contract", () => {
  it.each([
    ["left", "flex-start"],
    ["center", "center"],
    ["right", "flex-end"],
  ])("aligns the block and every explicit line for %s", async (align, justifyContent) => {
    const { container } = render(<PreviewOverlayItem ov={textOverlay(align)} canvasHeight={1080} />);
    const block = container.querySelector("[data-preview-text-block]");
    const layout = block.parentElement;

    expect(layout.style.justifyContent).toBe(justifyContent);
    expect(block.style.textAlign).toBe(align);
    expect(block.style.letterSpacing).toBe("0px");
    expect(layout.style.textShadow).toBe("");
    expect(layout.style.webkitTextStroke).toContain("rgba(0, 0, 0, 0.72)");
    await waitFor(() => expect(layout.dataset.fontLoadRevision).toBe("1"));
  });

  it("renders an image overlay whose canonical text payload is null", () => {
    const { container } = render(<PreviewOverlayItem ov={{
      id: "image-1",
      type: "sticker",
      timeline_start: 0,
      duration: 3,
      transform: { x: 0.5, y: 0.5, width: 0.6, height: 0.6, scale: 1, rotation: 0, opacity: 1 },
      content_fit: "contain",
      text: null,
      meta: { asset_id: 42, kind: "image", source_width: 1200, source_height: 800 },
    }} canvasHeight={1080} />);

    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("[data-preview-text-block]")).toBeNull();
  });
});
