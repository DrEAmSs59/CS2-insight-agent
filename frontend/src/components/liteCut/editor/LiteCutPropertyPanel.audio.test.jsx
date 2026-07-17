/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LiteCutPropertyPanel, { AudioPane } from "./LiteCutPropertyPanel.jsx";

describe("LiteCut audio inspector", () => {
  it("separates global BGM, video-track gain, and per-clip source volume", () => {
    render(<AudioPane trackLabel="V1" onTrackVolumeChange={() => {}} />);

    expect(screen.getByText("工程 BGM（全局）")).toBeTruthy();
    expect(screen.getByText("不占用音频轨(A轨)")).toBeTruthy();
    expect(screen.getByText("视频轨原声增益")).toBeTruthy();
    expect(screen.getByText(/片段音量 × 视频轨增益 × 项目音量/)).toBeTruthy();
    expect(screen.queryByText("保留视频原声")).toBeNull();
  });

  it("keeps A-track and selected audio-clip controls when an audio clip is selected", () => {
    render(<AudioPane isAudioClip trackLabel="A1" onTrackVolumeChange={() => {}} />);

    expect(screen.getByText("音频轨(A轨)增益")).toBeTruthy();
    expect(screen.getByText("音频轨(A轨)片段")).toBeTruthy();
    expect(screen.getByText(/两者导出时会同时混音/)).toBeTruthy();
  });

  it("exposes video source-volume keyframes beside the editable volume", () => {
    const onAdd = vi.fn();
    render(
      <AudioPane
        trackLabel="V1"
        onTrackVolumeChange={() => {}}
        onAddClipAudioKeyframe={onAdd}
      />,
    );

    expect(screen.getByText("当前片段原声音量 (%)")).toBeTruthy();
    expect(screen.getByText("音量关键帧")).toBeTruthy();
    expect(screen.getByText(/先添加关键帧，再调整上方的片段音量/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在播放头添加音量关键帧" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("routes A-track volume changes through the keyframe-aware volume callback", () => {
    const onVolumeChange = vi.fn();
    const onAudioPatch = vi.fn();
    render(
      <AudioPane
        isAudioClip
        volume={1}
        onVolumeChange={onVolumeChange}
        onAudioPatch={onAudioPatch}
      />,
    );

    const volumeRow = screen.getByText("片段音量 (%)").closest(".litecut-property-control-row");
    fireEvent.change(volumeRow.querySelector("input"), { target: { value: "35" } });
    expect(onVolumeChange).toHaveBeenCalledWith(0.35);
    expect(onAudioPatch).not.toHaveBeenCalled();
  });

  it("unmutes an A-track clip instead of only changing its volume", () => {
    const onVolumeChange = vi.fn();
    const onAudioPatch = vi.fn();
    render(
      <AudioPane
        isAudioClip
        muted
        volume={0.8}
        onVolumeChange={onVolumeChange}
        onAudioPatch={onAudioPatch}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));
    expect(onAudioPatch).toHaveBeenCalledWith({ muted: false });
    expect(onVolumeChange).not.toHaveBeenCalled();
  });

  it("renders the resolved A-track target while the selected timeline clip is video", () => {
    render(
      <LiteCutPropertyPanel
        defaultTab="audio"
        selectedMedia={{ id: "video", kind: "video", title: "video.mp4" }}
        isAudioClip={false}
        audioTargetIsAudioClip
        selectedClipLabel="detached-audio.wav"
      />,
    );

    expect(screen.getByText("音频轨(A轨)片段")).toBeTruthy();
    expect(screen.getByText("detached-audio.wav")).toBeTruthy();
  });
});
