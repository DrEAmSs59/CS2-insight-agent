import { describe, test, expect } from "vitest";
import zh from "../dict/zh.js";
import en from "../dict/en.js";

// __test_only_ 前缀是有意只存在于 zh 的回退测试夹具，排除在一致性校验外。
const realKeys = (d) =>
  Object.keys(d).filter((k) => !k.startsWith("__test_only_"));

describe("dict consistency", () => {
  test("en 不缺 zh 的任何 key", () => {
    const missing = realKeys(zh).filter((k) => !(k in en));
    expect(missing, `en.js 缺失这些 key: ${missing.join(", ")}`).toEqual([]);
  });

  test("en 没有多余的 key", () => {
    const extra = Object.keys(en).filter((k) => !(k in zh));
    expect(extra, `en.js 多出这些 key: ${extra.join(", ")}`).toEqual([]);
  });
});
