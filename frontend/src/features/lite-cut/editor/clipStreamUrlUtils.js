import {
  getLiteCutAssetAudioPreviewUrl,
  getLiteCutAssetStreamUrl,
  getRecordedClipStreamUrl,
} from "../../../api/api.js";

export function liteCutClipStreamUrl(clip, assetPreviewVersions = {}) {
  if (clip?.source_type === "file" && clip?.meta?.asset_id != null) {
    const assetId = Number(clip.meta.asset_id);
    const previewVersion = assetPreviewVersions?.[assetId] || clip.meta.preview_proxy_version || "";
    return getLiteCutAssetStreamUrl(clip.meta.asset_id, previewVersion);
  }
  return clip?.source_id ? getRecordedClipStreamUrl(clip.source_id) : null;
}

export function liteCutAudioPreviewUrl(item, videoClipIds, assetPreviewVersions = {}) {
  const clip = item?.clip;
  const assetId = clip?.meta?.asset_id;
  if (assetId != null) {
    const previewVersion = assetPreviewVersions?.[Number(assetId)] || clip.meta?.preview_proxy_version || "";
    const sourceVideoClipId = String(clip.meta?.source_clip_id || "");
    if (sourceVideoClipId && videoClipIds?.has(sourceVideoClipId)) {
      return getLiteCutAssetAudioPreviewUrl(assetId, previewVersion);
    }
    return getLiteCutAssetStreamUrl(assetId, previewVersion);
  }
  const recordedId = Number(clip?.source_id);
  return Number.isFinite(recordedId) && recordedId > 0 ? getRecordedClipStreamUrl(recordedId) : null;
}
