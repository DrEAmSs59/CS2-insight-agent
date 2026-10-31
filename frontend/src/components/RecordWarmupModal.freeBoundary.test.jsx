import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import RecordWarmupModal from "./RecordWarmupModal.jsx";

vi.mock("../api/api.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  useLocaleStore.getState().hydrate("zh");
  API.get.mockReturnValue(new Promise(() => {}));
});

it("submits only Free recording options when older shared preferences contain Pro fields", () => {
  const onConfirm = vi.fn();
  render(<RecordWarmupModal open onClose={() => {}} onConfirm={onConfirm}
    defaultOverrides={{ death_effect_enabled: true, scoreboard_follow_enabled: true }}
    captureSettings={{ capture_backend: "hlae" }} recordingPostProcess="ancient_cinematic" />);
  expect(screen.queryByText(/HLAE|ReShade|POV 死亡效果|跟随玩家 TAB|字幕/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
  expect(onConfirm).toHaveBeenCalledOnce();
  const payload = onConfirm.mock.calls[0][0];
  for (const key of ["capture_settings", "recording_capture", "recording_post_process",
    "recording_post_process_parameters", "death_effect_enabled", "scoreboard_follow_enabled", "subtitle_job_id"]) {
    expect(payload).not.toHaveProperty(key);
  }
  expect(API.get.mock.calls.some(([url]) => /native|capabilities|inspect3d|subtitle/.test(url))).toBe(false);
  expect(API.post).not.toHaveBeenCalled();
});
