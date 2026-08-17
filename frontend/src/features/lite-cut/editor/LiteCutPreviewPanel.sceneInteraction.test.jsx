import { fireEvent, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LiteCutPreviewPanel from "./LiteCutPreviewPanel.jsx";

const playedElements = [];

beforeAll(() => {
  globalThis.PointerEvent = MouseEvent;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play() {
    playedElements.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

beforeEach(() => {
  playedElements.length = 0;
});

describe("LiteCutPreviewPanel scene interaction", () => {
  it("keeps packaged-backend preview videos in no-CORS mode for WebView2 playback", () => {
    const { container } = render(
      <LiteCutPreviewPanel
        streamUrl="http://127.0.0.1:19871/api/lite-cut/assets/7/stream"
        previewClipId="clip-1"
        preloadStreamUrl="http://127.0.0.1:19871/api/lite-cut/assets/8/stream"
        underlayLayers={[{
          id: "underlay-1",
          streamUrl: "http://127.0.0.1:19871/api/lite-cut/assets/9/stream",
          sourceTime: 0,
          playbackRate: 1,
        }]}
      />,
    );

    const videos = Array.from(container.querySelectorAll("video"));
    expect(videos.length).toBeGreaterThanOrEqual(3);
    expect(videos.every((video) => video.crossOrigin === null)).toBe(true);
  });

  it("ignores a code 4 error raised while releasing the active media element", () => {
    const onTogglePlay = vi.fn();
    const { container, queryByText } = render(
      <LiteCutPreviewPanel
        streamUrl="/video.mp4"
        previewClipId="clip-1"
        onTogglePlay={onTogglePlay}
      />,
    );
    const video = container.querySelector('video[src="/video.mp4"]');
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });

    video.removeAttribute("src");
    fireEvent.error(video);

    expect(queryByText("浏览器无法解码此视频编码，请将 OBS 录制设为 H.264/MP4")).toBeNull();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("retains the outgoing video node until the incoming frame is presented", () => {
    const { container, rerender } = render(
      <LiteCutPreviewPanel streamUrl="/a.mp4" previewClipId="clip-a" />,
    );
    const outgoing = container.querySelector('video[src="/a.mp4"]');

    rerender(<LiteCutPreviewPanel streamUrl="/b.mp4" previewClipId="clip-b" />);

    const retained = container.querySelector('video[src="/a.mp4"]');
    const incoming = container.querySelector('video[src="/b.mp4"]');
    expect(retained).toBe(outgoing);
    expect(retained.getAttribute("src")).toBe("/a.mp4");
    expect(retained.style.opacity).toBe("1");
    expect(incoming.style.opacity).toBe("0");
  });

  it("keeps the last decoded segment mounted while a far-seek proxy is pending", () => {
    const { container, rerender } = render(
      <LiteCutPreviewPanel
        streamUrl="/segment-a.mp4"
        previewClipId="clip-a"
        segmentedPreview
      />,
    );
    const outgoing = container.querySelector('video[src="/segment-a.mp4"]');

    rerender(
      <LiteCutPreviewPanel
        streamUrl={null}
        previewClipId="clip-a"
        segmentedPreview
        previewPending
      />,
    );

    expect(container.querySelector('video[src="/segment-a.mp4"]')).toBe(outgoing);
  });

  it("selects and moves an unselected video layer in the first drag gesture", () => {
    const onSelect = vi.fn();
    const onTransform = vi.fn();
    const { container } = render(
      <LiteCutPreviewPanel
        streamUrl="/video.mp4"
        previewClipId="clip-1"
        mainIsVideoLayer
        mainLayerSelected={false}
        mainLayerTransform={{ x: 0.5, y: 0.5, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 }}
        onMainLayerSelect={onSelect}
        onMainLayerTransform={onTransform}
        canvasWidth={1920}
        canvasHeight={1080}
      />,
    );
    const canvas = container.querySelector("[data-preview-canvas]");
    const layer = container.querySelector("[data-preview-video-layer]");
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(layer, { pointerId: 7, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(document, { pointerId: 7, clientX: 600, clientY: 300 });
    fireEvent.pointerUp(document, { pointerId: 7, clientX: 600, clientY: 300 });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onTransform).toHaveBeenCalledWith({ x: 0.6, y: 0.6 });
  });

  it("keeps a prewarmed companion video mounted when the transition starts", () => {
    const baseProps = {
      streamUrl: "/a.mp4",
      previewClipId: "a",
      mainIsVideoLayer: true,
      mainLayerTransform: { x: 0.5, y: 0.5, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 },
      canvasWidth: 1920,
      canvasHeight: 1080,
    };
    const prewarm = {
      id: "b",
      streamUrl: "/b.mp4",
      sourceTime: 0,
      playbackRate: 1,
      prewarm: true,
      opacity: 0,
    };
    const { container, rerender } = render(
      <LiteCutPreviewPanel {...baseProps} underlayLayers={[prewarm]} />,
    );
    const prewarmedElement = container.querySelector('video[src="/b.mp4"]');

    rerender(
      <LiteCutPreviewPanel
        {...baseProps}
        transitionMainOpacity={0.98}
        underlayLayers={[{ ...prewarm, prewarm: false, transitionLayer: true, transitionRole: "to", opacity: 1 }]}
      />,
    );

    expect(container.querySelector('video[src="/b.mp4"]')).toBe(prewarmedElement);
  });

  it("starts the companion decoder when it leaves the frozen transition half", () => {
    const baseProps = {
      streamUrl: "/a.mp4",
      previewClipId: "a",
      isPlaying: true,
      mainIsVideoLayer: true,
      mainLayerTransform: { x: 0.5, y: 0.5, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 },
      canvasWidth: 1920,
      canvasHeight: 1080,
    };
    const frozenCompanion = {
      id: "b",
      streamUrl: "/b.mp4",
      sourceTime: 0,
      playbackRate: 1,
      freezePlayback: true,
      transitionLayer: true,
      opacity: 1,
    };
    const { container, rerender } = render(
      <LiteCutPreviewPanel {...baseProps} underlayLayers={[frozenCompanion]} />,
    );
    const companionElement = container.querySelector('video[src="/b.mp4"]');
    playedElements.length = 0;

    rerender(
      <LiteCutPreviewPanel
        {...baseProps}
        underlayLayers={[{ ...frozenCompanion, freezePlayback: false, sourceTime: 0.05 }]}
      />,
    );

    expect(playedElements).toContain(companionElement);
  });
});
