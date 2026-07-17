import { getLiteCutAssetStreamUrl, getRecordedClipStreamUrl } from "../../../api/api.js";

export function liteCutClipStreamUrl(clip, assetPreviewVersions = {}) {
  if (clip?.source_type === "file" && clip?.meta?.asset_id != null) {
    const assetId = Number(clip.meta.asset_id);
    const previewVersion = clip.meta.preview_proxy_version || assetPreviewVersions?.[assetId] || "";
    return getLiteCutAssetStreamUrl(clip.meta.asset_id, previewVersion);
  }
  return clip?.source_id ? getRecordedClipStreamUrl(clip.source_id) : null;
}
