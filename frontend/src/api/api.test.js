import { afterEach, describe, expect, test, vi } from "vitest";


describe("desktop backend asset URLs", () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.resetModules();
  });

  test("uses the Vite proxy in browser mode", async () => {
    delete window.__TAURI_INTERNALS__;
    vi.resetModules();
    const { getDemoRadarMapUrl } = await import("./api.js");

    expect(getDemoRadarMapUrl("de_mirage")).toBe("/api/demo/radar-map/de_mirage");
    expect(getDemoRadarMapUrl("de_nuke", "lower")).toBe("/api/demo/radar-map/de_nuke?layer=lower");
  });

  test("targets the bundled backend in Tauri mode", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { getDemoRadarMapUrl } = await import("./api.js");

    expect(getDemoRadarMapUrl("de_mirage")).toBe("http://127.0.0.1:19871/api/demo/radar-map/de_mirage");
  });
});
