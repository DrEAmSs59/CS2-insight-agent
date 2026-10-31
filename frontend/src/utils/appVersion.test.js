import { describe, expect, it } from "vitest";
import {
  displayVersion,
  formatProductVersion,
  formatUpdaterVersion,
  parseProductVersion,
} from "./appVersion.js";

function updaterOf(input) {
  return formatUpdaterVersion(parseProductVersion(input));
}

function semverRank(version) {
  const [core, prerelease = ""] = version.split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  return [major, minor, patch, prerelease ? 0 : 1, prerelease];
}

function isOlder(left, right) {
  const a = semverRank(left);
  const b = semverRank(right);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return a[4] < b[4];
}

describe("Pro four-part versions", () => {
  it("encodes a fourth segment so an installed 2.7.5 updates to 2.7.5.1 and then 2.7.6", () => {
    expect(updaterOf("2.7.5")).toBe("2.7.500");
    expect(updaterOf("2.7.5.1")).toBe("2.7.501");
    expect(updaterOf("2.7.5.2")).toBe("2.7.502");
    expect(updaterOf("2.7.6")).toBe("2.7.600");
    expect(updaterOf("2.7.42.1")).toBe("2.7.4201");

    const order = ["2.7.5", "2.7.500", "2.7.501", "2.7.502", "2.7.600"];
    for (let index = 1; index < order.length; index += 1) {
      expect(isOlder(order[index - 1], order[index])).toBe(true);
    }
    expect(isOlder("2.7.42", "2.7.4201")).toBe(true);
  });

  it("shows the product version for encoded updater versions", () => {
    expect(displayVersion("2.7.501")).toBe("2.7.5.1");
    expect(displayVersion("2.7.500")).toBe("2.7.5");
    expect(displayVersion("2.7.42")).toBe("2.7.42");
    expect(displayVersion("2.7.5.1")).toBe("2.7.5.1");
    expect(formatProductVersion(parseProductVersion("2.7.5.0"))).toBe("2.7.5.0");
  });

  it("rejects a fifth segment and a revision above 99", () => {
    expect(parseProductVersion("2.7.5.1.2")).toBeNull();
    expect(parseProductVersion("2.7.5.100")).toBeNull();
    expect(parseProductVersion("2.7")).toBeNull();
  });
});
