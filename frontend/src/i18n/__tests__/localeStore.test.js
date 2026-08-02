import { describe, test, expect, beforeEach, vi } from "vitest";

// 持久化改为后端 config（PUT /api/config），不再用 localStorage。Mock API 避免真实网络。
const putMock = vi.fn(() => Promise.resolve({ data: {} }));
vi.mock("../../api/api", () => ({ default: { put: (...a) => putMock(...a) } }));

import { useLocaleStore } from "../localeStore.js";

describe("localeStore", () => {
  beforeEach(() => {
    putMock.mockClear();
    putMock.mockResolvedValue({ data: {} });
    localStorage.clear();
    useLocaleStore.getState().hydrate("zh");
  });

  test("默认 locale 为 zh", () => {
    expect(useLocaleStore.getState().locale).toBe("zh");
  });

  test("hydrate 从配置注入但不回写后端", () => {
    useLocaleStore.getState().hydrate("en");
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(putMock).not.toHaveBeenCalled();
  });

  test("hydrate 非法值回退到 auto 并解析系统语言", () => {
    useLocaleStore.getState().hydrate("fr");
    expect(useLocaleStore.getState().locale).toBe("auto");
    expect(["zh", "en"]).toContain(useLocaleStore.getState().effectiveLocale);
  });

  test("setLocale 更新 state 并持久化到 config", async () => {
    await useLocaleStore.getState().setLocale("en");
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(putMock).toHaveBeenCalledWith("config", { locale: "en" });
  });

  test("setLocale 非法值回退到 auto", async () => {
    await useLocaleStore.getState().setLocale("fr");
    expect(useLocaleStore.getState().locale).toBe("auto");
    expect(putMock).toHaveBeenCalledWith("config", { locale: "auto" });
  });

  test("保存失败时恢复原语言并暴露错误", async () => {
    const error = new Error("offline");
    putMock.mockRejectedValueOnce(error);

    await expect(useLocaleStore.getState().setLocale("en")).rejects.toThrow("offline");

    expect(useLocaleStore.getState().locale).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(useLocaleStore.getState().persistenceError).toBe(error);
  });
});
