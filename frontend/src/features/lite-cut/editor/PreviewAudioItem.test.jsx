import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import PreviewAudioItem, {
  correctedPreviewAudioRate,
  previewAudioSourceDiscontinuity,
} from "./PreviewAudioItem.jsx";

beforeAll(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

describe("PreviewAudioItem", () => {
  it("loads packaged-backend media with anonymous CORS before routing it through Web Audio", () => {
    const { container } = render(
      <PreviewAudioItem
        item={{
          id: "clip-audio",
          src: "http://127.0.0.1:19871/api/lite-cut/assets/7/stream",
          sourceTime: 0,
          playbackRate: 1,
          volume: 1,
        }}
        isPlaying={false}
      />,
    );

    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio.crossOrigin).toBe("anonymous");
    expect(audio.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("does not hard-seek during continuous playback clock updates", () => {
    const previous = { sourceTime: 12, nowMs: 1_000, isPlaying: true };
    expect(previewAudioSourceDiscontinuity(previous, {
      sourceTime: 12.25,
      nowMs: 1_250,
      playbackRate: 1,
      isPlaying: true,
    })).toBe(false);
    expect(previewAudioSourceDiscontinuity(previous, {
      sourceTime: 24,
      nowMs: 1_250,
      playbackRate: 1,
      isPlaying: true,
    })).toBe(true);
    expect(previewAudioSourceDiscontinuity(previous, {
      sourceTime: 2,
      nowMs: 1_250,
      playbackRate: 1,
      isPlaying: true,
    })).toBe(true);
  });

  it("uses bounded rate correction for small continuous A/V drift", () => {
    expect(correctedPreviewAudioRate(1, 0.5)).toBeCloseTo(1.04);
    expect(correctedPreviewAudioRate(1, -0.5)).toBeCloseTo(0.96);
    expect(correctedPreviewAudioRate(1, 0.02)).toBe(1);
    expect(correctedPreviewAudioRate(4, 10)).toBe(4);
  });

  it("retargets an in-flight seek when the user jumps again", () => {
    const { container, rerender } = render(
      <PreviewAudioItem
        item={{ id: "a", src: "/segment.mp4", sourceTime: 0, volume: 1 }}
        isPlaying={false}
        userSeekToken={1}
      />,
    );
    const audio = container.querySelector("audio");
    Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
    Object.defineProperty(audio, "seeking", { configurable: true, value: true });
    rerender(
      <PreviewAudioItem
        item={{ id: "a", src: "/segment.mp4", sourceTime: 2.75, volume: 1 }}
        isPlaying={false}
        userSeekToken={2}
      />,
    );
    expect(audio.currentTime).toBeCloseTo(2.75);
  });
});
