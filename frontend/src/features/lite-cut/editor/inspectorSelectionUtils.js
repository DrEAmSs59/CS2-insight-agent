export function inspectorTabForTimelineSelection(body, selectedClipId, selectedTrackId) {
  if (!selectedClipId) return null;
  if (selectedTrackId === "overlay") {
    const overlay = (body?.overlays || []).find((item) => String(item.id) === String(selectedClipId));
    return overlay?.type === "text" ? "text" : "clip";
  }
  const track = (body?.tracks || []).find((item) => String(item.id) === String(selectedTrackId));
  return track?.type === "audio" ? "audio" : "clip";
}
