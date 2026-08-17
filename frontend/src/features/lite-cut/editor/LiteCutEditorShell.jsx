import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import LiteCutToolbar from "./LiteCutToolbar.jsx";
import LiteCutMediaBin from "./LiteCutMediaBin.jsx";
import LiteCutPreviewPanel from "./LiteCutPreviewPanel.jsx";
import LiteCutPropertyPanel, { ExportPane } from "./LiteCutPropertyPanel.jsx";
import LiteCutTimelinePanel from "./LiteCutTimelinePanel.jsx";
import LiteCutResizableLayout from "./LiteCutResizableLayout.jsx";
import LiteCutExportSettingsDialog from "./LiteCutExportSettingsDialog.jsx";
import LiteCutPresetsDrawer from "./LiteCutPresetsDrawer.jsx";
import LiteCutProjectStartPage from "./LiteCutProjectStartPage.jsx";
import LiteCutExportProgressDialog from "./LiteCutExportProgressDialog.jsx";
import FfmpegRequiredDialog from "../../../components/FfmpegRequiredDialog.jsx";
import { filterStyleFromColor, TEXT_STYLE_CARDS } from "./editorPresets.js";
import { boundaryTransitionPreviewVisual, transitionNodePreviewVisual } from "./transitionPreviewUtils.js";
import { shouldPrewarmNextClip } from "./previewFrameUtils.js";
import { LITECUT_PROJECT_TEMPLATES } from "./projectTemplates.js";
import { inspectorTabForTimelineSelection } from "./inspectorSelectionUtils.js";
import {
  getLiteCutAssetStreamUrl,
} from "../api/liteCutClient.js";
import { useLiteCutEditorStore } from "../state/editorStore.js";
import { collectUsedLiteCutAssetIds } from "../state/assetUtils.js";
import { liteCutAudioPreviewUrl, liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";
import { shouldUseSegmentedPreview, useSegmentedPreviewSource } from "./useSegmentedPreviewSource.js";
import { mapRecordedClipRow } from "../state/mediaUtils.js";
import { sceneResolvedContentFit, sceneTransformAt, VIDEO_SCENE_TRANSFORM_DEFAULTS } from "../state/sceneTransform.js";
import { audioKeyframeNearPlayhead, clipVolumeAt } from "../state/audioKeyframeUtils.js";
import {
  defaultLiteCutFilename,
  liteCutRangePatchFromPlayhead,
  normalizeLiteCutExportRange,
  resolveLiteCutOutputDir,
} from "../state/exportUtils.js";
import {
  nextTopVideoPlaybackAfter,
  hasSoloAudioTracks,
  selectedClipPreviewSourceTime,
  resolveTopVideoPlaybackAt,
} from "../state/playbackUtils.js";
import { useLiteCutHistoryStore } from "../state/historyStore.js";
import { buildPreviewScene } from "../state/previewScene.js";
import {
  isEditableShortcutTarget,
  resolveLiteCutShortcut,
} from "../state/keyboardShortcuts.js";
import {
  colorGradeFromBody,
  colorGradeFromClip,
  packagingBundleFromBody,
  transitionRhythmFromBody,
} from "../state/presetUtils.js";
import { useLiteCutTimelineStore } from "../state/timelineStore.js";
import {
  LITE_CUT_CANVAS_FIT_VALUES,
  LITE_CUT_OUTPUT_DEFAULTS,
  LITE_CUT_OUTPUT_LIMITS,
} from "../state/projectContract.js";
import {
  AUDIO_MASTER_GAIN,
  AUDIO_TRACK_GAIN,
  clampAudioGain,
} from "../domain/audioContract.js";
import {
  clipTransitionRef,
  overlayTransitionRef,
  TRANSITION_DURATION_DEFAULT,
  transitionEventForNodeEdge,
} from "../state/transitionModel.js";
import {
  findClipById,
  getTrack,
  isAssetMediaItem,
  mainVideoClips,
  projectFrameStepSec,
  resolveAudioEditingTarget,
  selectedTimelineRange,
  timelineTotalSec,
} from "../state/timelineUtils.js";
import {
  clipCanvasFit,
  clipFreezeFrameSec,
  clipPlaybackSpeed,
  clipPreservePitch,
  clipReversePlayback,
  clipSourceDuration,
  clipSpeedAtTimeline,
  clipTimelineEnd,
  clipTimelineTimeForSource,
  clipTrimmedSourceDuration,
} from "../domain/timelineMath.js";
import { visualMaterialCapabilities } from "../domain/visualMaterial.js";
import { stripMp4Extension } from "../../../utils/montageUtils.js";
import { useT } from "../../../i18n/useT.js";
import { useLiteCutFfmpegGateController } from "../controllers/useLiteCutFfmpegGateController.js";
import { useLiteCutExportController } from "../controllers/useLiteCutExportController.js";
import { useLiteCutMediaController } from "../controllers/useLiteCutMediaController.js";
import {
  useLiteCutProjectController,
  useLiteCutProjectSessionController,
} from "../controllers/useLiteCutProjectController.js";

function collectLiteCutFrameMeldSourceItems(body, mediaCache, mediaAssets) {
  const assetsById = new Map((mediaAssets || []).map((asset) => [String(asset?.id), asset]));
  const items = [];
  const addClip = (clip) => {
    const meta = clip?.meta && typeof clip.meta === "object" ? clip.meta : {};
    const kind = String(meta.kind || clip?.type || "").toLowerCase();
    const isVideo = clip?.source_type === "recorded_clip" || kind === "video" || kind === "webm";
    if (!isVideo) return;
    const recorded = clip?.source_id != null ? mediaCache?.[clip.source_id] : null;
    const asset = meta.asset_id != null ? assetsById.get(String(meta.asset_id)) : null;
    const fps = Number(
      meta.fps
        ?? meta.source_fps
        ?? recorded?.fps
        ?? recorded?._raw?.fps
        ?? asset?.fps,
    );
    items.push({ fps: Number.isFinite(fps) && fps > 0 ? fps : null });
  };
  for (const track of body?.tracks || []) {
    if (track?.type !== "video") continue;
    for (const clip of track?.clips || []) addClip(clip);
  }
  for (const overlay of body?.overlays || []) addClip(overlay);
  return items;
}

function clipToMedia(clip, mediaCache) {
  if (!clip) return null;
  if (clip.source_type === "file") {
    const meta = clip.meta || {};
    return {
      id: meta.asset_id ?? clip.id,
      title: meta.name || "Uploaded video",
      name: meta.name || "Uploaded video",
      mediaKind: "asset",
      kind: meta.kind || "video",
      path: clip.file_path,
      file_path: clip.file_path,
      duration_sec: meta.duration_sec,
      width: meta.source_width,
      height: meta.source_height,
      fps: meta.source_fps,
      codec_name: meta.codec_name,
    };
  }
  const cached = clip.source_id != null ? mediaCache[clip.source_id] : null;
  if (cached) return cached;
  if (clip.meta) return mapRecordedClipRow({
    ...clip.meta,
    id: clip.source_id,
    duration_sec: Number(clip.meta.duration_sec) > 0 ? clip.meta.duration_sec : clip.trim_out,
  });
  return null;
}

export default function LiteCutEditorShell({
  projectName: projectNameProp,
  defaultInspectorTab = "clip",
  defaultExportOpen = false,
  onExportPhaseChange,
}) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    projectId,
    projectName,
    dirty,
    saving,
    loading,
    body,
    mediaCache,
    projectList,
    projectListLoading,
    recoveryCandidate,
    error,
    loadOrCreateProject,
    listProjects,
    openProject,
    createNewProject,
    duplicateProject,
    deleteProject,
    deleteProjects,
    saveProject,
    setProjectName,
    setMediaCache,
    patchOutput,
    patchAudio,
    persistRecoveryDraft,
    restoreRecoveryDraft,
    discardRecoveryDraft,
  } = useLiteCutEditorStore();

  const playheadSec = useLiteCutTimelineStore((s) => s.playheadSec);
  const lastUserSeekAt = useLiteCutTimelineStore((s) => s.lastUserSeekAt);
  const setPlayhead = useLiteCutTimelineStore((s) => s.setPlayhead);
  const seekPlayhead = useLiteCutTimelineStore((s) => s.seekPlayhead);
  const isPlaying = useLiteCutTimelineStore((s) => s.isPlaying);
  const setPlaying = useLiteCutTimelineStore((s) => s.setPlaying);
  const togglePlay = useLiteCutTimelineStore((s) => s.togglePlay);
  const timelineZoom = useLiteCutTimelineStore((s) => s.timelineZoom);
  const setTimelineZoom = useLiteCutTimelineStore((s) => s.setTimelineZoom);
  const requestTimelineFocus = useLiteCutTimelineStore((s) => s.requestTimelineFocus);
  const selectedClipId = useLiteCutTimelineStore((s) => s.selectedClipId);
  const selectedClipIds = useLiteCutTimelineStore((s) => s.selectedClipIds);
  const selectedTransitionId = useLiteCutTimelineStore((s) => s.selectedTransitionId);
  const selectedTrackId = useLiteCutTimelineStore((s) => s.selectedTrackId);
  const selectClip = useLiteCutTimelineStore((s) => s.selectClip);
  const selectAllTimelineItems = useLiteCutTimelineStore((s) => s.selectAllTimelineItems);
  const selectTimelineItemsFromPlayhead = useLiteCutTimelineStore((s) => s.selectTimelineItemsFromPlayhead);
  const addMediaToTrack = useLiteCutTimelineStore((s) => s.addMediaToTrack);
  const addMediaAtTime = useLiteCutTimelineStore((s) => s.addMediaAtTime);
  const addOverlayFromAsset = useLiteCutTimelineStore((s) => s.addOverlayFromAsset);
  const migrateAlphaMovOverlaysToVideoTracks = useLiteCutTimelineStore((s) => s.migrateAlphaMovOverlaysToVideoTracks);
  const addTextOverlay = useLiteCutTimelineStore((s) => s.addTextOverlay);
  const addSubtitleOverlays = useLiteCutTimelineStore((s) => s.addSubtitleOverlays);
  const beginOverlayDrag = useLiteCutTimelineStore((s) => s.beginOverlayDrag);
  const updateOverlay = useLiteCutTimelineStore((s) => s.updateOverlay);
  const updateOverlayTransformAtTime = useLiteCutTimelineStore((s) => s.updateOverlayTransformAtTime);
  const upsertOverlayKeyframe = useLiteCutTimelineStore((s) => s.upsertOverlayKeyframe);
  const removeOverlayKeyframe = useLiteCutTimelineStore((s) => s.removeOverlayKeyframe);
  const updateClipTransformAtTime = useLiteCutTimelineStore((s) => s.updateClipTransformAtTime);
  const upsertClipKeyframe = useLiteCutTimelineStore((s) => s.upsertClipKeyframe);
  const removeClipKeyframe = useLiteCutTimelineStore((s) => s.removeClipKeyframe);
  const upsertClipAudioKeyframe = useLiteCutTimelineStore((s) => s.upsertClipAudioKeyframe);
  const removeClipAudioKeyframe = useLiteCutTimelineStore((s) => s.removeClipAudioKeyframe);
  const updateClipVolumeAtTime = useLiteCutTimelineStore((s) => s.updateClipVolumeAtTime);
  const applyOverlayMotionPreset = useLiteCutTimelineStore((s) => s.applyOverlayMotionPreset);
  const applyClipMotionPreset = useLiteCutTimelineStore((s) => s.applyClipMotionPreset);
  const updateOverlayText = useLiteCutTimelineStore((s) => s.updateOverlayText);
  const applyTextPatchToSubtitles = useLiteCutTimelineStore((s) => s.applyTextPatchToSubtitles);
  const selectOverlay = useLiteCutTimelineStore((s) => s.selectOverlay);
  const clearSelection = useLiteCutTimelineStore((s) => s.clearSelection);
  const deleteSelected = useLiteCutTimelineStore((s) => s.deleteSelected);
  const rippleDeleteSelected = useLiteCutTimelineStore((s) => s.rippleDeleteSelected);
  const splitAtPlayhead = useLiteCutTimelineStore((s) => s.splitAtPlayhead);
  const splitAllAtPlayhead = useLiteCutTimelineStore((s) => s.splitAllAtPlayhead);
  const trimSelectedStartToPlayhead = useLiteCutTimelineStore((s) => s.trimSelectedStartToPlayhead);
  const trimSelectedEndToPlayhead = useLiteCutTimelineStore((s) => s.trimSelectedEndToPlayhead);
  const undo = useLiteCutTimelineStore((s) => s.undo);
  const redo = useLiteCutTimelineStore((s) => s.redo);
  const jumpToPreviousEditPoint = useLiteCutTimelineStore((s) => s.jumpToPreviousEditPoint);
  const jumpToNextEditPoint = useLiteCutTimelineStore((s) => s.jumpToNextEditPoint);
  const addMarkerAtPlayhead = useLiteCutTimelineStore((s) => s.addMarkerAtPlayhead);
  const updateMarker = useLiteCutTimelineStore((s) => s.updateMarker);
  const deleteMarker = useLiteCutTimelineStore((s) => s.deleteMarker);
  const deleteMarkerNearPlayhead = useLiteCutTimelineStore((s) => s.deleteMarkerNearPlayhead);
  const jumpToPreviousMarker = useLiteCutTimelineStore((s) => s.jumpToPreviousMarker);
  const jumpToNextMarker = useLiteCutTimelineStore((s) => s.jumpToNextMarker);
  const nudgeSelectedFrame = useLiteCutTimelineStore((s) => s.nudgeSelectedFrame);
  const slipSelectedFrame = useLiteCutTimelineStore((s) => s.slipSelectedFrame);
  const compactSelectedTrackGaps = useLiteCutTimelineStore((s) => s.compactSelectedTrackGaps);
  const updateSelectedTransition = useLiteCutTimelineStore((s) => s.updateSelectedTransition);
  const updateSelectedTransitionType = useLiteCutTimelineStore((s) => s.updateSelectedTransitionType);
  const updateSelectedTransitionDuration = useLiteCutTimelineStore((s) => s.updateSelectedTransitionDuration);
  const updateSelectedColor = useLiteCutTimelineStore((s) => s.updateSelectedColor);
  const applySelectedTransitionToScope = useLiteCutTimelineStore((s) => s.applySelectedTransitionToScope);
  const canApplySelectedTransitionToScope = useLiteCutTimelineStore((s) => s.canApplySelectedTransitionToScope);
  const applySelectedColorToScope = useLiteCutTimelineStore((s) => s.applySelectedColorToScope);
  const canApplySelectedColorToScope = useLiteCutTimelineStore((s) => s.canApplySelectedColorToScope);
  const updateSelectedClip = useLiteCutTimelineStore((s) => s.updateSelectedClip);
  const updateClip = useLiteCutTimelineStore((s) => s.updateClip);
  const updateTrack = useLiteCutTimelineStore((s) => s.updateTrack);
  const toggleSnap = useLiteCutTimelineStore((s) => s.toggleSnap);
  const copySelected = useLiteCutTimelineStore((s) => s.copySelected);
  const pasteClipboard = useLiteCutTimelineStore((s) => s.pasteClipboard);
  const insertPasteClipboard = useLiteCutTimelineStore((s) => s.insertPasteClipboard);
  const duplicateSelected = useLiteCutTimelineStore((s) => s.duplicateSelected);
  const addFromMediaBin = useLiteCutTimelineStore((s) => s.addFromMediaBin);
  const replaceSelectedClipSource = useLiteCutTimelineStore((s) => s.replaceSelectedClipSource);
  const backfillClipSourceDuration = useLiteCutTimelineStore((s) => s.backfillClipSourceDuration);

  const [inspectorTab, setInspectorTab] = useState(defaultInspectorTab === "export" ? "clip" : defaultInspectorTab);
  const [textStyleId, setTextStyleId] = useState("clutch");
  const [overlayText, setOverlayText] = useState("CLUTCH");
  const [textDefaults, setTextDefaults] = useState({ font_family: "微软雅黑", font_file: null, font_size: 64, font_weight: 700, line_height: 1.2, align: "center" });
  const playheadAuthorityRef = useRef(0);
  const prevPlayingRef = useRef(isPlaying);

  useEffect(() => {
    playheadAuthorityRef.current = useLiteCutTimelineStore.getState().playheadSec;
  }, [lastUserSeekAt]);

  useEffect(() => {
    if (prevPlayingRef.current !== isPlaying) {
      playheadAuthorityRef.current = playheadSec;
      prevPlayingRef.current = isPlaying;
    }
  }, [isPlaying, playheadSec]);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(defaultExportOpen || defaultInspectorTab === "export");
  const [presetsOpen, setPresetsOpen] = useState(false);
  const selectionInspectorTab = useMemo(
    () => inspectorTabForTimelineSelection(body, selectedClipId, selectedTrackId),
    [body, selectedClipId, selectedTrackId],
  );

  useEffect(() => {
    if (selectionInspectorTab) setInspectorTab(selectionInspectorTab);
  }, [selectedClipId, selectedTrackId, selectionInspectorTab]);

  const totalSec = useMemo(() => timelineTotalSec(body, 30), [body]);
  const exportableClipCount = useMemo(() => mainVideoClips(body).length, [body]);

  const restartOrTogglePlayback = useCallback((forced) => {
    if (typeof forced === "boolean") {
      setPlaying(forced);
      return;
    }
    const current = useLiteCutTimelineStore.getState();
    // A stopped playhead at the project's end is a completed pass, not a
    // permanently exhausted media element.  Start the next pass at zero.
    if (!current.isPlaying && current.playheadSec >= totalSec - 0.015) {
      playheadAuthorityRef.current = 0;
      seekPlayhead(0);
      setPlaying(true);
      return;
    }
    togglePlay();
  }, [seekPlayhead, setPlaying, togglePlay, totalSec]);

  const outputDirHint = useMemo(() => resolveLiteCutOutputDir(body, mediaCache), [body, mediaCache]);
  const outputDir = String(body?.output?.dir || "");
  const outputWidth = Math.max(LITE_CUT_OUTPUT_LIMITS.width.min, Math.min(LITE_CUT_OUTPUT_LIMITS.width.max, Number(body?.output?.width) || LITE_CUT_OUTPUT_DEFAULTS.width));
  const outputHeight = Math.max(LITE_CUT_OUTPUT_LIMITS.height.min, Math.min(LITE_CUT_OUTPUT_LIMITS.height.max, Number(body?.output?.height) || LITE_CUT_OUTPUT_DEFAULTS.height));
  const outputFps = Math.max(LITE_CUT_OUTPUT_LIMITS.fps.min, Math.min(LITE_CUT_OUTPUT_LIMITS.fps.max, Number(body?.output?.fps) || LITE_CUT_OUTPUT_DEFAULTS.fps));
  const outputFrameMeldEnabled = body?.output?.framemeld_enabled === true;
  const outputEncoder = ["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"].includes(body?.output?.encoder)
    ? body.output.encoder
    : "auto";
  const outputEncoderTier = body?.output?.encoder_tier === "fast" ? "fast" : "quality";
  const outputCanvasFit = LITE_CUT_CANVAS_FIT_VALUES.includes(body?.output?.canvas_fit) ? body.output.canvas_fit : LITE_CUT_OUTPUT_DEFAULTS.canvas_fit;
  const outputBackgroundColor = /^#[0-9a-f]{6}$/i.test(String(body?.output?.background_color || ""))
    ? body.output.background_color
    : LITE_CUT_OUTPUT_DEFAULTS.background_color;
  const outputBlurAmount = Math.max(LITE_CUT_OUTPUT_LIMITS.blurAmount.min, Math.min(LITE_CUT_OUTPUT_LIMITS.blurAmount.max, Number(body?.output?.blur_amount) || LITE_CUT_OUTPUT_LIMITS.blurAmount.default));
  const outputRange = useMemo(() => normalizeLiteCutExportRange(body?.output, totalSec), [body?.output, totalSec]);
  const selectedExportRange = useMemo(
    () => selectedTimelineRange(body, selectedClipIds?.length ? selectedClipIds : selectedClipId ? [selectedClipId] : []),
    [body, selectedClipId, selectedClipIds],
  );
  const rawMasterVolume = Number(body?.audio?.master_volume);
  const masterVolume = clampAudioGain(rawMasterVolume, AUDIO_MASTER_GAIN);
  const bgm = body?.audio?.bgm && typeof body.audio.bgm === "object" ? body.audio.bgm : null;
  const usedAssetIds = useMemo(() => collectUsedLiteCutAssetIds(body), [body]);
  const outputFilename = useMemo(
    () => stripMp4Extension(body?.output?.filename || defaultLiteCutFilename(body, projectName)),
    [body, projectName],
  );

  const { ffmpegGate } = useLiteCutFfmpegGateController({
    pathname: location.pathname,
    outputFrameMeldEnabled,
    patchOutput,
    t,
  });
  useLiteCutProjectSessionController({
    body,
    dirty,
    ffmpegBlocked: ffmpegGate.blocked,
    ffmpegLoading: ffmpegGate.loading,
    loadOrCreateProject,
    loading,
    persistRecoveryDraft,
    projectId,
    projectName,
    saveProject,
    saving,
  });
  const {
    fontAssets,
    audioAssets,
    mediaAssets,
    assetPreviewVersions,
    handleAssetsLoaded,
    handleRelinkMissingAsset,
    ensureProjectMediaAsset,
  } = useLiteCutMediaController({
    body,
    migrateAlphaMovOverlaysToVideoTracks,
    outputHeight,
    outputWidth,
    projectId,
    updateOverlay,
  });
  useEffect(() => {
    if (!mediaAssets.length) return;
    const durationByAssetId = new Map(
      mediaAssets
        .map((asset) => [Number(asset?.id), Number(asset?.duration_sec)])
        .filter(([assetId, duration]) => Number.isFinite(assetId) && assetId > 0 && Number.isFinite(duration) && duration > 0.05),
    );
    if (!durationByAssetId.size) return;
    const repairedAssetIds = new Set();
    const currentBody = useLiteCutEditorStore.getState().body;
    for (const track of currentBody?.tracks || []) {
      for (const clip of track.clips || []) {
        const assetId = Number(clip?.meta?.asset_id);
        const duration = durationByAssetId.get(assetId);
        if (!duration || repairedAssetIds.has(assetId)) continue;
        repairedAssetIds.add(assetId);
        backfillClipSourceDuration(clip.id, duration);
      }
    }
  }, [backfillClipSourceDuration, mediaAssets]);
  const fontAssetSources = useMemo(
    () => Object.fromEntries(
      fontAssets
        .filter((asset) => asset?.id != null && asset?.file_path)
        .map((asset) => [String(asset.file_path), {
          // Keep the generated family a valid unquoted CSS identifier. A
          // whitespace-separated trailing asset id ("... Font 18") is
          // rejected by the browser when assigned through element.style and
          // silently falls back to the application font.
          family: `LiteCutProjectFont_${asset.id}`,
          url: getLiteCutAssetStreamUrl(asset.id),
        }]),
    ),
    [fontAssets],
  );
  const framemeldSourceItems = useMemo(
    () => collectLiteCutFrameMeldSourceItems(body, mediaCache, mediaAssets),
    [body, mediaAssets, mediaCache],
  );
  const {
    exporting,
    exportError,
    exportJob,
    exportDialog,
    exportHistory,
    handleExport,
    handleCancelExport,
    dismissExportDialog,
    loadExportHistory,
  } = useLiteCutExportController({
    body,
    dirty,
    exportableClipCount,
    onExportPhaseChange,
    outputDir,
    outputDirHint,
    outputFilename,
    patchOutput,
    projectId,
    projectName,
    saveProject,
    t,
  });
  const {
    handleNewProject,
    handleExportProject,
    handleImportProject,
    handleOpenProject,
    handleDuplicateProject,
    handleDeleteProject,
    handleDeleteProjects,
    handleRestoreSnapshot,
  } = useLiteCutProjectController({
    clearSelection,
    createNewProject,
    deleteProject,
    deleteProjects,
    dirty,
    duplicateProject,
    listProjects,
    openProject,
    projectId,
    projectName,
    saveProject,
    saving,
    setPlaying,
    setPlayhead,
    t,
  });

  const previewScene = useMemo(
    () => buildPreviewScene(body, playheadSec, { masterVolume }),
    [body, masterVolume, playheadSec],
  );
  const playback = previewScene.top;
  const baseVideoTrackId = previewScene.baseVideoTrackId;
  const playbackIsVideoLayer = Boolean(playback?.trackId && getTrack(body, playback.trackId)?.type === "video");
  const underlayPlayback = previewScene.underlay;
  const underlayPlaybacks = previewScene.underlays;
  const transitionCompanionPlayback = previewScene.transitionCompanion;
  const previewOverlays = previewScene.overlays;
  const { clip: selectedClip } = useMemo(
    () => {
      if (selectedTrackId === "overlay" && selectedClipId) {
        const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
        return { clip: ov || null, trackId: "overlay" };
      }
      return findClipById(body, selectedClipId);
    },
    [body, selectedClipId, selectedTrackId],
  );

  const activeClip = selectedClip || playback?.clip || null;
  // Selection controls the inspector, but the canvas must only show content
  // that actually covers the playhead. Otherwise a selected, trimmed clip can
  // leak its discarded source frames into an empty timeline region.
  const previewClip = playback?.clip || null;
  const selectedMedia = useMemo(() => {
    if (selectedTrackId === "overlay" && selectedClip) {
      if (selectedClip.type === "text") {
        return {
          id: selectedClip.id,
          title: selectedClip.text?.content || "Text",
          mediaKind: "asset",
          kind: "text",
          duration: Number(selectedClip.duration) || 3,
        };
      }
      const aid = selectedClip.meta?.asset_id;
      return {
        id: aid,
        title: selectedClip.meta?.name || "叠加素材",
        mediaKind: "asset",
        kind: selectedClip.meta?.kind || "image",
        assetStreamUrl: aid
          ? getLiteCutAssetStreamUrl(aid, assetPreviewVersions?.[Number(aid)] || selectedClip.meta?.preview_proxy_version || "")
          : null,
        duration_sec: selectedClip.meta?.duration_sec || selectedClip.duration,
        width: selectedClip.meta?.source_width,
        height: selectedClip.meta?.source_height,
        fps: selectedClip.meta?.source_fps,
        codec_name: selectedClip.meta?.codec_name,
      };
    }
    return clipToMedia(activeClip, mediaCache);
  }, [activeClip, assetPreviewVersions, mediaCache, selectedClip, selectedTrackId]);

  const overlayTransform = selectedTrackId === "overlay" ? sceneTransformAt(selectedClip, playheadSec) : null;
  const overlayHasKeyframe = Boolean(
    selectedTrackId === "overlay" &&
      selectedClip?.keyframes?.some(
        (keyframe) => Math.abs((Number(keyframe?.time_sec) || 0) - (playheadSec - (Number(selectedClip?.timeline_start) || 0))) <= 0.04,
      ),
  );
  const selectedTransitionRef = useMemo(() => {
    if (!selectedClip) return null;
    return selectedTrackId === "overlay"
      ? overlayTransitionRef(selectedClip)
      : selectedTrackId ? clipTransitionRef(selectedTrackId, selectedClip.id) : null;
  }, [selectedClip, selectedTrackId]);
  const selectedTransitionEvent = useMemo(
    () => (body?.transitions || []).find((event) => String(event?.id) === String(selectedTransitionId || "")) || null,
    [body?.transitions, selectedTransitionId],
  );
  const activeTransitionIn = useMemo(
    () => selectedTransitionRef ? transitionEventForNodeEdge(body, selectedTransitionRef, "in") : null,
    [body, selectedTransitionRef],
  );
  const activeTransitionOut = useMemo(
    () => selectedTransitionRef ? transitionEventForNodeEdge(body, selectedTransitionRef, "out") : null,
    [body, selectedTransitionRef],
  );
  const overlayTransitionType = selectedTrackId === "overlay" ? String(selectedTransitionEvent?.type || activeTransitionOut?.type || activeTransitionIn?.type || "cut") : "cut";
  const overlayTransitionInSec = selectedTrackId === "overlay" ? Math.max(0, Number(activeTransitionIn?.duration_sec) || 0) : 0;
  const overlayTransitionOutSec = selectedTrackId === "overlay" ? Math.max(0, Number(activeTransitionOut?.duration_sec) || 0) : 0;
  const selectedTextOverlay = selectedTrackId === "overlay" && selectedClip?.type === "text" ? selectedClip : null;
  const activeTextStyleId = selectedTextOverlay?.text?.preset_id || selectedTextOverlay?.meta?.textStyleId || textStyleId;
  const activeOverlayText = selectedTextOverlay?.text?.content ?? overlayText;
  const activeTextFontFamily = selectedTextOverlay?.text?.font_family ?? textDefaults.font_family;
  const activeTextFontFile = selectedTextOverlay?.text?.font_file ?? textDefaults.font_file;
  const activeTextFontSize = selectedTextOverlay?.text?.font_size ?? textDefaults.font_size;
  const activeTextFontWeight = selectedTextOverlay?.text?.font_weight ?? textDefaults.font_weight;
  const activeTextLineHeight = selectedTextOverlay?.text?.line_height ?? textDefaults.line_height;
  const activeTextAlign = selectedTextOverlay?.text?.align ?? textDefaults.align ?? "center";

  const clipStreamUrl = useCallback(
    (clip) => liteCutClipStreamUrl(clip, assetPreviewVersions),
    [assetPreviewVersions],
  );
  const assetForClip = useCallback((clip) => {
    const assetId = Number(clip?.meta?.asset_id);
    if (!Number.isFinite(assetId) || assetId <= 0) return null;
    return mediaAssets.find((asset) => Number(asset?.id) === assetId) || null;
  }, [mediaAssets]);

  const directStreamUrl = useMemo(() => clipStreamUrl(previewClip), [clipStreamUrl, previewClip]);
  const previewAssetId = Number(previewClip?.meta?.asset_id);
  const previewAsset = useMemo(() => assetForClip(previewClip), [assetForClip, previewClip]);
  const segmentedPreviewEnabled = shouldUseSegmentedPreview(previewAsset, previewClip);
  const segmentedPreview = useSegmentedPreviewSource({
    assetId: Number.isFinite(previewAssetId) && previewAssetId > 0 ? previewAssetId : null,
    directStreamUrl,
    enabled: segmentedPreviewEnabled,
    isPlaying,
    segmentStepSec: previewAsset?.preview_segment_step_sec || previewClip?.meta?.preview_segment_step_sec || 4,
    sourceDurationSec: previewAsset?.duration_sec || previewClip?.meta?.duration_sec || 0,
    sourceTime: playback?.sourceTime ?? playheadSec,
  });
  const streamUrl = segmentedPreview.streamUrl;
  const nextPreviewPlayback = useMemo(
    () => (playback?.clip ? nextTopVideoPlaybackAfter(body, playback) : null),
    [body, playback],
  );
  const nextPreviewClip = nextPreviewPlayback?.clip || null;
  const nextPreviewAsset = useMemo(() => assetForClip(nextPreviewClip), [assetForClip, nextPreviewClip]);
  const nextPreviewAssetId = Number(nextPreviewClip?.meta?.asset_id);
  const nextPreviewSourceTime = useMemo(
    () => nextPreviewClip
      ? selectedClipPreviewSourceTime(nextPreviewClip, Number(nextPreviewPlayback?.clipStart) || 0)
      : 0,
    [nextPreviewClip, nextPreviewPlayback?.clipStart],
  );
  const nextPreviewSegmentedEnabled = shouldUseSegmentedPreview(nextPreviewAsset, nextPreviewClip);
  const nextClipPrewarmActive = shouldPrewarmNextClip({
    currentClipEnd: playback?.clipEnd,
    isPlaying,
    nextClipStart: nextPreviewPlayback?.clipStart,
    playheadSec,
  });
  const transitionCompanionIsNext = Boolean(
    transitionCompanionPlayback?.clip?.id
    && String(transitionCompanionPlayback.clip.id) === String(nextPreviewClip?.id || ""),
  );
  const nextClipSourceActive = nextClipPrewarmActive || transitionCompanionIsNext;
  const directNextPreviewStreamUrl = useMemo(
    () => clipStreamUrl(nextPreviewClip),
    [clipStreamUrl, nextPreviewClip],
  );
  const nextSegmentedPreview = useSegmentedPreviewSource({
    assetId: Number.isFinite(nextPreviewAssetId) && nextPreviewAssetId > 0 ? nextPreviewAssetId : null,
    directStreamUrl: directNextPreviewStreamUrl,
    enabled: nextClipSourceActive && nextPreviewSegmentedEnabled,
    isPlaying,
    segmentStepSec: nextPreviewAsset?.preview_segment_step_sec || nextPreviewClip?.meta?.preview_segment_step_sec || 4,
    sourceDurationSec: nextPreviewAsset?.duration_sec || nextPreviewClip?.meta?.duration_sec || 0,
    sourceTime: nextPreviewSourceTime,
  });
  const nextClipPrewarmStreamUrl = nextClipSourceActive
    ? (nextPreviewSegmentedEnabled ? nextSegmentedPreview.streamUrl : directNextPreviewStreamUrl)
    : null;
  const nextClipPreloadStreamUrl = nextClipPrewarmStreamUrl;
  const preloadStreamUrl = segmentedPreview.preloadStreamUrl || nextClipPreloadStreamUrl;
  const preloadSourceTime = segmentedPreview.preloadStreamUrl
    ? 0
    : Math.max(0, nextPreviewSourceTime - (nextPreviewSegmentedEnabled ? nextSegmentedPreview.mediaTimeOffset : 0));
  const directUnderlayStreamUrl = useMemo(() => clipStreamUrl(underlayPlayback?.clip), [clipStreamUrl, underlayPlayback?.clip]);
  const underlayAsset = useMemo(() => assetForClip(underlayPlayback?.clip), [assetForClip, underlayPlayback?.clip]);
  const underlayAssetId = Number(underlayPlayback?.clip?.meta?.asset_id);
  const underlaySegmentedPreview = useSegmentedPreviewSource({
    assetId: Number.isFinite(underlayAssetId) && underlayAssetId > 0 ? underlayAssetId : null,
    directStreamUrl: directUnderlayStreamUrl,
    enabled: shouldUseSegmentedPreview(underlayAsset, underlayPlayback?.clip),
    isPlaying,
    segmentStepSec: underlayAsset?.preview_segment_step_sec || underlayPlayback?.clip?.meta?.preview_segment_step_sec || 4,
    sourceDurationSec: underlayAsset?.duration_sec || underlayPlayback?.clip?.meta?.duration_sec || 0,
    sourceTime: underlayPlayback?.sourceTime ?? 0,
  });
  // Keep the already decodable source visible while the first lower-layer
  // segment is warming; switch to the proxy as soon as it is ready so the
  // same DOM element can be promoted at the upper-track boundary.
  const underlayStreamUrl = underlaySegmentedPreview.streamUrl || directUnderlayStreamUrl;
  const underlayMediaTimeOffset = underlaySegmentedPreview.streamUrl
    ? underlaySegmentedPreview.mediaTimeOffset
    : 0;
  const activeClipStreamUrl = useMemo(
    () => (shouldUseSegmentedPreview(assetForClip(activeClip), activeClip) ? null : clipStreamUrl(activeClip)),
    [activeClip, assetForClip, clipStreamUrl],
  );
  const activeClipPreviewSourceTime = useMemo(
    () => selectedClipPreviewSourceTime(activeClip, playheadSec),
    [activeClip, playheadSec],
  );

  const previewFilter = useMemo(() => {
    const color = previewClip?.color || {};
    return filterStyleFromColor({
      brightness: color.brightness ?? 0,
      contrast: color.contrast ?? 0,
      saturation: color.saturation ?? 0,
      preset: color.filter_preset || "none",
    });
  }, [previewClip?.color]);

  const transitionType = selectedTransitionEvent?.type || activeTransitionOut?.type || activeTransitionIn?.type || "cut";
  const transitionDuration = selectedTransitionEvent?.duration_sec ?? activeTransitionOut?.duration_sec ?? TRANSITION_DURATION_DEFAULT;
  const transitionInDuration = activeTransitionIn?.duration_sec ?? TRANSITION_DURATION_DEFAULT;
  const transitionOutDuration = activeTransitionOut?.duration_sec ?? TRANSITION_DURATION_DEFAULT;
  const activeColor = {
    brightness: activeClip?.color?.brightness ?? 0,
    contrast: activeClip?.color?.contrast ?? 0,
    saturation: activeClip?.color?.saturation ?? 0,
    filter_preset: activeClip?.color?.filter_preset || null,
  };
  const selectedTrack = selectedTrackId && selectedTrackId !== "overlay" ? getTrack(body, selectedTrackId) : null;
  const activeClipIsVideoLayer = Boolean(selectedTrack?.type === "video");
  const activeClipIsAudio =
    selectedTrackId !== "overlay" && Boolean(selectedTrack?.type === "audio" || activeClip?.meta?.kind === "audio");
  const activeVisualCapabilities = activeClipIsAudio
    ? new Set()
    : visualMaterialCapabilities(activeClip, { timelineClip: activeClipIsVideoLayer });
  const activeClipSupportsSpeed = activeClipIsAudio || activeVisualCapabilities.has("speed");
  const activeClipSupportsSpeedRamp = activeClipIsAudio || activeVisualCapabilities.has("speed_ramp");
  const activeClipSupportsReverse = activeClipIsAudio || activeVisualCapabilities.has("reverse");
  const activeClipSupportsFreeze = activeVisualCapabilities.has("freeze");
  const activeClipSupportsPreservePitch = activeClipIsAudio || activeVisualCapabilities.has("audio");
  const activeClipSpeed = activeClipSupportsSpeed ? clipPlaybackSpeed(activeClip) : 1;
  const activeClipFreezeFrameSec = activeVisualCapabilities.has("freeze") ? clipFreezeFrameSec(activeClip) : 0;
  const activeClipCanvasFit = activeVisualCapabilities.has("content_fit") ? activeClip?.content_fit || null : null;
  const previewCanvasFit = playback?.clip
    ? sceneResolvedContentFit(playback.clip, clipCanvasFit(playback.clip, outputCanvasFit))
    : outputCanvasFit;
  const audioEditingTarget = useMemo(
    () => selectedTrackId === "overlay" ? { clip: null, trackId: null } : resolveAudioEditingTarget(body, selectedClipId, selectedTrackId),
    [body, selectedClipId, selectedTrackId],
  );
  const audioEditingClip = audioEditingTarget.clip || activeClip;
  const audioEditingTrackId = audioEditingTarget.trackId || selectedTrackId;
  const audioEditingTrack = audioEditingTrackId && audioEditingTrackId !== "overlay" ? getTrack(body, audioEditingTrackId) : null;
  const audioEditingIsAudioClip = Boolean(
    audioEditingTrack?.type === "audio" || audioEditingClip?.meta?.kind === "audio",
  );
  const activeClipBaseTransform = activeClipIsVideoLayer
    ? {
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        width: 1,
        height: 1,
        opacity: 1,
        ...(activeClip?.transform || {}),
      }
    : null;
  const activeClipTransform = activeClipIsVideoLayer
    ? sceneTransformAt(
        { ...activeClip, duration: clipSourceDuration(activeClip), transform: activeClipBaseTransform },
        playheadSec,
        VIDEO_SCENE_TRANSFORM_DEFAULTS,
      )
    : null;
  const activeClipHasKeyframe = Boolean(
    activeClipIsVideoLayer && activeClip?.keyframes?.some(
      (keyframe) => Math.abs((Number(keyframe?.time_sec) || 0) - (playheadSec - (Number(activeClip?.timeline_start) || 0))) <= 0.04,
    ),
  );
  const activeClipCrop = activeClipIsAudio || !activeVisualCapabilities.has("crop")
    ? null
    : {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        ...(activeClip?.crop || {}),
      };
  const activeClipVolume =
    selectedTrackId === "overlay" ? 1 : clipVolumeAt(audioEditingClip, playheadSec, clipSourceDuration(audioEditingClip));
  const activeClipHasAudioKeyframe = Boolean(
    selectedTrackId !== "overlay" && audioKeyframeNearPlayhead(audioEditingClip, playheadSec, 0.04, clipSourceDuration(audioEditingClip)),
  );
  const rawActiveTrackVolume = Number(audioEditingTrack?.volume);
  const activeTrackVolume = selectedTrackId === "overlay" ? 1 : clampAudioGain(rawActiveTrackVolume, AUDIO_TRACK_GAIN);
  const activeClipFadeInSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(activeClip?.fade_in_sec) || 0);
  const activeClipFadeOutSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(activeClip?.fade_out_sec) || 0);
  const activeClipSourceDuration = selectedTrackId === "overlay" ? 0 : clipTrimmedSourceDuration(activeClip);
  const activeClipVisibleDuration = selectedTrackId === "overlay" ? 0 : clipSourceDuration(activeClip);
  const audioEditingMuted = selectedTrackId === "overlay" ? false : Boolean(audioEditingClip?.muted);
  const audioEditingFadeInSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.fade_in_sec) || 0);
  const audioEditingFadeOutSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.fade_out_sec) || 0);
  const audioEditingSourceDuration = selectedTrackId === "overlay" ? 0 : clipTrimmedSourceDuration(audioEditingClip);
  const audioEditingTrimIn = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.trim_in) || 0);
  const activeClipFlipHorizontal = Boolean(activeClip?.flip_horizontal);
  const activeClipFlipVertical = Boolean(activeClip?.flip_vertical);
  const transitionPreview = transitionCompanionPlayback && previewScene.transitionKernel === "canvas"
    ? boundaryTransitionPreviewVisual(
        transitionCompanionPlayback.transitionType,
        transitionCompanionPlayback.progress,
        { mainRole: previewScene.nodeTransition?.role || "to" },
      )
    : previewScene.nodeTransition
      ? transitionNodePreviewVisual(previewScene.nodeTransition.type, previewScene.nodeTransition.role, previewScene.nodeTransition.progress, previewScene.nodeTransition)
      : boundaryTransitionPreviewVisual("none", 1);
  const underlayLayers = useMemo(
    () => {
      const layers = underlayPlaybacks.map((layer) => {
        const isPrimaryUnderlay = String(layer.clip?.id || "") === String(underlayPlayback?.clip?.id || "");
        return {
          id: layer.clip?.id || layer.trackId,
          streamUrl: isPrimaryUnderlay ? underlayStreamUrl : clipStreamUrl(layer.clip),
          sourceTime: layer.sourceTime,
          mediaTimeOffset: isPrimaryUnderlay ? underlayMediaTimeOffset : 0,
          segmentedPreview: isPrimaryUnderlay && Boolean(underlaySegmentedPreview.streamUrl),
          playbackRate: clipSpeedAtTimeline(layer.clip, layer.localTime),
          reversePlayback: clipReversePlayback(layer.clip),
          opacity: 1,
          contentFit: sceneResolvedContentFit(layer.clip, clipCanvasFit(layer.clip, outputCanvasFit)),
          crop: layer.clip?.crop || null,
          sourceWidth: layer.clip?.meta?.source_width || layer.clip?.meta?.width || outputWidth,
          sourceHeight: layer.clip?.meta?.source_height || layer.clip?.meta?.height || outputHeight,
          flipHorizontal: Boolean(layer.clip?.flip_horizontal),
          flipVertical: Boolean(layer.clip?.flip_vertical),
          filter: filterStyleFromColor({
            brightness: layer.clip?.color?.brightness ?? 0,
            contrast: layer.clip?.color?.contrast ?? 0,
            saturation: layer.clip?.color?.saturation ?? 0,
            preset: layer.clip?.color?.filter_preset || "none",
          }).filter,
          transform: sceneTransformAt(
            { ...layer.clip, duration: clipSourceDuration(layer.clip), transform: { ...VIDEO_SCENE_TRANSFORM_DEFAULTS, ...(layer.clip?.transform || {}) } },
            playheadSec,
            VIDEO_SCENE_TRANSFORM_DEFAULTS,
          ),
        };
      });
      const transitionCompanion = transitionCompanionPlayback;
      if (transitionCompanion?.clip) {
        const clip = transitionCompanion.clip;
        const usesNextSource = transitionCompanionIsNext && Boolean(nextClipPrewarmStreamUrl);
        const transitionLayer = {
          // Clip identity is deliberately stable across prewarm, transition,
          // and promotion.  Prefixing this id used to force React to destroy
          // the prewarmed decoder exactly when the transition started.
          id: clip.id,
          streamUrl: usesNextSource ? nextClipPrewarmStreamUrl : clipStreamUrl(clip),
          sourceTime: transitionCompanion.sourceTime,
          mediaTimeOffset: usesNextSource && nextPreviewSegmentedEnabled ? nextSegmentedPreview.mediaTimeOffset : 0,
          segmentedPreview: usesNextSource && nextPreviewSegmentedEnabled,
          playbackRate: clipSpeedAtTimeline(clip, transitionCompanion.localTime),
          reversePlayback: clipReversePlayback(clip),
          freezePlayback: Boolean(transitionCompanion.freezePlayback),
          transitionLayer: true,
          transitionRole: transitionCompanion.transitionRole,
          opacity: transitionPreview.companionOpacity ?? 1,
          contentFit: sceneResolvedContentFit(clip, clipCanvasFit(clip, outputCanvasFit)),
          crop: clip.crop || null,
          sourceWidth: clip.meta?.source_width || clip.meta?.width || outputWidth,
          sourceHeight: clip.meta?.source_height || clip.meta?.height || outputHeight,
          flipHorizontal: Boolean(clip.flip_horizontal),
          flipVertical: Boolean(clip.flip_vertical),
          filter: filterStyleFromColor({
            brightness: clip.color?.brightness ?? 0,
            contrast: clip.color?.contrast ?? 0,
            saturation: clip.color?.saturation ?? 0,
            preset: clip.color?.filter_preset || "none",
          }).filter,
          transform: sceneTransformAt(
            { ...clip, duration: clipSourceDuration(clip), transform: { ...VIDEO_SCENE_TRANSFORM_DEFAULTS, ...(clip.transform || {}) } },
            playheadSec,
            VIDEO_SCENE_TRANSFORM_DEFAULTS,
          ),
        };
        const existingIndex = layers.findIndex((layer) => String(layer.id) === String(clip.id));
        if (existingIndex >= 0) layers[existingIndex] = { ...layers[existingIndex], ...transitionLayer };
        else layers.push(transitionLayer);
      }
      // The next main clip is mounted invisibly during the bounded prewarm
      // window. At a plain cut LiteCutPreviewPanel promotes this already-
      // decoded element while the new main player finishes its handoff.
      if (
        nextClipPrewarmActive
        && nextClipPrewarmStreamUrl
        && !clipReversePlayback(nextPreviewClip)
      ) {
        const clip = nextPreviewClip;
        const id = clip.id;
        if (!layers.some((layer) => String(layer.id) === String(id))) {
          layers.push({
            id,
            streamUrl: nextClipPrewarmStreamUrl,
            sourceTime: nextPreviewSourceTime,
            mediaTimeOffset: nextPreviewSegmentedEnabled ? nextSegmentedPreview.mediaTimeOffset : 0,
            segmentedPreview: nextPreviewSegmentedEnabled,
            playbackRate: clipSpeedAtTimeline(clip, 0),
            reversePlayback: false,
            prewarm: true,
            // The element decodes while invisible; promotion makes it visible
            // exactly at the cut, including when the outgoing clip has alpha.
            opacity: 0,
            contentFit: sceneResolvedContentFit(clip, clipCanvasFit(clip, outputCanvasFit)),
            crop: clip.crop || null,
            sourceWidth: clip.meta?.source_width || clip.meta?.width || outputWidth,
            sourceHeight: clip.meta?.source_height || clip.meta?.height || outputHeight,
            flipHorizontal: Boolean(clip.flip_horizontal),
            flipVertical: Boolean(clip.flip_vertical),
            filter: filterStyleFromColor({
              brightness: clip.color?.brightness ?? 0,
              contrast: clip.color?.contrast ?? 0,
              saturation: clip.color?.saturation ?? 0,
              preset: clip.color?.filter_preset || "none",
            }).filter,
            transform: sceneTransformAt(
              { ...clip, duration: clipSourceDuration(clip), transform: { ...VIDEO_SCENE_TRANSFORM_DEFAULTS, ...(clip.transform || {}) } },
              playheadSec,
              VIDEO_SCENE_TRANSFORM_DEFAULTS,
            ),
          });
        }
      }
      return layers.filter((layer) => Boolean(layer.streamUrl));
    },
    [clipStreamUrl, nextClipPrewarmActive, nextClipPrewarmStreamUrl, nextPreviewClip, nextPreviewSegmentedEnabled, nextPreviewSourceTime, nextSegmentedPreview.mediaTimeOffset, outputCanvasFit, outputHeight, outputWidth, playheadSec, transitionCompanionIsNext, transitionCompanionPlayback, transitionPreview.companionOpacity, underlayMediaTimeOffset, underlayPlayback?.clip?.id, underlayPlaybacks, underlaySegmentedPreview.streamUrl, underlayStreamUrl],
  );
  const soloAudioActive = useMemo(() => hasSoloAudioTracks(body), [body]);
  const videoClipIds = useMemo(() => new Set(
    (body?.tracks || [])
      .filter((track) => track?.type === "video")
      .flatMap((track) => track.clips || [])
      .map((clip) => String(clip.id)),
  ), [body?.tracks]);
  const audioPreviewItems = useMemo(
    () => {
      const toPreviewItem = (item) => {
        const src = liteCutAudioPreviewUrl(item, videoClipIds, assetPreviewVersions);
        if (!src) return null;
        return {
          id: item.id,
          trackId: item.trackId,
          src,
          sourceTime: item.sourceTime,
          playbackRate: item.playbackRate,
          reversePlayback: item.reversePlayback,
          muted: item.muted,
          volume: item.volume,
          preloadOnly: Boolean(item.preloadOnly),
        };
      };
      const items = previewScene.audio
        .map((item) => {
          return toPreviewItem(item);
        })
        .filter(Boolean),
        activeKeys = new Set(items.map((item) => `${item.trackId}:${item.id}`)),
        preloadItems = previewScene.audioPreload
          .map((item) => toPreviewItem(item))
          .filter((item) => item && !activeKeys.has(`${item.trackId}:${item.id}`)),
        allItems = [...items, ...preloadItems],
        duckingEnabled = Boolean(bgm?.ducking_enabled),
        duckingVolume = Math.max(0.05, Math.min(1, Number(bgm?.ducking_volume) || 0.35)),
        hasForeground = items.some((item) => item.trackId !== "bgm" && !item.muted && item.volume > 0);
      if (!duckingEnabled || !hasForeground) return allItems;
      return allItems.map((item) => (item.trackId === "bgm" && !item.preloadOnly ? { ...item, volume: item.volume * duckingVolume } : item));
    },
    [assetPreviewVersions, bgm?.ducking_enabled, bgm?.ducking_volume, previewScene.audio, previewScene.audioPreload, videoClipIds],
  );
  const dedicatedAudioPreviewItems = audioPreviewItems;

  useEffect(() => {
    if (!isPlaying || !body) return;
    if (streamUrl && playback?.clip && !clipReversePlayback(playback.clip) && !playback.frozen && !playback.freezePlayback) return;
    let frameId = 0;
    let previousNow = performance.now();
    const tick = (now) => {
      const elapsedSec = Math.max(0, Math.min(0.1, (now - previousNow) / 1000));
      previousNow = now;
      const cur = useLiteCutTimelineStore.getState().playheadSec;
      const next = cur + elapsedSec;
      if (next >= totalSec) {
        setPlaying(false);
        setPlayhead(totalSec);
      } else {
        setPlayhead(next);
        frameId = window.requestAnimationFrame(tick);
      }
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [isPlaying, body, totalSec, setPlayhead, setPlaying, streamUrl, playback?.clip, playback?.freezePlayback, playback?.frozen]);

  useEffect(() => {
    const runShortcut = (shortcut) => {
      switch (shortcut.action) {
        case "undo":
          undo();
          return true;
        case "redo":
          redo();
          return true;
        case "saveProject":
          void saveProject();
          return true;
        case "selectAllTimelineItems":
          return selectAllTimelineItems();
        case "selectTimelineItemsFromPlayhead":
          return selectTimelineItemsFromPlayhead(shortcut.direction);
        case "clearSelection":
          clearSelection();
          return true;
        case "copySelected":
          return copySelected();
        case "insertPasteClipboard":
          return insertPasteClipboard();
        case "pasteClipboard":
          return pasteClipboard();
        case "duplicateSelected":
          duplicateSelected();
          return true;
        case "compactSelectedTrackGaps":
          return compactSelectedTrackGaps();
        case "zoomTimeline":
          setTimelineZoom(timelineZoom * (shortcut.delta > 0 ? 1.25 : 0.8));
          return true;
        case "resetTimelineZoom":
          setTimelineZoom(1);
          return true;
        case "focusTimeline":
          requestTimelineFocus();
          return true;
        case "rippleDeleteSelected":
          rippleDeleteSelected();
          return true;
        case "deleteSelected":
          deleteSelected();
          return true;
        case "splitAllAtPlayhead":
          splitAllAtPlayhead();
          return true;
        case "splitAtPlayhead":
          splitAtPlayhead();
          return true;
        case "trimSelectedStartToPlayhead":
          trimSelectedStartToPlayhead();
          return true;
        case "trimSelectedEndToPlayhead":
          trimSelectedEndToPlayhead();
          return true;
        case "toggleSnap":
          toggleSnap();
          return true;
        case "deleteMarkerNearPlayhead":
          deleteMarkerNearPlayhead();
          return true;
        case "addMarkerAtPlayhead":
          addMarkerAtPlayhead();
          return true;
        case "jumpToPreviousMarker":
          jumpToPreviousMarker();
          return true;
        case "jumpToNextMarker":
          jumpToNextMarker();
          return true;
        case "jumpToPreviousEditPoint":
          jumpToPreviousEditPoint();
          return true;
        case "jumpToNextEditPoint":
          jumpToNextEditPoint();
          return true;
        case "addKeyframeAtPlayhead":
          if (selectedTrackId === "overlay" && selectedClipId) {
            upsertOverlayKeyframe(selectedClipId, playheadSec);
            return true;
          }
          if (activeClipIsVideoLayer && selectedClipId && selectedTrackId) {
            upsertClipKeyframe(selectedClipId, selectedTrackId, playheadSec);
            return true;
          }
          return false;
        case "removeKeyframeAtPlayhead":
          if (selectedTrackId === "overlay" && selectedClipId) {
            removeOverlayKeyframe(selectedClipId, playheadSec);
            return true;
          }
          if (activeClipIsVideoLayer && selectedClipId && selectedTrackId) {
            removeClipKeyframe(selectedClipId, selectedTrackId, playheadSec);
            return true;
          }
          return false;
        case "addAudioKeyframeAtPlayhead":
          if (audioEditingClip?.id && audioEditingTrackId && audioEditingTrackId !== "overlay") {
            upsertClipAudioKeyframe(audioEditingClip.id, audioEditingTrackId, playheadSec);
            return true;
          }
          return false;
        case "removeAudioKeyframeAtPlayhead":
          if (audioEditingClip?.id && audioEditingTrackId && audioEditingTrackId !== "overlay") {
            removeClipAudioKeyframe(audioEditingClip.id, audioEditingTrackId, playheadSec);
            return true;
          }
          return false;
        case "togglePlay":
          restartOrTogglePlayback();
          return true;
        case "setPlayheadStart":
          seekPlayhead(0);
          return true;
        case "setPlayheadEnd":
          seekPlayhead(totalSec);
          return true;
        case "markExportRange":
          patchOutput(liteCutRangePatchFromPlayhead(body?.output, totalSec, playheadSec, shortcut.edge));
          return true;
        case "seekRelative":
          seekPlayhead(Math.max(0, Math.min(totalSec, playheadSec + shortcut.deltaSec)));
          return true;
        case "seekFrame":
          seekPlayhead(Math.max(0, Math.min(totalSec, playheadSec + projectFrameStepSec(body) * shortcut.direction)));
          return true;
        case "nudgeSelectedFrame":
          nudgeSelectedFrame(shortcut.direction, shortcut.large);
          return true;
        case "slipSelectedFrame":
          slipSelectedFrame(shortcut.direction, shortcut.large);
          return true;
        default:
          return false;
      }
    };

    const onKey = (e) => {
      if (isEditableShortcutTarget(e.target)) return;
      const shortcut = resolveLiteCutShortcut(e);
      if (!shortcut) return;
      const handled = runShortcut(shortcut);
      if (shortcut.preventDefault === "always" || (shortcut.preventDefault === "handled" && handled)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    undo,
    redo,
    selectAllTimelineItems,
    selectTimelineItemsFromPlayhead,
    clearSelection,
    copySelected,
    pasteClipboard,
    insertPasteClipboard,
    deleteSelected,
    rippleDeleteSelected,
    splitAtPlayhead,
    splitAllAtPlayhead,
    trimSelectedStartToPlayhead,
    trimSelectedEndToPlayhead,
    restartOrTogglePlayback,
    toggleSnap,
    jumpToPreviousEditPoint,
    jumpToNextEditPoint,
    addMarkerAtPlayhead,
    deleteMarkerNearPlayhead,
    jumpToPreviousMarker,
    jumpToNextMarker,
    upsertOverlayKeyframe,
    removeOverlayKeyframe,
    upsertClipKeyframe,
    removeClipKeyframe,
    upsertClipAudioKeyframe,
    removeClipAudioKeyframe,
    activeClipIsVideoLayer,
    audioEditingClip?.id,
    audioEditingTrackId,
    selectedClipId,
    selectedTrackId,
    nudgeSelectedFrame,
    slipSelectedFrame,
    compactSelectedTrackGaps,
    timelineZoom,
    setTimelineZoom,
    requestTimelineFocus,
    duplicateSelected,
    saveProject,
    seekPlayhead,
    patchOutput,
    body?.output,
    playheadSec,
    totalSec,
  ]);

  const handlePlayheadFromVideo = useCallback(
    (sourceTime, meta = {}) => {
      const timelineState = useLiteCutTimelineStore.getState();
      if (Date.now() - timelineState.lastUserSeekAt < 300) return;

      const bodyNow = useLiteCutEditorStore.getState().body;
      const storePlayhead = timelineState.playheadSec;
      const currentPlayhead = Math.max(storePlayhead, playheadAuthorityRef.current);
      const reportClipId = meta.clipId != null ? String(meta.clipId) : null;
      const located = reportClipId ? findClipById(bodyNow, reportClipId) : null;
      const reportClip = located?.clip || playback?.clip || null;

      let next = Number(meta.timelineSec);
      if (!Number.isFinite(next)) {
        if (reportClip) {
          next = (Number(reportClip.timeline_start) || 0) + clipTimelineTimeForSource(reportClip, Number(sourceTime));
        } else {
          next = Number(sourceTime);
        }
      }
      if (!Number.isFinite(next)) return;

      const clipEnd = reportClip ? clipTimelineEnd(reportClip) : Number(playback?.clipEnd) || 0;
      const reverse = reportClip ? clipReversePlayback(reportClip) : false;
      const topAtCurrent = resolveTopVideoPlaybackAt(bodyNow, currentPlayhead);

      if (
        reportClipId
        && topAtCurrent?.clip?.id
        && reportClipId !== String(topAtCurrent.clip.id)
        && reportClip
        && currentPlayhead >= clipEnd - 0.02
      ) {
        return;
      }

      if (isPlaying && !reverse && next >= clipEnd - 0.02) {
        if (currentPlayhead >= clipEnd - 0.015) {
          if (next <= currentPlayhead) return;
        } else if (reportClip) {
          const nxt = nextTopVideoPlaybackAfter(bodyNow, {
            clip: reportClip,
            clipEnd,
            clipStart: Number(reportClip.timeline_start) || 0,
            trackId: located?.trackId ?? playback?.trackId,
          });
          if (nxt) {
            const resume = Math.max(currentPlayhead, Number(nxt.resumeTimelineSec ?? nxt.clipStart) || 0);
            playheadAuthorityRef.current = resume;
            setPlayhead(resume);
            return;
          }
          const resume = Math.max(currentPlayhead, clipEnd);
          playheadAuthorityRef.current = resume;
          setPlayhead(resume);
          if (resume >= totalSec - 0.015) {
            setPlaying(false);
            setPlayhead(totalSec);
            playheadAuthorityRef.current = totalSec;
          }
          return;
        }
      }

      if (isPlaying && !reverse && next <= currentPlayhead) return;

      playheadAuthorityRef.current = next;
      setPlayhead(next);
    },
    [isPlaying, playback, setPlayhead, setPlaying, totalSec],
  );

  const previewClipId = previewClip?.id ?? null;
  const handlePreviewSourceDuration = useCallback(
    (duration) => {
      if (previewClipId != null) backfillClipSourceDuration(previewClipId, duration);
    },
    [backfillClipSourceDuration, previewClipId],
  );
  const handleUnderlaySourceDuration = useCallback(
    (clipId, duration) => {
      if (clipId != null) backfillClipSourceDuration(clipId, duration);
    },
    [backfillClipSourceDuration],
  );

  const handleMediaItemsLoaded = useCallback(
    (items) => {
      setMediaCache(items);
    },
    [setMediaCache],
  );

  const handleRecordedMediaDuration = useCallback((sourceId, durationSec) => {
    const id = Number(sourceId);
    const duration = Number(durationSec);
    if (!Number.isFinite(id) || !Number.isFinite(duration) || duration <= 0.05) return;
    useLiteCutEditorStore.setState((state) => {
      const current = state.mediaCache?.[id];
      if (!current || Math.abs((Number(current.duration) || 0) - duration) <= 0.05) return state;
      return {
        mediaCache: {
          ...state.mediaCache,
          [id]: { ...current, duration, _raw: { ...(current._raw || {}), duration_sec: duration } },
        },
      };
    });
    const currentBody = useLiteCutEditorStore.getState().body;
    const matchingClip = (currentBody?.tracks || [])
      .flatMap((track) => track.clips || [])
      .find((clip) => clip?.source_type === "recorded_clip" && Number(clip.source_id) === id);
    if (matchingClip?.id) backfillClipSourceDuration(matchingClip.id, duration);
  }, [backfillClipSourceDuration]);

  const handleSelectMedia = useCallback(
    (mediaItem) => {
      const v1 = getTrack(body, "v1");
      const existing = (v1?.clips || []).find((c) => Number(c.source_id) === Number(mediaItem.id));
      if (existing) {
        selectClip(existing.id, "v1");
      } else {
        addMediaToTrack(mediaItem, "v1");
      }
    },
    [body, selectClip, addMediaToTrack],
  );

  const handleAddFromMediaBin = useCallback(async (mediaItem) => {
    const linkedItem = await ensureProjectMediaAsset(mediaItem);
    if (linkedItem) addFromMediaBin(linkedItem);
  }, [addFromMediaBin, ensureProjectMediaAsset]);

  const handleReplaceMedia = useCallback(async (mediaItem) => {
    const linkedItem = await ensureProjectMediaAsset(mediaItem);
    if (linkedItem) replaceSelectedClipSource(linkedItem);
  }, [ensureProjectMediaAsset, replaceSelectedClipSource]);

  const handleDropMedia = useCallback(
    async (mediaItem, trackId, atTime, placement = {}) => {
      const linkedItem = await ensureProjectMediaAsset(mediaItem);
      if (!linkedItem) return;
      if ((trackId === "overlay" || String(trackId).startsWith("ot")) && isAssetMediaItem(linkedItem)) {
        addOverlayFromAsset(linkedItem, {
          x: 0.5,
          y: 0.5,
          atTime: atTime ?? playheadSec,
          overlayTrackId: trackId === "overlay" ? null : trackId,
        });
        return;
      }
      if (atTime != null) {
        addMediaAtTime(linkedItem, trackId, atTime, placement);
      } else {
        addMediaToTrack(linkedItem, trackId);
      }
    },
    [addMediaToTrack, addMediaAtTime, addOverlayFromAsset, ensureProjectMediaAsset, playheadSec],
  );

  const handlePreviewDrop = useCallback(
    async (mediaItem, { x, y }) => {
      const linkedItem = await ensureProjectMediaAsset(mediaItem);
      if (!linkedItem) return;
      if (isAssetMediaItem(linkedItem)) {
        addOverlayFromAsset(linkedItem, { x, y, atTime: playheadSec });
      } else {
        addFromMediaBin(linkedItem);
      }
    },
    [addOverlayFromAsset, addFromMediaBin, ensureProjectMediaAsset, playheadSec],
  );

  const handleSave = useCallback(async () => {
    await saveProject();
  }, [saveProject]);

  const handleAddTextOverlay = useCallback(() => {
    addTextOverlay({
      text: overlayText,
      presetId: textStyleId,
      atTime: playheadSec,
      overlayTrackId: useLiteCutTimelineStore.getState().selectedOverlayTrackId,
      fontFamily: textDefaults.font_family,
      fontFile: textDefaults.font_file,
      fontSize: textDefaults.font_size,
      fontWeight: textDefaults.font_weight,
      lineHeight: textDefaults.line_height,
      align: textDefaults.align,
    });
    setInspectorTab("text");
  }, [addTextOverlay, overlayText, textStyleId, playheadSec, textDefaults]);

  const handleImportSubtitles = useCallback(
    (rawText) => {
      const count = addSubtitleOverlays(rawText, {
        presetId: textStyleId,
        fontFamily: textDefaults.font_family,
        fontFile: textDefaults.font_file,
        fontSize: textDefaults.font_size,
      });
      if (count) setInspectorTab("text");
      return count;
    },
    [addSubtitleOverlays, textStyleId, textDefaults],
  );

  const subtitleCount = useMemo(
    () => (body?.overlays || []).filter((overlay) => overlay?.type === "text" && overlay?.meta?.subtitle).length,
    [body],
  );

  const applyTextPatch = useCallback(
    (patch) => {
      if (selectedTextOverlay?.id) {
        updateOverlayText(selectedTextOverlay.id, patch);
      } else {
        setTextDefaults((prev) => ({ ...prev, ...patch }));
      }
    },
    [selectedTextOverlay, updateOverlayText],
  );

  const handleUseFontAsset = useCallback(
    (asset) => {
      if (!asset?.file_path) return;
      const fontName = String(asset.name || "").replace(/\.[^.]+$/, "") || "Uploaded font";
      applyTextPatch({ font_family: fontName, font_file: asset.file_path });
      setInspectorTab("text");
    },
    [applyTextPatch],
  );

  const handleTextStyleChange = useCallback(
    (id) => {
      setTextStyleId(id);
      const card = TEXT_STYLE_CARDS.find((c) => c.id === id);
      const nextText = selectedTextOverlay ? null : card?.sample;
      if (selectedTextOverlay?.id) {
        updateOverlayText(selectedTextOverlay.id, { preset_id: id });
      } else if (nextText) {
        setOverlayText(nextText);
      }
    },
    [selectedTextOverlay, updateOverlayText],
  );

  const handleTextChange = useCallback(
    (value) => {
      if (selectedTextOverlay?.id) {
        updateOverlayText(selectedTextOverlay.id, { content: value });
      } else {
        setOverlayText(value);
      }
    },
    [selectedTextOverlay, updateOverlayText],
  );

  const handleApplyPresetBody = useCallback(
    (newBody) => {
      if (!newBody) return;
      const cur = useLiteCutEditorStore.getState().body;
      if (cur) useLiteCutHistoryStore.getState().push(cur);
      useLiteCutEditorStore.setState({ body: newBody, dirty: true });
    },
    [],
  );

  const displayName = projectNameProp || projectName;

  if (ffmpegGate.loading) {
    return (
      <div
        className="flex h-full items-center justify-center bg-cs2-bg-page"
        aria-busy="true"
        aria-label={t("montage.ffmpegChecking")}
      >
        <div className="flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-4 py-3 text-sm text-cs2-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
          {t("montage.ffmpegChecking")}
        </div>
      </div>
    );
  }

  if (ffmpegGate.blocked) {
    return (
      <div className="relative h-full min-h-0 bg-cs2-bg-page">
        <FfmpegRequiredDialog
          title={t("liteCut.ffmpegRequiredTitle")}
          subtitle={ffmpegGate.subtitle}
          message={ffmpegGate.message}
          onGoSettings={() => navigate("/settings?tab=video")}
        />
      </div>
    );
  }

  if (loading && !projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-cs2-bg-page text-sm text-cs2-text-muted">
        {t("liteCut.project.loading")}
      </div>
    );
  }

  if (!projectId || !body) {
    return (
      <LiteCutProjectStartPage
        projects={projectList}
        loading={projectListLoading}
        error={error}
        onRefresh={listProjects}
        onOpenProject={handleOpenProject}
        onNewProject={handleNewProject}
        onDeleteProject={handleDeleteProject}
      />
    );
  }

  return (
    <div
      className="litecut-editor-interactive relative flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-cs2-bg-page p-2"
      onDragStartCapture={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[draggable="true"]')) return;
        event.preventDefault();
      }}
    >
      {recoveryCandidate ? (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t("liteCut.recovery.title")}>
          <div className="w-full max-w-md rounded-2xl border border-amber-400/35 bg-cs2-bg-elevated p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">↺</div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-cs2-text-primary">{t("liteCut.recovery.title")}</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-secondary">{t("liteCut.recovery.description")}</p>
                <p className="mt-2 truncate font-mono text-[10px] text-cs2-text-muted">
                  {recoveryCandidate.projectName} · {new Date(recoveryCandidate.savedAt).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={discardRecoveryDraft} className="h-9 rounded-lg border border-cs2-border text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5">{t("liteCut.recovery.discard")}</button>
              <button type="button" onClick={restoreRecoveryDraft} className="h-9 rounded-lg border border-cs2-accent/50 bg-cs2-accent text-[11px] font-bold text-black hover:brightness-110">{t("liteCut.recovery.restore")}</button>
            </div>
          </div>
        </div>
      ) : null}
      <LiteCutToolbar
        projectId={projectId}
        projectName={displayName}
        dirty={dirty}
        saving={saving}
        body={body}
        projects={projectList}
        projectsLoading={projectListLoading}
        onProjectNameChange={setProjectName}
        onSave={handleSave}
        onNewProject={handleNewProject}
        projectTemplates={LITECUT_PROJECT_TEMPLATES}
        onOpenProject={handleOpenProject}
        onDuplicateProject={handleDuplicateProject}
        onDeleteProject={handleDeleteProject}
        onDeleteProjects={handleDeleteProjects}
        onRefreshProjects={listProjects}
        onOpenPresets={() => setPresetsOpen(true)}
        onExportProject={handleExportProject}
        onImportProject={handleImportProject}
        onProjectSettingsChange={patchOutput}
        onOpenExport={() => setExportSettingsOpen(true)}
        onRestoreSnapshot={handleRestoreSnapshot}
        onUpdateMarker={updateMarker}
        onDeleteMarker={deleteMarker}
        onSeekMarker={(time) => { setPlaying(false); setPlayhead(time); }}
      />

      <LiteCutPresetsDrawer
        open={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        projectId={projectId}
        body={body}
        onApplyBody={handleApplyPresetBody}
        buildColorGradeBody={() =>
          activeClip?.color ? colorGradeFromClip(activeClip) : colorGradeFromBody(body)
        }
        buildTransitionBody={() => transitionRhythmFromBody(body)}
        buildPackagingBody={() => packagingBundleFromBody(body)}
      />

      <LiteCutResizableLayout
        mediaBin={
          <LiteCutMediaBin
            projectId={projectId}
            selectedMediaId={activeClip?.source_id ?? null}
            onItemsLoaded={handleMediaItemsLoaded}
            onRecordedDurationChange={handleRecordedMediaDuration}
            onAssetsLoaded={handleAssetsLoaded}
            onUseFontAsset={handleUseFontAsset}
            onAddToTimeline={handleAddFromMediaBin}
            onReplaceSelectedClip={handleReplaceMedia}
            selectedTrackType={selectedTrack?.type ?? null}
            usedAssetIds={usedAssetIds}
            projectBody={body}
            onRelinkMissingAsset={handleRelinkMissingAsset}
          />
        }
        preview={
          <div className="flex h-full min-h-0 w-full flex-col">
            <LiteCutPreviewPanel
              playheadSec={playback?.sourceTime ?? playheadSec}
              totalSec={playback ? playback.clipEnd - playback.clipStart : totalSec}
              timelinePlayhead={playheadSec}
              timelineTotal={totalSec}
              isPlaying={isPlaying}
              userSeekToken={lastUserSeekAt}
              onTogglePlay={restartOrTogglePlayback}
              onPlayheadChange={handlePlayheadFromVideo}
              onTimelineSeek={seekPlayhead}
              onDurationChange={handlePreviewSourceDuration}
              onUnderlayDurationChange={handleUnderlaySourceDuration}
              playbackRate={playback?.clip ? clipSpeedAtTimeline(playback.clip, playback.localTime) : 1}
              reversePlayback={playback?.clip ? clipReversePlayback(playback.clip) : false}
              freezePlayback={Boolean(playback?.freezePlayback || playback?.frozen)}
              transitionMainOpacity={transitionPreview.mainOpacity}
              transitionMainTransform={transitionPreview.mainTransform}
              transitionMainTransformOrigin={transitionPreview.mainTransformOrigin}
              transitionMainClipPath={transitionPreview.mainClipPath}
              transitionCompanionTransform={transitionPreview.companionTransform}
              transitionCompanionTransformOrigin={transitionPreview.companionTransformOrigin}
              transitionFlashOpacity={transitionPreview.flashOpacity}
              transitionBlackOpacity={transitionPreview.blackOpacity}
              clipLocalTime={playback?.localTime ?? 0}
              mainFlipHorizontal={Boolean(playback?.clip?.flip_horizontal)}
              mainFlipVertical={Boolean(playback?.clip?.flip_vertical)}
              mainCrop={playback?.clip?.crop || null}
              mainSourceWidth={playback?.clip?.meta?.source_width || playback?.clip?.meta?.width || 0}
              mainSourceHeight={playback?.clip?.meta?.source_height || playback?.clip?.meta?.height || 0}
              mainFilter={previewFilter.filter}
              mainLayerTransform={
                playbackIsVideoLayer
                  ? sceneTransformAt(
                      { ...playback?.clip, duration: clipSourceDuration(playback?.clip) },
                      playheadSec,
                      VIDEO_SCENE_TRANSFORM_DEFAULTS,
                    )
                  : null
              }
              mainLayerSelected={Boolean(activeClipIsVideoLayer && selectedClipId === playback?.clip?.id)}
              onMainLayerTransform={(patch) => {
                if (playback?.clip?.id && playback?.trackId) {
                  updateClipTransformAtTime(playback.clip.id, playback.trackId, playheadSec, patch);
                }
              }}
              mainIsVideoLayer={playbackIsVideoLayer}
              mainMuted
              mainVolume={0}
              audioPreviewItems={dedicatedAudioPreviewItems}
              underlayStreamUrl={underlayStreamUrl}
              underlaySourceTime={underlayPlayback?.sourceTime ?? 0}
              underlayPlaybackRate={underlayPlayback?.clip ? clipSpeedAtTimeline(underlayPlayback.clip, underlayPlayback.localTime) : 1}
              underlayReversePlayback={underlayPlayback?.clip ? clipReversePlayback(underlayPlayback.clip) : false}
              underlayClipId={underlayPlayback?.clip?.id ?? null}
              underlayFlipHorizontal={Boolean(underlayPlayback?.clip?.flip_horizontal)}
              underlayFlipVertical={Boolean(underlayPlayback?.clip?.flip_vertical)}
              underlayLayers={underlayLayers}
              assetPreviewVersions={assetPreviewVersions}
              fontAssetSources={fontAssetSources}
              canvasFit={previewCanvasFit}
              canvasBackgroundColor={outputBackgroundColor}
              canvasBlurAmount={outputBlurAmount}
              canvasWidth={outputWidth}
              canvasHeight={outputHeight}
              overlayText={activeOverlayText}
              textStyleId={activeTextStyleId}
              selectedElement={inspectorTab === "text" ? "text" : "video"}
              streamUrl={streamUrl}
              mediaTimeOffset={segmentedPreview.mediaTimeOffset}
              segmentedPreview={segmentedPreview.segmented}
              previewPending={segmentedPreview.pending}
              previewProxyError={segmentedPreview.error}
              onPreviewRetry={segmentedPreview.retry}
              preloadStreamUrl={preloadStreamUrl && preloadStreamUrl !== streamUrl ? preloadStreamUrl : null}
              preloadSourceTime={preloadSourceTime}
              previewClipId={previewClip?.id ?? null}
              previewLabel={selectedMedia?.title || null}
              previewOverlays={previewOverlays}
              onDropMedia={handlePreviewDrop}
              selectedOverlayId={selectedTrackId === "overlay" ? selectedClipId : null}
              onOverlaySelect={selectOverlay}
              onOverlayDeselect={clearSelection}
              onOverlayDragStart={beginOverlayDrag}
              onOverlayTransform={(overlayId, patch) => updateOverlayTransformAtTime(overlayId, playheadSec, patch)}
              onMainLayerSelect={() => {
                if (playback?.clip?.id && playback?.trackId) selectClip(playback.clip.id, playback.trackId);
              }}
              sequenceMode
            />
          </div>
        }
        properties={
          <LiteCutPropertyPanel
            defaultTab={inspectorTab}
            selectedMedia={selectedMedia}
            streamUrl={activeClipStreamUrl}
            clipPreviewSourceTime={activeClipPreviewSourceTime}
            clipPreviewKey={activeClip?.id ?? null}
            clipPreviewPlaying={isPlaying}
            transitionType={transitionType}
            transitionDuration={transitionDuration}
            transitionInDuration={transitionInDuration}
            transitionOutDuration={transitionOutDuration}
            onTransitionChange={updateSelectedTransitionType}
            onTransitionDurationChange={(d) => updateSelectedTransition(transitionType, d)}
            onTransitionInDurationChange={(d) => updateSelectedTransitionDuration("in", d)}
            onTransitionOutDurationChange={(d) => updateSelectedTransitionDuration("out", d)}
            canApplyTransitionTrack={canApplySelectedTransitionToScope("track", transitionType, transitionDuration)}
            canApplyTransitionAll={canApplySelectedTransitionToScope("all", transitionType, transitionDuration)}
            onApplyTransitionScope={(scope) => applySelectedTransitionToScope(scope, transitionType, transitionDuration)}
            brightness={activeColor.brightness}
            contrast={activeColor.contrast}
            saturation={activeColor.saturation}
            onColorChange={(patch) => updateSelectedColor(patch)}
            filterPreset={activeClip?.color?.filter_preset || "none"}
            onFilterPresetChange={(id) => updateSelectedColor({ filter_preset: id === "none" ? null : id })}
            canApplyColorTrack={canApplySelectedColorToScope("track", activeColor)}
            canApplyColorAll={canApplySelectedColorToScope("all", activeColor)}
            onApplyColorScope={(scope) => applySelectedColorToScope(scope, activeColor)}
            textStyleId={activeTextStyleId}
            onTextStyleChange={handleTextStyleChange}
            text={activeOverlayText}
            onTextChange={handleTextChange}
            onAddText={handleAddTextOverlay}
            onImportSubtitles={handleImportSubtitles}
            subtitleCount={subtitleCount}
            onApplySubtitleStyle={(patch) => applyTextPatchToSubtitles(patch)}
            textFontFamily={activeTextFontFamily}
            textFontFile={activeTextFontFile}
            textFontSize={activeTextFontSize}
            textFontWeight={activeTextFontWeight}
            textLineHeight={activeTextLineHeight}
            textAlign={activeTextAlign}
            textFillColor={activeClip?.text?.fill_color || null}
            fontAssets={fontAssets}
            audioAssets={audioAssets}
            onTextPatch={applyTextPatch}
            onTabChange={setInspectorTab}
            outputDir={outputDir}
            outputDirHint={outputDirHint}
            outputFilename={outputFilename}
            outputWidth={outputWidth}
            outputHeight={outputHeight}
            outputFps={outputFps}
            outputFrameMeldEnabled={outputFrameMeldEnabled}
            outputFrameMeldAvailable={ffmpegGate.framemeldAvailable}
            framemeldSourceItems={framemeldSourceItems}
            outputEncoder={outputEncoder}
            outputEncoderTier={outputEncoderTier}
            outputCanvasFit={outputCanvasFit}
            outputBackgroundColor={outputBackgroundColor}
            outputBlurAmount={outputBlurAmount}
            outputRangeMode={outputRange.rangeMode}
            outputRangeStartSec={outputRange.rangeStartSec}
            outputRangeEndSec={outputRange.rangeEndSec}
            outputRangeValid={outputRange.rangeValid}
            selectedExportRange={selectedExportRange}
            timelineTotalSec={totalSec}
            currentPlayheadSec={playheadSec}
            onOutputDirChange={(dir) => patchOutput({ dir })}
            onOutputFilenameChange={(name) => patchOutput({ filename: name })}
            onOutputSettingsChange={(patch) => patchOutput(patch)}
            onExport={() => void handleExport()}
            exporting={exporting}
            exportError={exportError}
            exportProgress={exportJob?.progress ?? 0}
            exportStage={exportJob?.stage || exportJob?.status || ""}
            exportStatus={exportJob?.status || ""}
            exportHistory={exportHistory}
            onRefreshExportHistory={loadExportHistory}
            onCancelExport={handleCancelExport}
            v1ClipCount={exportableClipCount}
            isOverlay={selectedTrackId === "overlay"}
            overlayTransform={overlayTransform}
            overlayTransitionType={overlayTransitionType}
            overlayTransitionInSec={overlayTransitionInSec}
            overlayTransitionOutSec={overlayTransitionOutSec}
            onOverlayTransformChange={(patch) => {
              if (selectedClipId) updateOverlayTransformAtTime(selectedClipId, playheadSec, patch);
            }}
            overlayHasKeyframe={overlayHasKeyframe}
            onAddOverlayKeyframe={() => selectedClipId && upsertOverlayKeyframe(selectedClipId, playheadSec)}
            onRemoveOverlayKeyframe={() => selectedClipId && removeOverlayKeyframe(selectedClipId, playheadSec)}
            onApplyMotionPreset={(preset) => {
              if (!selectedClipId) return;
              if (selectedTrackId === "overlay") applyOverlayMotionPreset(selectedClipId, preset);
              else if (activeClipIsVideoLayer && selectedTrackId) applyClipMotionPreset(selectedClipId, selectedTrackId, preset);
            }}
            onOverlayPatch={(patch) => {
              if (selectedClipId) updateOverlay(selectedClipId, patch);
            }}
            clipSpeed={activeClipSpeed}
            onClipSpeedChange={(speed) => activeClipSupportsSpeed && updateSelectedClip({ speed, speed_keyframes: [] })}
            clipSpeedKeyframes={activeClip?.speed_keyframes || []}
            clipTrimIn={Number(activeClip?.trim_in) || 0}
            onClipSpeedKeyframesChange={(speed_keyframes) => activeClipSupportsSpeedRamp && updateSelectedClip({ speed_keyframes })}
            clipPreservePitch={clipPreservePitch(activeClip)}
            onClipPreservePitchChange={(preserve_pitch) => activeClipSupportsPreservePitch && updateSelectedClip({ preserve_pitch })}
            clipReverse={clipReversePlayback(activeClip)}
            onClipReverseChange={(reverse) => activeClipSupportsReverse && updateSelectedClip({ reverse })}
            clipFreezeFrameSec={activeClipFreezeFrameSec}
            onClipFreezeFrameChange={(freeze_frame_sec) => activeClipSupportsFreeze && updateSelectedClip({ freeze_frame_sec })}
            clipVolume={activeClipVolume}
            onClipVolumeChange={(volume) => {
              if (audioEditingClip?.id && audioEditingTrackId) {
                updateClipVolumeAtTime(audioEditingClip.id, audioEditingTrackId, playheadSec, volume);
              }
            }}
            clipHasAudioKeyframe={activeClipHasAudioKeyframe}
            onAddClipAudioKeyframe={() => audioEditingClip?.id && audioEditingTrackId && upsertClipAudioKeyframe(audioEditingClip.id, audioEditingTrackId, playheadSec)}
            onRemoveClipAudioKeyframe={() => audioEditingClip?.id && audioEditingTrackId && removeClipAudioKeyframe(audioEditingClip.id, audioEditingTrackId, playheadSec)}
            isAudioClip={activeClipIsAudio}
            clipMuted={audioEditingMuted}
            trackVolume={activeTrackVolume}
            trackLabel={audioEditingTrack?.name || audioEditingTrack?.label || "轨道"}
            onTrackVolumeChange={(volume) => audioEditingTrackId && audioEditingTrackId !== "overlay" && updateTrack(audioEditingTrackId, { volume }, { recordHistory: false })}
            clipFadeInSec={activeClipFadeInSec}
            clipFadeOutSec={activeClipFadeOutSec}
            clipVisibleDuration={activeClipVisibleDuration}
            clipCanvasFit={activeClipCanvasFit}
            projectCanvasFit={outputCanvasFit}
            onClipCanvasFitChange={(content_fit) => updateSelectedClip({ content_fit })}
            clipFlipHorizontal={activeClipFlipHorizontal}
            clipFlipVertical={activeClipFlipVertical}
            clipTransform={activeClipTransform}
            onClipTransformChange={(patch) => {
              if (selectedClipId && selectedTrackId) updateClipTransformAtTime(selectedClipId, selectedTrackId, playheadSec, patch);
            }}
            clipHasKeyframe={activeClipHasKeyframe}
            onAddClipKeyframe={() => selectedClipId && selectedTrackId && upsertClipKeyframe(selectedClipId, selectedTrackId, playheadSec)}
            onRemoveClipKeyframe={() => selectedClipId && selectedTrackId && removeClipKeyframe(selectedClipId, selectedTrackId, playheadSec)}
            clipCrop={activeClipCrop}
            onClipCropChange={(patch) => updateSelectedClip({ crop: { ...activeClipCrop, ...patch } })}
            clipSupportsCrop={activeVisualCapabilities.has("crop")}
            clipSupportsContentFit={activeVisualCapabilities.has("content_fit")}
            clipSupportsSpeed={activeClipSupportsSpeed}
            clipSupportsSpeedRamp={activeClipSupportsSpeedRamp}
            clipSupportsReverse={activeClipSupportsReverse}
            clipSupportsFreeze={activeClipSupportsFreeze}
            clipSupportsPreservePitch={activeClipSupportsPreservePitch}
            isVideoLayer={activeClipIsVideoLayer}
            masterVolume={masterVolume}
            onMasterVolumeChange={(master_volume) => patchAudio({ master_volume })}
            bgm={bgm}
            onBgmChange={(nextBgm) => patchAudio({ bgm: nextBgm })}
            onClipAudioPatch={(patch) => {
              if (audioEditingClip?.id && audioEditingTrackId && audioEditingTrackId !== "overlay") {
                updateClip(audioEditingClip.id, audioEditingTrackId, patch);
              }
            }}
            selectedClipSourceDuration={activeClipSourceDuration}
            audioTargetIsAudioClip={audioEditingIsAudioClip}
            audioTargetFadeInSec={audioEditingFadeInSec}
            audioTargetFadeOutSec={audioEditingFadeOutSec}
            audioTargetSourceDuration={audioEditingSourceDuration}
            audioTargetTrimIn={audioEditingTrimIn}
            selectedClipLabel={clipToMedia(audioEditingClip, mediaCache)?.title || selectedMedia?.title || ""}
            clipAudioUrl={audioEditingTrack?.type === "audio" ? clipStreamUrl(audioEditingClip) : null}
          />
        }
        timeline={<LiteCutTimelinePanel body={body} onDropMedia={handleDropMedia} />}
      />
      <LiteCutExportSettingsDialog open={exportSettingsOpen} onClose={() => setExportSettingsOpen(false)}>
        <ExportPane
          outputDir={outputDir}
          outputDirHint={outputDirHint}
          filename={outputFilename}
          width={outputWidth}
          height={outputHeight}
          fps={outputFps}
          framemeldEnabled={outputFrameMeldEnabled}
          framemeldRuntimeAvailable={ffmpegGate.framemeldAvailable}
          framemeldSourceItems={framemeldSourceItems}
          encoder={outputEncoder}
          encoderTier={outputEncoderTier}
          rangeMode={outputRange.rangeMode}
          rangeStartSec={outputRange.rangeStartSec}
          rangeEndSec={outputRange.rangeEndSec}
          rangeValid={outputRange.rangeValid}
          selectedExportRange={selectedExportRange}
          timelineTotalSec={totalSec}
          currentPlayheadSec={playheadSec}
          onOutputDirChange={(dir) => patchOutput({ dir })}
          onFilenameChange={(name) => patchOutput({ filename: name })}
          onOutputSettingsChange={(patch) => patchOutput(patch)}
          onExport={() => {
            setExportSettingsOpen(false);
            void handleExport();
          }}
          exporting={exporting}
          exportError={exportError}
          exportHistory={exportHistory}
          onRefreshExportHistory={loadExportHistory}
          clipCount={exportableClipCount}
        />
      </LiteCutExportSettingsDialog>
      <LiteCutExportProgressDialog
        phase={exportDialog.phase}
        result={exportDialog.result}
        error={exportDialog.error}
        onClose={dismissExportDialog}
        onCancel={() => void handleCancelExport()}
      />
    </div>
  );
}
