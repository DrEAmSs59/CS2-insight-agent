import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import CommonParamsModal from "./CommonParamsModal.jsx";
import { useRecordingQueue } from "../stores/recordingQueueStore";
vi.mock("../api/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const renderPreset = () => render(<CommonParamsModal variant="page" open batchRecording={false} configReady />);
describe("Free shared recording settings", () => {
  beforeEach(() => { vi.clearAllMocks(); API.get.mockReturnValue(new Promise(() => {})); useLocaleStore.getState().hydrate("zh"); useRecordingQueue.setState({ presetPacing: {} }); });
  it("retains the ten-second pre-roll cap after numeric editing", () => {
    renderPreset();
    const name = "击杀段/死亡段前预留 (秒)";
    const slider = screen.getByRole("slider", { name });
    const input = screen.getByRole("spinbutton", { name });
    expect(slider.max).toBe("10"); expect(input.max).toBe("10");
    fireEvent.change(input, { target: { value: "20" } }); fireEvent.blur(input);
    expect(useRecordingQueue.getState().presetPacing.pre_first_sec).toBe(10);
  });
  it("allows clearing and entering a 150-second merge gap", () => {
    renderPreset();
    const input = screen.getByRole("spinbutton", { name: "合并间隔" });
    for (const value of ["", "1", "15", "150"]) { fireEvent.change(input, { target: { value } }); expect(input.value).toBe(value); }
    fireEvent.blur(input); expect(useRecordingQueue.getState().presetPacing.max_gap_sec).toBe(150);
  });
  it("shares ordered setting groups without requesting paid runtime capabilities", () => {
    const { container } = renderPreset();
    expect([...container.querySelectorAll("section[id]")].map(x => x.id)).toEqual(["rp-pacing", "rp-replay", "rp-camera", "rp-experimental", "rp-hud", "rp-canvas", "rp-launch"]);
    expect(screen.queryByText(/HLAE|ReShade|时光|夜间暴雨|下雪|POV 死亡效果|跟随玩家 TAB/)).toBeNull();
    expect(screen.getByRole("switch", { name: "POV HUD 增强" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "语音控制" })).toBeTruthy();
    expect(screen.queryByTestId("experimental-feature-card")).toBeNull();
    expect(API.get.mock.calls.some(([url]) => /capabilities|inspect3d|subtitle/.test(url))).toBe(false);
  });
});
