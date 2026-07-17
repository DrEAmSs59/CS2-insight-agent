import { describe, test, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useT } from "../useT.js";
import { useLocaleStore } from "../localeStore.js";

describe("useT", () => {
  beforeEach(() => {
    localStorage.clear();
    useLocaleStore.getState().hydrate("zh");
  });

  test("按当前 locale 返回译文", () => {
    useLocaleStore.getState().hydrate("en");
    const { result } = renderHook(() => useT());
    expect(result.current("common.cancel")).toBe("Cancel");
  });

  test("缺 key 时回退到 zh", () => {
    useLocaleStore.getState().hydrate("en");
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

  test("LiteCut 调色面板使用中文词条", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("liteCut.color.filters")).toBe("滤镜");
    expect(result.current("liteCut.color.brightness")).toBe("亮度");
    expect(result.current("liteCut.color.preset.highcon")).toBe("高对比");
  });

  test("LiteCut 属性页签和说明支持中英文切换", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("liteCut.inspector.audio")).toBe("音频");
    expect(result.current("liteCut.inspector.audioDescription")).toBe("工程、轨道与片段混音");
    act(() => useLocaleStore.getState().hydrate("en"));
    expect(result.current("liteCut.inspector.audio")).toBe("Audio");
    expect(result.current("liteCut.inspector.selectedClip")).toBe("Selected clip");
  });
});
