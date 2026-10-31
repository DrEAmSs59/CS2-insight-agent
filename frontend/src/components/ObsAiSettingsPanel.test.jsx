import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ObsAiSettingsPanel from "./ObsAiSettingsPanel.jsx";
import { DiscoveryRail } from "../pages/ObsAiTuningPreviewPage.jsx";

describe("ObsAiSettingsPanel connection gate", () => {
  it("blocks tuning and explains how OBS will be connected", () => {
    render(
      <ObsAiSettingsPanel
        obsPath="C:\\Program Files\\OBS Studio\\bin\\64bit\\obs64.exe"
        obsConnected={false}
        ffmpegReady
        previewMode
      />,
    );

    expect(screen.getByRole("dialog", { name: "还没有连接到 OBS" })).toBeTruthy();
    expect(screen.getByText("我们会帮你完成")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "选择帧率和分辨率" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "稍后再说" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const connectButtons = screen.getAllByRole("button", { name: "连接 OBS" });
    expect(connectButtons.length).toBe(2);

    fireEvent.click(connectButtons[1]);
    fireEvent.click(screen.getByRole("button", { name: "自动打开并连接 OBS" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "OBS 已连接，这是你现在的录制设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用 AI 检查并调整" })).toBeTruthy();
  });

  it("opens the prototype workspace immediately after an existing connection is known", () => {
    render(
      <ObsAiSettingsPanel
        obsPath="C:\\OBS\\obs64.exe"
        obsConnected
        ffmpegReady
        previewMode
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "OBS 已连接，这是你现在的录制设置" })).toBeTruthy();
    expect(screen.getByText("2560 × 1440")).toBeTruthy();
    expect(screen.getByText("60 / 1 FPS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保持当前设置" }));
    expect(screen.getByText(/已经保持当前设置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "使用 AI 检查并调整" }));
    expect(screen.getByRole("heading", { name: "选择帧率和分辨率" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "480 FPS" })).toBeTruthy();
    expect(screen.queryByText("你主要想怎么用这段视频？")).toBeNull();
    expect(screen.queryByText("你更看重什么？")).toBeNull();
    expect(screen.queryByText("视频格式")).toBeNull();
    expect(screen.queryByText("先录一小段测试")).toBeNull();
  });

  it("shows AI review, runs the full test, and opens the validation report", async () => {
    render(
      <ObsAiSettingsPanel
        obsPath="C:\\OBS\\obs64.exe"
        obsConnected
        ffmpegReady
        previewMode
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用 AI 检查并调整" }));
    fireEvent.click(screen.getByRole("button", { name: "480 FPS" }));
    fireEvent.click(screen.getByRole("button", { name: "看看推荐设置" }));
    expect(await screen.findByText("设置分析")).toBeTruthy();
    expect(screen.getByText(/RTX 5070 具备高帧率硬件编码能力/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "自动设置并完成测试" }));

    expect(await screen.findByRole("heading", { name: "设置与真实录制测试已通过" })).toBeTruthy();
    expect(screen.getByText("480 / 1 FPS")).toBeTruthy();
    expect(screen.getByText("真实录制测试通过")).toBeTruthy();
    expect(screen.getByRole("button", { name: /查看测试结果/ }).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "查看完整测试结果" }));
    expect(screen.getByRole("heading", { name: "稳定性测试通过" })).toBeTruthy();
    expect(screen.getByText("480/1")).toBeTruthy();
    expect(screen.getByText("0.08%")).toBeTruthy();
  });

  it("shows the discrete RTX GPU before an integrated GPU", () => {
    render(
      <DiscoveryRail
        recommendation={{
          score: 80,
          tone: "accent",
          renderLoad: 55,
          encoderLoad: 60,
          headroom: 40,
          bottleneck: "GPU 编码",
          fileEstimate: "12–20 GB / 10 分钟",
        }}
        environment={{
          obs: { version: "32.1.1" },
          hardware: {
            cpu: "AMD Ryzen 7 7800X3D",
            memory_gb: 31.1,
            gpus: [
              { name: "AMD Radeon(TM) Graphics", memory_mb: 512 },
              { name: "NVIDIA GeForce RTX 5070", memory_mb: 12227 },
            ],
            encoders: [
              { id: "nvenc_h264", codec: "h264" },
              { id: "nvenc_hevc", codec: "hevc" },
              { id: "nvenc_av1", codec: "av1" },
            ],
          },
          limits: {},
          disk: { free_gb: 149.7 },
        }}
      />,
    );

    expect(screen.getByText("NVIDIA GeForce RTX 5070")).toBeTruthy();
    expect(screen.getByText(/12 GB 显存/)).toBeTruthy();
    expect(screen.getByText(/另有 AMD Radeon\(TM\) Graphics/)).toBeTruthy();
  });
});
