import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import useSessionState from "./useSessionState";

describe("useSessionState", () => {
  beforeEach(() => sessionStorage.clear());

  it("restores each dynamic key without leaking the previous key value", () => {
    const { result, rerender } = renderHook(
      ({ storageKey }) => useSessionState(storageKey, 0),
      { initialProps: { storageKey: "demo-a" } },
    );

    act(() => result.current[1](5));
    expect(JSON.parse(sessionStorage.getItem("cs2-session-demo-a"))).toBe(5);

    rerender({ storageKey: "demo-b" });
    expect(result.current[0]).toBe(0);
    act(() => result.current[1](9));

    rerender({ storageKey: "demo-a" });
    expect(result.current[0]).toBe(5);
  });
});
