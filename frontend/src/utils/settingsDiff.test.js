import { describe, expect, it } from "vitest";
import { countChangedFields } from "./settingsDiff.js";

describe("countChangedFields", () => {
  it("counts nested object fields individually and arrays as one value", () => {
    const saved = { a: 1, obs: { host: "localhost", port: 4455 }, players: ["x"] };
    expect(countChangedFields(saved, saved)).toBe(0);
    expect(countChangedFields(
      { a: 2, obs: { host: "pc", port: 4456 }, players: ["x", "y"] },
      saved,
    )).toBe(4);
  });

  it("treats missing and null values as equal", () => {
    expect(countChangedFields({ base_url: null }, {})).toBe(0);
    expect(countChangedFields({ base_url: "http://x" }, {})).toBe(1);
  });
});
