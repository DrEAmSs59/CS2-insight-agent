import { describe, expect, test } from "vitest";

import en from "../i18n/dict/en.js";
import zh from "../i18n/dict/zh.js";
import {
  AI_DEMO_LOADING_MESSAGE_KEYS,
  COMMON_DEMO_LOADING_MESSAGE_KEYS,
  DESKTOP_DEMO_LOADING_MESSAGE_KEYS,
  getDemoLoadingMessageKeys,
  pickNextDemoLoadingMessageKey,
} from "./demoLoadingMessages.js";

describe("demo loading message pool", () => {
  test("keeps the default pool within the planned 30-40 line dose", () => {
    expect(COMMON_DEMO_LOADING_MESSAGE_KEYS.length).toBeGreaterThanOrEqual(30);
    expect(COMMON_DEMO_LOADING_MESSAGE_KEYS.length).toBeLessThanOrEqual(40);
    expect(new Set(COMMON_DEMO_LOADING_MESSAGE_KEYS).size).toBe(COMMON_DEMO_LOADING_MESSAGE_KEYS.length);
  });

  test("only adds environment-specific copy when that path is active", () => {
    const common = getDemoLoadingMessageKeys();
    expect(common).not.toEqual(expect.arrayContaining(DESKTOP_DEMO_LOADING_MESSAGE_KEYS));
    expect(common).not.toEqual(expect.arrayContaining(AI_DEMO_LOADING_MESSAGE_KEYS));

    const full = getDemoLoadingMessageKeys({ desktop: true, aiEnabled: true });
    expect(full).toEqual(expect.arrayContaining(DESKTOP_DEMO_LOADING_MESSAGE_KEYS));
    expect(full).toEqual(expect.arrayContaining(AI_DEMO_LOADING_MESSAGE_KEYS));
  });

  test("every selectable message has Chinese and English copy", () => {
    const keys = getDemoLoadingMessageKeys({ desktop: true, aiEnabled: true });
    for (const key of keys) {
      expect(zh[key], `${key} is missing Chinese copy`).toBeTypeOf("string");
      expect(en[key], `${key} is missing English copy`).toBeTypeOf("string");
    }
  });

  test("never repeats the currently visible line", () => {
    const keys = ["one", "two", "three"];
    expect(pickNextDemoLoadingMessageKey(keys, "one", () => 0)).toBe("two");
    expect(pickNextDemoLoadingMessageKey(keys, "one", () => 0.999)).toBe("three");
  });
});
