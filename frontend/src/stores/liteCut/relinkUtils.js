function samePath(left, right) {
  const normalize = (value) => String(value || "").trim().replaceAll("\\", "/").toLowerCase();
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

function replacementMeta(asset, previous = {}) {
  return {
    ...previous,
    asset_id: Number(asset.id),
    name: asset.name,
    kind: asset.kind,
    duration_sec: Number(asset.duration_sec) || previous.duration_sec,
    source_width: Number(asset.width) || previous.source_width,
    source_height: Number(asset.height) || previous.source_height,
  };
}

export function replacementAcceptForWarning(warning) {
  switch (String(warning?.kind || "")) {
    case "font": return ".ttf,.otf,.woff,.woff2";
    case "audio":
    case "bgm": return "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg";
    case "overlay": return "image/*,video/*,.gif,.webm,.mov";
    default: return "video/*,.mp4,.mov,.mkv,.m4v,.avi,.webm";
  }
}

export function replacementMatchesWarning(warning, asset) {
  const kind = String(warning?.kind || "");
  const assetKind = String(asset?.kind || "");
  if (kind === "font") return assetKind === "font";
  if (kind === "audio" || kind === "bgm") return assetKind === "audio";
  if (kind === "overlay") return ["image", "video", "webm"].includes(assetKind);
  if (kind === "video" || kind === "recording") return ["video", "webm"].includes(assetKind);
  return true;
}

/** Replace every reference represented by one validation warning. */
export function relinkMissingAssetReferences(rawBody, warning, asset) {
  if (!rawBody || !warning || !asset?.file_path || !asset?.id) return { body: rawBody, changed: 0 };
  const body = structuredClone(rawBody);
  const oldPath = warning.path;
  const sourceId = Number(warning.source_id);
  let changed = 0;

  for (const track of body.tracks || []) {
    for (const clip of track.clips || []) {
      const recordedMatch = String(warning.kind) === "recording"
        && Number.isFinite(sourceId)
        && Number(clip.source_id) === sourceId;
      if (!recordedMatch && !samePath(clip.file_path, oldPath)) continue;
      clip.source_type = "file";
      clip.source_id = null;
      clip.file_path = asset.file_path;
      clip.meta = replacementMeta(asset, clip.meta);
      const duration = Number(asset.duration_sec);
      if (duration > 0) {
        const trimIn = Math.max(0, Math.min(Number(clip.trim_in) || 0, Math.max(0, duration - 0.05)));
        clip.trim_in = trimIn;
        clip.trim_out = Math.max(trimIn + 0.05, Math.min(Number(clip.trim_out) || duration, duration));
      }
      changed += 1;
    }
  }

  for (const overlay of body.overlays || []) {
    if (samePath(overlay.asset_path, oldPath)) {
      overlay.asset_path = asset.file_path;
      overlay.meta = replacementMeta(asset, overlay.meta);
      changed += 1;
    }
    if (samePath(overlay.text?.font_file, oldPath)) {
      overlay.text = {
        ...(overlay.text || {}),
        font_file: asset.file_path,
        font_family: String(asset.name || "Imported font").replace(/\.[^.]+$/, ""),
      };
      overlay.meta = replacementMeta(asset, overlay.meta);
      changed += 1;
    }
  }

  if (samePath(body.audio?.bgm?.path, oldPath)) {
    body.audio = {
      ...(body.audio || {}),
      bgm: {
        ...(body.audio?.bgm || {}),
        path: asset.file_path,
        name: asset.name,
        asset_id: Number(asset.id),
        duration_sec: Number(asset.duration_sec) || body.audio?.bgm?.duration_sec,
      },
    };
    changed += 1;
  }
  return { body, changed };
}
