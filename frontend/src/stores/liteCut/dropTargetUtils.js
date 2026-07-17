import {
  audioTracks,
  canPlaceOnTrack,
  clipSourceDuration,
  getTrack,
  insertVideoTrack,
  visibleVideoTracks,
} from "./timelineUtils.js";

/** 与 LiteCutTimelinePanel 轨道行高 class 对齐 */
export const TRACK_HEIGHT_PX = {
  video: 44,
  overlay: 28,
  audio: 24,
};
export const TRACK_GAP_PX = 1;

export function orderedTimelineRows(body) {
  const rows = [];
  rows.push({ id: "ov", type: "overlay", track: null });
  for (const vt of visibleVideoTracks(body)) {
    rows.push({ id: vt.id, type: "video", track: vt });
  }
  for (const at of audioTracks(body)) {
    rows.push({ id: at.id, type: "audio", track: at });
  }
  return rows;
}

function isEditableMediaRow(row) {
  if (!row?.track) return false;
  return !row.track.locked && !row.track.hidden;
}

export function rowHeightPx(type) {
  return TRACK_HEIGHT_PX[type] ?? TRACK_HEIGHT_PX.video;
}

export function getTrackAtY(mouseY, rows, verticalDragDirection = null) {
  let cumulative = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = rowHeightPx(rows[i].type);
    const top = cumulative;
    const bottom = top + h;
    if (mouseY >= top && mouseY < bottom) {
      return { rowIndex: i, row: rows[i], relativeY: mouseY - top };
    }
    if (i < rows.length - 1 && verticalDragDirection) {
      const gapTop = bottom;
      const gapBottom = gapTop + TRACK_GAP_PX;
      if (mouseY >= gapTop && mouseY < gapBottom) {
        const up = verticalDragDirection === "up";
        const idx = up ? i : i + 1;
        return {
          rowIndex: idx,
          row: rows[idx] ?? rows[i],
          relativeY: up ? h - 1 : 0,
        };
      }
    }
    cumulative += h + TRACK_GAP_PX;
  }
  return null;
}

export function verticalDragDirection(startY, currentY) {
  if (currentY < startY) return "up";
  if (currentY > startY) return "down";
  return null;
}

function trackTypeForMedia(mediaItem) {
  if (mediaItem?.mediaKind === "asset") {
    const kind = mediaItem.kind || "image";
    if (kind === "audio") return "audio";
    return "video";
  }
  return "video";
}

function mediaDurationSec(mediaItem) {
  if (mediaItem?.mediaKind === "asset") {
    const d = Number(mediaItem.duration_sec);
    if (d > 0) return d;
    return mediaItem.kind === "image" ? 3 : 5;
  }
  const d = Number(mediaItem?.duration);
  return d > 0 ? d : 5;
}

/**
 * OpenCut computeDropTarget 的 LiteCut 简化版。
 * @returns {{ trackId: string, startTime: number, isNewTrack: boolean, insertAfterTrackId: string | null, rowIndex: number, dropLineY: number } | null}
 */
export function computeMediaDropTarget({
  body,
  mouseY,
  startTime,
  mediaItem,
  excludeClipId = null,
  verticalDir = null,
}) {
  const rows = orderedTimelineRows(body);
  const elementTrackType = trackTypeForMedia(mediaItem);
  const duration = mediaDurationSec(mediaItem);
  const isOverlayAsset =
    mediaItem?.mediaKind === "asset" && !["video", "audio"].includes(String(mediaItem?.kind || "image"));

  const trackAt = getTrackAtY(mouseY, rows, verticalDir);
  const dropLineY = (rowIndex) => {
    let y = 0;
    for (let i = 0; i < rowIndex; i++) {
      y += rowHeightPx(rows[i].type) + TRACK_GAP_PX;
    }
    return y;
  };

  if (!trackAt) {
    const above = mouseY < 0;
    const rowIndex = above ? 0 : rows.length;
    if (isOverlayAsset) {
      const ovIdx = rows.findIndex((r) => r.type === "overlay");
      return {
        trackId: "ov",
        startTime,
        isNewTrack: false,
        insertAfterTrackId: null,
        rowIndex: ovIdx >= 0 ? ovIdx : 0,
        dropLineY: dropLineY(ovIdx >= 0 ? ovIdx : 0),
      };
    }
    const videoRows = rows.filter((r) => r.type === "video");
    const anchor = above ? videoRows[0]?.id : videoRows[videoRows.length - 1]?.id;
    return {
      trackId: anchor || "v1",
      startTime,
      isNewTrack: true,
      createBelow: !above,
      insertAfterTrackId: above ? null : anchor || null,
      rowIndex,
      dropLineY: dropLineY(rowIndex),
    };
  }

  const { row, rowIndex, relativeY } = trackAt;
  const hoverAbove = relativeY < rowHeightPx(row.type) / 2;

  if (isOverlayAsset) {
    if (row.type === "overlay") {
      return {
        trackId: "ov",
        startTime,
        isNewTrack: false,
        insertAfterTrackId: null,
        rowIndex,
        dropLineY: dropLineY(rowIndex),
      };
    }
    const ovIdx = rows.findIndex((r) => r.type === "overlay");
    return {
      trackId: "ov",
      startTime,
      isNewTrack: false,
      insertAfterTrackId: null,
      rowIndex: ovIdx >= 0 ? ovIdx : rowIndex,
      dropLineY: dropLineY(ovIdx >= 0 ? ovIdx : rowIndex),
    };
  }

  if (elementTrackType === "audio") {
    if (row.type === "audio" && row.track && isEditableMediaRow(row)) {
      if (canPlaceOnTrack(row.track.clips, startTime, duration, excludeClipId)) {
        return {
          trackId: row.id,
          startTime,
          isNewTrack: false,
          insertAfterTrackId: null,
          rowIndex,
          dropLineY: dropLineY(rowIndex),
        };
      }
    }
    const audioIdx = row.type === "audio" ? rowIndex : rows.findIndex((r) => r.type === "audio");
    const insertAt = audioIdx >= 0 ? (hoverAbove ? audioIdx : audioIdx + 1) : rows.length;
    return {
      trackId: row.type === "audio" ? row.id : "a1",
      startTime,
      isNewTrack: true,
      insertAfterTrackId: row.type === "audio" ? row.id : null,
      rowIndex: insertAt,
      dropLineY: dropLineY(insertAt),
    };
  }

  if (row.type === "video" && row.track) {
    if (!isEditableMediaRow(row)) {
      const newRowIndex = hoverAbove ? rowIndex : rowIndex + 1;
      return {
        trackId: row.id,
        startTime,
        isNewTrack: true,
        createBelow: !hoverAbove,
        insertAfterTrackId: hoverAbove ? null : row.id,
        rowIndex: newRowIndex,
        dropLineY: dropLineY(newRowIndex),
      };
    }
    if (canPlaceOnTrack(row.track.clips, startTime, duration, excludeClipId)) {
      return {
        trackId: row.id,
        startTime,
        isNewTrack: false,
        insertAfterTrackId: null,
        rowIndex,
        dropLineY: dropLineY(rowIndex),
      };
    }
    const insertAfter = hoverAbove ? null : row.id;
    const newRowIndex = hoverAbove ? rowIndex : rowIndex + 1;
    return {
      trackId: row.id,
      startTime,
      isNewTrack: true,
      createBelow: !hoverAbove,
      insertAfterTrackId: insertAfter,
      rowIndex: newRowIndex,
      dropLineY: dropLineY(newRowIndex),
    };
  }

  if (row.type === "overlay") {
    const videos = rows.filter((r) => r.type === "video");
    const nearest = hoverAbove ? videos[videos.length - 1] : videos[0];
    if (nearest?.track && isEditableMediaRow(nearest)) {
      if (canPlaceOnTrack(nearest.track.clips, startTime, duration, excludeClipId)) {
        return {
          trackId: nearest.id,
          startTime,
          isNewTrack: false,
          insertAfterTrackId: null,
          rowIndex: rows.indexOf(nearest),
          dropLineY: dropLineY(rows.indexOf(nearest)),
        };
      }
    }
    const anchor = nearest?.id || "v1";
    return {
      trackId: anchor,
      startTime,
      isNewTrack: true,
      createBelow: !hoverAbove,
      insertAfterTrackId: hoverAbove ? null : anchor,
      rowIndex: hoverAbove ? 0 : 1,
      dropLineY: dropLineY(hoverAbove ? 0 : 1),
    };
  }

  if (row.type === "audio") {
    const videos = rows.filter((r) => r.type === "video");
    const lastVideo = videos[videos.length - 1];
    if (lastVideo?.track && isEditableMediaRow(lastVideo) && canPlaceOnTrack(lastVideo.track.clips, startTime, duration, excludeClipId)) {
      return {
        trackId: lastVideo.id,
        startTime,
        isNewTrack: false,
        insertAfterTrackId: null,
        rowIndex: rows.indexOf(lastVideo),
        dropLineY: dropLineY(rows.indexOf(lastVideo)),
      };
    }
    return {
      trackId: lastVideo?.id || "v1",
      startTime,
      isNewTrack: true,
      insertAfterTrackId: lastVideo?.id || null,
      rowIndex: rows.indexOf(lastVideo) + 1,
      dropLineY: dropLineY(rows.indexOf(lastVideo) + 1),
    };
  }

  return null;
}

/** 片段在轨道上拖动时的落点（OpenCut element-interaction 风格） */
export function computeClipMoveTarget({
  body,
  mouseY,
  startTime,
  fromTrackId,
  clipId,
  clipDuration,
  verticalDir = null,
}) {
  const rows = orderedTimelineRows(body);
  const trackAt = getTrackAtY(mouseY, rows, verticalDir);
  const dropLineY = (rowIndex) => {
    let y = 0;
    for (let i = 0; i < rowIndex; i++) {
      y += rowHeightPx(rows[i].type) + TRACK_GAP_PX;
    }
    return y;
  };

  const fromRow = rows.find((r) => r.id === fromTrackId);
  if (fromRow?.track?.locked) return null;
  const isVideoClip = fromRow?.type === "video";

  if (!trackAt) {
    const above = mouseY < 0;
    const videoRows = rows.filter((r) => r.type === "video");
    const anchor = above ? videoRows[0] : videoRows[videoRows.length - 1];
    if (!anchor) return null;
    return {
      trackId: anchor.id,
      startTime,
      isNewTrack: true,
      createBelow: !above,
      rowIndex: above ? 0 : rows.length,
      dropLineY: dropLineY(above ? 0 : rows.length),
    };
  }

  const { row, rowIndex, relativeY } = trackAt;
  const hoverAbove = relativeY < rowHeightPx(row.type) / 2;

  if (!isVideoClip || row.type !== "video") {
    if (fromRow?.type === "video") {
      return {
        trackId: fromTrackId,
        startTime,
        isNewTrack: false,
        createBelow: false,
        rowIndex: rows.findIndex((r) => r.id === fromTrackId),
        dropLineY: dropLineY(rows.findIndex((r) => r.id === fromTrackId)),
      };
    }
    return {
      trackId: fromTrackId,
      startTime,
      isNewTrack: false,
      createBelow: false,
      rowIndex,
      dropLineY: dropLineY(rowIndex),
    };
  }

  if (row.type === "video" && row.track) {
    if (!isEditableMediaRow(row)) {
      const h = rowHeightPx(row.type);
      const edgeZone = Math.max(6, h * 0.22);
      const inEdge = relativeY < edgeZone || relativeY > h - edgeZone;
      if (!inEdge) return null;
      return {
        trackId: row.id,
        startTime,
        isNewTrack: true,
        createBelow: !hoverAbove,
        rowIndex: hoverAbove ? rowIndex : rowIndex + 1,
        dropLineY: dropLineY(hoverAbove ? rowIndex : rowIndex + 1),
      };
    }
    if (row.id === fromTrackId) {
      return {
        trackId: row.id,
        startTime,
        isNewTrack: false,
        createBelow: false,
        rowIndex,
        dropLineY: dropLineY(rowIndex),
      };
    }
    if (canPlaceOnTrack(row.track.clips, startTime, clipDuration, clipId)) {
      return {
        trackId: row.id,
        startTime,
        isNewTrack: false,
        createBelow: false,
        rowIndex,
        dropLineY: dropLineY(rowIndex),
      };
    }
    const h = rowHeightPx(row.type);
    const edgeZone = Math.max(6, h * 0.22);
    const inEdge = relativeY < edgeZone || relativeY > h - edgeZone;
    if (inEdge) {
      return {
        trackId: row.id,
        startTime,
        isNewTrack: true,
        createBelow: !hoverAbove,
        rowIndex: hoverAbove ? rowIndex : rowIndex + 1,
        dropLineY: dropLineY(hoverAbove ? rowIndex : rowIndex + 1),
      };
    }
    return {
      trackId: row.id,
      startTime,
      isNewTrack: false,
      createBelow: false,
      rowIndex,
      dropLineY: dropLineY(rowIndex),
    };
  }

  const videos = rows.filter((r) => r.type === "video");
  const nearest = videos[videos.length - 1];
  if (nearest?.track && isEditableMediaRow(nearest) && canPlaceOnTrack(nearest.track.clips, startTime, clipDuration, clipId)) {
    return {
      trackId: nearest.id,
      startTime,
      isNewTrack: false,
      createBelow: false,
      rowIndex: rows.indexOf(nearest),
      dropLineY: dropLineY(rows.indexOf(nearest)),
    };
  }
  return {
    trackId: nearest?.id || fromTrackId,
    startTime,
    isNewTrack: true,
    createBelow: true,
    rowIndex: rows.indexOf(nearest) + 1,
    dropLineY: dropLineY(rows.indexOf(nearest) + 1),
  };
}

export function applyDropPlacement(body, placement) {
  if (!placement?.isNewTrack || !placement.insertAfterTrackId) {
    return placement?.trackId || null;
  }
  return insertVideoTrack(body, placement.insertAfterTrackId);
}

export function findClipDuration(body, clipId, trackId) {
  const track = getTrack(body, trackId);
  const clip = (track?.clips || []).find((c) => c.id === clipId);
  return clip ? clipSourceDuration(clip) : 5;
}
