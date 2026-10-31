import { describe, expect, it } from "vitest";
import { progressToastShowsBusy } from "./progressToast.js";

describe("progress toast busy state", () => {
  it.each(["正在停止采集并恢复游戏配置", "Stopping recording...", "检测中…"])(
    "stops spinning when completion is explicit despite stale text: %s", text => {
      expect(progressToastShowsBusy(text, { loading: false })).toBe(false);
    },
  );

  it("keeps explicit live work busy regardless of its text", () => {
    expect(progressToastShowsBusy("", { loading: true })).toBe(true);
    expect(progressToastShowsBusy("完成", { parsing: true, loading: false })).toBe(true);
  });

  it("preserves legacy detection when no lifecycle state was supplied", () => {
    expect(progressToastShowsBusy("正在扫描", { loading: undefined })).toBe(true);
    expect(progressToastShowsBusy("Uploading...")).toBe(true);
    expect(progressToastShowsBusy("录制已取消")).toBe(false);
    expect(progressToastShowsBusy("")).toBe(false);
  });
});
