import { describe, expect, it, vi } from "vitest";

import { createMediaElementRefRegistry } from "./previewMediaElementUtils.js";

describe("createMediaElementRefRegistry", () => {
  it("keeps one stable callback per layer and releases only the detached element", () => {
    const elements = new Map();
    const release = vi.fn();
    const registry = createMediaElementRefRegistry(elements, release);
    const ref = registry.refFor("underlay-1");
    const first = { id: "first" };
    const second = { id: "second" };

    expect(registry.refFor("underlay-1")).toBe(ref);
    ref(first);
    expect(elements.get("underlay-1")).toBe(first);

    ref(null);
    expect(release).toHaveBeenCalledWith(first);
    expect(elements.has("underlay-1")).toBe(false);

    ref(second);
    expect(elements.get("underlay-1")).toBe(second);
    expect(release).not.toHaveBeenCalledWith(second);
  });

  it("releases every currently attached layer during panel teardown", () => {
    const release = vi.fn();
    const registry = createMediaElementRefRegistry(new Map(), release);
    const first = { id: "first" };
    const second = { id: "second" };
    registry.refFor("a")(first);
    registry.refFor("b")(second);

    registry.releaseAll();

    expect(release).toHaveBeenCalledTimes(2);
    expect(registry.elements.size).toBe(0);
  });
});
