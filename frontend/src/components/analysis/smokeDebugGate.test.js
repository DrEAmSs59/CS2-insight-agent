import { describe, expect, test, beforeEach } from "vitest";
import { isSmokeDebugEnabled } from "./smokeDebugGate";

describe("isSmokeDebugEnabled", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  test("false when localStorage and query absent", () => {
    expect(isSmokeDebugEnabled({ search: "", storage: localStorage, isDev: true })).toBe(false);
  });

  test("true when query smokeDebug=1 in DEV", () => {
    expect(isSmokeDebugEnabled({ search: "?smokeDebug=1", storage: localStorage, isDev: true })).toBe(true);
  });

  test("true when localStorage cs2.smokeDebug=1 in DEV", () => {
    localStorage.setItem("cs2.smokeDebug", "1");
    expect(isSmokeDebugEnabled({ search: "", storage: localStorage, isDev: true })).toBe(true);
  });

  test("false in production even with query", () => {
    expect(isSmokeDebugEnabled({ search: "?smokeDebug=1", storage: localStorage, isDev: false })).toBe(false);
  });

  test("false in production even with localStorage", () => {
    localStorage.setItem("cs2.smokeDebug", "1");
    expect(isSmokeDebugEnabled({ search: "", storage: localStorage, isDev: false })).toBe(false);
  });
});
