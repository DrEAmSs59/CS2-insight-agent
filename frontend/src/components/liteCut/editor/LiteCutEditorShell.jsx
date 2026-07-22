import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import LiteCutToolbar from "./LiteCutToolbar.jsx";
import LiteCutMediaBin from "./LiteCutMediaBin.jsx";
import LiteCutPreviewPanel from "./LiteCutPreviewPanel.jsx";
import LiteCutPropertyPanel from "./LiteCutPropertyPanel.jsx";
import LiteCutTimelinePanel from "./LiteCutTimelinePanel.jsx";
import LiteCutResizableLayout from "./LiteCutResizableLayout.jsx";
import LiteCutPresetsDrawer from "./LiteCutPresetsDrawer.jsx";
import LiteCutProjectStartPage from "./LiteCutProjectStartPage.jsx";
import LiteCutExportProgressDialog from "./LiteCutExportProgressDialog.jsx";
import FfmpegRequiredDialog from "../../FfmpegRequiredDialog.jsx";
import { filterStyleFromColor, TEXT_STYLE_CARDS } from "./editorPresets.js";
import { transitionPreviewVisual } from "./transitionPreviewUtils.js";
import { LITECUT_PROJECT_TEMPLATES, projectBodyFromTemplate } from "./projectTemplates.js";
import { inspectorTabForTimelineSelection } from "./inspectorSelectionUtils.js";
import API, { getLiteCutAssetStreamUrl, getRecordedClipStreamUrl } from "../../../api/api.js";
import { desktopBridge } from "../../../desktop/desktopBridge.js";
import { useLiteCutEditorStore } from "../../../stores/liteCutEditorStore.js";
import { collectUsedLiteCutAssetIds, mapAssetRow } from "../../../stores/liteCut/assetUtils.js";
import { liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";
import {
  LITE_CUT_AUTOSAVE_FLUSH_EVENTS,
  LITE_CUT_AUTOSAVE_DELAY_MS,
  shouldScheduleLiteCutAutosave,
  shouldFlushLiteCutAutosave,
} from "../../../stores/liteCut/autosaveUtils.js";
import { mapRecordedClipRow } from "../../../stores/liteCut/mediaUtils.js";
import { overlayTransformAt, VIDEO_LAYER_TRANSFORM_DEFAULTS } from "../../../stores/liteCut/overlayKeyframeUtils.js";
import { audioKeyframeNearPlayhead, clipVolumeAt } from "../../../stores/liteCut/audioKeyframeUtils.js";
import { relinkMissingAssetReferences } from "../../../stores/liteCut/relinkUtils.js";
import {
  defaultLiteCutFilename,
  cancelLiteCutExport,
  getLiteCutExportStatus,
  listLiteCutExports,
  liteCutRangePatchFromPlayhead,
  normalizeLiteCutExportRange,
  resolveLiteCutOutputDir,
  startLiteCutExport,
} from "../../../stores/liteCut/exportUtils.js";
import {
  nextTopVideoPlaybackAfter,
  hasSoloAudioTracks,
  resolveAudioPreviewItems,
  resolveBaseVideoTrackId,
  resolveIncomingTransitionPlayback,
  resolveOutgoingTransitionPreload,
  selectedClipPreviewSourceTime,
  resolveTopVideoPlaybackAt,
  resolveVideoUnderlayPlaybackAt,
  resolveVideoUnderlayPlaybacksAt,
} from "../../../stores/liteCut/playbackUtils.js";
import { useLiteCutHistoryStore } from "../../../stores/liteCut/historyStore.js";
import {
  isEditableShortcutTarget,
  resolveLiteCutShortcut,
} from "../../../stores/liteCut/keyboardShortcuts.js";
import {
  colorGradeFromBody,
  colorGradeFromClip,
  packagingBundleFromBody,
  transitionRhythmFromBody,
} from "../../../stores/liteCut/presetUtils.js";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";
import {
  clipPlaybackSpeed,
  clipSpeedAtTimeline,
  clipTimelineEnd,
  clipTimelineTimeForSource,
  clipCanvasFit,
  clipFreezeFrameSec,
  clipPreservePitch,
  clipReversePlayback,
  clipSourceDuration,
  clipTrimmedSourceDuration,
  findClipById,
  getTrack,
  isAssetMediaItem,
  mainVideoClips,
  overlaysActiveAt,
  projectFrameStepSec,
  resolveAudioEditingTarget,
  selectedTimelineRange,
  timelineTotalSec,
} from "../../../stores/liteCut/timelineUtils.js";
import { formatMontageApiError } from "../../../utils/formatMontageApiError.js";
import { messageFromApiCode } from "../../../utils/apiErrorMessages.js";
import { stripMp4Extension } from "../../../utils/montageUtils.js";
import { useT } from "../../../i18n/useT.js";

const FFMPEG_GATE_IDLE = { loading: true, blocked: false, subtitle: "", message: "" };

function ffmpegGateSubtitle(reason, t) {
  if (reason === "not_configured") return t("montage.ffmpegGateNotConfigured");
  if (reason === "path_not_found") return t("montage.ffmpegGatePathNotFound");
  if (reason === "not_usable") return t("montage.ffmpegGateNotUsable");
  return t("montage.ffmpegGateNotReady");
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
  onExportPhaseChange,
}) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [ffmpegGate, setFfmpegGate] = useState(FFMPEG_GATE_IDLE);
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
    loadOrCreateProject,
    listProjects,
    openProject,
    createNewProject,
    importProject,
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
  const detachSelectedAudio = useLiteCutTimelineStore((s) => s.detachSelectedAudio);
  const addFromMediaBin = useLiteCutTimelineStore((s) => s.addFromMediaBin);
  const replaceSelectedClipSource = useLiteCutTimelineStore((s) => s.replaceSelectedClipSource);
  const backfillClipSourceDuration = useLiteCutTimelineStore((s) => s.backfillClipSourceDuration);

  const [inspectorTab, setInspectorTab] = useState(defaultInspectorTab);
  const [textStyleId, setTextStyleId] = useState("clutch");
  const [overlayText, setOverlayText] = useState("CLUTCH");
  const [textDefaults, setTextDefaults] = useState({ font_family: "微软雅黑", font_file: null, font_size: 64 });
  const [fontAssets, setFontAssets] = useState([]);
  const [audioAssets, setAudioAssets] = useState([]);
  const [assetPreviewVersions, setAssetPreviewVersions] = useState({});
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportJob, setExportJob] = useState(null);
  const [exportDialog, setExportDialog] = useState({ phase: "idle", result: null, error: "" });
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
  const [exportHistory, setExportHistory] = useState([]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const selectionInspectorTab = useMemo(
    () => inspectorTabForTimelineSelection(body, selectedClipId, selectedTrackId),
    [body, selectedClipId, selectedTrackId],
  );

  useEffect(() => {
    if (selectionInspectorTab) setInspectorTab(selectionInspectorTab);
  }, [selectedClipId, selectedTrackId, selectionInspectorTab]);

  const checkFfmpegGate = useCallback(async ({ showLoading = true } = {}) => {
    if (showLoading) {
      setFfmpegGate((prev) => ({ ...prev, loading: true }));
    }
    try {
      const { data } = await API.get("config/ffmpeg-check");
      if (data?.ok) {
        setFfmpegGate({ loading: false, blocked: false, subtitle: "", message: "" });
        return;
      }
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: ffmpegGateSubtitle(data?.reason, t),
        message: t("liteCut.ffmpegGateDefaultMessage"),
      });
    } catch {
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: t("montage.ffmpegGateDetectFail"),
        message: t("montage.ffmpegGateConnectFail"),
      });
    }
  }, [t]);

  useEffect(() => {
    void checkFfmpegGate();
  }, [checkFfmpegGate, location.pathname]);

  useEffect(() => {
    // Native file pickers temporarily blur the window. Recheck FFmpeg after
    // focus returns without unmounting the editor and losing the file input's
    // pending change event or the media-bin tab state.
    const onFocus = () => void checkFfmpegGate({ showLoading: false });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkFfmpegGate]);

  useEffect(() => {
    if (ffmpegGate.loading || ffmpegGate.blocked) return;
    void loadOrCreateProject();
  }, [loadOrCreateProject, ffmpegGate.loading, ffmpegGate.blocked]);

  useEffect(() => {
    if (dirty && projectId && body) persistRecoveryDraft();
  }, [body, dirty, persistRecoveryDraft, projectId, projectName]);

  useEffect(() => {
    const stateAtSchedule = useLiteCutEditorStore.getState();
    if (!shouldScheduleLiteCutAutosave(stateAtSchedule)) return undefined;
    const projectIdAtSchedule = stateAtSchedule.projectId;
    const timer = window.setTimeout(() => {
      const state = useLiteCutEditorStore.getState();
      if (
        shouldScheduleLiteCutAutosave({
          projectId: state.projectId,
          body: state.body,
          dirty: state.dirty,
          loading: state.loading,
          saving: state.saving,
        }) &&
        Number(state.projectId) === Number(projectIdAtSchedule)
      ) {
        void saveProject();
      }
    }, LITE_CUT_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [projectId, body, projectName, dirty, loading, saveProject]);

  useEffect(() => {
    const flushAutosave = (event) => {
      if (shouldFlushLiteCutAutosave(event, useLiteCutEditorStore.getState())) {
        void saveProject();
        if (event.type === "beforeunload") {
          event.preventDefault();
          event.returnValue = "";
        }
      }
    };
    for (const eventName of LITE_CUT_AUTOSAVE_FLUSH_EVENTS) {
      window.addEventListener(eventName, flushAutosave);
    }
    return () => {
      for (const eventName of LITE_CUT_AUTOSAVE_FLUSH_EVENTS) {
        window.removeEventListener(eventName, flushAutosave);
      }
    };
  }, [saveProject]);

  const loadFontAssets = useCallback(async () => {
    try {
      const { data } = await API.get("/lite-cut/assets", {
        params: { project_id: projectId ?? undefined, limit: 500 },
      });
      const mapped = (data.items || []).map(mapAssetRow).filter(Boolean);
      setFontAssets(mapped.filter((a) => a?.kind === "font"));
      setAudioAssets(mapped.filter((a) => a?.kind === "audio"));
      setAssetPreviewVersions(Object.fromEntries(mapped.map((asset) => [Number(asset.id), asset.preview_proxy_version || "source"])));
    } catch {
      setFontAssets([]);
      setAudioAssets([]);
      setAssetPreviewVersions({});
    }
  }, [projectId]);

  useEffect(() => {
    void loadFontAssets();
  }, [loadFontAssets]);

  const loadExportHistory = useCallback(async () => {
    try {
      const { items } = await listLiteCutExports({ projectId: projectId ?? null, limit: 8 });
      setExportHistory(Array.isArray(items) ? items : []);
    } catch {
      setExportHistory([]);
    }
  }, [projectId]);

  useEffect(() => {
    void loadExportHistory();
  }, [loadExportHistory]);

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
  const outputWidth = Math.max(320, Math.min(7680, Number(body?.output?.width) || 1920));
  const outputHeight = Math.max(180, Math.min(4320, Number(body?.output?.height) || 1080));
  const outputFps = Math.max(1, Math.min(240, Number(body?.output?.fps) || 60));
  const outputEncoder = ["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"].includes(body?.output?.encoder)
    ? body.output.encoder
    : "auto";
  const outputEncoderTier = body?.output?.encoder_tier === "fast" ? "fast" : "quality";
  const outputCanvasFit = ["contain", "cover", "blur"].includes(body?.output?.canvas_fit) ? body.output.canvas_fit : "contain";
  const outputBackgroundColor = /^#[0-9a-f]{6}$/i.test(String(body?.output?.background_color || ""))
    ? body.output.background_color
    : "#000000";
  const outputBlurAmount = Math.max(4, Math.min(80, Number(body?.output?.blur_amount) || 24));
  const outputRange = useMemo(() => normalizeLiteCutExportRange(body?.output, totalSec), [body?.output, totalSec]);
  const selectedExportRange = useMemo(
    () => selectedTimelineRange(body, selectedClipIds?.length ? selectedClipIds : selectedClipId ? [selectedClipId] : []),
    [body, selectedClipId, selectedClipIds],
  );
  const rawMasterVolume = Number(body?.audio?.master_volume);
  const masterVolume = Math.max(0, Math.min(2, Number.isFinite(rawMasterVolume) ? rawMasterVolume : 1));
  const bgm = body?.audio?.bgm && typeof body.audio.bgm === "object" ? body.audio.bgm : null;
  const usedAssetIds = useMemo(() => collectUsedLiteCutAssetIds(body), [body]);
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
  const outputFilename = useMemo(
    () => stripMp4Extension(body?.output?.filename || defaultLiteCutFilename(body, projectName)),
    [body, projectName],
  );

  const playback = useMemo(() => resolveTopVideoPlaybackAt(body, playheadSec), [body, playheadSec]);
  const baseVideoTrackId = useMemo(() => resolveBaseVideoTrackId(body), [body]);
  const playbackIsVideoLayer = Boolean(playback?.trackId && getTrack(body, playback.trackId)?.type === "video");
  const underlayPlayback = useMemo(
    () => resolveVideoUnderlayPlaybackAt(body, playheadSec, playback),
    [body, playheadSec, playback],
  );
  const underlayPlaybacks = useMemo(
    () => resolveVideoUnderlayPlaybacksAt(body, playheadSec, playback),
    [body, playheadSec, playback],
  );
  const incomingTransitionPlayback = useMemo(
    () => resolveIncomingTransitionPlayback(body, playback),
    [body, playback],
  );
  const outgoingTransitionPreload = useMemo(
    () => resolveOutgoingTransitionPreload(body, playback),
    [body, playback],
  );
  const backgroundTransition = useMemo(() => {
    if (!playback?.clip || !playback?.trackId) return null;
    const clips = [...(getTrack(body, playback.trackId)?.clips || [])].sort((a, b) => (Number(a.timeline_start) || 0) - (Number(b.timeline_start) || 0));
    const index = clips.findIndex((clip) => clip.id === playback.clip.id);
    const local = Math.max(0, Number(playback.localTime) || 0);
    const clipDuration = Math.max(0, (Number(playback.clipEnd) || 0) - (Number(playback.clipStart) || 0));
    if (index === 0) {
      const transition = playback.clip.transition_in;
      const duration = Math.max(0, Math.min(1.5, Number(transition?.duration_sec) || 0));
      if (transition?.type && transition.type !== "cut" && duration >= 0.02 && local < duration) {
        return {
          visual: transitionPreviewVisual(transition.type, local / duration),
          spec: { type: transition.type, phase: "in", duration, startLocalTime: 0 },
        };
      }
    }
    if (index === clips.length - 1) {
      const transition = playback.clip.transition_out;
      const duration = Math.max(0, Math.min(1.5, Number(transition?.duration_sec) || 0));
      if (transition?.type && transition.type !== "cut" && duration >= 0.02 && local >= clipDuration - duration) {
        return {
          visual: transitionPreviewVisual(transition.type, 1 - ((local - (clipDuration - duration)) / duration)),
          spec: { type: transition.type, phase: "out", duration, startLocalTime: clipDuration - duration },
        };
      }
    }
    return null;
  }, [body, playback]);
  const previewOverlays = useMemo(() => overlaysActiveAt(body, playheadSec), [body, playheadSec]);
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
          ? getLiteCutAssetStreamUrl(aid, selectedClip.meta?.preview_proxy_version || assetPreviewVersions?.[Number(aid)] || "")
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

  const overlayTransform = selectedTrackId === "overlay" ? overlayTransformAt(selectedClip, playheadSec) : null;
  const overlayHasKeyframe = Boolean(
    selectedTrackId === "overlay" &&
      selectedClip?.keyframes?.some(
        (keyframe) => Math.abs((Number(keyframe?.time_sec) || 0) - (playheadSec - (Number(selectedClip?.timeline_start) || 0))) <= 0.04,
      ),
  );
  const overlayFadeInSec = selectedTrackId === "overlay" ? Math.max(0, Number(selectedClip?.fade_in_sec) || 0) : 0;
  const overlayFadeOutSec = selectedTrackId === "overlay" ? Math.max(0, Number(selectedClip?.fade_out_sec) || 0) : 0;
  const overlayTransitionType = selectedTrackId === "overlay" ? String(selectedClip?.transition_out?.type || selectedClip?.transition_in?.type || "cut") : "cut";
  const overlayTransitionInSec = selectedTrackId === "overlay" ? Math.max(0, Number(selectedClip?.transition_in?.duration_sec) || 0) : 0;
  const overlayTransitionOutSec = selectedTrackId === "overlay" ? Math.max(0, Number(selectedClip?.transition_out?.duration_sec) || 0) : 0;
  const selectedTextOverlay = selectedTrackId === "overlay" && selectedClip?.type === "text" ? selectedClip : null;
  const activeTextStyleId = selectedTextOverlay?.text?.preset_id || selectedTextOverlay?.meta?.textStyleId || textStyleId;
  const activeOverlayText = selectedTextOverlay?.text?.content ?? overlayText;
  const activeTextFontFamily = selectedTextOverlay?.text?.font_family ?? textDefaults.font_family;
  const activeTextFontFile = selectedTextOverlay?.text?.font_file ?? textDefaults.font_file;
  const activeTextFontSize = selectedTextOverlay?.text?.font_size ?? textDefaults.font_size;
  const activeTextAnimIn = selectedTextOverlay?.text?.anim_in || "";
  const activeTextAnimOut = selectedTextOverlay?.text?.anim_out || "";

  const clipStreamUrl = useCallback(
    (clip) => liteCutClipStreamUrl(clip, assetPreviewVersions),
    [assetPreviewVersions],
  );

  const streamUrl = useMemo(() => clipStreamUrl(previewClip), [clipStreamUrl, previewClip]);
  const nextPreviewPlayback = useMemo(
    () => (playback?.clip ? nextTopVideoPlaybackAfter(body, playback) : null),
    [body, playback],
  );
  const preloadStreamUrl = useMemo(
    () => clipStreamUrl(nextPreviewPlayback?.clip),
    [clipStreamUrl, nextPreviewPlayback?.clip],
  );
  const underlayStreamUrl = useMemo(() => clipStreamUrl(underlayPlayback?.clip), [clipStreamUrl, underlayPlayback?.clip]);
  const activeClipStreamUrl = useMemo(() => clipStreamUrl(activeClip), [activeClip, clipStreamUrl]);
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

  const transitionType = activeClip?.transition_out?.type || "fade";
  const transitionDuration = activeClip?.transition_out?.duration_sec ?? 0.4;
  const transitionInDuration = activeClip?.transition_in?.duration_sec ?? 0.25;
  const transitionOutDuration = activeClip?.transition_out?.duration_sec ?? 0.25;
  const activeColor = {
    brightness: activeClip?.color?.brightness ?? 0,
    contrast: activeClip?.color?.contrast ?? 0,
    saturation: activeClip?.color?.saturation ?? 0,
    filter_preset: activeClip?.color?.filter_preset || null,
  };
  const activeClipSpeed = selectedTrackId === "overlay" ? 1 : clipPlaybackSpeed(activeClip);
  const activeClipFreezeFrameSec = selectedTrackId === "overlay" ? 0 : clipFreezeFrameSec(activeClip);
  const activeClipCanvasFit = selectedTrackId === "overlay" ? null : activeClip?.canvas_fit || null;
  const previewCanvasFit = playback?.clip ? clipCanvasFit(playback.clip, outputCanvasFit) : outputCanvasFit;
  const selectedTrack = selectedTrackId && selectedTrackId !== "overlay" ? getTrack(body, selectedTrackId) : null;
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
  const activeClipIsVideoLayer = Boolean(selectedTrack?.type === "video");
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
    ? overlayTransformAt(
        { ...activeClip, duration: clipSourceDuration(activeClip), transform: activeClipBaseTransform },
        playheadSec,
        VIDEO_LAYER_TRANSFORM_DEFAULTS,
      )
    : null;
  const activeClipHasKeyframe = Boolean(
    activeClipIsVideoLayer && activeClip?.keyframes?.some(
      (keyframe) => Math.abs((Number(keyframe?.time_sec) || 0) - (playheadSec - (Number(activeClip?.timeline_start) || 0))) <= 0.04,
    ),
  );
  const activeClipIsAudio =
    selectedTrackId !== "overlay" && Boolean(selectedTrack?.type === "audio" || activeClip?.meta?.kind === "audio");
  const activeClipCrop = activeClipIsAudio || selectedTrackId === "overlay"
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
  const activeTrackVolume = selectedTrackId === "overlay" ? 1 : Math.max(0, Math.min(2, Number.isFinite(rawActiveTrackVolume) ? rawActiveTrackVolume : 1));
  const activeClipFadeInSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(activeClip?.fade_in_sec) || 0);
  const activeClipFadeOutSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(activeClip?.fade_out_sec) || 0);
  const activeClipSourceDuration = selectedTrackId === "overlay" ? 0 : clipTrimmedSourceDuration(activeClip);
  const activeClipVisibleDuration = selectedTrackId === "overlay" ? 0 : clipSourceDuration(activeClip);
  const audioEditingMuted = selectedTrackId === "overlay" ? false : Boolean(audioEditingClip?.muted);
  const audioEditingFadeInSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.fade_in_sec) || 0);
  const audioEditingFadeOutSec = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.fade_out_sec) || 0);
  const audioEditingSourceDuration = selectedTrackId === "overlay" ? 0 : clipTrimmedSourceDuration(audioEditingClip);
  const audioEditingTrimIn = selectedTrackId === "overlay" ? 0 : Math.max(0, Number(audioEditingClip?.trim_in) || 0);
  const previewClipFadeInSec = Math.max(0, Number(previewClip?.fade_in_sec) || 0);
  const previewClipFadeOutSec = Math.max(0, Number(previewClip?.fade_out_sec) || 0);
  const activeClipFlipHorizontal = Boolean(activeClip?.flip_horizontal);
  const activeClipFlipVertical = Boolean(activeClip?.flip_vertical);
  const previewClipVisibleDuration = playback?.clip ? clipSourceDuration(playback.clip) : 0;
  const underlayFadeInSec = Math.max(0, Number(underlayPlayback?.clip?.fade_in_sec) || 0);
  const underlayFadeOutSec = Math.max(0, Number(underlayPlayback?.clip?.fade_out_sec) || 0);
  const underlayVisibleDuration = underlayPlayback?.clip ? clipSourceDuration(underlayPlayback.clip) : 0;
  const underlayFadeInFactor =
    underlayFadeInSec > 0 ? Math.min(1, Math.max(0, Number(underlayPlayback?.localTime) || 0) / underlayFadeInSec) : 1;
  const underlayFadeOutFactor =
    underlayFadeOutSec > 0 && underlayVisibleDuration > 0
      ? Math.min(1, Math.max(0, (underlayVisibleDuration - (Number(underlayPlayback?.localTime) || 0)) / underlayFadeOutSec))
      : 1;
  const underlayOpacity = Math.min(underlayFadeInFactor, underlayFadeOutFactor);
  const underlayLayers = useMemo(
    () => {
      const layers = underlayPlaybacks.map((layer) => {
        const duration = clipSourceDuration(layer.clip);
        const local = Number(layer.localTime) || 0;
        const fadeIn = Math.max(0, Number(layer.clip?.fade_in_sec) || 0);
        const fadeOut = Math.max(0, Number(layer.clip?.fade_out_sec) || 0);
        const fadeInFactor = fadeIn > 0 ? Math.min(1, Math.max(0, local) / fadeIn) : 1;
        const fadeOutFactor = fadeOut > 0 && duration > 0 ? Math.min(1, Math.max(0, (duration - local) / fadeOut)) : 1;
        return {
          id: layer.clip?.id || layer.trackId,
          streamUrl: clipStreamUrl(layer.clip),
          sourceTime: layer.sourceTime,
          playbackRate: clipSpeedAtTimeline(layer.clip, layer.localTime),
          reversePlayback: clipReversePlayback(layer.clip),
          opacity: Math.min(fadeInFactor, fadeOutFactor),
          flipHorizontal: Boolean(layer.clip?.flip_horizontal),
          flipVertical: Boolean(layer.clip?.flip_vertical),
          filter: filterStyleFromColor({
            brightness: layer.clip?.color?.brightness ?? 0,
            contrast: layer.clip?.color?.contrast ?? 0,
            saturation: layer.clip?.color?.saturation ?? 0,
            preset: layer.clip?.color?.filter_preset || "none",
          }).filter,
          transform:
            layer.trackId === baseVideoTrackId
              ? null
              : overlayTransformAt(
                  { ...layer.clip, duration: clipSourceDuration(layer.clip), transform: { ...VIDEO_LAYER_TRANSFORM_DEFAULTS, ...(layer.clip?.transform || {}) } },
                  playheadSec,
                  VIDEO_LAYER_TRANSFORM_DEFAULTS,
                ),
        };
      });
      const transitionUnderlay = incomingTransitionPlayback || outgoingTransitionPreload;
      if (transitionUnderlay?.clip) {
        const clip = transitionUnderlay.clip;
        layers.push({
          id: `transition-${clip.id}`,
          streamUrl: clipStreamUrl(clip),
          sourceTime: transitionUnderlay.sourceTime,
          playbackRate: 1,
          reversePlayback: false,
          freezePlayback: true,
          // The preload is intentionally invisible before the boundary. It
          // becomes the same DOM media element used for the transition, so an
          // incoming fade never exposes the black canvas while it decodes.
          opacity: incomingTransitionPlayback ? 1 : 0,
          flipHorizontal: Boolean(clip.flip_horizontal),
          flipVertical: Boolean(clip.flip_vertical),
          filter: filterStyleFromColor({
            brightness: clip.color?.brightness ?? 0,
            contrast: clip.color?.contrast ?? 0,
            saturation: clip.color?.saturation ?? 0,
            preset: clip.color?.filter_preset || "none",
          }).filter,
          transform: null,
        });
      }
      return layers.filter((layer) => Boolean(layer.streamUrl));
    },
    [baseVideoTrackId, clipStreamUrl, incomingTransitionPlayback, outgoingTransitionPreload, playheadSec, underlayPlaybacks],
  );
  const transitionPreview = incomingTransitionPlayback
    ? transitionPreviewVisual(incomingTransitionPlayback.transitionType, incomingTransitionPlayback.progress)
    : backgroundTransition?.visual || transitionPreviewVisual("none", 1);
  const transitionPreviewSpec = incomingTransitionPlayback
    ? {
        type: incomingTransitionPlayback.transitionType,
        phase: "in",
        duration: incomingTransitionPlayback.transitionDuration,
        startLocalTime: 0,
      }
    : backgroundTransition?.spec || null;
  const soloAudioActive = useMemo(() => hasSoloAudioTracks(body), [body]);
  const audioPreviewItems = useMemo(
    () => {
      const items = resolveAudioPreviewItems(body, playheadSec, masterVolume)
        .map((item) => {
          const assetId = item.clip?.meta?.asset_id;
          const recordedId = Number(item.clip?.source_id);
          const src = assetId != null
            ? getLiteCutAssetStreamUrl(assetId)
            : Number.isFinite(recordedId) && recordedId > 0
              ? getRecordedClipStreamUrl(recordedId)
              : null;
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
          };
        })
        .filter(Boolean),
        duckingEnabled = Boolean(bgm?.ducking_enabled),
        duckingVolume = Math.max(0.05, Math.min(1, Number(bgm?.ducking_volume) || 0.35)),
        hasForeground = items.some((item) => item.trackId !== "bgm" && !item.muted && item.volume > 0);
      if (!duckingEnabled || !hasForeground) return items;
      return items.map((item) => (item.trackId === "bgm" ? { ...item, volume: item.volume * duckingVolume } : item));
    },
    [bgm?.ducking_enabled, bgm?.ducking_volume, body, masterVolume, playheadSec],
  );

  useEffect(() => {
    if (!isPlaying || !body) return;
    if (streamUrl && playback?.clip && !clipReversePlayback(playback.clip) && !playback.frozen) return;
    const id = window.setInterval(() => {
      const cur = useLiteCutTimelineStore.getState().playheadSec;
      const next = cur + 0.05;
      if (next >= totalSec) {
        setPlaying(false);
        setPlayhead(totalSec);
      } else {
        setPlayhead(next);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [isPlaying, body, totalSec, setPlayhead, setPlaying, streamUrl, playback?.clip, playback?.frozen]);

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
        case "detachSelectedAudio":
          detachSelectedAudio();
          return true;
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
    detachSelectedAudio,
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

  const publishExportPhase = useCallback((phase, payload = null) => {
    setExportDialog({
      phase,
      result: phase === "error" ? null : payload,
      error: phase === "error" ? (payload?.error || "导出失败") : "",
    });
    onExportPhaseChange?.(phase, payload);
  }, [onExportPhaseChange]);

  const handleExport = useCallback(async () => {
    if (!body || exportableClipCount === 0) return;
    const dir = outputDir.trim() || outputDirHint;
    const fn = defaultLiteCutFilename({ output: { filename: outputFilename } }, projectName);
    if (!dir) {
      setExportError("请填写导出目录（绝对路径）");
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportJob(null);
    publishExportPhase("running", { progress: 0, stage: "queued" });
    try {
      if (dirty) await saveProject();
      const result = await startLiteCutExport({
        projectId,
        body: useLiteCutEditorStore.getState().body,
        outputDir: dir,
        filename: fn,
      });
      setExportJob(result);
      setExportHistory((prev) => [result, ...prev.filter((item) => item.export_id !== result.export_id)].slice(0, 8));
      patchOutput({ dir: outputDir.trim() || dir, filename: fn });
      publishExportPhase("running", result);
    } catch (e) {
      const msg = formatMontageApiError(e, t, e?.message || "导出失败");
      setExportError(msg);
      publishExportPhase("error", { error: msg });
      setExporting(false);
    }
  }, [
    body,
    exportableClipCount,
    outputDir,
    outputDirHint,
    outputFilename,
    projectName,
    dirty,
    saveProject,
    projectId,
    patchOutput,
    loadExportHistory,
    publishExportPhase,
    t,
  ]);

  useEffect(() => {
    if (!exporting || !exportJob?.export_id) return undefined;
    let stopped = false;
    let intervalId = null;
    const poll = async () => {
      try {
        const next = await getLiteCutExportStatus(exportJob.export_id);
        if (stopped) return;
        setExportJob(next);
        if (next.status === "done") {
          setExporting(false);
          setExportError(null);
          publishExportPhase("done", next);
          void loadExportHistory();
          return;
        }
        if (next.status === "cancelled") {
          setExporting(false);
          setExportError(null);
          publishExportPhase("cancelled", next);
          void loadExportHistory();
          return;
        }
        if (next.status === "error") {
          const msg = messageFromApiCode(next.error, t) || next.error || "导出失败";
          setExporting(false);
          setExportError(msg);
          publishExportPhase("error", { ...next, error: msg });
          void loadExportHistory();
          return;
        }
        publishExportPhase("running", next);
      } catch (e) {
        if (stopped) return;
        const msg = formatMontageApiError(e, t, e?.message || "导出状态读取失败");
        setExporting(false);
        setExportError(msg);
        publishExportPhase("error", { error: msg });
      }
    };
    void poll();
    intervalId = window.setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [exporting, exportJob?.export_id, loadExportHistory, publishExportPhase, t]);

  const handleCancelExport = useCallback(async () => {
    if (!exportJob?.export_id) return;
    try {
      const next = await cancelLiteCutExport(exportJob.export_id);
      setExportJob(next);
      publishExportPhase("running", next);
    } catch (e) {
      const msg = formatMontageApiError(e, t, e?.message || "取消导出失败");
      setExportError(msg);
    }
  }, [exportJob?.export_id, publishExportPhase, t]);

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

  const handleAssetsLoaded = useCallback((assets) => {
    const allAssets = assets || [];
    setFontAssets(allAssets.filter((a) => a?.kind === "font"));
    setAudioAssets(allAssets.filter((a) => a?.kind === "audio"));
    setAssetPreviewVersions(Object.fromEntries(allAssets.map((asset) => [Number(asset.id), asset.preview_proxy_version || "source"])));
    migrateAlphaMovOverlaysToVideoTracks(allAssets);

    // Repair overlays created before image dimensions were persisted. Keep
    // their visible width, but derive height from the real source aspect ratio
    // so neither preview nor export stretches the image.
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
  }, [body?.overlays, migrateAlphaMovOverlaysToVideoTracks, outputHeight, outputWidth, updateOverlay]);

  const handleRelinkMissingAsset = useCallback((warning, asset) => {
    const current = useLiteCutEditorStore.getState().body;
    const result = relinkMissingAssetReferences(current, warning, asset);
    if (!result.changed) return false;
    useLiteCutHistoryStore.getState().push(current);
    useLiteCutEditorStore.setState({ body: result.body, dirty: true });
    return true;
  }, []);

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

  const handleDropMedia = useCallback(
    (mediaItem, trackId, atTime, placement = {}) => {
      if ((trackId === "overlay" || String(trackId).startsWith("ot")) && isAssetMediaItem(mediaItem)) {
        addOverlayFromAsset(mediaItem, {
          x: 0.5,
          y: 0.5,
          atTime: atTime ?? playheadSec,
          overlayTrackId: trackId === "overlay" ? null : trackId,
        });
        return;
      }
      if (atTime != null) {
        addMediaAtTime(mediaItem, trackId, atTime, placement);
      } else {
        addMediaToTrack(mediaItem, trackId);
      }
    },
    [addMediaToTrack, addMediaAtTime, addOverlayFromAsset, playheadSec],
  );

  const handlePreviewDrop = useCallback(
    (mediaItem, { x, y }) => {
      if (isAssetMediaItem(mediaItem)) {
        addOverlayFromAsset(mediaItem, { x, y, atTime: playheadSec });
      } else {
        addFromMediaBin(mediaItem);
      }
    },
    [addOverlayFromAsset, addFromMediaBin, playheadSec],
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

  const handleNewProject = useCallback(async (template = null) => {
    if (dirty || saving) await saveProject();
    if (template?.isCustomProject) {
      const customBody = projectBodyFromTemplate("highlight-16x9");
      customBody.output = {
        ...(customBody.output || {}),
        width: template.width,
        height: template.height,
        fps: template.fps,
      };
      const result = await createNewProject(template.name, customBody);
      if (result?.ok) {
        setPlayhead(0);
        clearSelection();
      }
      return result;
    }
    const stamp = new Date();
    const prefix = template?.label ? `LiteCut ${template.label}` : "LiteCut";
    const name = `${prefix} ${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}`;
    const result = await createNewProject(name, template?.id ? projectBodyFromTemplate(template.id) : null);
    setPlayhead(0);
    clearSelection();
    return result;
  }, [dirty, saving, saveProject, createNewProject, setPlayhead, clearSelection]);

  const handleExportProject = useCallback(() => {
    const currentBody = useLiteCutEditorStore.getState().body;
    if (!currentBody) return;
    const safeName = String(projectName || "litecut-project").trim().replace(/[\\/:*?\"<>|]+/g, "-") || "litecut-project";
    const payload = {
      format: "litecut-project",
      schema_version: 2,
      exported_at: new Date().toISOString(),
      name: projectName || "LiteCut Project",
      body: currentBody,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeName}.litecut.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [projectName]);

  const handleImportProject = useCallback(
    async (file) => {
      try {
        const raw = JSON.parse(await file.text());
        const importedBody = raw?.body && typeof raw.body === "object" ? raw.body : raw;
        if (!importedBody || typeof importedBody !== "object" || !Array.isArray(importedBody.tracks)) return { ok: false };
        const importedName = raw?.name || String(file.name || "Imported LiteCut Project").replace(/\.litecut\.json$|\.json$/i, "");
        const result = await importProject({ name: importedName, body: importedBody });
        if (result.ok) {
          setPlayhead(0);
          clearSelection();
        }
        return result;
      } catch {
        return { ok: false };
      }
    },
    [importProject, setPlayhead, clearSelection],
  );

  const handleOpenProject = useCallback(
    async (nextProjectId) => {
      if (Number(nextProjectId) === Number(projectId)) return;
      if (dirty || saving) await saveProject();
      await openProject(nextProjectId);
      setPlayhead(0);
      clearSelection();
    },
    [projectId, dirty, saving, saveProject, openProject, setPlayhead, clearSelection],
  );

  const handleDuplicateProject = useCallback(
    async (sourceProjectId) => {
      if (Number(sourceProjectId) === Number(projectId) && (dirty || saving)) await saveProject();
      await duplicateProject(sourceProjectId);
      setPlayhead(0);
      clearSelection();
    },
    [projectId, dirty, saving, saveProject, duplicateProject, setPlayhead, clearSelection],
  );

  const handleDeleteProject = useCallback(
    async (targetProjectId, confirmed = false) => {
      const id = Number(targetProjectId);
      if (!Number.isFinite(id) || id <= 0) return;
      if (!confirmed && typeof window !== "undefined" && !window.confirm(t("liteCut.project.deleteIdConfirm", { id }))) return;
      if (id === Number(projectId)) {
        setPlaying(false);
        if (saving) await saveProject();
      }
      await deleteProject(id);
      setPlayhead(0);
      clearSelection();
    },
    [projectId, saving, setPlaying, saveProject, deleteProject, setPlayhead, clearSelection, t],
  );

  const handleDeleteProjects = useCallback(
    async (targetProjectIds) => {
      if ((targetProjectIds || []).map(Number).includes(Number(projectId))) {
        setPlaying(false);
        if (saving) await saveProject();
      }
      const result = await deleteProjects(targetProjectIds);
      if (result?.ok) {
        setPlayhead(0);
        clearSelection();
      }
      return result;
    },
    [projectId, saving, setPlaying, saveProject, deleteProjects, setPlayhead, clearSelection],
  );

  const handleRestoreSnapshot = useCallback(async (snapshotId) => {
    if (!projectId) return { ok: false };
    if (dirty || saving) await saveProject();
    const current = useLiteCutEditorStore.getState().body;
    const { data } = await API.post(`/lite-cut/projects/${projectId}/snapshots/${snapshotId}/restore`);
    if (current) useLiteCutHistoryStore.getState().push(current);
    useLiteCutEditorStore.setState({
      projectName: data.name || projectName,
      body: data.body,
      dirty: false,
      projectUpdatedAt: data.updated_at || null,
      recoveryCandidate: null,
    });
    setPlaying(false);
    setPlayhead(0);
    clearSelection();
    return { ok: true };
  }, [projectId, dirty, saving, saveProject, projectName, setPlaying, setPlayhead, clearSelection]);

  const handleImportPortable = useCallback(async (file) => {
    const form = new FormData();
    form.append("file", file);
    const { data } = await API.post("/lite-cut/projects/portable-import", form, { headers: { "Content-Type": "multipart/form-data" } });
    await openProject(data.id);
    setPlayhead(0);
    clearSelection();
    return { ok: true };
  }, [openProject, setPlayhead, clearSelection]);

  const handleStartPortableExport = useCallback(async () => {
    if (!projectId) return { cancelled: true };
    // Desktop builds use the native folder chooser so the final location is
    // explicit. Browser builds retain a normal download after preparation.
    let destination = "";
    if (desktopBridge?.chooseDirectory) {
      destination = await desktopBridge.chooseDirectory("");
      if (!destination) return { cancelled: true };
    }
    const { data } = await API.post(`/lite-cut/projects/${projectId}/portable-package/start`, { destination });
    return { data };
  }, [projectId]);

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
          onGoSettings={() => navigate("/settings")}
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
        onRefresh={listProjects}
        onOpenProject={handleOpenProject}
        onNewProject={handleNewProject}
      />
    );
  }

  return (
    <div
      className="litecut-editor-interactive relative flex h-full min-h-0 flex-col overflow-hidden bg-cs2-bg-page"
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
        onOpenExport={() => setInspectorTab("export")}
        onRestoreSnapshot={handleRestoreSnapshot}
        onImportPortable={handleImportPortable}
        onStartPortableExport={handleStartPortableExport}
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
            onAddToTimeline={addFromMediaBin}
            onReplaceSelectedClip={replaceSelectedClipSource}
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
              freezePlayback={Boolean(playback?.frozen)}
              transitionMainOpacity={transitionPreview.mainOpacity}
              transitionMainTransform={transitionPreview.mainTransform}
              transitionMainClipPath={transitionPreview.mainClipPath}
              transitionFlashOpacity={transitionPreview.flashOpacity}
              transitionBlackOpacity={transitionPreview.blackOpacity}
              transitionSpec={transitionPreviewSpec}
              clipLocalTime={playback?.localTime ?? 0}
              clipVisibleDuration={previewClipVisibleDuration}
              clipFadeInSec={previewClipFadeInSec}
              clipFadeOutSec={previewClipFadeOutSec}
              mainFlipHorizontal={Boolean(playback?.clip?.flip_horizontal)}
              mainFlipVertical={Boolean(playback?.clip?.flip_vertical)}
              mainCrop={playback?.clip?.crop || null}
              mainFilter={previewFilter.filter}
              mainLayerTransform={
                playbackIsVideoLayer
                  ? overlayTransformAt(
                      { ...playback?.clip, duration: clipSourceDuration(playback?.clip) },
                      playheadSec,
                      VIDEO_LAYER_TRANSFORM_DEFAULTS,
                    )
                  : null
              }
              mainLayerSelected={Boolean(activeClipIsVideoLayer && selectedClipId === playback?.clip?.id)}
              onMainLayerTransform={(patch) => {
                if (selectedClipId && selectedTrackId) updateClipTransformAtTime(selectedClipId, selectedTrackId, playheadSec, patch);
              }}
              mainIsVideoLayer={playbackIsVideoLayer}
              mainMuted={true}
              mainVolume={0}
              audioPreviewItems={audioPreviewItems}
              underlayStreamUrl={underlayStreamUrl}
              underlaySourceTime={underlayPlayback?.sourceTime ?? 0}
              underlayPlaybackRate={underlayPlayback?.clip ? clipSpeedAtTimeline(underlayPlayback.clip, underlayPlayback.localTime) : 1}
              underlayReversePlayback={underlayPlayback?.clip ? clipReversePlayback(underlayPlayback.clip) : false}
              underlayClipId={underlayPlayback?.clip?.id ?? null}
              underlayOpacity={underlayOpacity}
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
              preloadStreamUrl={preloadStreamUrl && preloadStreamUrl !== streamUrl ? preloadStreamUrl : null}
              preloadSourceTime={nextPreviewPlayback?.sourceTime ?? 0}
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
            textAnimIn={activeTextAnimIn}
            textAnimOut={activeTextAnimOut}
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
            overlayFadeInSec={overlayFadeInSec}
            overlayFadeOutSec={overlayFadeOutSec}
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
            onClipSpeedChange={(speed) => updateSelectedClip({ speed, speed_keyframes: [] })}
            clipSpeedKeyframes={activeClip?.speed_keyframes || []}
            clipTrimIn={Number(activeClip?.trim_in) || 0}
            onClipSpeedKeyframesChange={(speed_keyframes) => updateSelectedClip({ speed_keyframes })}
            clipPreservePitch={clipPreservePitch(activeClip)}
            onClipPreservePitchChange={(preserve_pitch) => updateSelectedClip({ preserve_pitch })}
            clipReverse={clipReversePlayback(activeClip)}
            onClipReverseChange={(reverse) => updateSelectedClip({ reverse })}
            clipFreezeFrameSec={activeClipFreezeFrameSec}
            onClipFreezeFrameChange={(freeze_frame_sec) => updateSelectedClip({ freeze_frame_sec })}
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
            onClipCanvasFitChange={(canvas_fit) => updateSelectedClip({ canvas_fit })}
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
      <LiteCutExportProgressDialog
        phase={exportDialog.phase}
        result={exportDialog.result}
        error={exportDialog.error}
        onClose={() => setExportDialog({ phase: "idle", result: null, error: "" })}
        onCancel={() => void handleCancelExport()}
      />
    </div>
  );
}
