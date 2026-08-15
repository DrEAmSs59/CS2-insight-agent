/** Map lite_cut_assets API row → media bin item */

export function mapAssetRow(row) {
  if (!row || row.id == null) return null;
  return {
    id: row.id,
    asset_uid: row.asset_uid || null,
    origin_type: row.origin_type || "local_file",
    origin_ref: row.origin_ref ?? null,
    origin_metadata: row.origin_metadata && typeof row.origin_metadata === "object" ? row.origin_metadata : {},
    name: row.name || `asset-${row.id}`,
    kind: row.kind || "file",
    asset_registered: row.asset_registered !== false,
    storage_mode: row.storage_mode || "managed",
    source_status: row.source_status || "available",
    source_available: row.source_available !== false && !["missing", "changed"].includes(row.source_status),
    metadata_status: row.metadata_status || "ready",
    path: row.file_path,
    file_path: row.file_path,
    duration_sec: row.duration_sec,
    fps: Number(row.fps) > 0 ? Number(row.fps) : null,
    width: row.width,
    height: row.height,
    has_alpha: Boolean(row.has_alpha),
    is_looping_animation: Boolean(row.is_looping_animation),
    codec_name: row.codec_name || null,
    audio_codec_name: row.audio_codec_name || null,
    has_audio: row.has_audio === true || Boolean(row.audio_codec_name),
    preview_proxy_required: Boolean(row.preview_proxy_required),
    preview_proxy_status: row.preview_proxy_status || "not_needed",
    preview_proxy_mode: row.preview_proxy_mode || "direct",
    preview_segment_step_sec: Number(row.preview_segment_step_sec) > 0 ? Number(row.preview_segment_step_sec) : null,
    preview_proxy_version: row.preview_proxy_version || "source",
    mime_type: row.mime_type,
    mediaKind: "asset",
  };
}

export function canPlaceAssetOnTimeline(asset) {
  return Boolean(
    asset
    && asset.asset_registered !== false
    && asset.source_available !== false
    && asset.source_status !== "missing",
  );
}

function addAssetId(out, value) {
  const id = Number(value);
  if (Number.isFinite(id) && id > 0) out.add(id);
}

export function collectUsedLiteCutAssetIds(body) {
  const out = new Set();
  for (const track of body?.tracks || []) {
    for (const clip of track?.clips || []) {
      addAssetId(out, clip?.meta?.asset_id);
    }
  }
  for (const overlay of body?.overlays || []) {
    addAssetId(out, overlay?.meta?.asset_id);
  }
  addAssetId(out, body?.audio?.bgm?.asset_id);
  return out;
}
