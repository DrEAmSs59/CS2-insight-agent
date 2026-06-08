import { describe, test, expect, beforeEach } from "vitest";
import { vi } from "vitest";

const KEY = "cs2-insight-locale";

describe("localeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules?.();
  });

  test("默认 locale 为 zh（无 localStorage 时）", async () => {
    const { useLocaleStore } = await import("../localeStore.js");
    expect(useLocaleStore.getState().locale).toBe("zh");
  });

  test("setLocale 更新 state 并写入 localStorage", async () => {
    const { useLocaleStore } = await import("../localeStore.js");
    useLocaleStore.getState().setLocale("en");
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(localStorage.getItem(KEY)).toBe("en");
  });

  test("非法 locale 回退到 zh", async () => {
    const { useLocaleStore } = await import("../localeStore.js");
    useLocaleStore.getState().setLocale("fr");
    expect(useLocaleStore.getState().locale).toBe("zh");
  });
});
