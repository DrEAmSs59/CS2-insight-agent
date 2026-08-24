import {
  Volume2,
  FolderOpen,
  RotateCcw,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Captions,
  CopyCheck,
  Check,
  Layers,
  DiamondMinus,
  DiamondPlus,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  Zap,
  Loader2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLiteCutTimelineStore } from "../state/timelineStore.js";
import { useT } from "../../../i18n/useT.js";
import { messageFromApiCode } from "../../../utils/apiErrorMessages.js";
import { liteCutClient } from "../api/liteCutClient.js";
import { desktopBridge } from "../../../desktop/desktopBridge.js";
import { writeLiteCutClipboardText } from "./liteCutClipboard.js";
import { summarizeFrameMeldSources } from "../../../utils/framemeld.js";
import FrameMeldEnableDialog from "../../../components/FrameMeldEnableDialog.jsx";
import {
  LITE_CUT_CANVAS_FIT_VALUES,
  LITE_CUT_OUTPUT_DEFAULTS,
  LITE_CUT_OUTPUT_LIMITS,
  LITE_CUT_RESOLUTION_PRESETS,
  LITE_CUT_TIMELINE_LIMITS,
} from "../state/projectContract.js";
import {
  AUDIO_BGM_GAIN,
  AUDIO_CLIP_GAIN,
  AUDIO_DUCKING_GAIN,
  AUDIO_FADE_DURATION,
  AUDIO_MASTER_GAIN,
  AUDIO_TRACK_GAIN,
  clampAudioGain,
} from "../domain/audioContract.js";
import {
  VISUAL_CROP_DEFAULTS,
  VISUAL_CROP_POSITION_MAX,
  VISUAL_CROP_POSITION_MIN,
  VISUAL_CROP_SIZE_MAX,
  VISUAL_CROP_SIZE_MIN,
  normalizeVisualCrop,
} from "../domain/visualMaterial.js";
import AudioWaveformBars from "./AudioWaveformBars.jsx";
import { NumericPairCard, PaneSection, ProSlider, SceneTransformControls, ScopeActionButton, Toggle } from "./PropertyControls.jsx";
import {
  TEXT_STYLE_CARDS,
  FONT_OPTIONS,
  CANVAS_PRESETS,
  TRANSITION_DURATION_DEFAULT,
  TRANSITION_DURATION_MAX,
  TRANSITION_DURATION_MIN,
  TRANSITION_OPTIONS,
} from "./editorPresets.js";
import {
  TEXT_FONT_SIZE_DEFAULT,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_FONT_WEIGHT_DEFAULT,
  TEXT_FONT_WEIGHT_MAX,
  TEXT_FONT_WEIGHT_MIN,
  TEXT_LINE_HEIGHT_DEFAULT,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  normalizeTextFontSize,
} from "./textLayout.js";
const SOURCE_METADATA_CACHE = new Map();
const OUTPUT_WIDTH = LITE_CUT_OUTPUT_LIMITS.width;
const OUTPUT_HEIGHT = LITE_CUT_OUTPUT_LIMITS.height;
const OUTPUT_FPS = LITE_CUT_OUTPUT_LIMITS.fps;
const OUTPUT_BLUR = LITE_CUT_OUTPUT_LIMITS.blurAmount;
const TIMELINE_TIME = LITE_CUT_TIMELINE_LIMITS.time;
const TIMELINE_DURATION = LITE_CUT_TIMELINE_LIMITS.duration;

function formatSourceDuration(value) {
  const total = Math.max(0, Number(value) || 0);
  if (!total) return "—";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const fraction = Math.floor((total - Math.floor(total)) * 100);
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function formatSourceFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return `${Math.abs(fps - Math.round(fps)) < 0.01 ? Math.round(fps) : fps.toFixed(2)} FPS`;
}

function formatSourceCodec(value) {
  const codec = String(value || "").trim().toLowerCase();
  return ({ h264: "H.264", hevc: "HEVC", h265: "HEVC", vp9: "VP9", av1: "AV1", prores: "ProRes", aac: "AAC", mp3: "MP3" })[codec] || (codec ? codec.toUpperCase() : null);
}

function KeyframeEditorBar({
  label,
  active = false,
  onAdd,
  onRemove,
  hint,
}) {
  return (
    <div className="litecut-keyframe-editor space-y-1.5 py-1">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-cs2-text-secondary">{label}</p>
          <p className={`mt-0.5 text-[9px] ${active ? "text-cs2-accent" : "text-cs2-text-muted"}`}>
            {active ? "当前播放头已有关键帧，修改下方参数会更新此关键帧" : "当前播放头没有关键帧，修改下方参数会调整片段基础值"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`在播放头添加${label}`}
            title={`在播放头添加${label}`}
            onClick={onAdd}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-cs2-accent/35 bg-cs2-accent-soft px-2 text-[9px] font-semibold text-cs2-accent hover:border-cs2-accent/65"
          >
            <DiamondPlus className="h-3.5 w-3.5" />
            {active ? "更新" : "添加"}
          </button>
          <button
            type="button"
            aria-label={`删除当前${label}`}
            title={`删除当前${label}`}
            disabled={!active}
            onClick={onRemove}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-cs2-text-muted hover:border-cs2-border hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <DiamondMinus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {hint ? <p className="text-[9px] leading-relaxed text-cs2-text-muted">{hint}</p> : null}
    </div>
  );
}

export function ClipPane({
  media,
  streamUrl = null,
  previewSourceTime = 0,
  previewKey = null,
  previewPlaying = false,
  transitionType = "cut",
  transitionDuration = 0.4,
  transitionInDuration = 0.25,
  transitionOutDuration = 0.25,
  onTransitionChange,
  onTransitionDurationChange,
  onTransitionInDurationChange,
  onTransitionOutDurationChange,
  onApplyTransitionScope,
  canApplyTransitionTrack = false,
  canApplyTransitionAll = false,
  overlayTransform = null,
  overlayTransitionType = "cut",
  overlayTransitionInSec = 0,
  overlayTransitionOutSec = 0,
  onOverlayPatch,
  onOverlayTransformChange,
  onApplyMotionPreset,
  overlayHasKeyframe = false,
  onAddOverlayKeyframe,
  onRemoveOverlayKeyframe,
  clipFadeInSec = 0,
  clipFadeOutSec = 0,
  clipDuration = 0,
  clipCanvasFit = null,
  projectCanvasFit = "contain",
  onClipCanvasFitChange,
  onClipPatch,
  clipFlipHorizontal = false,
  clipFlipVertical = false,
  clipTransform = null,
  onClipTransformChange,
  clipHasKeyframe = false,
  onAddClipKeyframe,
  onRemoveClipKeyframe,
  clipHasAudioKeyframe = false,
  onAddClipAudioKeyframe,
  onRemoveClipAudioKeyframe,
  clipCrop = null,
  onClipCropChange,
  supportsCrop = false,
  supportsContentFit = false,
  isVideoLayer = false,
  isAudioClip = false,
  isOverlay = false,
  clipVolume = 1,
  onClipVolumeChange,
  outputWidth = LITE_CUT_OUTPUT_DEFAULTS.width,
  outputHeight = LITE_CUT_OUTPUT_DEFAULTS.height,
}) {
  const [sourceMetadata, setSourceMetadata] = useState(null);
  const builtin = TRANSITION_OPTIONS.filter((t) => t.builtin !== false);
  const directDuration = Number(media?.duration_sec ?? media?.duration) || 0;
  const thumbUrl = media?.assetStreamUrl || streamUrl;
  const thumbVideoRef = useRef(null);
  const lastPreviewIdentityRef = useRef("");
  const imagePreview = media?.kind === "image";

  useEffect(() => {
    const initial = {
      duration_sec: directDuration || null,
      width: Number(media?.width ?? media?.source_width) || null,
      height: Number(media?.height ?? media?.source_height) || null,
      fps: Number(media?.fps ?? media?.source_fps) || null,
      codec_name: media?.codec_name || null,
      extension: String(media?.name || media?.title || "").split(".").pop()?.toUpperCase() || null,
    };
    const metadataCacheKey = `${media?.mediaKind || "unknown"}:${media?.id ?? "none"}`;
    const cachedMetadata = SOURCE_METADATA_CACHE.get(metadataCacheKey);
    setSourceMetadata(cachedMetadata ? { ...initial, ...cachedMetadata } : initial);
    const assetId = Number(media?.id);
    if (media?.mediaKind !== "asset" || !Number.isFinite(assetId) || assetId <= 0 || media?.kind === "text") return undefined;
    if (cachedMetadata) return undefined;
    let cancelled = false;
    liteCutClient.getAssetMetadata(assetId)
      .then((data) => {
        if (!data) return;
        SOURCE_METADATA_CACHE.set(metadataCacheKey, data);
        if (!cancelled) setSourceMetadata((current) => ({ ...current, ...data }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [directDuration, media?.codec_name, media?.fps, media?.height, media?.id, media?.kind, media?.mediaKind, media?.name, media?.source_fps, media?.source_height, media?.source_width, media?.title, media?.width]);

  const metadataWidth = Number(sourceMetadata?.width) || 0;
  const metadataHeight = Number(sourceMetadata?.height) || 0;
  const resolutionLabel = metadataWidth > 0 && metadataHeight > 0 ? `${metadataWidth} × ${metadataHeight}` : null;
  const fpsLabel = formatSourceFps(sourceMetadata?.fps);
  const codecLabel = formatSourceCodec(sourceMetadata?.codec_name);
  const extensionLabel = String(sourceMetadata?.extension || "").trim().toUpperCase() || null;
  const sourceDurationLabel = formatSourceDuration(sourceMetadata?.duration_sec ?? directDuration);

  useEffect(() => {
    const element = thumbVideoRef.current;
    if (!element || imagePreview || !thumbUrl) return undefined;
    const identity = `${previewKey ?? media?.id ?? "clip"}:${thumbUrl}`;
    const identityChanged = lastPreviewIdentityRef.current !== identity;
    lastPreviewIdentityRef.current = identity;
    if (previewPlaying && !identityChanged) return undefined;
    const seekToPreviewFrame = () => {
      try {
        element.pause();
        const target = Math.max(0, Number(previewSourceTime) || 0);
        if (Math.abs(element.currentTime - target) > 0.025) element.currentTime = target;
      } catch {
        // Metadata may not be ready yet; loadedmetadata retries the seek.
      }
    };
    if (element.readyState >= 1) seekToPreviewFrame();
    else element.addEventListener("loadedmetadata", seekToPreviewFrame, { once: true });
    return () => element.removeEventListener("loadedmetadata", seekToPreviewFrame);
  }, [imagePreview, media?.id, previewKey, previewPlaying, previewSourceTime, thumbUrl]);
  const overlayMaxTransition = TRANSITION_DURATION_MAX;
  const activeCanvasFit = ["fill", ...LITE_CUT_CANVAS_FIT_VALUES].includes(clipCanvasFit) ? clipCanvasFit : "inherit";
  const normalizedCrop = normalizeVisualCrop(clipCrop);
  const canvasFitOptions = [
    { id: "fill", label: "拉伸" },
    { id: "inherit", label: `继承 ${projectCanvasFit === "cover" ? "填满" : projectCanvasFit === "blur" ? "模糊" : "适应"}` },
    { id: "contain", label: "适应" },
    { id: "cover", label: "填满" },
    { id: "blur", label: "模糊" },
  ];

  if (!media) {
    return (
      <p className="px-4 py-8 text-center text-xs text-cs2-text-muted">选中时间轴片段以编辑属性</p>
    );
  }

  return (
    <>
      <div className="litecut-selected-media flex items-center gap-2 overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card p-2">
        <div className="relative aspect-video w-[92px] shrink-0 overflow-hidden rounded-md bg-black">
          {thumbUrl ? (
            imagePreview ? (
              <img src={thumbUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <video
                ref={thumbVideoRef}
                key={`${previewKey ?? media?.id ?? "clip"}:${thumbUrl}`}
                src={thumbUrl}
                className="h-full w-full object-contain"
                muted
                playsInline
                preload="metadata"
              />
            )
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-orange-900 to-zinc-900" />
          )}
          {sourceDurationLabel !== "—" ? <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[8px] text-white/90">{sourceDurationLabel}</span> : null}
        </div>
        <div className="min-w-0 flex-1 px-1 py-1">
          <p className="break-all text-[10px] font-medium leading-snug text-cs2-text-primary" title={media.title}>{media.title}</p>
          {media?.mediaKind === "asset" ? (
            <>
              <p className="mt-1 break-words font-mono text-[9px] leading-snug text-cs2-text-secondary">
                {[resolutionLabel, fpsLabel].filter(Boolean).join(" · ") || (media.kind === "audio" ? "音频素材" : "媒体信息读取中…")}
              </p>
              <p className="mt-0.5 break-words font-mono text-[9px] leading-snug text-cs2-text-muted">
                {[sourceDurationLabel, codecLabel, extensionLabel].filter((item) => item && item !== "—").join(" · ") || "—"}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 break-words text-[9px] leading-snug text-cs2-text-muted">{isOverlay ? "叠加层 · 文字/图片轨" : `${media.player || "—"} · 回合 ${media.round ?? "—"}`}</p>
              <p className="mt-0.5 font-mono text-[9px] text-cs2-text-muted">{sourceDurationLabel}</p>
            </>
          )}
        </div>
      </div>
      {isVideoLayer && clipTransform ? (
        <PaneSection title="变换与画面关键帧">
          <KeyframeEditorBar
            label="画面关键帧"
            active={clipHasKeyframe}
            onAdd={onAddClipKeyframe}
            onRemove={onRemoveClipKeyframe}
            hint="把播放头移到目标时间，先添加关键帧，再修改位置、大小、缩放、旋转或透明度；前后关键帧之间会自动生成动画。"
          />
          <SceneTransformControls
            transform={clipTransform}
            onChange={onClipTransformChange}
            outputWidth={outputWidth}
            outputHeight={outputHeight}
            flipHorizontal={clipFlipHorizontal}
            flipVertical={clipFlipVertical}
            onFlipHorizontal={(value) => onClipPatch?.({ flip_horizontal: value })}
            onFlipVertical={(value) => onClipPatch?.({ flip_vertical: value })}
          />
        </PaneSection>
      ) : null}
      {!isOverlay && !isAudioClip && media?.kind !== "image" ? <PaneSection title="视频原声与音量关键帧">
        <KeyframeEditorBar
          label="音量关键帧"
          active={clipHasAudioKeyframe}
          onAdd={onAddClipAudioKeyframe}
          onRemove={onRemoveClipAudioKeyframe}
          hint="把播放头移到需要改变音量的位置，先添加关键帧，再调整下面的音量；关键帧之间会自动平滑变化。"
        />
        <ProSlider label="当前片段原声音量 (%)" value={Math.round(clampAudioGain(clipVolume, AUDIO_CLIP_GAIN, 0) * 100)} onChange={(value) => onClipVolumeChange?.(value / 100)} min={AUDIO_CLIP_GAIN.min * 100} max={AUDIO_CLIP_GAIN.max * 100} resetValue={AUDIO_CLIP_GAIN.default * 100} />
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">仅作用于当前视频片段；所在视频轨的整体原声增益请在“音频”页调整。</p>
      </PaneSection> : null}
      {supportsContentFit ? (
        <PaneSection title="素材适配">
          <div className="grid grid-cols-2 gap-2">
            {canvasFitOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onClipCanvasFitChange?.(option.id)}
                className={`rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors ${activeCanvasFit === option.id ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </PaneSection>
      ) : null}
      {supportsCrop && clipCrop ? (
        <PaneSection title="取景裁切">
          <ProSlider
            label="宽度 %"
            value={Math.round(normalizedCrop.width * 100)}
            onChange={(v) => {
              const width = Math.max(VISUAL_CROP_SIZE_MIN, Math.min(VISUAL_CROP_SIZE_MAX, Number(v) / 100));
              onClipCropChange?.({ width, x: Math.min(normalizedCrop.x, VISUAL_CROP_SIZE_MAX - width) });
            }}
            min={VISUAL_CROP_SIZE_MIN * 100}
            max={VISUAL_CROP_SIZE_MAX * 100}
            resetValue={VISUAL_CROP_SIZE_MAX * 100}
          />
          <ProSlider
            label="高度 %"
            value={Math.round(normalizedCrop.height * 100)}
            onChange={(v) => {
              const height = Math.max(VISUAL_CROP_SIZE_MIN, Math.min(VISUAL_CROP_SIZE_MAX, Number(v) / 100));
              onClipCropChange?.({ height, y: Math.min(normalizedCrop.y, VISUAL_CROP_SIZE_MAX - height) });
            }}
            min={VISUAL_CROP_SIZE_MIN * 100}
            max={VISUAL_CROP_SIZE_MAX * 100}
            resetValue={VISUAL_CROP_SIZE_MAX * 100}
          />
          <ProSlider
            label="横向位置 %"
            value={Math.round(normalizedCrop.x * 100)}
            onChange={(v) => onClipCropChange?.({ x: Math.max(VISUAL_CROP_POSITION_MIN, Math.min(VISUAL_CROP_POSITION_MAX - normalizedCrop.width, Number(v) / 100)) })}
            min={VISUAL_CROP_POSITION_MIN * 100}
            max={Math.max(VISUAL_CROP_POSITION_MIN * 100, Math.round((VISUAL_CROP_POSITION_MAX - normalizedCrop.width) * 100))}
            resetValue={VISUAL_CROP_DEFAULTS.x * 100}
          />
          <ProSlider
            label="纵向位置 %"
            value={Math.round(normalizedCrop.y * 100)}
            onChange={(v) => onClipCropChange?.({ y: Math.max(VISUAL_CROP_POSITION_MIN, Math.min(VISUAL_CROP_POSITION_MAX - normalizedCrop.height, Number(v) / 100))})}
            min={VISUAL_CROP_POSITION_MIN * 100}
            max={Math.max(VISUAL_CROP_POSITION_MIN * 100, Math.round((VISUAL_CROP_POSITION_MAX - normalizedCrop.height) * 100))}
            resetValue={VISUAL_CROP_DEFAULTS.y * 100}
          />
        </PaneSection>
      ) : null}
      {isOverlay && overlayTransform ? (
        <>
        <PaneSection title="变换" defaultOpen={false}>
          <SceneTransformControls
            transform={overlayTransform}
            onChange={onOverlayTransformChange}
            outputWidth={outputWidth}
            outputHeight={outputHeight}
            flipHorizontal={clipFlipHorizontal}
            flipVertical={clipFlipVertical}
            onFlipHorizontal={(value) => onOverlayPatch?.({ flip_horizontal: value })}
            onFlipVertical={(value) => onOverlayPatch?.({ flip_vertical: value })}
          />
        </PaneSection>
        <PaneSection title="素材过渡" defaultOpen={false}>
          <div className="grid grid-cols-3 gap-1.5">
            {builtin.slice(0, 9).map((tr) => {
              const selected = overlayTransitionType === tr.id;
              return <button key={tr.id} type="button" onClick={() => onTransitionChange?.(tr.id)} className={`flex flex-col items-center gap-1 rounded-lg border py-2 transition-all ${selected ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 bg-cs2-surface-1/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}><span className="text-base leading-none">{tr.icon}</span><span className="text-[9px] font-semibold">{tr.label}</span></button>;
            })}
          </div>
          <ProSlider label="进入过渡（总时长 s）" value={Math.max(TRANSITION_DURATION_MIN, Math.min(overlayMaxTransition, Number(overlayTransitionInSec) || TRANSITION_DURATION_DEFAULT))} onChange={onTransitionInDurationChange} min={TRANSITION_DURATION_MIN} max={overlayMaxTransition} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
          <ProSlider label="退出过渡（总时长 s）" value={Math.max(TRANSITION_DURATION_MIN, Math.min(overlayMaxTransition, Number(overlayTransitionOutSec) || TRANSITION_DURATION_DEFAULT))} onChange={onTransitionOutDurationChange} min={TRANSITION_DURATION_MIN} max={overlayMaxTransition} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
        </PaneSection>
        </>
      ) : (
        <>
      <PaneSection title="素材过渡" defaultOpen={false}>
        <div className="grid grid-cols-3 gap-1.5">
          {builtin.slice(0, 9).map((tr) => (
            <button
              key={tr.id}
              type="button"
              onClick={() => onTransitionChange?.(tr.id)}
              className={`flex flex-col items-center gap-1 rounded-lg border py-2 transition-all ${
                transitionType === tr.id
                  ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 bg-cs2-surface-1/50 text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              <span className="text-base leading-none">{tr.icon}</span>
              <span className="text-[9px] font-semibold">{tr.label}</span>
            </button>
          ))}
        </div>
        <ProSlider label="素材前（过渡时长）s" value={transitionType === "cut" ? 0 : Math.max(TRANSITION_DURATION_MIN, Number(transitionInDuration) || TRANSITION_DURATION_DEFAULT)} onChange={(v) => onTransitionInDurationChange?.(v)} min={TRANSITION_DURATION_MIN} max={TRANSITION_DURATION_MAX} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
        <ProSlider label="素材后（过渡时长）s" value={transitionType === "cut" ? 0 : Math.max(TRANSITION_DURATION_MIN, Number(transitionOutDuration) || TRANSITION_DURATION_DEFAULT)} onChange={(v) => onTransitionOutDurationChange?.(v)} min={TRANSITION_DURATION_MIN} max={TRANSITION_DURATION_MAX} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
        <div className="grid grid-cols-2 gap-2">
          <ScopeActionButton
            icon={CopyCheck}
            disabled={!canApplyTransitionTrack}
            onClick={() => onApplyTransitionScope?.("track")}
          >
            同步同轨
          </ScopeActionButton>
          <ScopeActionButton
            icon={Layers}
            disabled={!canApplyTransitionAll}
            onClick={() => onApplyTransitionScope?.("all")}
          >
            同步全部
          </ScopeActionButton>
        </div>
      </PaneSection>
      {media.ai ? (
        <PaneSection title="CS2 元数据" defaultOpen={false}>
          <p className="text-[11px] leading-relaxed text-cs2-text-secondary">{media.ai}</p>
        </PaneSection>
      ) : null}
        </>
      )}
    </>
  );
}

export { TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX };

export function clampTextFontSize(value, fallback = 48) {
  return normalizeTextFontSize(Number(value) || fallback);
}

export function TextPane({
  textStyleId,
  onTextStyleChange,
  text,
  onTextChange,
  onAddText,
  fontFamily,
  fontFile,
  fontSize = 48,
  fontWeight = 700,
  lineHeight = 1.2,
  textAlign = "center",
  fillColor = null,
  transitionType = "cut",
  transitionInDuration = 0,
  transitionOutDuration = 0,
  onTransitionChange,
  onTransitionInDurationChange,
  onTransitionOutDurationChange,
  fontAssets = [],
  onTextPatch,
  onImportSubtitles,
  subtitleCount = 0,
  onApplySubtitleStyle,
  overlayTransform = null,
  overlayDuration = 3,
  maxTextDuration = TIMELINE_TIME.uiMax,
  onOverlayTransformChange,
  onOverlayPatch,
  flipHorizontal = false,
  flipVertical = false,
  outputWidth = LITE_CUT_OUTPUT_DEFAULTS.width,
  outputHeight = LITE_CUT_OUTPUT_DEFAULTS.height,
}) {
  const subtitleInputRef = useRef(null);
  const [subtitleError, setSubtitleError] = useState("");
  const [font, setFont] = useState(FONT_OPTIONS[0]);
  const [draftFontSize, setDraftFontSize] = useState(TEXT_FONT_SIZE_DEFAULT);
  const effectiveFont = fontFamily || font;
  const effectiveFontSize = clampTextFontSize(fontSize, draftFontSize);
  const effectiveTextAlign = ["left", "center", "right"].includes(textAlign) ? textAlign : "center";
  const textDurationMax = Math.max(TIMELINE_DURATION.uiMin, Math.min(TIMELINE_DURATION.max, Number(maxTextDuration) || TIMELINE_TIME.uiMax));
  const systemFontValue = FONT_OPTIONS.includes(effectiveFont) ? effectiveFont : "__project_font__";
  const handleFontChange = (value) => {
    setFont(value);
    onTextPatch?.({ font_family: value, font_file: null, font_weight: value === "思源黑体 Medium" ? 500 : 700 });
  };
  const handleFontSizeChange = (value) => {
    const next = clampTextFontSize(value);
    setDraftFontSize(next);
    onTextPatch?.({ font_size: next });
  };
  const selectedFontFile = String(fontFile || "");
  const applyFontAsset = (asset) => {
    if (!asset?.file_path) return;
    const family = String(asset.name || "").replace(/\.[^.]+$/, "") || "Uploaded font";
    setFont(family);
    onTextPatch?.({ font_family: family, font_file: asset.file_path });
  };
  const handleSubtitleFile = async (file) => {
    if (!file) return;
    setSubtitleError("");
    try {
      const raw = await file.text();
      const count = onImportSubtitles?.(raw);
      if (!count) setSubtitleError("未识别到有效字幕时间轴");
    } catch {
      setSubtitleError("字幕文件读取失败");
    } finally {
      if (subtitleInputRef.current) subtitleInputRef.current.value = "";
    }
  };

  return (
    <>
      <PaneSection title="文字层">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onAddText?.()}
            className="rounded-lg bg-cs2-accent py-2 text-xs font-bold text-black hover:bg-cs2-accent-light"
          >
            添加文字
          </button>
          <button
            type="button"
            onClick={() => subtitleInputRef.current?.click()}
            className="inline-flex items-center justify-center gap-1 rounded-lg border border-cs2-border/70 bg-cs2-surface-1 py-2 text-xs font-bold text-cs2-text-primary hover:border-cs2-accent/50"
          >
            <Captions className="h-3.5 w-3.5" />
            导入字幕
          </button>
        </div>
        <input
          ref={subtitleInputRef}
          type="file"
          accept=".srt,.vtt,text/plain"
          className="hidden"
          onChange={(e) => void handleSubtitleFile(e.target.files?.[0])}
        />
        {subtitleError ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">{subtitleError}</p>
        ) : null}
        <button
          type="button"
          disabled={!subtitleCount}
          onClick={() => onApplySubtitleStyle?.({
            preset_id: textStyleId,
            font_family: effectiveFont,
            font_file: fontFile || null,
            font_size: effectiveFontSize,
            font_weight: fontWeight,
            line_height: lineHeight,
            letter_spacing: 0,
            align: effectiveTextAlign,
            fill_color: /^#[0-9a-f]{6}$/i.test(String(fillColor || "")) ? String(fillColor).toLowerCase() : null,
          })}
          className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-cs2-border/70 bg-cs2-surface-1 py-1.5 text-[10px] font-semibold text-cs2-text-primary hover:border-cs2-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Captions className="h-3.5 w-3.5" />
          同步全部字幕样式
        </button>
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          文字会进入 T 轨，可在预览区拖动、缩放、旋转，并参与导出。
        </p>
      </PaneSection>
      <PaneSection title="文字内容">
        <textarea
          value={text}
          onChange={(e) => onTextChange?.(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-3 py-2 text-sm font-bold outline-none focus:border-cs2-accent/50"
          style={{ fontFamily: effectiveFont }}
        />
        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold text-cs2-text-muted">文字对齐</span>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ["left", "左对齐", AlignLeft],
              ["center", "居中对齐", AlignCenter],
              ["right", "右对齐", AlignRight],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={effectiveTextAlign === value}
                onClick={() => onTextPatch?.({ align: value })}
                className={`inline-flex items-center justify-center gap-1 rounded-md border py-1.5 text-[10px] font-semibold ${effectiveTextAlign === value ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-accent/50"}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <ProSlider label="素材显示时间 (s)" value={Number(Math.max(TIMELINE_DURATION.uiMin, Math.min(textDurationMax, overlayDuration)).toFixed(2))} onChange={(value) => onOverlayPatch?.({ duration: Math.max(TIMELINE_DURATION.uiMin, Math.min(textDurationMax, value)) })} min={TIMELINE_DURATION.uiMin} max={textDurationMax} resetValue={TIMELINE_DURATION.default} step={0.1} />
        <select value={systemFontValue} onChange={(e) => handleFontChange(e.target.value)} className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs">
          {systemFontValue === "__project_font__" ? <option value="__project_font__" disabled>使用项目字体</option> : null}
          {FONT_OPTIONS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <ProSlider label="字号" value={effectiveFontSize} onChange={handleFontSizeChange} min={TEXT_FONT_SIZE_MIN} max={TEXT_FONT_SIZE_MAX} resetValue={TEXT_FONT_SIZE_DEFAULT} />
        <ProSlider label="字重" value={fontWeight} onChange={(value) => onTextPatch?.({ font_weight: value })} min={TEXT_FONT_WEIGHT_MIN} max={TEXT_FONT_WEIGHT_MAX} resetValue={TEXT_FONT_WEIGHT_DEFAULT} step={100} />
        <ProSlider label="行高" value={lineHeight} onChange={(value) => onTextPatch?.({ line_height: value })} min={TEXT_LINE_HEIGHT_MIN} max={TEXT_LINE_HEIGHT_MAX} resetValue={TEXT_LINE_HEIGHT_DEFAULT} step={0.05} />
        <label className="flex items-center justify-between gap-3 text-[10px] font-semibold text-cs2-text-muted">
          <span>填充颜色</span>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(String(fillColor || "")) ? fillColor : "#ffffff"}
            onChange={(event) => onTextPatch?.({ fill_color: event.target.value.toLowerCase() })}
            className="h-8 w-16 cursor-pointer rounded border border-cs2-border bg-cs2-bg-input p-1"
          />
        </label>
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">在左侧“本地上传”导入 TTF / OTF / WOFF2 后，可在下方项目字体中选择并参与导出。</p>
        {fontAssets.length ? <div className="grid grid-cols-1 gap-1">
          {fontAssets.map((asset) => <button key={asset.id} type="button" onClick={() => applyFontAsset(asset)} className={`whitespace-normal break-all rounded-lg border px-2 py-1.5 text-left text-[10px] font-semibold leading-snug ${selectedFontFile === asset.file_path ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-secondary"}`}>{asset.name}</button>)}
        </div> : null}
      </PaneSection>
      {overlayTransform ? <PaneSection title="变换" defaultOpen={false}>
        <SceneTransformControls
          transform={overlayTransform}
          onChange={onOverlayTransformChange}
          outputWidth={outputWidth}
          outputHeight={outputHeight}
          flipHorizontal={flipHorizontal}
          flipVertical={flipVertical}
          onFlipHorizontal={(value) => onOverlayPatch?.({ flip_horizontal: value })}
          onFlipVertical={(value) => onOverlayPatch?.({ flip_vertical: value })}
        />
      </PaneSection> : null}
      <div className="hidden">
        <select value={systemFontValue} onChange={(e) => handleFontChange(e.target.value)} className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs">
          {systemFontValue === "__project_font__" ? <option value="__project_font__" disabled>使用项目字体</option> : null}
          {FONT_OPTIONS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <ProSlider label="字号" value={effectiveFontSize} onChange={handleFontSizeChange} min={TEXT_FONT_SIZE_MIN} max={TEXT_FONT_SIZE_MAX} resetValue={TEXT_FONT_SIZE_DEFAULT} />
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-muted">项目字体</span>
            {selectedFontFile ? (
              <button
                type="button"
                onClick={() => handleFontChange(FONT_OPTIONS[0])}
                className="text-[10px] font-semibold text-cs2-accent hover:text-cs2-accent-light"
              >
                使用系统字体
              </button>
            ) : null}
          </div>
          {fontAssets.length ? (
            <div className="grid grid-cols-1 gap-1">
              {fontAssets.map((asset) => {
                const selected = selectedFontFile && selectedFontFile === asset.file_path;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => applyFontAsset(asset)}
                    className={`whitespace-normal break-all rounded-lg border px-2 py-1.5 text-left text-[10px] font-semibold leading-snug transition-colors ${
                      selected
                        ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent"
                        : "border-cs2-border/60 bg-cs2-surface-1/50 text-cs2-text-secondary hover:border-cs2-border-focus"
                    }`}
                    title={asset.name}
                  >
                    {asset.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] leading-relaxed text-cs2-text-muted">
              在左侧“本地上传”导入 TTF / OTF / WOFF2 后，可在这里分配给文字层并参与导出。
            </p>
          )}
        </div>
      </div>
      <PaneSection title="素材过渡" defaultOpen={false}>
        <div className="grid grid-cols-3 gap-1.5">
          {TRANSITION_OPTIONS.map((item) => <button
            key={item.id}
            type="button"
            onClick={() => onTransitionChange?.(item.id)}
            className={`flex flex-col items-center gap-1 rounded-lg border py-2 transition-all ${transitionType === item.id ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 bg-cs2-surface-1/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span className="text-[9px] font-semibold">{item.label}</span>
          </button>)}
        </div>
        <ProSlider label="进入过渡（总时长 s）" value={Math.max(TRANSITION_DURATION_MIN, Number(transitionInDuration) || TRANSITION_DURATION_DEFAULT)} onChange={onTransitionInDurationChange} min={TRANSITION_DURATION_MIN} max={Math.max(TRANSITION_DURATION_MIN, Math.min(TRANSITION_DURATION_MAX, overlayDuration * 2))} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
        <ProSlider label="退出过渡（总时长 s）" value={Math.max(TRANSITION_DURATION_MIN, Number(transitionOutDuration) || TRANSITION_DURATION_DEFAULT)} onChange={onTransitionOutDurationChange} min={TRANSITION_DURATION_MIN} max={Math.max(TRANSITION_DURATION_MIN, Math.min(TRANSITION_DURATION_MAX, overlayDuration * 2))} resetValue={TRANSITION_DURATION_DEFAULT} step={0.05} />
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          与视频、图片共用同一过渡事件；连接相邻素材时，总时长以剪辑点为中心左右各占一半。
        </p>
      </PaneSection>
      <PaneSection title="风格预设" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          {TEXT_STYLE_CARDS.map((card) => <button
            key={card.id}
            type="button"
            onClick={() => onTextStyleChange?.(card.id)}
            className={`overflow-hidden rounded-xl border text-left transition-all ${textStyleId === card.id ? "border-cs2-accent ring-2 ring-cs2-accent/30" : "border-cs2-border/50"}`}
          >
            <div className={`flex h-[4.5rem] items-center justify-center px-2 ${card.cardClass}`} style={card.cardStyle}><span className={card.className} style={card.previewStyle}>{card.preview}</span></div>
            <p className="border-t border-white/5 bg-cs2-surface-1/80 px-2 py-1 text-[10px] text-cs2-text-muted">{card.label}</p>
          </button>)}
        </div>
      </PaneSection>
    </>
  );
}

export function AudioPane({
  volume = AUDIO_CLIP_GAIN.default,
  onVolumeChange,
  clipLabel = "Selected clip",
  isAudioClip = false,
  muted = false,
  fadeInSec = AUDIO_FADE_DURATION.default,
  fadeOutSec = AUDIO_FADE_DURATION.default,
  masterVolume = AUDIO_MASTER_GAIN.default,
  onMasterVolumeChange,
  bgm = null,
  audioAssets = [],
  onBgmChange,
  timelineTotalSec = 0,
  clipDuration = 0,
  trimIn = 0,
  onAudioPatch,
  sourceUrl = null,
  trackVolume = AUDIO_TRACK_GAIN.default,
  trackLabel = "当前轨道",
  onTrackVolumeChange,
  clipHasAudioKeyframe = false,
  onAddClipAudioKeyframe,
  onRemoveClipAudioKeyframe,
}) {
  const safeVolume = clampAudioGain(volume, AUDIO_CLIP_GAIN);
  const volumePct = Math.round(safeVolume * 100);
  const safeMasterVolume = clampAudioGain(masterVolume, AUDIO_MASTER_GAIN);
  const masterVolumePct = Math.round(safeMasterVolume * 100);
  const bgmVolume = clampAudioGain(bgm?.volume, AUDIO_BGM_GAIN);
  const bgmVolumePct = Math.round(bgmVolume * 100);
  const bgmFadeIn = Math.max(AUDIO_FADE_DURATION.min, Math.min(AUDIO_FADE_DURATION.uiMax, Number(bgm?.fade_in_sec) || AUDIO_FADE_DURATION.default));
  const bgmFadeOut = Math.max(AUDIO_FADE_DURATION.min, Math.min(AUDIO_FADE_DURATION.uiMax, Number(bgm?.fade_out_sec) || AUDIO_FADE_DURATION.default));
  const rawBgmStart = Number(bgm?.start_sec);
  const bgmStart = Math.max(
    TIMELINE_TIME.min,
    Math.min(TIMELINE_TIME.max, Number.isFinite(rawBgmStart) ? rawBgmStart : TIMELINE_TIME.default),
  );
  const bgmStartMax = Math.max(
    TIMELINE_TIME.uiMax,
    Math.min(TIMELINE_TIME.max, Number(timelineTotalSec) || TIMELINE_TIME.default),
    bgmStart,
  );
  const bgmDuckingEnabled = Boolean(bgm?.ducking_enabled);
  const rawBgmDuckingVolume = Number(bgm?.ducking_volume);
  const bgmDuckingVolume = Math.round(clampAudioGain(rawBgmDuckingVolume, AUDIO_DUCKING_GAIN) * 100);
  const maxFade = Math.max(
    TIMELINE_DURATION.uiMin,
    Math.min(AUDIO_FADE_DURATION.uiMax, Math.ceil(Math.max(Number(clipDuration) || 0, Number(fadeInSec) || 0, Number(fadeOutSec) || 0, TIMELINE_DURATION.uiMin))),
  );
  const safeFadeIn = Math.max(AUDIO_FADE_DURATION.min, Math.min(maxFade, Number(fadeInSec) || AUDIO_FADE_DURATION.default));
  const safeFadeOut = Math.max(AUDIO_FADE_DURATION.min, Math.min(maxFade, Number(fadeOutSec) || AUDIO_FADE_DURATION.default));
  const soundEnabled = !muted && volumePct > 0;
  const rawTrackVolume = Number(trackVolume);
  const trackVolumePct = Math.round(clampAudioGain(rawTrackVolume, AUDIO_TRACK_GAIN) * 100);

  const commit = (patch) => {
    if (onAudioPatch) {
      onAudioPatch(patch);
      return;
    }
    if (patch.volume != null) onVolumeChange?.(patch.volume);
  };

  const handleEnabledChange = (checked) => {
    if (isAudioClip) {
      if (checked && safeVolume <= 0) onVolumeChange?.(1);
      onAudioPatch?.({ muted: !checked });
      return;
    }
    onVolumeChange?.(checked ? Math.max(safeVolume, 1) : 0);
  };

  const handleVolumeChange = (pct) => {
    const next = clampAudioGain(Number(pct) / 100, AUDIO_CLIP_GAIN, 0);
    // The shell resolves this callback at the current playhead, so an active
    // audio keyframe is updated instead of silently changing the base volume.
    onVolumeChange?.(next);
    if (isAudioClip && Boolean(muted) !== (next <= 0)) onAudioPatch?.({ muted: next <= 0 });
  };

  const updateBgm = (patch) => {
    const base = bgm && typeof bgm === "object" ? bgm : {};
    onBgmChange?.({ ...base, ...patch });
  };

  const selectBgmAsset = (assetId) => {
    const asset = audioAssets.find((a) => String(a.id) === String(assetId));
    if (!asset) {
      onBgmChange?.(null);
      return;
    }
    onBgmChange?.({
      path: asset.path || asset.file_path,
      name: asset.name || "BGM",
      asset_id: asset.id,
      duration_sec: Number(asset.duration_sec) || null,
      volume: bgmVolume,
      start_sec: bgmStart,
      fade_in_sec: bgmFadeIn,
      fade_out_sec: bgmFadeOut,
      ducking_enabled: bgmDuckingEnabled,
      ducking_volume: bgmDuckingVolume / 100,
    });
  };

  const masterOutput = (
    <PaneSection title="主输出">
      <ProSlider
        label="项目音量 (%)"
        value={masterVolumePct}
        onChange={(pct) => onMasterVolumeChange?.(clampAudioGain(Number(pct) / 100, AUDIO_MASTER_GAIN, 0))}
        min={AUDIO_MASTER_GAIN.min * 100}
        max={AUDIO_MASTER_GAIN.max * 100}
        resetValue={AUDIO_MASTER_GAIN.default * 100}
      />
      <p className="text-[10px] leading-relaxed text-cs2-text-muted">
        导出时作用于整条成片：V 轨原声与音频轨(A轨)混音都会经过这一级音量。
      </p>
    </PaneSection>
  );

  const trackMix = onTrackVolumeChange ? (
    <PaneSection title={isAudioClip ? "音频轨(A轨)增益" : "视频轨原声增益"}>
      <ProSlider
        label={`${trackLabel} 整轨音量 (%)`}
        value={trackVolumePct}
        onChange={(pct) => onTrackVolumeChange(clampAudioGain(Number(pct) / 100, AUDIO_TRACK_GAIN, 0))}
        min={AUDIO_TRACK_GAIN.min * 100}
        max={AUDIO_TRACK_GAIN.max * 100}
        resetValue={AUDIO_TRACK_GAIN.default * 100}
      />
      <p className="text-[10px] leading-relaxed text-cs2-text-muted">
        {isAudioClip
          ? "作用于这条音频轨(A轨)内的全部音频片段，不影响其他音频轨(A轨)、视频轨原声或工程 BGM。"
          : "作用于这条视频轨内全部视频片段的原声，不改变单个片段音量，也不影响音频轨(A轨)或工程 BGM。"}
      </p>
    </PaneSection>
  ) : null;

  const bgmSection = (
    <PaneSection title="工程 BGM（全局）">
      <div className="litecut-property-inline-group px-1 py-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-bold text-cs2-accent">独立的全局背景音乐</p>
          <span className="shrink-0 rounded-full border border-cs2-accent/40 px-1.5 py-0.5 text-[8px] font-bold text-cs2-accent">不占用音频轨(A轨)</span>
        </div>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-cs2-text-secondary">
          <li>全工程只能设置一条，从指定开始时间播放，无需放到时间轴音频轨(A轨)。</li>
          <li>音频轨(A轨)用于可移动、裁切和叠加的配乐、语音或音效；两者导出时会同时混音。</li>
          <li>同一音频既设为 BGM 又放入音频轨(A轨)会叠加播放；音频轨(A轨)启用“独奏”时会暂时排除 BGM。</li>
        </ul>
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] font-medium text-cs2-text-muted">选择全局背景音乐</span>
        <select
          value={bgm?.asset_id ?? ""}
          onChange={(e) => selectBgmAsset(e.target.value)}
          className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-[11px] text-cs2-text-primary"
        >
          <option value="">不使用 BGM</option>
          {audioAssets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name || `audio-${asset.id}`}
            </option>
          ))}
        </select>
      </label>
      {bgm?.path ? (
        <>
          <ProSlider
            label="BGM 音量 (%)"
            value={bgmVolumePct}
            onChange={(pct) => updateBgm({ volume: clampAudioGain(Number(pct) / 100, AUDIO_BGM_GAIN, 0) })}
            min={AUDIO_BGM_GAIN.min * 100}
            max={AUDIO_BGM_GAIN.max * 100}
            resetValue={AUDIO_BGM_GAIN.default * 100}
          />
          <ProSlider
            label="开始时间 (s)"
            value={bgmStart}
            onChange={(v) => updateBgm({ start_sec: Math.max(TIMELINE_TIME.min, Math.min(bgmStartMax, Number(v) || TIMELINE_TIME.default)) })}
            min={TIMELINE_TIME.min}
            max={bgmStartMax}
            resetValue={TIMELINE_TIME.default}
            step={0.5}
          />
          <div className="grid grid-cols-2 gap-2">
            <ProSlider
              label="淡入 (s)"
              value={bgmFadeIn}
              onChange={(v) => updateBgm({ fade_in_sec: Math.max(AUDIO_FADE_DURATION.min, Number(v) || AUDIO_FADE_DURATION.default) })}
              min={AUDIO_FADE_DURATION.min}
              max={AUDIO_FADE_DURATION.uiMax}
              resetValue={AUDIO_FADE_DURATION.default}
              step={0.1}
            />
            <ProSlider
              label="淡出 (s)"
              value={bgmFadeOut}
              onChange={(v) => updateBgm({ fade_out_sec: Math.max(AUDIO_FADE_DURATION.min, Number(v) || AUDIO_FADE_DURATION.default) })}
              min={AUDIO_FADE_DURATION.min}
              max={AUDIO_FADE_DURATION.uiMax}
              resetValue={AUDIO_FADE_DURATION.default}
              step={0.1}
            />
          </div>
          <div className="litecut-property-inline-group flex items-center justify-between px-1 py-1">
            <span className="text-[10px] font-semibold text-cs2-text-secondary">原声时自动压低 BGM</span>
            <Toggle checked={bgmDuckingEnabled} onChange={(checked) => updateBgm({ ducking_enabled: checked })} />
          </div>
          {bgmDuckingEnabled ? (
            <ProSlider
              label="压低后 BGM (%)"
              value={bgmDuckingVolume}
              onChange={(pct) => updateBgm({ ducking_volume: clampAudioGain(Number(pct) / 100, AUDIO_DUCKING_GAIN, 0) })}
              min={AUDIO_DUCKING_GAIN.min * 100}
              max={AUDIO_DUCKING_GAIN.max * 100}
              resetValue={AUDIO_DUCKING_GAIN.default * 100}
            />
          ) : null}
          <p className="truncate font-mono text-[10px] text-cs2-text-muted" title={bgm.path}>
            {bgm.name || bgm.path}
          </p>
        </>
      ) : (
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          上传 MP3 / WAV / M4A 后可设为全局 BGM；需要在时间轴上精确摆放、裁切或重复使用时，请改放到音频轨(A轨)。
        </p>
      )}
    </PaneSection>
  );

  const keyframeControls = (
    <KeyframeEditorBar
      label="音量关键帧"
      active={clipHasAudioKeyframe}
      onAdd={onAddClipAudioKeyframe}
      onRemove={onRemoveClipAudioKeyframe}
      hint="把播放头移到需要改变音量的位置，先添加关键帧，再调整上方的片段音量；关键帧之间会自动平滑变化。"
    />
  );

  if (isAudioClip) {
    return (
      <>
        {masterOutput}
        {bgmSection}
        {trackMix}
        <PaneSection title="音频轨(A轨)片段">
          <div className="litecut-property-inline-group flex items-center gap-2 px-1 py-1">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cs2-accent-soft text-cs2-accent">
              <Volume2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-cs2-text-primary">{clipLabel}</p>
              <p className="text-[10px] text-cs2-text-muted">音频素材 · 导出时混入主视频</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cs2-text-secondary">启用声音</span>
            <Toggle checked={soundEnabled} onChange={handleEnabledChange} />
          </div>
          <ProSlider label="片段音量 (%)" value={volumePct} onChange={handleVolumeChange} min={AUDIO_CLIP_GAIN.min * 100} max={AUDIO_CLIP_GAIN.max * 100} resetValue={AUDIO_CLIP_GAIN.default * 100} />
          {keyframeControls}
          <AudioWaveformBars sourceUrl={sourceUrl} startSec={trimIn} endSec={Number(trimIn) + Number(clipDuration || 0)} className="h-10 rounded-md" />
          <p className="text-[10px] text-cs2-text-muted">作用于当前音频轨(A轨)片段 · {clipLabel}</p>
        </PaneSection>

        <PaneSection title="淡入淡出">
          <ProSlider
            label="淡入 (s)"
            value={safeFadeIn}
            onChange={(v) => commit({ fade_in_sec: Math.max(AUDIO_FADE_DURATION.min, Number(v) || AUDIO_FADE_DURATION.default) })}
            min={AUDIO_FADE_DURATION.min}
            max={maxFade}
            resetValue={AUDIO_FADE_DURATION.default}
            step={0.1}
          />
          <ProSlider
            label="淡出 (s)"
            value={safeFadeOut}
            onChange={(v) => commit({ fade_out_sec: Math.max(AUDIO_FADE_DURATION.min, Number(v) || AUDIO_FADE_DURATION.default) })}
            min={AUDIO_FADE_DURATION.min}
            max={maxFade}
            resetValue={AUDIO_FADE_DURATION.default}
            step={0.1}
          />
          <p className="text-[10px] leading-relaxed text-cs2-text-muted">
            导出时 FFmpeg 会把淡入淡出应用在该音频片段自身，再按时间轴位置延迟混音。
          </p>
        </PaneSection>
      </>
    );
  }

  return (
    <>
      {masterOutput}
      {bgmSection}
      {trackMix}
      <PaneSection title="当前视频片段原声">
        <ProSlider
          label="当前片段原声音量 (%)"
          value={volumePct}
          onChange={handleVolumeChange}
          min={AUDIO_CLIP_GAIN.min * 100}
          max={AUDIO_CLIP_GAIN.max * 100}
          resetValue={AUDIO_CLIP_GAIN.default * 100}
        />
        {keyframeControls}
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          这里调整当前视频片段自身的原声，也可在“片段”页调整；最终原声音量按“片段音量 × 视频轨增益 × 项目音量”计算。
        </p>
      </PaneSection>

      <PaneSection title="音频轨(A轨)素材" defaultOpen={false}>
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          MP3 / WAV / M4A 可从左侧本地素材拖到 A1、A2 等音频轨(A轨)；选中音频轨(A轨)片段后可调音量、静音和淡入淡出。
        </p>
      </PaneSection>
    </>
  );
}

function basenameFromPath(path) {
  const s = String(path || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function formatExportTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function exportStatusLabel(status) {
  return (
    {
      queued: "排队",
      running: "导出中",
      cancelling: "取消中",
      cancelled: "已取消",
      interrupted: "已中断",
      done: "完成",
      error: "失败",
    }[status] || status || "-"
  );
}

function canvasRatioLabel(width, height) {
  let w = Math.max(1, Math.round(Number(width) || 1920));
  let h = Math.max(1, Math.round(Number(height) || 1080));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(w, h);
  w /= divisor;
  h /= divisor;
  return `${w}:${h}`;
}

export function CanvasPane({
  width = LITE_CUT_OUTPUT_DEFAULTS.width,
  height = LITE_CUT_OUTPUT_DEFAULTS.height,
  canvasFit = LITE_CUT_OUTPUT_DEFAULTS.canvas_fit,
  backgroundColor = LITE_CUT_OUTPUT_DEFAULTS.background_color,
  blurAmount = OUTPUT_BLUR.default,
  onOutputSettingsChange,
}) {
  const commitCanvas = (patch) => onOutputSettingsChange?.(patch);
  const sizePresets = CANVAS_PRESETS;
  const currentRatio = canvasRatioLabel(width, height);
  const hasPresetRatio = sizePresets.some((preset) => preset.id === currentRatio);
  const fitLabels = {
    contain: { label: "适应", desc: "保留完整画面" },
    cover: { label: "填满", desc: "裁切画面边缘" },
    blur: { label: "模糊底", desc: "竖屏与窄屏素材" },
  };
  const fitOptions = LITE_CUT_CANVAS_FIT_VALUES.map((id) => ({ id, ...fitLabels[id] })).filter((item) => item.label);
  const normalizedColor = /^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : LITE_CUT_OUTPUT_DEFAULTS.background_color;
  const normalizedBlur = Math.max(OUTPUT_BLUR.min, Math.min(OUTPUT_BLUR.max, Number(blurAmount) || OUTPUT_BLUR.default));
  const [widthDraft, setWidthDraft] = useState(String(width));
  const [heightDraft, setHeightDraft] = useState(String(height));
  useEffect(() => setWidthDraft(String(width)), [width]);
  useEffect(() => setHeightDraft(String(height)), [height]);
  const commitWidth = () => {
    const nextWidth = Math.max(OUTPUT_WIDTH.min, Math.min(OUTPUT_WIDTH.max, Number(widthDraft) || Number(width) || LITE_CUT_OUTPUT_DEFAULTS.width));
    setWidthDraft(String(nextWidth));
    if (nextWidth !== Number(width)) commitCanvas({ width: nextWidth });
  };
  const commitHeight = () => {
    const nextHeight = Math.max(OUTPUT_HEIGHT.min, Math.min(OUTPUT_HEIGHT.max, Number(heightDraft) || Number(height) || LITE_CUT_OUTPUT_DEFAULTS.height));
    setHeightDraft(String(nextHeight));
    if (nextHeight !== Number(height)) commitCanvas({ height: nextHeight });
  };

  return (
    <div className="space-y-2">
      <PaneSection title="画布规格">
        <div className="litecut-property-inline-group flex items-center justify-between px-1 py-1">
          <div>
            <p className="text-[11px] font-bold text-cs2-text-primary">当前工程画布</p>
            <p className="mt-0.5 text-[9px] text-cs2-text-muted">修改后会立即同步预览，导出沿用当前比例。</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-[12px] font-bold text-cs2-accent">{currentRatio}</p>
            <p className="font-mono text-[9px] text-cs2-text-muted">{width} × {height}</p>
          </div>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {sizePresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => commitCanvas({ width: preset.width, height: preset.height })}
              className={`rounded-lg border px-1 py-1.5 text-[9px] font-bold transition-colors ${
                currentRatio === preset.id
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 bg-cs2-bg-card text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              {preset.id}
            </button>
          ))}
          <span
            aria-label="自定义画布比例"
            className={`cursor-default rounded-lg border px-1 py-1.5 text-center text-[9px] font-bold ${
              !hasPresetRatio
                ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                : "border-cs2-border/60 bg-cs2-bg-card text-cs2-text-muted"
            }`}
          >
            自定义
          </span>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <input
            type="number"
            aria-label="画布宽度"
            min={OUTPUT_WIDTH.min}
            max={OUTPUT_WIDTH.max}
            value={widthDraft}
            onChange={(event) => setWidthDraft(event.target.value)}
            onBlur={commitWidth}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="litecut-property-number w-full"
          />
          <span className="text-[10px] text-cs2-text-muted">×</span>
          <input
            type="number"
            aria-label="画布高度"
            min={OUTPUT_HEIGHT.min}
            max={OUTPUT_HEIGHT.max}
            value={heightDraft}
            onChange={(event) => setHeightDraft(event.target.value)}
            onBlur={commitHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="litecut-property-number w-full"
          />
        </div>
      </PaneSection>

      <PaneSection title="画布适配">
        <div className="grid grid-cols-3 gap-1.5">
          {fitOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => commitCanvas({ canvas_fit: option.id })}
              className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                canvasFit === option.id
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 bg-cs2-bg-card text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              <span className="block text-[10px] font-bold">{option.label}</span>
              <span className="mt-0.5 block whitespace-normal text-[9px] leading-snug opacity-75">{option.desc}</span>
            </button>
          ))}
        </div>
      </PaneSection>

      <PaneSection title="画布背景">
        <label className="block space-y-1">
          <span className="text-[10px] font-medium text-cs2-text-muted">底色</span>
          <div className="flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5">
            <input
              type="color"
              aria-label="画布底色"
              value={normalizedColor}
              onChange={(event) => commitCanvas({ background_color: event.target.value })}
              className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
            />
            <span className="font-mono text-[10px] text-cs2-text-secondary">{normalizedColor}</span>
          </div>
        </label>
        <label className={`block space-y-1 ${canvasFit === "blur" ? "" : "opacity-55"}`}>
          <span className="flex items-center justify-between text-[10px] font-medium text-cs2-text-muted">
            <span>模糊强度</span>
            <span className="font-mono">{normalizedBlur}</span>
          </span>
          <input
            type="range"
            aria-label="画布模糊强度"
            min={OUTPUT_BLUR.min}
            max={OUTPUT_BLUR.max}
            step={1}
            value={normalizedBlur}
            disabled={canvasFit !== "blur"}
            onChange={(event) => commitCanvas({ blur_amount: Math.max(OUTPUT_BLUR.min, Math.min(OUTPUT_BLUR.max, Number(event.target.value) || OUTPUT_BLUR.default)) })}
            style={{ "--cs2-range-progress": `${((normalizedBlur - OUTPUT_BLUR.min) / Math.max(1, OUTPUT_BLUR.max - OUTPUT_BLUR.min)) * 100}%` }}
            className="cs2-data-slider w-full disabled:cursor-not-allowed disabled:opacity-40"
          />
          {canvasFit !== "blur" ? <p className="text-[9px] text-cs2-text-muted">选择“模糊底”后可调节。</p> : null}
        </label>
      </PaneSection>
    </div>
  );
}

export function ExportPane({
  outputDir,
  outputDirHint,
  filename,
  width = LITE_CUT_OUTPUT_DEFAULTS.width,
  height = LITE_CUT_OUTPUT_DEFAULTS.height,
  fps = LITE_CUT_OUTPUT_DEFAULTS.fps,
  framemeldEnabled = false,
  framemeldRuntimeAvailable = false,
  framemeldSourceItems = [],
  encoder = LITE_CUT_OUTPUT_DEFAULTS.encoder,
  encoderTier = LITE_CUT_OUTPUT_DEFAULTS.encoder_tier,
  rangeMode = LITE_CUT_OUTPUT_DEFAULTS.range_mode,
  rangeStartSec = LITE_CUT_OUTPUT_DEFAULTS.range_start_sec,
  rangeEndSec = TIMELINE_DURATION.uiMin,
  rangeValid = true,
  selectedExportRange = null,
  timelineTotalSec = 0,
  currentPlayheadSec = 0,
  onOutputDirChange,
  onFilenameChange,
  onOutputSettingsChange,
  onExport,
  exporting,
  exportError,
  exportHistory = [],
  onRefreshExportHistory,
  clipCount,
}) {
  const t = useT();
  const canExport = clipCount > 0 && (outputDir.trim() || outputDirHint) && filename.trim() && rangeValid;
  const [encoderDetecting, setEncoderDetecting] = useState(false);
  const [encoderDetection, setEncoderDetection] = useState(null);
  const [frameMeldConfirmationOpen, setFrameMeldConfirmationOpen] = useState(false);
  const commitSize = (patch) => onOutputSettingsChange?.(patch);
  const setPresetSize = (w, h) => commitSize({ width: w, height: h });
  const framemeldSourceSummary = summarizeFrameMeldSources(framemeldSourceItems);
  const framemeldAvailable = framemeldRuntimeAvailable && framemeldSourceSummary.compatible;
  const framemeldActive = framemeldAvailable && Boolean(framemeldEnabled);
  const framemeldBlockedReason = !framemeldRuntimeAvailable
    ? t("liteCut.frameMeldUnavailable")
    : framemeldSourceSummary.hasUnknownFps || !framemeldSourceItems.length
      ? t("liteCut.frameMeldBlockedUnknownFps")
      : framemeldSourceSummary.hasMixedFrameRates
        ? t("liteCut.frameMeldBlockedMixedFps")
        : "";
  const commitWorkingFps = (value) => {
    const nextFps = Math.max(OUTPUT_FPS.min, Math.min(OUTPUT_FPS.max, Math.round(Number(value) || LITE_CUT_OUTPUT_DEFAULTS.fps)));
    commitSize({ fps: nextFps });
  };
  const toggleFrameMeld = () => {
    if (!framemeldAvailable) return;
    if (framemeldActive) {
      commitSize({ framemeld_enabled: false });
      return;
    }
    setFrameMeldConfirmationOpen(true);
  };
  const confirmFrameMeld = () => {
    setFrameMeldConfirmationOpen(false);
    if (framemeldAvailable) commitSize({ framemeld_enabled: true });
  };
  const maxRangeEnd = Math.max(TIMELINE_DURATION.uiMin, Math.min(TIMELINE_TIME.max, Number(timelineTotalSec) || TIMELINE_DURATION.uiMin));
  const clampRangeStart = (value) => Math.max(TIMELINE_TIME.min, Math.min(maxRangeEnd - TIMELINE_DURATION.uiMin, Number(value) || TIMELINE_TIME.default));
  const clampRangeEnd = (value, start = rangeStartSec) =>
    Math.max(clampRangeStart(start) + TIMELINE_DURATION.uiMin, Math.min(maxRangeEnd, Number(value) || maxRangeEnd));
  const commitRangeStart = (value) => {
    const start = clampRangeStart(value);
    commitSize({ range_mode: "custom", range_start_sec: start, range_end_sec: clampRangeEnd(rangeEndSec, start) });
  };
  const commitRangeEnd = (value) => {
    commitSize({ range_mode: "custom", range_end_sec: clampRangeEnd(value) });
  };
  const commitSelectionRange = () => {
    if (!selectedExportRange) return;
    const start = clampRangeStart(selectedExportRange.startSec);
    commitSize({
      range_mode: "custom",
      range_start_sec: start,
      range_end_sec: clampRangeEnd(selectedExportRange.endSec, start),
    });
  };
  const detectEncoders = async () => {
    setEncoderDetecting(true);
    setEncoderDetection(null);
    try {
      const data = await liteCutClient.detectEncoder();
      setEncoderDetection(data || null);
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setEncoderDetection({ error: typeof detail === "string" ? detail : error?.message || "编码器检测失败" });
    } finally {
      setEncoderDetecting(false);
    }
  };
  const copyExportPath = async (path) => {
    if (!path) return;
    await writeLiteCutClipboardText(path);
  };
  const revealExportPath = async (path) => {
    if (!path) return;
    try {
      if (desktopBridge?.showItemInFolder && await desktopBridge.showItemInFolder(path)) return;
    } catch {
      // Copying the path remains a useful fallback in browser mode.
    }
    await copyExportPath(path);
  };
  const chooseOutputDir = async () => {
    try {
      const chosen = await desktopBridge?.chooseDirectory?.(outputDir.trim() || outputDirHint);
      if (chosen) onOutputDirChange?.(chosen);
    } catch {
      // The text field remains available when the desktop shell cannot open a picker.
    }
  };
  return (
    <div className="space-y-2">
      <PaneSection title="导出规格">
        <div className="grid grid-cols-2 gap-1.5">
          {LITE_CUT_RESOLUTION_PRESETS.map(({ width: w, height: h, id: label }) => (
            <button
              key={label}
              type="button"
              onClick={() => setPresetSize(w, h)}
              className={`rounded-lg border px-2 py-1.5 text-[10px] font-bold ${
                Number(width) === w && Number(height) === h
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">宽</span>
            <input
              type="number"
              min={OUTPUT_WIDTH.min}
              max={OUTPUT_WIDTH.max}
              value={width}
              onChange={(e) => commitSize({ width: Math.max(OUTPUT_WIDTH.min, Math.min(OUTPUT_WIDTH.max, Number(e.target.value) || LITE_CUT_OUTPUT_DEFAULTS.width)) })}
              className="litecut-property-number w-full"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">高</span>
            <input
              type="number"
              min={OUTPUT_HEIGHT.min}
              max={OUTPUT_HEIGHT.max}
              value={height}
              onChange={(e) => commitSize({ height: Math.max(OUTPUT_HEIGHT.min, Math.min(OUTPUT_HEIGHT.max, Number(e.target.value) || LITE_CUT_OUTPUT_DEFAULTS.height)) })}
              className="litecut-property-number w-full"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">工程帧率 (FPS)</span>
            <input
              type="number"
              min={OUTPUT_FPS.min}
              max={OUTPUT_FPS.max}
              step="1"
              value={fps}
              onChange={(e) => commitWorkingFps(e.target.value)}
              className="litecut-property-number w-full"
              aria-label="工程帧率"
            />
          </label>
        </div>
        <div className="rounded-lg border border-cs2-border/70 bg-cs2-surface-1/60 p-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-cs2-text-primary">{t("liteCut.frameMeldTitle")}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-cs2-text-muted">
                {t("liteCut.frameMeldHint")}
              </p>
            </div>
            <button
              type="button"
              aria-pressed={framemeldActive}
              aria-label={t("liteCut.frameMeldTitle")}
              disabled={!framemeldAvailable}
              onClick={toggleFrameMeld}
              className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 active:scale-95 ${
                framemeldActive
                  ? "border-cs2-accent bg-cs2-accent text-white shadow-sm"
                  : "border-cs2-border bg-cs2-bg-input text-transparent hover:border-cs2-accent/70 hover:bg-cs2-surface-2"
              }`}
            >
              <Check size={17} strokeWidth={3} aria-hidden="true" />
            </button>
          </div>
          {!framemeldAvailable ? (
            <p className="mt-2 text-[10px] leading-relaxed text-amber-300/90">{framemeldBlockedReason}</p>
          ) : framemeldActive ? (
            <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">{t("liteCut.frameMeldLockedPlan")}</p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            ["quality", "高质量"],
            ["fast", "快速导出"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => commitSize({ encoder_tier: id })}
              className={`rounded-lg border px-2 py-1.5 text-[10px] font-bold ${
                encoderTier === id
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </PaneSection>
      <PaneSection title="视频编码" defaultOpen={false}>
        <div className="flex gap-2">
          <select
            value={encoder}
            onChange={(event) => commitSize({ encoder: event.target.value })}
            className="min-w-0 flex-1 rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-2 text-[11px] text-cs2-text-primary focus:border-amber-500/70 focus:outline-none"
          >
            <option value="auto">自动（主显卡硬编 → x264 保底）</option>
            <option value="h264_nvenc">NVIDIA NVENC</option>
            <option value="h264_qsv">Intel Quick Sync (QSV)</option>
            <option value="h264_amf">AMD AMF</option>
            <option value="libx264">x264 软件（CPU）</option>
          </select>
          <button
            type="button"
            onClick={() => void detectEncoders()}
            disabled={encoderDetecting}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-cs2-border px-3 text-[10px] font-semibold text-cs2-text-secondary hover:border-amber-500/60 hover:text-amber-200 disabled:opacity-50"
          >
            {encoderDetecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {encoderDetecting ? "检测中" : "检测"}
          </button>
        </div>
        {encoderDetection?.error ? <p className="text-[10px] text-rose-300">{encoderDetection.error}</p> : null}
        {encoderDetection && !encoderDetection.error ? <div className="space-y-1 text-[10px] text-cs2-text-muted">
          <p>自动选择：<span className="font-semibold text-emerald-300">{{ h264_nvenc: "NVIDIA NVENC", h264_qsv: "Intel QSV", h264_amf: "AMD AMF", libx264: "x264 CPU", none: "无可用编码器" }[encoderDetection.selected] || encoderDetection.selected}</span></p>
          <p>{(encoderDetection.hw || []).map((item) => `${item.codec.replace("h264_", "").toUpperCase()} ${item.probe_ok ? "✓" : "×"}`).join(" · ")} · x264 {encoderDetection.libx264_available ? "✓" : "×"}</p>
        </div> : <p className="text-[10px] text-cs2-text-muted">硬件编码能显著降低导出时的 CPU 占用；点击检测确认本机可用项。</p>}
      </PaneSection>
      <PaneSection title="导出范围" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            ["full", "完整时间轴"],
            ["custom", "自定义范围"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => commitSize({ range_mode: id })}
              className={`rounded-lg border px-2 py-1.5 text-[10px] font-bold ${
                rangeMode === id
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {rangeMode === "custom" ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-[10px] font-medium text-cs2-text-muted">开始时间</span>
                <input
                  type="number"
                  min={TIMELINE_TIME.min}
                  max={maxRangeEnd}
                  step={0.1}
                  value={Number(rangeStartSec).toFixed(1)}
                  onChange={(e) => commitRangeStart(e.target.value)}
                  className="litecut-property-number w-full"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] font-medium text-cs2-text-muted">结束时间</span>
                <input
                  type="number"
                  min={TIMELINE_DURATION.uiMin}
                  max={maxRangeEnd}
                  step={0.1}
                  value={Number(rangeEndSec).toFixed(1)}
                  onChange={(e) => commitRangeEnd(e.target.value)}
                  className="litecut-property-number w-full"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => commitRangeStart(currentPlayheadSec)}
                className="rounded-lg border border-cs2-border/60 px-2 py-1.5 text-[10px] font-semibold text-cs2-text-muted hover:border-cs2-border-focus"
              >
                开始点设为播放头
              </button>
              <button
                type="button"
                onClick={() => commitRangeEnd(currentPlayheadSec)}
                className="rounded-lg border border-cs2-border/60 px-2 py-1.5 text-[10px] font-semibold text-cs2-text-muted hover:border-cs2-border-focus"
              >
                结束点设为播放头
              </button>
            </div>
            <button
              type="button"
              onClick={commitSelectionRange}
              disabled={!selectedExportRange}
              className="w-full rounded-lg border border-cs2-border/60 px-2 py-1.5 text-[10px] font-semibold text-cs2-text-muted hover:border-cs2-border-focus disabled:cursor-not-allowed disabled:opacity-40"
            >
              使用时间轴选区
            </button>
          </div>
        ) : null}
      </PaneSection>
      <PaneSection title="输出路径">
        <label className="block space-y-1">
          <span className="text-[10px] font-medium text-cs2-text-muted">文件夹（绝对路径）</span>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => onOutputDirChange?.(e.target.value)}
              placeholder={outputDirHint || "D:\\Videos\\CS2Exports\\lite-cut"}
              className="min-w-0 flex-1 rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-2 font-mono text-[11px] text-cs2-text-primary"
            />
            {desktopBridge?.chooseDirectory ? (
              <button
                type="button"
                title="选择导出文件夹"
                onClick={() => void chooseOutputDir()}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cs2-border text-cs2-text-muted hover:bg-white/5 hover:text-cs2-text-primary"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </label>
        {outputDirHint && !outputDir.trim() ? (
          <p className="text-[10px] text-cs2-text-muted">
            留空将使用：<span className="font-mono text-cs2-text-secondary">{outputDirHint}</span>
          </p>
        ) : null}
        <label className="block space-y-1">
          <span className="text-[10px] font-medium text-cs2-text-muted">文件名</span>
          <input
            type="text"
            value={filename}
            onChange={(e) => onFilenameChange?.(e.target.value)}
            className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-2 font-mono text-[11px] text-cs2-text-primary"
          />
        </label>
      </PaneSection>
      <p className="text-[10px] leading-relaxed text-cs2-text-muted">
        视频主轨、裁切、转场、叠加层、音频与调色将统一导出为 MP4。
      </p>
      {exportError ? (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{exportError}</p>
      ) : null}
      <button
        type="button"
        disabled={!canExport || exporting}
        onClick={() => onExport?.()}
        className="w-full rounded-lg bg-cs2-accent py-2.5 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:opacity-40"
      >
        {exporting ? "导出中…" : "使用 FFmpeg 导出"}
      </button>
      {clipCount === 0 ? (
        <p className="text-center text-[10px] text-amber-400/90">请先在视频轨添加片段</p>
      ) : null}
      <PaneSection title="最近导出" defaultOpen={false}>
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-cs2-text-muted">当前工程最近的导出任务</p>
          <button
            type="button"
            onClick={() => onRefreshExportHistory?.()}
            className="rounded p-1 text-cs2-text-muted hover:bg-white/5 hover:text-cs2-text-primary"
            title="刷新导出历史"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
        {exportHistory.length ? (
          <div className="space-y-1.5">
            {exportHistory.slice(0, 6).map((item) => {
              const status = String(item.status || "");
              const done = status === "done";
              const failed = status === "error";
              const file = basenameFromPath(item.output_path) || `export-${item.export_id}`;
              const failureMessage = failed
                ? messageFromApiCode(item.error, t) || item.error || "-"
                : "";
              return (
                <div key={item.export_id} className="rounded-lg border border-cs2-border/60 bg-cs2-surface-1/60 px-2 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        done ? "bg-emerald-400" : failed ? "bg-rose-400" : status === "cancelled" ? "bg-amber-400" : "bg-cs2-accent"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-cs2-text-primary">{file}</span>
                    <span className="text-[9px] font-semibold text-cs2-text-muted">{exportStatusLabel(status)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[9px] text-cs2-text-muted">
                      {failed ? failureMessage : item.output_path || "-"}
                    </span>
                    {done && item.output_path ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          title="在文件夹中显示"
                          onClick={() => void revealExportPath(item.output_path)}
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-cs2-text-muted hover:bg-white/5 hover:text-cs2-text-primary"
                        >
                          <FolderOpen className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="复制输出路径"
                          onClick={() => void copyExportPath(item.output_path)}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold text-cs2-accent hover:bg-cs2-accent-soft"
                        >
                          复制
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[9px] text-cs2-text-muted">{formatExportTime(item.updated_at || item.created_at)}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-cs2-border/60 px-3 py-3 text-center text-[10px] text-cs2-text-muted">
            还没有导出记录
          </p>
        )}
      </PaneSection>
      <FrameMeldEnableDialog
        open={frameMeldConfirmationOpen}
        onCancel={() => setFrameMeldConfirmationOpen(false)}
        onConfirm={confirmFrameMeld}
      />
    </div>
  );
}
