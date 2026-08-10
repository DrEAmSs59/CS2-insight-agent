/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import LiteCutResizableLayout from "./LiteCutResizableLayout.jsx";

describe("LiteCutResizableLayout", () => {
  it("renders the editor as four independent rounded work regions", () => {
    const { container } = render(
      <LiteCutResizableLayout
        mediaBin={<div>media</div>}
        preview={<div>preview</div>}
        properties={<div>properties</div>}
        timeline={<div>timeline</div>}
      />,
    );

    const regions = [...container.querySelectorAll("[data-litecut-region]")];
    expect(regions.map((region) => region.getAttribute("data-litecut-region"))).toEqual([
      "media-bin",
      "preview",
      "properties",
      "timeline",
    ]);
    for (const region of regions) {
      expect(region.className).toContain("rounded-lg");
      expect(region.className).toContain("border-cs2-border");
    }
  });
});
