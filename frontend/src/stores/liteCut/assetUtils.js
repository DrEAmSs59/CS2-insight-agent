/** Map lite_cut_assets API row → media bin item */

export function mapAssetRow(row) {
  if (!row || row.id == null) return null;
  return {
    id: row.id,
    name: row.name || `asset-${row.id}`,
    kind: row.kind || "file",
    path: row.file_path,
    file_path: row.file_path,
    duration_sec: row.duration_sec,
    width: row.width,
    height: row.height,
    has_alpha: Boolean(row.has_alpha),
    preview_proxy_required: Boolean(row.preview_proxy_required),
    preview_proxy_status: row.preview_proxy_status || "not_needed",
    preview_proxy_error: row.preview_proxy_error || "",
    preview_proxy_version: row.preview_proxy_version || "source",
    mime_type: row.mime_type,
    mediaKind: "asset",
  };
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
