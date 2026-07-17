/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import OpenCutTrackTimeline, { snapPlacementStart } from "./OpenCutTrackTimeline.jsx";
import { useLiteCutEditorStore } from "../../../stores/liteCutEditorStore.js";
import { useLiteCutHistoryStore } from "../../../stores/liteCut/historyStore.js";
import { liteCutMediaDragSource } from "../../../stores/liteCut/mediaDragSource.js";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";

const body = {
  tracks: [
    { id: "v1", type: "video", label: "V1", clips: [] },
    { id: "v2", type: "video", label: "V2", clips: [{ id: "clip-v2", timeline_start: 4, trim_in: 0, trim_out: 4, meta: { name: "V2 clip" } }] },
    { id: "a1", type: "audio", label: "A1", clips: [] },
  ],
  overlays: [],
};

describe("OpenCutTrackTimeline", () => {
  afterEach(() => {
    liteCutMediaDragSource.end();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    useLiteCutEditorStore.setState({ body: structuredClone(body), dirty: false });
    useLiteCutHistoryStore.setState({ past: [], future: [] });
    useLiteCutTimelineStore.setState({
      playheadSec: 12,
      isPlaying: false,
      selectedClipId: null,
      selectedClipIds: [],
      selectedTrackId: "v1",
      timelineZoom: 1,
      snapEnabled: true,
    });
  });

  it("keeps the playhead still when selecting a clip", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    expect(clip).toBeTruthy();
    fireEvent.pointerDown(clip, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(document, { pointerId: 0, clientX: 20, clientY: 20 });

    expect(useLiteCutTimelineStore.getState()).toMatchObject({
      playheadSec: 12,
      selectedClipId: "clip-v2",
      selectedTrackId: "v2",
    });
  });

  it("shows segmented speed labels directly on the timeline clip", () => {
    const nextBody = structuredClone(body);
    nextBody.tracks[1].clips[0].speed_keyframes = [
      { source_sec: 0, speed: 0.5 },
      { source_sec: 2, speed: 2 },
      { source_sec: 4, speed: 2 },
    ];
    nextBody.tracks[1].clips[0].transition_in = { type: "fade", duration_sec: 0.25 };
    useLiteCutEditorStore.setState({ body: nextBody });

    render(<OpenCutTrackTimeline body={nextBody} />);

    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    expect(clip.dataset.ocClipTone).toBe("video");
    expect(clip.querySelector("[data-speed-ramp-overlay]")).toBeTruthy();
    expect(clip.querySelectorAll("[data-speed-ramp-segment]")).toHaveLength(2);
    expect(clip.querySelector("[data-speed-ramp-segment]").className).toContain("litecut-speed-ramp-segment--even");
    expect(clip.querySelector("[data-speed-ramp-overlay]").className).toContain("h-[12px]");
    expect(clip.querySelector("[data-transition-marker='in']").style.bottom).toBe("12px");
    expect(clip.querySelector("[data-transition-marker='in']").hasAttribute("data-transition-annotation")).toBe(true);
    expect(clip.textContent).toContain("0.50x");
    expect(clip.textContent).toContain("2.00x");
  });

  it("renders fixed track headers and a separate time ruler", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    expect(screen.getByText("视频轨 · V1")).toBeTruthy();
    expect(screen.getByText("视频轨 · V2")).toBeTruthy();
    expect(screen.getByText("音频轨(A轨) · A1")).toBeTruthy();
    expect(screen.getByText("文字轨1")).toBeTruthy();
    expect(screen.getByText("删左侧")).toBeTruthy();
    expect(screen.getByText("删右侧")).toBeTruthy();
    expect(document.querySelector("[data-oc-ruler]")).toBeTruthy();
    expect(document.querySelector("[data-oc-lane][data-oc-track-id='v1']")).toBeTruthy();
  });

  it("supports continuous zoom down to 8 percent", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    const slider = screen.getByRole("slider", { name: "时间轴无级缩放" });
    fireEvent.change(slider, { target: { value: "0" } });

    expect(useLiteCutTimelineStore.getState().timelineZoom).toBeCloseTo(0.08);
    expect(screen.getByText("8%")).toBeTruthy();
  });

  it("supports fast pointer-centered zoom with Ctrl plus mouse wheel", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    const scroller = document.querySelector("[data-oc-timeline-scroll]");
    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: 120, clientX: 500 });

    expect(useLiteCutTimelineStore.getState().timelineZoom).toBeLessThan(1);
  });

  it("moves a clip from V2 to V1 only after an intentional drag", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    const v1Lane = document.querySelector("[data-oc-lane][data-oc-track-id='v1']");
    expect(clip).toBeTruthy();
    expect(v1Lane).toBeTruthy();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => v1Lane });
    vi.spyOn(v1Lane, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 58, width: 900, height: 58 });

    fireEvent.pointerDown(clip, { button: 0, clientX: 180, clientY: 120 });
    fireEvent.pointerMove(document, { clientX: 220, clientY: 80 });
    fireEvent.pointerUp(document, { clientX: 220, clientY: 80 });

    const nextBody = useLiteCutEditorStore.getState().body;
    expect(nextBody.tracks.find((track) => track.id === "v1").clips.map((item) => item.id)).toEqual(["clip-v2"]);
    expect(nextBody.tracks.find((track) => track.id === "v2").clips).toEqual([]);
  });

  it("moves every member when dragging one clip from a selected group", () => {
    const groupedBody = structuredClone(body);
    const track = groupedBody.tracks.find((item) => item.id === "v2");
    track.clips = [
      { ...track.clips[0], id: "group-a", timeline_start: 4, meta: { ...(track.clips[0].meta || {}), group_id: "grp-test" } },
      { ...track.clips[0], id: "group-b", timeline_start: 10, trim_out: 2, meta: { ...(track.clips[0].meta || {}), group_id: "grp-test" } },
    ];
    useLiteCutEditorStore.setState({ body: groupedBody, dirty: false });
    useLiteCutTimelineStore.getState().selectClip("group-a", "v2");
    render(<OpenCutTrackTimeline body={groupedBody} />);

    const lane = document.querySelector("[data-oc-lane][data-oc-track-id='v2']");
    const clipNode = document.querySelector("[data-oc-clip-id='group-a']");
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 58, width: 900, height: 58 });
    fireEvent(clipNode, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 180, clientY: 120 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 224, clientY: 120 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 224, clientY: 120 }));

    expect(useLiteCutEditorStore.getState().body.tracks.find((item) => item.id === "v2").clips.map((item) => [item.id, item.timeline_start])).toEqual([
      ["group-a", 5],
      ["group-b", 11],
    ]);
  });

  it("pauses playback when an intentional clip drag begins", () => {
    useLiteCutTimelineStore.setState({ isPlaying: true });
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);

    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    const v1Lane = document.querySelector("[data-oc-lane][data-oc-track-id='v1']");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => v1Lane });
    vi.spyOn(v1Lane, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 58, width: 900, height: 58 });

    fireEvent.pointerDown(clip, { button: 0, clientX: 180, clientY: 120 });
    fireEvent.pointerMove(document, { clientX: 220, clientY: 80 });

    expect(useLiteCutTimelineStore.getState()).toMatchObject({ isPlaying: false, playheadSec: 12 });
    fireEvent.pointerUp(document, { clientX: 220, clientY: 80 });
  });

  it("uses the explicit +V drop zone to request a new video track", () => {
    const onDropMedia = vi.fn();
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} onDropMedia={onDropMedia} />);
    const zone = document.querySelector("[data-auto-video-track-drop]");
    expect(zone).toBeTruthy();
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({ left: 128, right: 1028, top: 0, bottom: 26, width: 900, height: 26 });
    const media = { mediaKind: "asset", kind: "video", name: "next.mov", duration_sec: 4 };
    liteCutMediaDragSource.begin(media);

    fireEvent.dragOver(zone, { clientX: 216, clientY: 12 });
    fireEvent.drop(zone, { clientX: 216, clientY: 12 });

    expect(onDropMedia).toHaveBeenCalledWith(media, "v2", expect.any(Number), { createNewTrack: true, createBelow: true });
  });

  it("moves an existing video clip into a newly created track through the +V zone", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);
    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    const zone = document.querySelector("[data-auto-video-track-drop]");
    expect(clip).toBeTruthy();
    expect(zone).toBeTruthy();
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({ left: 128, right: 1028, top: 0, bottom: 26, width: 900, height: 26 });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => zone });

    fireEvent.pointerDown(clip, { button: 0, clientX: 180, clientY: 120 });
    fireEvent.pointerMove(document, { clientX: 240, clientY: 220 });
    fireEvent.pointerUp(document, { clientX: 240, clientY: 220 });

    const nextBody = useLiteCutEditorStore.getState().body;
    const videoTracks = nextBody.tracks.filter((track) => track.type === "video");
    expect(videoTracks).toHaveLength(3);
    expect(videoTracks[2].clips.map((item) => item.id)).toEqual(["clip-v2"]);
    expect(videoTracks[1].clips).toEqual([]);
  });

  it("moves an existing text or image overlay into a newly created track through the +T zone", () => {
    const overlayBody = structuredClone(body);
    overlayBody.overlay_tracks = [{ id: "ot1", label: "文字轨 1" }];
    overlayBody.overlays = [{
      id: "overlay-1",
      type: "text",
      timeline_start: 1,
      duration: 3,
      text: { content: "CLUTCH" },
      meta: { overlay_track_id: "ot1" },
    }];
    useLiteCutEditorStore.setState({ body: overlayBody, dirty: false });
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);
    const overlay = document.querySelector("[data-oc-clip-id='overlay-1']");
    const zone = document.querySelector("[data-auto-overlay-track-drop]");
    expect(overlay).toBeTruthy();
    expect(zone).toBeTruthy();
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({ left: 128, right: 1028, top: 0, bottom: 26, width: 900, height: 26 });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => zone });

    fireEvent.pointerDown(overlay, { button: 0, clientX: 180, clientY: 80 });
    fireEvent.pointerMove(document, { clientX: 250, clientY: 140 });
    fireEvent.pointerUp(document, { clientX: 250, clientY: 140 });

    const nextBody = useLiteCutEditorStore.getState().body;
    expect(nextBody.overlay_tracks).toHaveLength(2);
    expect(nextBody.overlays[0].meta.overlay_track_id).toBe(nextBody.overlay_tracks[1].id);
  });

  it("keeps transition text and duration inside the scaled transition strips", () => {
    const transitionBody = structuredClone(body);
    transitionBody.tracks.find((track) => track.id === "v2").clips[0] = {
      ...transitionBody.tracks.find((track) => track.id === "v2").clips[0],
      transition_in: { type: "fade", duration_sec: 0.25 },
      transition_out: { type: "zoom", duration_sec: 0.25 },
    };
    useLiteCutEditorStore.setState({ body: transitionBody, dirty: false });

    render(<OpenCutTrackTimeline body={transitionBody} />);

    const inMarker = document.querySelector("[data-transition-marker='in']");
    const outMarker = document.querySelector("[data-transition-marker='out']");
    expect(inMarker.className).toContain("litecut-transition-marker--in");
    expect(inMarker.dataset.transitionDurationSec).toBe("0.25");
    expect(inMarker.style.width).toBe("11px");
    expect(outMarker.style.width).toBe("11px");
    expect(inMarker.title).toContain("0.25s");
    expect(outMarker.title).toContain("0.25s");
    expect(inMarker.className).toContain("litecut-transition-marker--compact");
    expect(outMarker.className).toContain("litecut-transition-marker--compact");
    const compactLayout = document.querySelector("[data-transition-label-layout='compact']");
    expect(compactLayout).toBeTruthy();
    expect(compactLayout.querySelector("[data-transition-compact-label='in']").title).toContain("0.25s");
    expect(compactLayout.querySelector("[data-transition-compact-label='out']").title).toContain("0.25s");
  });

  it("renders one boundary transition when the incoming clip owns it", () => {
    const transitionBody = structuredClone(body);
    const track = transitionBody.tracks.find((item) => item.id === "v2");
    track.clips = [
      { ...track.clips[0], id: "first", timeline_start: 0, trim_out: 4, transition_out: { type: "fade", duration_sec: 0.4 } },
      { ...track.clips[0], id: "second", timeline_start: 4, trim_out: 4, transition_in: { type: "zoom", duration_sec: 0.6 } },
    ];
    useLiteCutEditorStore.setState({ body: transitionBody, dirty: false });

    render(<OpenCutTrackTimeline body={transitionBody} />);

    expect(document.querySelector("[data-oc-clip-id='first'] [data-transition-marker='out']")).toBeNull();
    expect(document.querySelector("[data-oc-clip-id='second'] [data-transition-marker='in']")?.title).toContain("0.60s");
  });

  it("uses distinct tones for video, audio, text, and image materials", () => {
    const toneBody = structuredClone(body);
    toneBody.tracks.find((track) => track.id === "v2").clips[0].meta = { kind: "image", name: "alpha-overlay.mov" };
    toneBody.tracks.find((track) => track.id === "a1").clips = [{ id: "audio-1", timeline_start: 0, trim_in: 0, trim_out: 3, meta: { kind: "audio", name: "music.mp3" } }];
    toneBody.overlay_tracks = [{ id: "ot1", label: "文字轨1" }, { id: "ot2", label: "图片轨1" }];
    toneBody.overlays = [
      { id: "text-1", type: "text", timeline_start: 0, duration: 3, fade_in_sec: 0.3, fade_out_sec: 0.4, text: { content: "TITLE", anim_in: "slide_up", anim_out: "fade" }, meta: { overlay_track_id: "ot1" } },
      { id: "image-1", type: "sticker", timeline_start: 3, duration: 3, transition_in: { type: "fade", duration_sec: 0.25 }, transition_out: { type: "zoom", duration_sec: 0.35 }, meta: { kind: "image", overlay_track_id: "ot2" } },
    ];
    useLiteCutEditorStore.setState({ body: toneBody, dirty: false });

    render(<OpenCutTrackTimeline body={toneBody} />);

    expect(document.querySelector("[data-oc-clip-id='clip-v2']").dataset.ocClipTone).toBe("video");
    expect(document.querySelector("[data-oc-clip-id='audio-1']").dataset.ocClipTone).toBe("audio");
    expect(document.querySelector("[data-oc-clip-id='text-1']").dataset.ocClipTone).toBe("text");
    expect(document.querySelector("[data-oc-clip-id='image-1']").dataset.ocClipTone).toBe("image");
    expect(document.querySelector("[data-oc-clip-id='text-1'] [data-transition-marker='in']").title).toContain("0.30s");
    expect(document.querySelector("[data-oc-clip-id='image-1'] [data-transition-marker='in']").title).toContain("0.25s");
  });

  it("renders draggable markers and commits one history step after a drag", () => {
    const markerBody = structuredClone(body);
    markerBody.markers = [{ id: "marker-1", time_sec: 2, label: "Clutch", color: "#f59e0b" }];
    useLiteCutEditorStore.setState({ body: markerBody, dirty: false });
    render(<OpenCutTrackTimeline body={markerBody} />);
    const ruler = document.querySelector("[data-oc-ruler]");
    const marker = document.querySelector("[data-timeline-marker='marker-1']");
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 34, width: 900, height: 34 });

    fireEvent.pointerDown(marker, { button: 0, clientX: 110 });
    const move = new Event("pointermove", { bubbles: true });
    Object.defineProperty(move, "clientX", { value: 165 });
    act(() => document.dispatchEvent(move));
    fireEvent.pointerUp(document, { clientX: 165 });

    expect(useLiteCutEditorStore.getState().body.markers[0].time_sec).toBeCloseTo(3.75);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("treats a marker click with tiny pointer jitter as a seek, not a move", () => {
    const markerBody = structuredClone(body);
    markerBody.markers = [{ id: "marker-1", time_sec: 2, label: "Clutch", color: "#f59e0b" }];
    useLiteCutEditorStore.setState({ body: markerBody, dirty: false });
    render(<OpenCutTrackTimeline body={markerBody} />);
    const ruler = document.querySelector("[data-oc-ruler]");
    const marker = document.querySelector("[data-timeline-marker='marker-1']");
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 34, width: 900, height: 34 });

    fireEvent(marker, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 88 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 90 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 90 }));

    expect(useLiteCutEditorStore.getState().body.markers[0].time_sec).toBe(2);
    expect(useLiteCutTimelineStore.getState().playheadSec).toBe(2);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(0);
  });

  it("uses marker times as material placement snap candidates", () => {
    const result = snapPlacementStart(
      4.9,
      2,
      { tracks: [], overlays: [], markers: [{ id: "beat", time_sec: 5 }] },
      null,
      20,
      44,
    );
    expect(result).toMatchObject({ start: 5, guide: 5 });
  });

  it("exposes clip actions and keyframe creation from the context menu", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);
    const lane = document.querySelector("[data-oc-lane][data-oc-track-id='v2']");
    const clip = document.querySelector("[data-oc-clip-id='clip-v2']");
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({ left: 0, right: 900, top: 0, bottom: 58, width: 900, height: 58 });

    fireEvent.contextMenu(clip, { clientX: 275, clientY: 120 });
    expect(screen.getByRole("menu", { name: "素材操作" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /分割全部轨道/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /滑移素材内容向前一帧/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /选择该素材末尾左侧全部素材/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /在播放头添加画面关键帧/ }));

    const stored = useLiteCutEditorStore.getState().body.tracks.find((track) => track.id === "v2").clips[0];
    expect(stored.keyframes).toHaveLength(1);
  });

  it("drags a timeline keyframe to a new frame-aligned time", () => {
    const nextBody = structuredClone(body);
    nextBody.output = { width: 1920, height: 1080, fps: 60 };
    nextBody.tracks[1].clips[0].keyframes = [{ time_sec: 1, transform: { x: 0.7, y: 0.4, scale: 1.2 } }];
    useLiteCutEditorStore.setState({ body: nextBody });
    render(<OpenCutTrackTimeline body={nextBody} />);

    const point = document.querySelector("[data-timeline-keyframe='transform']");
    fireEvent(point, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 144 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 144 }));

    const stored = useLiteCutEditorStore.getState().body.tracks[1].clips[0].keyframes[0];
    expect(stored).toMatchObject({ time_sec: 2, transform: { x: 0.7, scale: 1.2 } });
    expect(useLiteCutTimelineStore.getState().playheadSec).toBeCloseTo(6);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("shows a discoverable shortcut reference", () => {
    render(<OpenCutTrackTimeline body={useLiteCutEditorStore.getState().body} />);
    fireEvent.click(screen.getByText("快捷键"));
    expect(screen.getByRole("dialog", { name: "LiteCut 快捷键" })).toBeTruthy();
    expect(screen.getByText("添加标记点")).toBeTruthy();
    expect(screen.getByText("Alt+K / Alt+Shift+K")).toBeTruthy();
    expect(screen.getByText("滑移素材内容")).toBeTruthy();
    expect(screen.getByText("选择播放头左/右素材")).toBeTruthy();
  });
});
