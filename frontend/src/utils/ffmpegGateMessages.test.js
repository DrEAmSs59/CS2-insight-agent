import { describe, expect, it } from "vitest";

import { translate } from "../i18n/translate.js";
import { ffmpegGateSubtitle } from "./ffmpegGateMessages.js";

const zh = (key, params) => translate("zh", key, params);

describe("ffmpegGateSubtitle", () => {
  it.each([
    ["not_configured", "FFmpeg 尚未配置"],
    ["path_not_found", "FFmpeg 路径无效"],
    ["ffprobe_missing", "FFmpeg 目录缺少 ffprobe.exe"],
    ["version_mismatch", "FFmpeg 与 ffprobe 版本不匹配"],
    ["incompatible", "FFmpeg 版本与当前导出功能不兼容"],
    ["not_usable", "FFmpeg 不可执行"],
    ["not_runnable", "FFmpeg 不可执行"],
    ["unexpected_reason", "FFmpeg 未就绪"],
  ])("maps %s", (reason, expected) => {
    expect(ffmpegGateSubtitle(reason, zh)).toBe(expected);
  });
});
