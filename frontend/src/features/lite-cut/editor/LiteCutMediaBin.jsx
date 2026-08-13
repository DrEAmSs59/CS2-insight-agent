import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileSearch, FileVideo2, Film, ImageIcon, Layers, Link2, Loader2, Music, RefreshCw, Search, Trash2, Type, Upload, X } from "lucide-react";
import { useRef } from "react";

import { desktopBridge } from "../../../desktop/desktopBridge.js";
import {
  getLiteCutAssetStreamUrl,
  getRecordedClipStreamUrl,
  liteCutClient,
} from "../api/liteCutClient.js";
import { canPlaceAssetOnTimeline, mapAssetRow } from "../state/assetUtils.js";
import { mapRecordedClipRow, reconcileRecordedClipDuration } from "../state/mediaUtils.js";
import { replacementMatchesWarning } from "../state/relinkUtils.js";
import { useT } from "../../../i18n/useT.js";

import DraggableMediaCard from "./DraggableMediaCard.jsx";
import DraggableMediaListRow from "./DraggableMediaListRow.jsx";
import VoiceoverRecorder from "./VoiceoverRecorder.jsx";

const LITE_CUT_ASSET_EXTENSIONS = [
  "webm", "png", "gif", "jpg", "jpeg", "webp", "mp4", "mov", "m4v", "mkv", "avi",
  "mp3", "wav", "m4a", "aac", "ogg", "flac", "woff", "woff2", "ttf", "otf",
];

function normalizeLinkedPaths(entries) {
  return Array.from(new Set(Array.from(entries || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function localPathFromDropValue(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#")) return "";
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(raw)) return raw;
  if (!raw.toLowerCase().startsWith("file://")) return "";
  try {
    const url = new URL(raw);
    const pathname = decodeURIComponent(url.pathname || "");
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    return pathname.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\");
  } catch {
    return "";
  }
}

/** Extract real local paths only; browser File objects are never uploaded as a fallback. */
export function extractDroppedAssetPaths(dataTransfer) {
  const candidates = [];
  for (const file of Array.from(dataTransfer?.files || [])) {
    if (typeof file?.path === "string") candidates.push(file.path);
  }
  for (const type of ["text/uri-list", "text/plain"]) {
    try {
      const raw = dataTransfer?.getData?.(type);
      if (raw) candidates.push(...String(raw).split(/\r?\n/).map(localPathFromDropValue));
    } catch {
      // Some WebViews reject reads for data types they do not expose.
    }
  }
  return normalizeLinkedPaths(candidates);
}

function formatDuration(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? `${n.toFixed(1)}s` : "--";
}

const PROBEABLE_GENERATED_TYPES = /^audio\//;

/** Browser-side duration probe; backend ffprobe may be unavailable in some installs. */
function probeGeneratedMediaDurationSec(file) {
  if (!PROBEABLE_GENERATED_TYPES.test(String(file?.type || ""))) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load?.();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => finish(null), 8000);
    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => finish(element.duration);
    element.onerror = () => finish(null);
    element.src = url;
  });
}

function assetKindLabel(t, kind) {
  return ["video", "webm", "image", "audio", "font"].includes(kind)
    ? t(`liteCut.media.kind.${kind}`)
    : t("liteCut.media.kind.file");
}

function assetKindIcon(kind) {
  if (kind === "video" || kind === "webm") return FileVideo2;
  if (kind === "audio") return Music;
  if (kind === "font") return Type;
  return ImageIcon;
}

function insightAssetToRecordedItem(asset) {
  const origin = asset?.origin_metadata || {};
  const recordingId = Number(asset?.origin_ref);
  const semantic = mapRecordedClipRow({
    ...origin,
    id: Number.isFinite(recordingId) && recordingId > 0 ? recordingId : Number(asset?.id),
    output_path: asset?.file_path,
    duration_sec: asset?.duration_sec,
    fps: asset?.fps,
  });
  if (!semantic) return null;
  return {
    ...semantic,
    ...asset,
    id: asset.id,
    mediaKind: "asset",
    recordingId: Number.isFinite(recordingId) && recordingId > 0 ? recordingId : null,
    title: semantic.title || asset.name,
    duration: Number(asset.duration_sec) || semantic.duration || 0,
    _raw: { ...origin, id: recordingId, output_path: asset.file_path },
  };
}

function RecordedClipListRow({ item, active, onAddToTimeline, onReplace, onDurationChange, onRelinkAsset }) {
  const t = useT();
  const categoryClasses = {
    highlight: "bg-emerald-500/20 text-emerald-300",
    fail: "bg-rose-500/20 text-rose-300",
    compilation: "bg-amber-500/20 text-amber-300",
    timeline: "bg-cs2-accent-soft text-cs2-accent",
    meme_death: "bg-cs2-bg-input text-cs2-text-secondary",
  };
  const cat = {
    cls: categoryClasses[item.category] || "bg-cs2-bg-input text-cs2-text-muted",
    label: Object.prototype.hasOwnProperty.call(categoryClasses, item.category)
      ? t(`liteCut.media.category.${item.category}`)
      : item.category,
  };
  const sourceMissing = item.source_status === "missing" || item.source_available === false;
  const isLinkedAsset = item.mediaKind === "asset";
  const thumbUrl = isLinkedAsset
    ? getLiteCutAssetStreamUrl(item.id, item.preview_proxy_version)
    : getRecordedClipStreamUrl(item.id);
  const metaLine = [item.map?.replace(/^de_/, ""), item.round != null ? `R${item.round}` : null, item.player]
    .filter(Boolean)
    .join(" 路 ");

  const thumb = sourceMissing ? (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/80 text-amber-200">
      <AlertTriangle className="h-5 w-5" />
      <span className="text-[8px] font-semibold">{t("liteCut.media.sourceMissing")}</span>
    </div>
  ) : (
    <video
      src={thumbUrl}
      className="h-full w-full object-cover"
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        const duration = Number(event.currentTarget?.duration);
        if (Number.isFinite(duration) && duration > 0.05 && Math.abs(duration - (Number(item.duration) || 0)) > 0.05) {
          if (!isLinkedAsset) onDurationChange?.(item.id, duration);
        }
      }}
    />
  );

  return (
    <DraggableMediaListRow
      mediaPayload={item}
      active={active}
      draggable={!sourceMissing}
      onAddToTimeline={sourceMissing ? undefined : () => onAddToTimeline?.(item)}
      dragPreview={thumb}
    >
      <div className="flex gap-2.5 p-2 pr-9">
        <div className="relative aspect-video w-[112px] shrink-0 overflow-hidden rounded-md bg-black ring-1 ring-cs2-border">
          {thumb}
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 py-px font-mono text-[8px] text-cs2-accent">
            {formatDuration(item.duration)}
          </span>
          <span className="absolute bottom-0.5 left-0.5 rounded bg-black/75 px-1 py-px font-mono text-[8px] text-white">
            {item.fps != null ? `${Math.round(Number(item.fps) * 100) / 100} FPS` : "FPS ?"}
          </span>
        </div>
        <div className="min-w-0 flex-1 py-0.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${cat.cls}`}>{cat.label}</span>
            {(item.tags || []).slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="max-w-[5rem] truncate rounded bg-white/5 px-1.5 py-0.5 text-[8px] font-medium text-cs2-text-muted"
                title={tag}
              >
                {tag}
              </span>
            ))}
          </div>
          <p className="mt-1 truncate text-[10px] font-semibold leading-snug text-cs2-text-primary">{item.title}</p>
          <p className="mt-0.5 truncate text-[10px] text-cs2-text-muted">{metaLine || "--"}</p>
          {item.ai ? (
            <p className="mt-0.5 line-clamp-1 text-[9px] leading-relaxed text-cs2-text-secondary/80">{item.ai}</p>
          ) : null}
          {sourceMissing ? <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRelinkAsset?.(item); }} className="mt-1.5 inline-flex items-center gap-1 rounded border border-amber-300/40 px-2 py-1 text-[9px] font-semibold text-amber-200 hover:bg-amber-300 hover:text-black"><Link2 className="h-3 w-3" />{t("liteCut.media.relink")}</button> : null}
        </div>
      </div>
      {onReplace && !sourceMissing ? (
        <button
          type="button"
          title={t("liteCut.media.replaceSelected")}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReplace(item); }}
          className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md bg-cs2-bg-card/90 text-cs2-accent ring-1 ring-cs2-border hover:bg-cs2-accent hover:text-cs2-text-on-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </DraggableMediaListRow>
  );
}

export function LocalAssetCard({
  item,
  onAddToTimeline,
  onUseFontAsset,
  onDeleteAsset,
  onReplace,
  onRelinkAsset,
  deleting = false,
  inUse = false,
}) {
  const t = useT();
  const isVideo = item.kind === "video" || item.kind === "webm";
  const isAudio = item.kind === "audio";
  const isFont = item.kind === "font";
  const Icon = assetKindIcon(item.kind);
  const sourceMissing = item.source_status === "missing" || item.source_available === false;
  const canPlace = canPlaceAssetOnTimeline(item);
  const streamUrl = getLiteCutAssetStreamUrl(item.id, item.preview_proxy_version);

  return (
    <DraggableMediaCard
      name={item.name}
      aspectClass={isVideo ? "aspect-video" : "aspect-square"}
      mediaPayload={item}
      draggable={!isFont && canPlace}
      actionTitle={isFont ? t("liteCut.media.useFont") : t("liteCut.media.addToTimeline")}
      onAddToTimeline={canPlace ? () => (isFont ? onUseFontAsset?.(item) : onAddToTimeline?.(item)) : undefined}
      preview={
        <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 via-neutral-900 to-black">
          {isVideo && !sourceMissing ? (
            <video src={streamUrl} className="h-full w-full object-cover opacity-90" muted playsInline preload="metadata" />
          ) : isVideo ? (
            <FileVideo2 className="h-8 w-8 text-cs2-text-muted" />
          ) : isAudio ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-cs2-bg-elevated via-cs2-bg-card to-cs2-bg-page text-cs2-accent">
              <Music className="h-7 w-7" />
              <div className="flex h-8 w-4/5 items-end gap-px">
                {Array.from({ length: 28 }, (_, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-sm bg-cs2-accent/70"
                    style={{ height: `${22 + Math.abs(Math.sin(i * 0.7)) * 66}%` }}
                  />
                ))}
              </div>
            </div>
          ) : item.kind === "font" ? (
            <div className="flex flex-col items-center gap-1 text-zinc-400">
              <Type className="h-5 w-5" />
              <span className="text-[10px] font-bold">字体</span>
            </div>
          ) : (
            <img src={streamUrl} alt="" className="h-full w-full object-contain" />
          )}
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[8px] font-bold text-white">
            <Icon className="h-2.5 w-2.5" />
            {assetKindLabel(t, item.kind)}
          </span>
          {Number(item.duration_sec) > 0 ? (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[8px] text-cs2-accent">
              {formatDuration(item.duration_sec)}
            </span>
          ) : null}
          {isVideo ? (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[8px] text-white">
              {item.fps != null ? `${Math.round(Number(item.fps) * 100) / 100} FPS` : "FPS ?"}
            </span>
          ) : null}
          {sourceMissing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/80 px-2 text-center text-[9px] font-semibold text-amber-200">
              <AlertTriangle className="h-5 w-5" />
              <span>{t("liteCut.media.sourceMissing")}</span>
              <button
                type="button"
                onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRelinkAsset?.(item); }}
                className="rounded-md border border-amber-300/50 bg-cs2-bg-card px-2 py-1 text-amber-200 hover:bg-amber-300 hover:text-black"
              >
                {t("liteCut.media.relink")}
              </button>
            </div>
          ) : null}
          {onReplace && canPlace ? (
            <button
              type="button"
              title={t("liteCut.media.replaceSelected")}
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReplace(item); }}
              className="absolute left-1.5 top-8 inline-flex h-6 w-6 items-center justify-center rounded-md bg-cs2-bg-card/90 text-cs2-accent ring-1 ring-cs2-border hover:bg-cs2-accent hover:text-cs2-text-on-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            title={inUse ? t("liteCut.media.assetInUse") : t("liteCut.media.deleteAsset")}
            disabled={deleting || inUse}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!inUse) onDeleteAsset?.(item);
            }}
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/75 text-zinc-300 opacity-0 ring-1 ring-white/10 transition-opacity hover:bg-rose-500/90 hover:text-white disabled:cursor-not-allowed disabled:text-amber-300 disabled:opacity-60 group-hover:opacity-100"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      }
    />
  );
}

export default function LiteCutMediaBin({
  projectId,
  selectedMediaId,
  onItemsLoaded,
  onAssetsLoaded,
  onUseFontAsset,
  onAddToTimeline,
  onReplaceSelectedClip,
  onRecordedDurationChange,
  selectedTrackType,
  usedAssetIds,
  projectBody,
  onRelinkMissingAsset,
}) {
  const t = useT();
  const [tab, setTab] = useState("recorded");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [localAssets, setLocalAssets] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkDragOver, setLinkDragOver] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [assetWarnings, setAssetWarnings] = useState([]);
  const [assetWarningsLoading, setAssetWarningsLoading] = useState(false);
  const uploadAbortRef = useRef(null);
  const linkDropZoneRef = useRef(null);
  const durationPatchRef = useRef(new Set());

  const handleRecordedDurationChange = useCallback((clipId, durationSec) => {
    const duration = Number(durationSec);
    if (!Number.isFinite(duration) || duration <= 0.05) return;
    setItems((current) => reconcileRecordedClipDuration(current, clipId, duration));
    onRecordedDurationChange?.(clipId, duration);
    const patchKey = `${Number(clipId)}:${duration.toFixed(3)}`;
    if (durationPatchRef.current.has(patchKey)) return;
    durationPatchRef.current.add(patchKey);
    void liteCutClient.patchRecordedClipDuration(Number(clipId), duration)
      .catch(() => {})
      .finally(() => durationPatchRef.current.delete(patchKey));
  }, [onRecordedDurationChange]);

  const assetReferenceSignature = useMemo(() => JSON.stringify({
    tracks: (projectBody?.tracks || []).map((track) => ({
      id: track?.id,
      type: track?.type,
      hidden: track?.hidden,
      muted: track?.muted,
      solo: track?.solo,
      clips: (track?.clips || []).map((clip) => ({
        source_type: clip?.source_type,
        source_id: clip?.source_id,
        file_path: clip?.file_path,
      })),
    })),
    overlays: (projectBody?.overlays || []).map((overlay) => ({
      type: overlay?.type,
      asset_path: overlay?.asset_path,
      font_file: overlay?.text?.font_file,
    })),
    bgm_path: projectBody?.audio?.bgm?.path,
  }), [projectBody]);

  const loadAssetWarnings = useCallback(async () => {
    if (!projectBody) {
      setAssetWarnings([]);
      return;
    }
    setAssetWarningsLoading(true);
    try {
      const data = await liteCutClient.validateAssets(projectBody);
      setAssetWarnings(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setAssetWarnings([]);
    } finally {
      setAssetWarningsLoading(false);
    }
  }, [assetReferenceSignature]);

  const loadAssets = useCallback(async () => {
    try {
      const data = await liteCutClient.listAssets({ projectId, limit: 500 });
      const mapped = (data.items || []).map(mapAssetRow).filter(Boolean);
      setLocalAssets(mapped);
      onAssetsLoaded?.(mapped);
    } catch {
      setLocalAssets([]);
      onAssetsLoaded?.([]);
    }
  }, [projectId, onAssetsLoaded]);

  const loadClips = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await liteCutClient.listRecordedClips({ limit: 500, offset: 0 });
      const mapped = (data.items || []).map(mapRecordedClipRow).filter(Boolean);
      setItems(mapped);
      onItemsLoaded?.(mapped);
    } catch {
      setItems([]);
      setLoadError("load_failed");
    } finally {
      setLoading(false);
    }
  }, [onItemsLoaded]);

  // Keep the two sources isolated.  Transforming a canvas item updates the
  // editor body, which can legitimately recreate the local-asset callback;
  // that must never put the recorded-material list back into its loading
  // state while the user is dragging an item in the preview.
  useEffect(() => {
    if (tab === "recorded") void loadClips();
  }, [tab, loadClips]);

  useEffect(() => { void loadAssets(); }, [loadAssets]);

  useEffect(() => {
    void loadAssetWarnings();
  }, [loadAssetWarnings]);

  const saveGeneratedAssets = async (files) => {
    const queue = Array.from(files || []).filter(Boolean);
    if (!queue.length) return;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploading(true);
    setUploadError(null);
    setUploadProgress({ current: 0, total: queue.length, percent: 0, name: queue[0]?.name || "" });
    try {
      for (const [index, file] of queue.entries()) {
        setUploadProgress({ current: index, total: queue.length, percent: 0, name: file.name || "" });
        const probedDuration = await probeGeneratedMediaDurationSec(file);
        await liteCutClient.uploadGeneratedAsset({
          file,
          projectId: projectId || null,
          clientDurationSec: probedDuration != null ? probedDuration.toFixed(3) : null,
          signal: controller.signal,
          onUploadProgress: (event) => {
            const total = Number(event.total) || 0;
            const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((Number(event.loaded) || 0) / total * 100))) : 0;
            setUploadProgress({ current: index, total: queue.length, percent, name: file.name || "" });
          },
        });
      }
      await loadAssets();
      setTab("local");
    } catch (error) {
      if (error?.code !== "ERR_CANCELED") setUploadError(t("liteCut.media.uploadFailed"));
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    }
  };

  const cancelUpload = () => uploadAbortRef.current?.abort();

  const registerLinkedAssets = useCallback(async (entries) => {
    const paths = normalizeLinkedPaths(entries);
    if (!paths.length) return;
    setLinking(true);
    setUploadError(null);
    try {
      await liteCutClient.linkAssets({ paths, projectId: projectId || null });
      await loadAssets();
      setTab("local");
    } catch {
      setUploadError(t("liteCut.media.linkFailed"));
    } finally {
      setLinking(false);
    }
  }, [loadAssets, projectId, t]);

  const pickLocalAssetPaths = useCallback(async (multiple = true) => {
    if (desktopBridge?.showOpenDialog) {
      const result = await desktopBridge.showOpenDialog({
        title: t("liteCut.media.chooseFiles"),
        filters: [{ name: t("liteCut.media.linkTitle"), extensions: LITE_CUT_ASSET_EXTENSIONS }],
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      });
      return result?.filePaths || [];
    }
    const result = await liteCutClient.pickFiles({ fileType: "lite_cut_asset", multiple });
    return result?.paths || (result?.path ? [result.path] : []);
  }, [t]);

  const chooseAndLinkAssets = useCallback(async () => {
    if (picking || linking) return;
    setPicking(true);
    setUploadError(null);
    let paths = [];
    try {
      paths = await pickLocalAssetPaths(true);
    } catch {
      setUploadError(t("liteCut.media.pickerFailed"));
    } finally {
      setPicking(false);
    }
    if (paths.length) await registerLinkedAssets(paths);
  }, [linking, pickLocalAssetPaths, picking, registerLinkedAssets, t]);

  const handleBrowserAssetDrop = useCallback((event) => {
    event.preventDefault();
    setLinkDragOver(false);
    if (picking || linking) return;
    const paths = extractDroppedAssetPaths(event.dataTransfer);
    if (paths.length) {
      void registerLinkedAssets(paths);
      return;
    }
    if (event.dataTransfer?.files?.length && desktopBridge?.resolveDroppedFilePaths) {
      setUploadError(null);
      void desktopBridge.resolveDroppedFilePaths(event.dataTransfer.files)
        .then((resolvedPaths) => {
          if (resolvedPaths.length) return registerLinkedAssets(resolvedPaths);
          setUploadError(t("liteCut.media.dropPathUnavailable"));
          return undefined;
        })
        .catch(() => setUploadError(t("liteCut.media.dropPathUnavailable")));
      return;
    }
    if (event.dataTransfer?.files?.length || event.dataTransfer?.types?.includes?.("Files")) {
      setUploadError(t("liteCut.media.dropPathUnavailable"));
    }
  }, [linking, picking, registerLinkedAssets, t]);

  useEffect(() => {
    if (tab !== "local" || !desktopBridge?.onFileDragDrop) return undefined;
    return desktopBridge.onFileDragDrop((payload) => {
      if (payload?.type === "leave") {
        setLinkDragOver(false);
        return;
      }
      const zone = linkDropZoneRef.current;
      const position = payload?.position;
      if (!zone || !position) return;
      const rect = zone.getBoundingClientRect();
      const inside = position.x >= rect.left && position.x <= rect.right
        && position.y >= rect.top && position.y <= rect.bottom;
      if (payload.type === "enter" || payload.type === "over") {
        setLinkDragOver(inside && !picking && !linking);
        return;
      }
      if (payload.type === "drop") {
        setLinkDragOver(false);
        if (inside && !picking && !linking) void registerLinkedAssets(payload.paths);
      }
    });
  }, [linking, picking, registerLinkedAssets, tab]);

  const relinkMissingAssetPath = async (warning, replacementPath, existingAsset = null) => {
    if (!replacementPath || !warning || !projectId) return;
    setAssetWarningsLoading(true);
    setUploadError(null);
    try {
      const data = existingAsset
        ? await liteCutClient.relinkAsset(existingAsset.id, replacementPath)
        : (await liteCutClient.linkAssets({ paths: [replacementPath], projectId })).items?.[0];
      const asset = mapAssetRow(data);
      if (!replacementMatchesWarning(warning, asset)) {
        if (!existingAsset) await liteCutClient.deleteAsset(Number(asset.id)).catch(() => {});
        throw new Error("incompatible_replacement");
      }
      const changed = await onRelinkMissingAsset?.(warning, asset);
      if (changed === false && !existingAsset) throw new Error("reference_not_found");
      await loadAssets();
      await loadAssetWarnings();
      setTab("local");
    } catch (error) {
      const code = error?.response?.data?.detail?.code;
      setUploadError(code === "LITECUT_ASSET_IDENTITY_MISMATCH"
        ? t("liteCut.media.relinkIdentityMismatch")
        : error?.message === "incompatible_replacement" || code === "LITECUT_ASSET_TYPE_MISMATCH"
          ? t("liteCut.media.relinkTypeMismatch")
          : t("liteCut.media.relinkFailed"));
    } finally {
      setAssetWarningsLoading(false);
    }
  };

  const pickReplacementForWarning = async (warning, existingAsset = null) => {
    if (picking || linking || assetWarningsLoading) return;
    setPicking(true);
    setUploadError(null);
    let replacementPath = "";
    try {
      replacementPath = (await pickLocalAssetPaths(false))[0] || "";
    } catch {
      setUploadError(t("liteCut.media.pickerFailed"));
    } finally {
      setPicking(false);
    }
    if (replacementPath) await relinkMissingAssetPath(warning, replacementPath, existingAsset);
  };

  const chooseReplacement = async (warning) => {
    const normalizedWarningPath = String(warning?.path || "").replace(/\\/g, "/").toLowerCase();
    const existing = localAssets.find((asset) => (
      String(asset?.path || "").replace(/\\/g, "/").toLowerCase() === normalizedWarningPath
    ));
    await pickReplacementForWarning(warning, existing || null);
  };

  const relinkAssetSource = (asset) => {
    void pickReplacementForWarning({
      kind: asset?.kind || "file",
      name: asset?.name,
      path: asset?.path,
    }, asset);
  };

  const deleteAsset = async (asset) => {
    const id = Number(asset?.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (usedAssetIds?.has?.(id)) return;
    if (typeof window !== "undefined" && !window.confirm(t("liteCut.media.deleteAssetConfirm", { name: asset.name || id }))) return;
    setDeletingAssetId(id);
    try {
      await liteCutClient.deleteAsset(id);
      await loadAssets();
    } finally {
      setDeletingAssetId(null);
    }
  };

  const query = q.trim().toLowerCase();

  const recordedLibraryItems = useMemo(() => {
    const insightAssets = localAssets
      .filter((asset) => asset?.origin_type === "insight_recording")
      .map(insightAssetToRecordedItem)
      .filter(Boolean);
    const linkedRecordingIds = new Set(
      insightAssets.map((asset) => Number(asset.recordingId)).filter(Number.isFinite),
    );
    return [...insightAssets, ...items.filter((item) => !linkedRecordingIds.has(Number(item.id)))];
  }, [items, localAssets]);

  const filteredRecorded = useMemo(
    () =>
      recordedLibraryItems.filter((m) => {
        if (filter !== "all" && m.category !== filter) return false;
        if (!query) return true;
        const tagHay = (m.tags || []).join(" ").toLowerCase();
        return (
          m.title.toLowerCase().includes(query) ||
          m.player.toLowerCase().includes(query) ||
          m.map.toLowerCase().includes(query) ||
          tagHay.includes(query)
        );
      }),
    [recordedLibraryItems, filter, query],
  );

  const filteredAssets = useMemo(
    () =>
      localAssets.filter((a) => {
        if (a?.origin_type === "insight_recording") return false;
        if (filter !== "all" && a.kind !== filter) return false;
        if (!query) return true;
        return `${a.name || ""} ${a.kind || ""}`.toLowerCase().includes(query);
      }),
    [localAssets, filter, query],
  );

  const activeFilters = tab === "recorded"
    ? ["all", "highlight", "fail", "compilation", "timeline"].map((id) => ({ id, label: t(`liteCut.media.category.${id}`) }))
    : ["all", "video", "image", "webm", "audio", "font"].map((id) => ({ id, label: t(`liteCut.media.kind.${id}`) }));
  const replaceRecorded = selectedTrackType === "video" ? onReplaceSelectedClip : null;
  const canReplaceAsset = (asset) =>
    (selectedTrackType === "audio" && asset?.kind === "audio") || (selectedTrackType === "video" && asset?.kind === "video");

  return (
    <aside className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-sidebar">
      <div className="shrink-0 border-b border-cs2-border bg-cs2-bg-card p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-bold text-cs2-text-primary">素材库</p>
            <p className="mt-0.5 text-[9px] text-cs2-text-muted">拖拽素材到预览区或时间轴</p>
          </div>
          <span className="rounded-full border border-cs2-border bg-cs2-bg-input px-2 py-0.5 font-mono text-[9px] text-cs2-text-muted">{tab === "recorded" ? filteredRecorded.length : filteredAssets.length}</span>
        </div>
        <div className="flex gap-1 rounded-lg border border-cs2-border bg-cs2-bg-input p-1">
          <button
            type="button"
            onClick={() => {
              setTab("recorded");
              setFilter("all");
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1.5 text-[10px] font-bold transition-colors ${
              tab === "recorded" ? "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent" : "border-transparent text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-secondary"
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            {t("liteCut.media.insightRecording")}
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("local");
              setFilter("all");
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1.5 text-[10px] font-bold transition-colors ${
              tab === "local" ? "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent" : "border-transparent text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-secondary"
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            {t("liteCut.media.localUpload")}
          </button>
        </div>

        <div className="relative mt-2.5">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === "recorded" ? t("liteCut.media.searchRecorded") : t("liteCut.media.searchLocal")}
            className="h-8 w-full rounded-lg border border-cs2-border bg-cs2-bg-sidebar py-1.5 pl-8 pr-3 text-[11px] outline-none transition-colors focus:border-cs2-accent"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {activeFilters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-md border px-2 py-1 text-[9px] font-semibold transition-colors ${
                filter === f.id
                  ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border-subtle bg-cs2-bg-sidebar text-cs2-text-muted hover:border-cs2-border-focus hover:text-cs2-text-secondary"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {assetWarnings.length ? (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("liteCut.media.unavailableAssets", { count: assetWarnings.length })}</span>
              <button
                type="button"
                title={t("liteCut.media.recheckAssets")}
                onClick={() => void loadAssetWarnings()}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-amber-200 hover:bg-amber-500/15"
              >
                <RefreshCw className={`h-3 w-3 ${assetWarningsLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto pr-0.5">
              {assetWarnings.map((warning, index) => (
                <div key={`${warning.kind}:${warning.path || warning.source_id || index}`} className="flex min-w-0 items-center gap-1.5 rounded border border-amber-400/15 bg-black/15 px-1.5 py-1">
                  <p className="min-w-0 flex-1 truncate font-mono text-[9px] text-amber-100/80" title={warning.path || warning.name}>
                    {warning.name || t("liteCut.media.missingAssetPath")}
                  </p>
                  <button
                    type="button"
                    disabled={assetWarningsLoading}
                    onClick={() => void chooseReplacement(warning)}
                    className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-amber-400/25 px-1.5 text-[8px] font-semibold text-amber-100 hover:bg-amber-400/15 disabled:opacity-40"
                  >
                    {assetWarningsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSearch className="h-3 w-3" />}
                    {t("liteCut.media.relink")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === "local" ? (
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">
            {t("liteCut.media.dragHint")}
          </p>
        ) : null}
      </div>

      {tab === "local" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-2">
            <button
              ref={linkDropZoneRef}
              data-lite-cut-link-dropzone
              type="button"
              disabled={picking || linking}
              onClick={() => void chooseAndLinkAssets()}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!picking && !linking) setLinkDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "link";
                if (!picking && !linking) setLinkDragOver(true);
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                setLinkDragOver(false);
              }}
              onDrop={handleBrowserAssetDrop}
              className={`flex min-h-28 w-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-3 py-4 text-center transition-colors disabled:cursor-wait ${
                linkDragOver
                  ? "border-cs2-accent bg-cs2-accent/10"
                  : "border-cs2-border bg-cs2-bg-card hover:border-cs2-accent/50 hover:bg-cs2-bg-hover"
              }`}
            >
              <span className={`mb-2 inline-flex h-9 w-9 items-center justify-center rounded-lg ${linkDragOver ? "bg-cs2-accent/20" : "bg-cs2-bg-input"}`}>
                {picking || linking
                  ? <Loader2 className="h-5 w-5 animate-spin text-cs2-accent" />
                  : linkDragOver
                    ? <Link2 className="h-5 w-5 text-cs2-accent" />
                    : <Upload className="h-5 w-5 text-cs2-text-secondary" />}
              </span>
              <span className={`text-[11px] font-bold ${linkDragOver ? "text-cs2-accent" : "text-cs2-text-primary"}`}>
                {linkDragOver
                  ? t("liteCut.media.dropRelease")
                  : picking
                    ? t("liteCut.media.choosingFiles")
                    : linking
                      ? t("liteCut.media.linking")
                      : t("liteCut.media.selectOrDrop")}
              </span>
              <span className="mt-1 text-[9px] text-cs2-text-muted">{t("liteCut.media.linkNoCopyHint")}</span>
            </button>
            <VoiceoverRecorder disabled={uploading} onRecorded={(file) => saveGeneratedAssets([file])} />
            {uploading ? (
              <div className="px-1 py-1.5 text-[10px] text-cs2-text-muted">
                <div className="flex min-w-0 items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span className="min-w-0 flex-1 truncate">{uploadProgress?.name || t("liteCut.media.uploading")}</span>
                  <span className="shrink-0 font-mono text-cs2-text-secondary">{uploadProgress?.total ? `${uploadProgress.current + 1}/${uploadProgress.total}` : ""}</span>
                  <button
                    type="button"
                    title={t("liteCut.media.cancelUpload")}
                    onClick={cancelUpload}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-cs2-text-muted hover:bg-rose-500/20 hover:text-rose-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/8">
                  <div className="h-full bg-cs2-accent transition-[width]" style={{ width: `${uploadProgress?.percent ?? 0}%` }} />
                </div>
              </div>
            ) : null}
            {uploadError ? <p className="px-1 text-[10px] text-rose-300">{uploadError}</p> : null}
            {filteredAssets.length === 0 && !uploading ? (
              <p className="py-6 text-center text-xs text-cs2-text-muted">{t("liteCut.media.noLocalAssets")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2.5">
                {filteredAssets.map((a) => (
                  <li key={a.id}>
                    <LocalAssetCard
                      item={a}
                      onAddToTimeline={onAddToTimeline}
                      onUseFontAsset={onUseFontAsset}
                      onDeleteAsset={(asset) => void deleteAsset(asset)}
                      onRelinkAsset={relinkAssetSource}
                      onReplace={canReplaceAsset(a) ? onReplaceSelectedClip : null}
                      deleting={Number(deletingAssetId) === Number(a.id)}
                      inUse={usedAssetIds?.has?.(Number(a.id))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-cs2-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("liteCut.media.loadingRecordings")}
            </div>
          ) : loadError ? (
            <p className="py-6 text-center text-xs text-rose-400">{t("liteCut.media.loadRecordingsFailed")}</p>
          ) : filteredRecorded.length === 0 ? (
            <p className="py-6 text-center text-xs text-cs2-text-muted">{t("liteCut.media.noRecordedClips")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filteredRecorded.map((m) => (
                <li key={`${m.mediaKind}-${m.id}`}>
                  <RecordedClipListRow
                    item={m}
                    active={selectedMediaId === m.id}
                    onAddToTimeline={onAddToTimeline}
                    onReplace={replaceRecorded}
                    onDurationChange={handleRecordedDurationChange}
                    onRelinkAsset={m.mediaKind === "asset" ? relinkAssetSource : null}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
