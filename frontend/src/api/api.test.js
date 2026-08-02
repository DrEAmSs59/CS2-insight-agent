import { afterEach, describe, expect, test, vi } from "vitest";


describe("desktop backend asset URLs", () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.resetModules();
  });

  test("uses the Vite proxy in browser mode", async () => {
    delete window.__TAURI_INTERNALS__;
    vi.resetModules();
    const { getDemoRadarMapUrl, getDemoUtilityMaskUrl } = await import("./api.js");

    expect(getDemoRadarMapUrl("de_mirage")).toBe("/api/demo/radar-map/de_mirage");
    expect(getDemoRadarMapUrl("de_nuke", "lower")).toBe("/api/demo/radar-map/de_nuke?layer=lower");
    expect(getDemoUtilityMaskUrl("de_mirage")).toBe("/api/demo/utility-mask/de_mirage");
    expect(getDemoUtilityMaskUrl("de_nuke", "lower")).toBe("/api/demo/utility-mask/de_nuke?layer=lower");
  });

  test("targets the bundled backend in Tauri mode", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { getDemoRadarMapUrl, getDemoUtilityMaskUrl } = await import("./api.js");

    expect(getDemoRadarMapUrl("de_mirage")).toBe("http://127.0.0.1:19871/api/demo/radar-map/de_mirage");
    expect(getDemoUtilityMaskUrl("de_mirage")).toBe("http://127.0.0.1:19871/api/demo/utility-mask/de_mirage");
  });

  test("does not attach a desktop session credential to asset URLs", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { getDemoRadarMapUrl, getLiteCutAssetStreamUrl } = await import("./api.js");

    expect(getDemoRadarMapUrl("de_nuke", "lower")).toBe(
      "http://127.0.0.1:19871/api/demo/radar-map/de_nuke?layer=lower",
    );
    expect(getLiteCutAssetStreamUrl(7, "ready")).toBe(
      "http://127.0.0.1:19871/api/lite-cut/assets/7/stream?preview=ready",
    );
  });

  test("does not attach a desktop session credential to axios headers", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { default: API } = await import("./api.js");
    let requestConfig;

    await API.get("/config", {
      adapter: async (config) => {
        requestConfig = config;
        return {
          data: {},
          status: 200,
          statusText: "OK",
          headers: {},
          config,
          request: {},
        };
      },
    });

    expect(requestConfig.headers.get("X-CS2-Insight-Token")).toBeFalsy();
  });
});
