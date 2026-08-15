/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  addTimelineMarker,
  canLinkTimelineClips,
  canMoveTimelineSelection,
  groupTimelineItems,
  linkTimelineClips,
  moveTimelineSelection,
  pasteTimelineClipboard,
  splitTimelineSelection,
  trimTimelineSelection,
  updateTimelineMarker,
  upsertTimelineTransformKeyframe,
  ungroupTimelineItems,
  unlinkTimelineClips,
} from "./timelineCommands.js";

const body = {
  tracks: [
    {
      id: "v1",
      type: "video",
      clips: [
        { id: "a", timeline_start: 1, trim_in: 0, trim_out: 2 },
        { id: "b", timeline_start: 4, trim_in: 0, trim_out: 2 },
      ],
    },
  ],
  overlays: [{ id: "title", timeline_start: 1, duration: 1 }],
};

describe("pure timeline commands", () => {
  it("returns an explicit unchanged result and reason for an invalid move", () => {
    expect(canMoveTimelineSelection(body, ["a", "title"], -2)).toMatchObject({
      allowed: false,
      reason: "before_timeline_start",
    });
    expect(moveTimelineSelection(body, ["a", "title"], -2)).toEqual({
      changed: false,
      body,
      reason: "before_timeline_start",
      selectedIds: ["a", "title"],
    });
  });

  it("moves clips and overlays without mutating the input body", () => {
    const original = structuredClone(body);
    const result = moveTimelineSelection(body, ["a", "title"], 0.5);
    expect(result).toMatchObject({ changed: true, reason: null, selectedIds: ["a", "title"] });
    expect(result.body.tracks[0].clips[0].timeline_start).toBe(1.5);
    expect(result.body.overlays[0].timeline_start).toBe(1.5);
    expect(body).toEqual(original);
  });

  it("groups and ungroups through explicit pure command results", () => {
    const grouped = groupTimelineItems(body, ["a", "title"], "grp-fixture");
    expect(grouped.changed).toBe(true);
    expect(grouped.body.tracks[0].clips[0].meta.group_id).toBe("grp-fixture");
    expect(grouped.body.overlays[0].meta.group_id).toBe("grp-fixture");
    const ungrouped = ungroupTimelineItems(grouped.body, ["a"]);
    expect(ungrouped.changed).toBe(true);
    expect(ungrouped.body.tracks[0].clips[0].meta?.group_id).toBeUndefined();
    expect(ungrouped.body.overlays[0].meta?.group_id).toBeUndefined();
  });

  it("links and unlinks a video/audio pair without mutating the source", () => {
    const linkedBody = {
      tracks: [
        { id: "v1", type: "video", clips: [{ id: "video", timeline_start: 0, trim_out: 2 }] },
        { id: "a1", type: "audio", clips: [{ id: "audio", timeline_start: 0, trim_out: 2 }] },
      ],
      overlays: [],
    };
    expect(canLinkTimelineClips(linkedBody, ["video", "audio"])).toMatchObject({ allowed: true });
    const linked = linkTimelineClips(linkedBody, ["video", "audio"]);
    expect(linked.changed).toBe(true);
    expect(linked.body.tracks[0].clips[0].meta.linked_audio_clip_id).toBe("audio");
    const unlinked = unlinkTimelineClips(linked.body, "audio");
    expect(unlinked.changed).toBe(true);
    expect(unlinked.body.tracks[0].clips[0].meta.linked_audio_clip_id).toBeUndefined();
    expect(linkedBody.tracks[0].clips[0].meta).toBeUndefined();
  });

  it("owns marker validation and ordering as a pure command", () => {
    const added = addTimelineMarker(body, 2.5, "marker-fixture");
    expect(added).toMatchObject({ changed: true, markerId: "marker-fixture" });
    const updated = updateTimelineMarker(added.body, "marker-fixture", {
      label: "x".repeat(100),
      color: "invalid",
      time_sec: 0.5,
    });
    expect(updated.body.markers[0]).toMatchObject({ color: "#f59e0b", time_sec: 0.5 });
    expect(updated.body.markers[0].label).toHaveLength(80);
    expect(body.markers).toBeUndefined();
  });

  it("pastes, splits, and trims without mutating the input", () => {
    const original = structuredClone(body);
    const pasted = pasteTimelineClipboard(body, {
      type: "clip",
      trackType: "video",
      item: body.tracks[0].clips[0],
    }, 7, "v1");
    expect(pasted.changed).toBe(true);
    expect(pasted.body.tracks[0].clips).toHaveLength(3);
    const split = splitTimelineSelection(body, ["a"], 2);
    expect(split.changed).toBe(true);
    expect(split.body.tracks[0].clips).toHaveLength(3);
    const trimmed = trimTimelineSelection(body, ["a"], "end", 2);
    expect(trimmed.changed).toBe(true);
    expect(trimmed.body.tracks[0].clips[0].trim_out).toBe(1);
    expect(body).toEqual(original);
  });

  it("moves an exit transition endpoint to the right half after a split", () => {
    const source = {
      ...structuredClone(body),
      transitions: [{ id: "a-exit", type: "fade", duration_sec: 0.5, from: { kind: "clip", track_id: "v1", id: "a" }, to: null }],
    };
    const split = splitTimelineSelection(source, ["a"], 2);
    expect(split.changed).toBe(true);
    expect(split.body.transitions[0].from.id).toBe(split.selectedClipId);
    expect(split.body.transitions[0].from.id).not.toBe("a");
    expect(source.transitions[0].from.id).toBe("a");
  });

  it("applies transform keyframes as immutable domain edits", () => {
    const result = upsertTimelineTransformKeyframe(body, {
      kind: "overlay",
      itemId: "title",
      playheadSec: 1.5,
    });
    expect(result.changed).toBe(true);
    expect(result.body.overlays[0].keyframes[0].time_sec).toBe(0.5);
    expect(body.overlays[0].keyframes).toBeUndefined();
  });
});
