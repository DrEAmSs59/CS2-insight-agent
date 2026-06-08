import { describe, test, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useT } from "../useT.js";
import { useLocaleStore } from "../localeStore.js";

describe("useT", () => {
  beforeEach(() => {
    localStorage.clear();
    useLocaleStore.setState({ locale: "zh" });
  });

  test("按当前 locale 返回译文", () => {
    useLocaleStore.setState({ locale: "en" });
    const { result } = renderHook(() => useT());
    expect(result.current("common.cancel")).toBe("Cancel");
  });

  test("缺 key 时回退到 zh", () => {
    useLocaleStore.setState({ locale: "en" });
    const { result } = renderHook(() => useT());
    expect(result.current("__test_only_zh")).toBe("仅中文");
  });

  test("zh/en 都缺时原样返回 key", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("nope.nope")).toBe("nope.nope");
  });

  test("支持 {name} 插值", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("test.greet", { name: "Neo" })).toBe("你好 Neo");
  });
});
