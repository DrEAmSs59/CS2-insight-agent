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

  test("adds the ephemeral desktop token to browser-owned resource URLs", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const {
      getDemoRadarMapUrl,
      getLiteCutAssetStreamUrl,
      setDesktopSessionToken,
    } = await import("./api.js");

    setDesktopSessionToken("session-123");

    expect(getDemoRadarMapUrl("de_nuke", "lower")).toBe(
      "http://127.0.0.1:19871/api/demo/radar-map/de_nuke?layer=lower&_session=session-123",
    );
    expect(getLiteCutAssetStreamUrl(7, "ready")).toBe(
      "http://127.0.0.1:19871/api/lite-cut/assets/7/stream?preview=ready&_session=session-123",
    );
  });

  test("adds the ephemeral desktop token to axios headers", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { default: API, setDesktopSessionToken } = await import("./api.js");
    setDesktopSessionToken("session-123");
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

    expect(requestConfig.headers.get("X-CS2-Insight-Token")).toBe("session-123");
  });
});
