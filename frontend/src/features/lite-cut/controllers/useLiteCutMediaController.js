import { useCallback, useEffect, useState } from "react";
import { liteCutClient } from "../api/liteCutClient.js";
import { mapAssetRow } from "../state/assetUtils.js";
import { relinkMissingAssetReferences } from "../state/relinkUtils.js";
import { useLiteCutEditorStore } from "../state/editorStore.js";
import { useLiteCutHistoryStore } from "../state/historyStore.js";

export function partitionLiteCutAssets(assets = []) {
  return {
    fontAssets: assets.filter((asset) => asset?.kind === "font"),
    audioAssets: assets.filter((asset) => asset?.kind === "audio"),
    assetPreviewVersions: Object.fromEntries(
      assets.map((asset) => [Number(asset.id), asset.preview_proxy_version || "source"]),
    ),
    assetProxyBusy: assets.some((asset) => ["queued", "running"].includes(asset.preview_proxy_status)),
  };
}

export function useLiteCutMediaController({
  body,
  migrateAlphaMovOverlaysToVideoTracks,
  outputHeight,
  outputWidth,
  projectId,
  updateOverlay,
}) {
  const [fontAssets, setFontAssets] = useState([]);
  const [audioAssets, setAudioAssets] = useState([]);
  const [mediaAssets, setMediaAssets] = useState([]);
  const [assetPreviewVersions, setAssetPreviewVersions] = useState({});
  const [assetProxyBusy, setAssetProxyBusy] = useState(false);

  const applyAssets = useCallback((assets) => {
    const allAssets = assets || [];
    const partition = partitionLiteCutAssets(allAssets);
    setMediaAssets(allAssets);
    setFontAssets(partition.fontAssets);
    setAudioAssets(partition.audioAssets);
    setAssetPreviewVersions(partition.assetPreviewVersions);
    setAssetProxyBusy(partition.assetProxyBusy);
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      const data = await liteCutClient.listAssets({ projectId, limit: 500 });
      applyAssets((data.items || []).map(mapAssetRow).filter(Boolean));
    } catch {
      applyAssets([]);
    }
  }, [applyAssets, projectId]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!assetProxyBusy) return undefined;
    const timer = window.setInterval(() => void loadAssets(), 1000);
    return () => window.clearInterval(timer);
  }, [assetProxyBusy, loadAssets]);

  const handleAssetsLoaded = useCallback((assets) => {
    const allAssets = assets || [];
    applyAssets(allAssets);
    migrateAlphaMovOverlaysToVideoTracks(allAssets);

    // Repair overlays created before image dimensions were persisted. Preserve
    // their visible width while deriving height from the source aspect ratio.
    const byId = new Map(allAssets.map((asset) => [Number(asset.id), asset]));
    for (const overlay of body?.overlays || []) {
      if (overlay?.meta?.kind !== "image" || (overlay.meta.source_width && overlay.meta.source_height)) continue;
      const asset = byId.get(Number(overlay.meta?.asset_id));
      const sourceWidth = Number(asset?.width) || 0;
      const sourceHeight = Number(asset?.height) || 0;
      if (sourceWidth <= 0 || sourceHeight <= 0) continue;
      const widthFraction = Math.max(0.01, Number(overlay.transform?.width) || 0.33);
      const correctedHeight = widthFraction * (outputWidth / outputHeight) * (sourceHeight / sourceWidth);
      updateOverlay(overlay.id, {
        transform: { ...(overlay.transform || {}), width: widthFraction, height: correctedHeight },
        meta: { ...(overlay.meta || {}), source_width: sourceWidth, source_height: sourceHeight },
      });
    }
  }, [applyAssets, body?.overlays, migrateAlphaMovOverlaysToVideoTracks, outputHeight, outputWidth, updateOverlay]);

  const handleRelinkMissingAsset = useCallback((warning, asset) => {
    const current = useLiteCutEditorStore.getState().body;
    const result = relinkMissingAssetReferences(current, warning, asset);
    if (!result.changed) return false;
    useLiteCutHistoryStore.getState().push(current);
    useLiteCutEditorStore.setState({ body: result.body, dirty: true });
    return true;
  }, []);

  return {
    fontAssets,
    audioAssets,
    mediaAssets,
    assetPreviewVersions,
    assetProxyBusy,
    loadAssets,
    handleAssetsLoaded,
    handleRelinkMissingAsset,
  };
}
