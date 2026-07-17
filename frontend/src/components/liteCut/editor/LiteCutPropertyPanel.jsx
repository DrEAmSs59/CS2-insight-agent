import {
  Film,
  Type,
  SlidersHorizontal,
  Volume2,
  Gauge,
  Download,
  FolderOpen,
  RotateCcw,
  FlipHorizontal,
  FlipVertical,
  Captions,
  CopyCheck,
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
import { ConfigProvider } from "antd";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";
import { useT } from "../../../i18n/useT.js";
import API from "../../../api/api.js";
import AudioWaveformBars from "./AudioWaveformBars.jsx";
import ColorPropertyPane from "./ColorPropertyPane.jsx";
import SpeedPropertyPane from "./SpeedPropertyPane.jsx";
import { NumericPairCard, PaneSection, ProSlider, ScopeActionButton, snapRotation, Toggle, useTransformControls } from "./PropertyControls.jsx";
import {
  TEXT_STYLE_CARDS,
  FONT_OPTIONS,
  TEXT_ANIMATION_OPTIONS,
  TRANSITION_OPTIONS,
} from "./editorPresets.js";

const RAIL = [
  { id: "clip", labelKey: "liteCut.inspector.clip", icon: Film },
  { id: "text", labelKey: "liteCut.inspector.text", icon: Type },
  { id: "color", labelKey: "liteCut.inspector.color", icon: SlidersHorizontal },
  { id: "audio", labelKey: "liteCut.inspector.audio", icon: Volume2 },
  { id: "speed", labelKey: "liteCut.inspector.speed", icon: Gauge },
  { id: "export", labelKey: "liteCut.inspector.export", icon: Download },
];
const SOURCE_METADATA_CACHE = new Map();

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
    <div className="space-y-1.5 rounded-lg border border-cs2-border/60 bg-cs2-surface-1/55 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-cs2-text-primary">{label}</p>
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
  transitionType = "fade",
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
  overlayFadeInSec = 0,
  overlayFadeOutSec = 0,
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
  isVideoLayer = false,
  isAudioClip = false,
  isOverlay = false,
  clipVolume = 1,
  onClipVolumeChange,
  outputWidth = 1920,
  outputHeight = 1080,
}) {
  const [sourceMetadata, setSourceMetadata] = useState(null);
  const transformControls = useTransformControls(
    isOverlay ? overlayTransform : clipTransform,
    isOverlay ? onOverlayTransformChange : onClipTransformChange,
    isOverlay ? 0.33 : 1,
  );
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
    API.get(`/lite-cut/assets/${assetId}/metadata`)
      .then(({ data }) => {
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
  const overlayMaxFade = Math.max(
    1,
    Math.min(10, Math.ceil(Math.max(Number(media?.duration) || 0, Number(overlayFadeInSec) || 0, Number(overlayFadeOutSec) || 0, 1))),
  );
  const clipMaxFade = Math.max(
    1,
    Math.min(10, Math.ceil(Math.max(Number(clipDuration) || 0, Number(clipFadeInSec) || 0, Number(clipFadeOutSec) || 0, 1))),
  );
  const activeCanvasFit = ["contain", "cover", "blur"].includes(clipCanvasFit) ? clipCanvasFit : "inherit";
  const overlayScale = Math.max(0.01, Number(overlayTransform?.scale) || 1);
  const overlayWidthPx = Math.max(1, (Number(overlayTransform?.width) || 0.33) * outputWidth * overlayScale);
  const overlayHeightPx = Math.max(1, (Number(overlayTransform?.height) || 0.33) * outputHeight * overlayScale);
  const setOverlayWidthPx = (value) => {
    const nextWidthPx = Math.max(1, Number(value) || 1);
    const width = nextWidthPx / (outputWidth * overlayScale);
    const nextHeightPx = overlayHeightPx * nextWidthPx / overlayWidthPx;
    onOverlayTransformChange?.(transformControls.sizeLinked
      ? { width, height: nextHeightPx / (outputHeight * overlayScale) }
      : { width });
  };
  const setOverlayHeightPx = (value) => {
    const nextHeightPx = Math.max(1, Number(value) || 1);
    const height = nextHeightPx / (outputHeight * overlayScale);
    const nextWidthPx = overlayWidthPx * nextHeightPx / overlayHeightPx;
    onOverlayTransformChange?.(transformControls.sizeLinked
      ? { height, width: nextWidthPx / (outputWidth * overlayScale) }
      : { height });
  };
  const normalizedCrop = {
    x: Math.max(0, Math.min(1, Number(clipCrop?.x) || 0)),
    y: Math.max(0, Math.min(1, Number(clipCrop?.y) || 0)),
    width: Math.max(0.05, Math.min(1, Number(clipCrop?.width) || 1)),
    height: Math.max(0.05, Math.min(1, Number(clipCrop?.height) || 1)),
  };
  normalizedCrop.x = Math.min(normalizedCrop.x, 1 - normalizedCrop.width);
  normalizedCrop.y = Math.min(normalizedCrop.y, 1 - normalizedCrop.height);
  const canvasFitOptions = [
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
      <div className="litecut-selected-media flex items-center gap-2 overflow-hidden rounded-lg border border-cs2-border/55 bg-cs2-bg-card p-2 shadow-sm">
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
      {!isOverlay && !isAudioClip && media?.kind !== "image" ? <PaneSection title="视频原声与音量关键帧">
        <KeyframeEditorBar
          label="音量关键帧"
          active={clipHasAudioKeyframe}
          onAdd={onAddClipAudioKeyframe}
          onRemove={onRemoveClipAudioKeyframe}
          hint="把播放头移到需要改变音量的位置，先添加关键帧，再调整下面的音量；关键帧之间会自动平滑变化。"
        />
        <ProSlider label="当前片段原声音量 (%)" value={Math.round(Math.max(0, Math.min(5, Number(clipVolume) || 0)) * 100)} onChange={(value) => onClipVolumeChange?.(value / 100)} min={0} max={500} resetValue={100} />
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">仅作用于当前视频片段；所在视频轨的整体原声增益请在“音频”页调整。</p>
      </PaneSection> : null}
      {isVideoLayer && clipTransform ? (
        <PaneSection title="变换与画面关键帧">
          <KeyframeEditorBar
            label="画面关键帧"
            active={clipHasKeyframe}
            onAdd={onAddClipKeyframe}
            onRemove={onRemoveClipKeyframe}
            hint="把播放头移到目标时间，先添加关键帧，再修改位置、大小、缩放、旋转或透明度；前后关键帧之间会自动生成动画。"
          />
          <div className="grid grid-cols-1 gap-1">
            <NumericPairCard title="位置" firstLabel="X" firstValue={Math.round((clipTransform.x ?? 0.5) * 100)} onFirstChange={(v) => onClipTransformChange?.({ x: v / 100 })} secondLabel="Y" secondValue={Math.round((clipTransform.y ?? 0.5) * 100)} onSecondChange={(v) => onClipTransformChange?.({ y: v / 100 })} />
            <NumericPairCard title="大小" firstLabel="W" firstValue={Math.round((clipTransform.width ?? 1) * 100)} onFirstChange={transformControls.setWidthPercent} secondLabel="H" secondValue={Math.round((clipTransform.height ?? 1) * 100)} onSecondChange={transformControls.setHeightPercent} min={8} max={300} linked={transformControls.sizeLinked} onToggleLinked={transformControls.toggleSizeLinked} />
          </div>
          <ProSlider
            label="缩放"
            value={Math.round((clipTransform.scale ?? 1) * 100)}
            onChange={(v) => onClipTransformChange?.({ scale: v / 100 })}
            min={10}
            max={300}
            resetValue={100}
          />
          <ProSlider
            label="旋转 °"
            value={Math.round(clipTransform.rotation ?? 0)}
            onChange={transformControls.setRotation}
            min={-180}
            max={180}
            resetValue={0}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => onClipPatch?.({ flip_horizontal: !clipFlipHorizontal })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${clipFlipHorizontal ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipHorizontal className="h-4 w-4" />左右镜像</button>
            <button type="button" onClick={() => onClipPatch?.({ flip_vertical: !clipFlipVertical })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${clipFlipVertical ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipVertical className="h-4 w-4" />上下镜像</button>
          </div>
          <ProSlider
            label="透明度 %"
            value={Math.round((clipTransform.opacity ?? 1) * 100)}
            onChange={(v) => onClipTransformChange?.({ opacity: Math.max(0, Math.min(100, Number(v) || 0)) / 100 })}
            min={10}
            max={100}
            resetValue={100}
          />
        </PaneSection>
      ) : null}
      {!isAudioClip && !isOverlay && !isVideoLayer && clipCrop ? (
        <PaneSection title="取景裁切">
          <ProSlider
            label="宽度 %"
            value={Math.round(normalizedCrop.width * 100)}
            onChange={(v) => {
              const width = Math.max(0.05, Math.min(1, Number(v) / 100));
              onClipCropChange?.({ width, x: Math.min(normalizedCrop.x, 1 - width) });
            }}
            min={5}
            max={100}
            resetValue={100}
          />
          <ProSlider
            label="高度 %"
            value={Math.round(normalizedCrop.height * 100)}
            onChange={(v) => {
              const height = Math.max(0.05, Math.min(1, Number(v) / 100));
              onClipCropChange?.({ height, y: Math.min(normalizedCrop.y, 1 - height) });
            }}
            min={5}
            max={100}
            resetValue={100}
          />
          <ProSlider
            label="横向位置 %"
            value={Math.round(normalizedCrop.x * 100)}
            onChange={(v) => onClipCropChange?.({ x: Math.max(0, Math.min(1 - normalizedCrop.width, Number(v) / 100)) })}
            min={0}
            max={Math.max(0, Math.round((1 - normalizedCrop.width) * 100))}
            resetValue={0}
          />
          <ProSlider
            label="纵向位置 %"
            value={Math.round(normalizedCrop.y * 100)}
            onChange={(v) => onClipCropChange?.({ y: Math.max(0, Math.min(1 - normalizedCrop.height, Number(v) / 100))})}
            min={0}
            max={Math.max(0, Math.round((1 - normalizedCrop.height) * 100))}
            resetValue={0}
          />
        </PaneSection>
      ) : null}
      {isOverlay && overlayTransform ? (
        <>
        <PaneSection title="变换" defaultOpen={false}>
          <div className="grid grid-cols-1 gap-1">
            <NumericPairCard title="位置" firstLabel="X" firstValue={Math.round((overlayTransform.x ?? 0.5) * 100)} onFirstChange={(v) => onOverlayTransformChange?.({ x: v / 100 })} secondLabel="Y" secondValue={Math.round((overlayTransform.y ?? 0.5) * 100)} onSecondChange={(v) => onOverlayTransformChange?.({ y: v / 100 })} />
            <NumericPairCard title="大小 (px)" firstLabel="W" firstValue={Math.round(overlayWidthPx)} onFirstChange={setOverlayWidthPx} secondLabel="H" secondValue={Math.round(overlayHeightPx)} onSecondChange={setOverlayHeightPx} min={1} max={50000} linked={transformControls.sizeLinked} onToggleLinked={transformControls.toggleSizeLinked} />
          </div>
          <ProSlider
            label="整体缩放 %"
            value={Math.round((overlayTransform.scale ?? 0.38) * 100)}
            onChange={(v) => onOverlayTransformChange?.({ scale: v / 100 })}
            min={1}
            max={300}
            resetValue={100}
          />
          <ProSlider
            label="旋转 °"
            value={Math.round(overlayTransform.rotation ?? 0)}
            onChange={transformControls.setRotation}
            min={-180}
            max={180}
            resetValue={0}
          />
          <ProSlider
            label="透明度 %"
            value={Math.round((overlayTransform.opacity ?? 1) * 100)}
            onChange={(v) => onOverlayTransformChange?.({ opacity: Math.max(0, Math.min(100, Number(v) || 0)) / 100 })}
            min={0}
            max={100}
            resetValue={100}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" title="左右镜像" aria-label="左右镜像" onClick={() => onOverlayPatch?.({ flip_horizontal: !clipFlipHorizontal })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${clipFlipHorizontal ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipHorizontal className="h-4 w-4" />左右镜像</button>
            <button type="button" title="上下镜像" aria-label="上下镜像" onClick={() => onOverlayPatch?.({ flip_vertical: !clipFlipVertical })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${clipFlipVertical ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipVertical className="h-4 w-4" />上下镜像</button>
          </div>
        </PaneSection>
        <PaneSection title="素材过渡" defaultOpen={false}>
          <div className="grid grid-cols-3 gap-1.5">
            {builtin.slice(0, 9).map((tr) => {
              const selected = overlayTransitionType === tr.id;
              return <button key={tr.id} type="button" onClick={() => {
                onOverlayPatch?.({
                  transition_in: { type: tr.id, duration_sec: tr.id === "cut" ? 0 : Math.max(0.05, Number(overlayTransitionInSec) || 0.25) },
                  transition_out: { type: tr.id, duration_sec: tr.id === "cut" ? 0 : Math.max(0.05, Number(overlayTransitionOutSec) || 0.25) },
                  fade_in_sec: 0,
                  fade_out_sec: 0,
                });
              }} className={`flex flex-col items-center gap-1 rounded-lg border py-2 transition-all ${selected ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 bg-cs2-surface-1/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}><span className="text-base leading-none">{tr.icon}</span><span className="text-[9px] font-semibold">{tr.label}</span></button>;
            })}
          </div>
          <ProSlider label="素材前（过渡时长）s" value={Math.max(0, Math.min(overlayMaxFade, Number(overlayTransitionInSec) || 0))} onChange={(v) => onOverlayPatch?.({ transition_in: { type: overlayTransitionType === "cut" ? "fade" : overlayTransitionType, duration_sec: Math.max(0, Number(v) || 0) } })} min={0} max={overlayMaxFade} resetValue={0.25} step={0.05} />
          <ProSlider label="素材后（过渡时长）s" value={Math.max(0, Math.min(overlayMaxFade, Number(overlayTransitionOutSec) || 0))} onChange={(v) => onOverlayPatch?.({ transition_out: { type: overlayTransitionType === "cut" ? "fade" : overlayTransitionType, duration_sec: Math.max(0, Number(v) || 0) } })} min={0} max={overlayMaxFade} resetValue={0.25} step={0.05} />
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
        <ProSlider label="素材前（过渡时长）s" value={transitionType === "cut" ? 0 : Math.max(0.05, Number(transitionInDuration) || 0.25)} onChange={(v) => onTransitionInDurationChange?.(v)} min={0.05} max={1.5} resetValue={0.25} step={0.05} />
        <ProSlider label="素材后（过渡时长）s" value={transitionType === "cut" ? 0 : Math.max(0.05, Number(transitionOutDuration) || 0.25)} onChange={(v) => onTransitionOutDurationChange?.(v)} min={0.05} max={1.5} resetValue={0.25} step={0.05} />
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

export const TEXT_FONT_SIZE_MIN = 12;
export const TEXT_FONT_SIZE_MAX = 220;

export function clampTextFontSize(value, fallback = 48) {
  return Math.max(TEXT_FONT_SIZE_MIN, Math.min(TEXT_FONT_SIZE_MAX, Number(value) || fallback));
}

function TextPane({
  textStyleId,
  onTextStyleChange,
  text,
  onTextChange,
  onAddText,
  fontFamily,
  fontFile,
  fontSize = 48,
  animIn = "",
  animOut = "",
  fontAssets = [],
  onTextPatch,
  onImportSubtitles,
  subtitleCount = 0,
  onApplySubtitleStyle,
  overlayTransform = null,
  overlayDuration = 3,
  overlayFadeInSec = 0,
  overlayFadeOutSec = 0,
  onOverlayTransformChange,
  onOverlayPatch,
  flipHorizontal = false,
  flipVertical = false,
}) {
  const subtitleInputRef = useRef(null);
  const [subtitleError, setSubtitleError] = useState("");
  const [font, setFont] = useState(FONT_OPTIONS[0]);
  const [draftFontSize, setDraftFontSize] = useState(48);
  const [sizeLinked, setSizeLinked] = useState(true);
  const effectiveFont = fontFamily || font;
  const effectiveFontSize = clampTextFontSize(fontSize, draftFontSize);
  const systemFontValue = FONT_OPTIONS.includes(effectiveFont) ? effectiveFont : "__project_font__";
  const handleFontChange = (value) => {
    setFont(value);
    onTextPatch?.({ font_family: value, font_file: null });
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
        <ProSlider label="素材显示时间 (s)" value={Number(Math.max(0.1, overlayDuration).toFixed(2))} onChange={(value) => onOverlayPatch?.({ duration: Math.max(0.1, value) })} min={0.1} max={60} resetValue={3} step={0.1} />
        <select value={systemFontValue} onChange={(e) => handleFontChange(e.target.value)} className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs">
          {systemFontValue === "__project_font__" ? <option value="__project_font__" disabled>使用项目字体</option> : null}
          {FONT_OPTIONS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <ProSlider label="字号" value={effectiveFontSize} onChange={handleFontSizeChange} min={TEXT_FONT_SIZE_MIN} max={TEXT_FONT_SIZE_MAX} resetValue={48} />
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">在左侧“本地上传”导入 TTF / OTF / WOFF2 后，可在下方项目字体中选择并参与导出。</p>
        {fontAssets.length ? <div className="grid grid-cols-1 gap-1">
          {fontAssets.map((asset) => <button key={asset.id} type="button" onClick={() => applyFontAsset(asset)} className={`whitespace-normal break-all rounded-lg border px-2 py-1.5 text-left text-[10px] font-semibold leading-snug ${selectedFontFile === asset.file_path ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-secondary"}`}>{asset.name}</button>)}
        </div> : null}
      </PaneSection>
      {overlayTransform ? <PaneSection title="变换" defaultOpen={false}>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          <NumericPairCard title="位置" firstLabel="X" firstValue={Math.round((overlayTransform.x ?? 0.5) * 100)} onFirstChange={(value) => onOverlayTransformChange?.({ x: value / 100 })} secondLabel="Y" secondValue={Math.round((overlayTransform.y ?? 0.5) * 100)} onSecondChange={(value) => onOverlayTransformChange?.({ y: value / 100 })} />
          <NumericPairCard title="大小" firstLabel="W" firstValue={Math.round((overlayTransform.width ?? 0.65) * 100)} onFirstChange={(value) => {
            const width = value / 100;
            const currentWidth = Math.max(0.01, Number(overlayTransform.width) || 0.65);
            onOverlayTransformChange?.(sizeLinked ? { width, height: (Number(overlayTransform.height) || 0.18) * width / currentWidth } : { width });
          }} secondLabel="H" secondValue={Math.round((overlayTransform.height ?? 0.18) * 100)} onSecondChange={(value) => {
            const height = value / 100;
            const currentHeight = Math.max(0.01, Number(overlayTransform.height) || 0.18);
            onOverlayTransformChange?.(sizeLinked ? { height, width: (Number(overlayTransform.width) || 0.65) * height / currentHeight } : { height });
          }} min={5} max={300} linked={sizeLinked} onToggleLinked={() => setSizeLinked((value) => !value)} />
        </div>
        <ProSlider label="整体缩放 %" value={Math.round((overlayTransform.scale ?? 1) * 100)} onChange={(value) => onOverlayTransformChange?.({ scale: value / 100 })} min={10} max={300} resetValue={100} />
        <ProSlider label="旋转 °" value={Math.round(overlayTransform.rotation ?? 0)} onChange={(value) => onOverlayTransformChange?.({ rotation: snapRotation(value) })} min={-180} max={180} resetValue={0} />
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" title="左右镜像" aria-label="左右镜像" onClick={() => onOverlayPatch?.({ flip_horizontal: !flipHorizontal })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${flipHorizontal ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipHorizontal className="h-4 w-4" />左右镜像</button>
          <button type="button" title="上下镜像" aria-label="上下镜像" onClick={() => onOverlayPatch?.({ flip_vertical: !flipVertical })} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${flipVertical ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipVertical className="h-4 w-4" />上下镜像</button>
        </div>
        <ProSlider label="透明度 %" value={Math.round((overlayTransform.opacity ?? 1) * 100)} onChange={(value) => onOverlayTransformChange?.({ opacity: value / 100 })} min={0} max={100} resetValue={100} />
      </PaneSection> : null}
      <div className="hidden">
        <select value={systemFontValue} onChange={(e) => handleFontChange(e.target.value)} className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs">
          {systemFontValue === "__project_font__" ? <option value="__project_font__" disabled>使用项目字体</option> : null}
          {FONT_OPTIONS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <ProSlider label="字号" value={effectiveFontSize} onChange={handleFontSizeChange} min={TEXT_FONT_SIZE_MIN} max={TEXT_FONT_SIZE_MAX} resetValue={48} />
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
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">入场</span>
            <select
              value={animIn || ""}
              onChange={(e) => onTextPatch?.({ anim_in: e.target.value || null })}
              className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs"
            >
              {TEXT_ANIMATION_OPTIONS.map((opt) => (
                <option key={opt.id || "none-in"} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">出场</span>
            <select
              value={animOut || ""}
              onChange={(e) => onTextPatch?.({ anim_out: e.target.value || null })}
              className="w-full rounded-lg border border-cs2-border/60 bg-cs2-bg-input/80 px-2 py-2 text-xs"
            >
              {TEXT_ANIMATION_OPTIONS.map((opt) => (
                <option key={opt.id || "none-out"} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>
        <ProSlider label="素材前（时长）" value={Number(Math.max(0, overlayFadeInSec).toFixed(2))} onChange={(value) => onOverlayPatch?.({ fade_in_sec: Math.max(0, value) })} min={0} max={Math.max(1, overlayDuration)} resetValue={0} step={0.05} />
        <ProSlider label="素材后（时长）" value={Number(Math.max(0, overlayFadeOutSec).toFixed(2))} onChange={(value) => onOverlayPatch?.({ fade_out_sec: Math.max(0, value) })} min={0} max={Math.max(1, overlayDuration)} resetValue={0} step={0.05} />
        <p className="text-[10px] leading-relaxed text-cs2-text-muted">
          动画仅作用于文字层；导出时会转成 FFmpeg drawtext 表达式。
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
            <div className={`flex h-[4.5rem] items-center justify-center px-2 ${card.cardClass}`}><span className={card.className}>{card.preview}</span></div>
            <p className="border-t border-white/5 bg-cs2-surface-1/80 px-2 py-1 text-[10px] text-cs2-text-muted">{card.label}</p>
          </button>)}
        </div>
      </PaneSection>
    </>
  );
}

export function AudioPane({
  volume = 1,
  onVolumeChange,
  clipLabel = "Selected clip",
  isAudioClip = false,
  muted = false,
  fadeInSec = 0,
  fadeOutSec = 0,
  masterVolume = 1,
  onMasterVolumeChange,
  bgm = null,
  audioAssets = [],
  onBgmChange,
  clipDuration = 0,
  trimIn = 0,
  onAudioPatch,
  sourceUrl = null,
  trackVolume = 1,
  trackLabel = "当前轨道",
  onTrackVolumeChange,
  clipHasAudioKeyframe = false,
  onAddClipAudioKeyframe,
  onRemoveClipAudioKeyframe,
}) {
  const maxClipVolume = isAudioClip ? 2 : 5;
  const safeVolume = Math.max(0, Math.min(maxClipVolume, Number.isFinite(Number(volume)) ? Number(volume) : 1));
  const volumePct = Math.round(safeVolume * 100);
  const safeMasterVolume = Math.max(0, Math.min(2, Number.isFinite(Number(masterVolume)) ? Number(masterVolume) : 1));
  const masterVolumePct = Math.round(safeMasterVolume * 100);
  const bgmVolume = Math.max(0, Math.min(2, Number.isFinite(Number(bgm?.volume)) ? Number(bgm.volume) : 1));
  const bgmVolumePct = Math.round(bgmVolume * 100);
  const bgmFadeIn = Math.max(0, Number(bgm?.fade_in_sec) || 0);
  const bgmFadeOut = Math.max(0, Number(bgm?.fade_out_sec) || 0);
  const bgmStart = Math.max(0, Number(bgm?.start_sec) || 0);
  const bgmDuckingEnabled = Boolean(bgm?.ducking_enabled);
  const bgmDuckingVolume = Math.max(5, Math.min(100, Math.round((Number(bgm?.ducking_volume) || 0.35) * 100)));
  const maxFade = Math.max(
    1,
    Math.min(10, Math.ceil(Math.max(Number(clipDuration) || 0, Number(fadeInSec) || 0, Number(fadeOutSec) || 0, 1))),
  );
  const safeFadeIn = Math.max(0, Math.min(maxFade, Number(fadeInSec) || 0));
  const safeFadeOut = Math.max(0, Math.min(maxFade, Number(fadeOutSec) || 0));
  const soundEnabled = !muted && volumePct > 0;
  const rawTrackVolume = Number(trackVolume);
  const trackVolumePct = Math.round(Math.max(0, Math.min(2, Number.isFinite(rawTrackVolume) ? rawTrackVolume : 1)) * 100);

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
    const next = Math.max(0, Math.min(maxClipVolume * 100, Number(pct) || 0)) / 100;
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
        onChange={(pct) => onMasterVolumeChange?.(Math.max(0, Math.min(200, Number(pct) || 0)) / 100)}
        min={0}
        max={200}
        resetValue={100}
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
        onChange={(pct) => onTrackVolumeChange(Math.max(0, Math.min(200, Number(pct) || 0)) / 100)}
        min={0}
        max={200}
        resetValue={100}
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
      <div className="rounded-lg border border-cs2-accent/30 bg-cs2-accent-soft px-3 py-2.5">
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
            onChange={(pct) => updateBgm({ volume: Math.max(0, Math.min(200, Number(pct) || 0)) / 100 })}
            min={0}
            max={200}
            resetValue={100}
          />
          <ProSlider
            label="开始时间 (s)"
            value={bgmStart}
            onChange={(v) => updateBgm({ start_sec: Math.max(0, Number(v) || 0) })}
            min={0}
            max={60}
            resetValue={0}
            step={0.5}
          />
          <div className="grid grid-cols-2 gap-2">
            <ProSlider
              label="淡入 (s)"
              value={bgmFadeIn}
              onChange={(v) => updateBgm({ fade_in_sec: Math.max(0, Number(v) || 0) })}
              min={0}
              max={10}
              resetValue={0}
              step={0.1}
            />
            <ProSlider
              label="淡出 (s)"
              value={bgmFadeOut}
              onChange={(v) => updateBgm({ fade_out_sec: Math.max(0, Number(v) || 0) })}
              min={0}
              max={10}
              resetValue={0}
              step={0.1}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-cs2-border/60 bg-cs2-surface-1/50 px-2.5 py-2">
            <span className="text-[10px] font-semibold text-cs2-text-secondary">原声时自动压低 BGM</span>
            <Toggle checked={bgmDuckingEnabled} onChange={(checked) => updateBgm({ ducking_enabled: checked })} />
          </div>
          {bgmDuckingEnabled ? (
            <ProSlider
              label="压低后 BGM (%)"
              value={bgmDuckingVolume}
              onChange={(pct) => updateBgm({ ducking_volume: Math.max(5, Math.min(100, Number(pct) || 0)) / 100 })}
              min={5}
              max={100}
              resetValue={35}
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
          <div className="flex items-center gap-2 rounded-lg border border-cs2-border/50 bg-cs2-surface-1/60 p-2">
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
          <ProSlider label="片段音量 (%)" value={volumePct} onChange={handleVolumeChange} min={0} max={200} resetValue={100} />
          {keyframeControls}
          <AudioWaveformBars sourceUrl={sourceUrl} startSec={trimIn} endSec={Number(trimIn) + Number(clipDuration || 0)} className="h-10 rounded-md" />
          <p className="text-[10px] text-cs2-text-muted">作用于当前音频轨(A轨)片段 · {clipLabel}</p>
        </PaneSection>

        <PaneSection title="淡入淡出">
          <ProSlider
            label="淡入 (s)"
            value={safeFadeIn}
            onChange={(v) => commit({ fade_in_sec: Math.max(0, Number(v) || 0) })}
            min={0}
            max={maxFade}
            resetValue={0}
            step={0.1}
          />
          <ProSlider
            label="淡出 (s)"
            value={safeFadeOut}
            onChange={(v) => commit({ fade_out_sec: Math.max(0, Number(v) || 0) })}
            min={0}
            max={maxFade}
            resetValue={0}
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
          min={0}
          max={500}
          resetValue={100}
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

function ExportPane({
  outputDir,
  outputDirHint,
  filename,
  width = 1920,
  height = 1080,
  fps = 60,
  encoder = "auto",
  encoderTier = "quality",
  canvasFit = "contain",
  backgroundColor = "#000000",
  blurAmount = 24,
  rangeMode = "full",
  rangeStartSec = 0,
  rangeEndSec = 1,
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
  const canExport = clipCount > 0 && (outputDir.trim() || outputDirHint) && filename.trim() && rangeValid;
  const [encoderDetecting, setEncoderDetecting] = useState(false);
  const [encoderDetection, setEncoderDetection] = useState(null);
  const commitSize = (patch) => onOutputSettingsChange?.(patch);
  const setPresetSize = (w, h) => commitSize({ width: w, height: h });
  const maxRangeEnd = Math.max(0.1, Number(timelineTotalSec) || 0.1);
  const clampRangeStart = (value) => Math.max(0, Math.min(maxRangeEnd - 0.1, Number(value) || 0));
  const clampRangeEnd = (value, start = rangeStartSec) =>
    Math.max(clampRangeStart(start) + 0.1, Math.min(maxRangeEnd, Number(value) || maxRangeEnd));
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
      const response = await API.post("/config/detect-encoder");
      setEncoderDetection(response.data || null);
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setEncoderDetection({ error: typeof detail === "string" ? detail : error?.message || "编码器检测失败" });
    } finally {
      setEncoderDetecting(false);
    }
  };
  const copyExportPath = async (path) => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // ignore clipboard failures in the desktop shell.
    }
  };
  const revealExportPath = async (path) => {
    if (!path) return;
    try {
      if (window.electron?.showItemInFolder && await window.electron.showItemInFolder(path)) return;
    } catch {
      // Copying the path remains a useful fallback in browser mode.
    }
    await copyExportPath(path);
  };
  const chooseOutputDir = async () => {
    try {
      const chosen = await window.electron?.chooseDirectory?.(outputDir.trim() || outputDirHint);
      if (chosen) onOutputDirChange?.(chosen);
    } catch {
      // The text field remains available when the desktop shell cannot open a picker.
    }
  };
  const fitOptions = [
    { id: "contain", label: "适应", desc: "保留完整画面" },
    { id: "cover", label: "填满", desc: "裁切边缘" },
    { id: "blur", label: "模糊底", desc: "竖屏/窄屏友好" },
  ];
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-cs2-border/70 bg-cs2-bg-card p-3 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-primary"><span className="h-1.5 w-1.5 rounded-full bg-cs2-accent" />画布比例</span>
          <span className="font-mono text-[9px] text-cs2-text-muted">{width} × {height}</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
        {[
          [1920, 1080, "16:9"],
          [1080, 1920, "9:16"],
          [1080, 1080, "1:1"],
          [1080, 1350, "4:5"],
        ].map(([w, h, label]) => (
          <button
            key={label}
            type="button"
            title={`设置为 ${label} 画布`}
            onClick={() => setPresetSize(w, h)}
            className={`flex min-h-10 flex-col items-center justify-center rounded-md border text-[10px] font-bold transition-colors ${
              Math.abs(Number(width) / Math.max(1, Number(height)) - w / h) < 0.005
                ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"
            }`}
          >
            {label}
          </button>
        ))}
        </div>
      </div>
      <PaneSection title="导出规格">
        <div className="grid grid-cols-2 gap-1.5">
          {[
            [1280, 720, "720p"],
            [1920, 1080, "1080p"],
            [2560, 1440, "1440p"],
            [3840, 2160, "4K"],
          ].map(([w, h, label]) => (
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
              min="320"
              max="7680"
              value={width}
              onChange={(e) => commitSize({ width: Math.max(320, Math.min(7680, Number(e.target.value) || 1920)) })}
              className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">高</span>
            <input
              type="number"
              min="180"
              max="4320"
              value={height}
              onChange={(e) => commitSize({ height: Math.max(180, Math.min(4320, Number(e.target.value) || 1080)) })}
              className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">帧率 (FPS)</span>
            <select
              value={fps}
              onChange={(e) => commitSize({ fps: Number(e.target.value) || 60 })}
              className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary"
            >
              {[24, 30, 50, 60, 120, 144].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
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
            <option value="auto">自动（NVENC → QSV → AMF → x264）</option>
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
                  min={0}
                  max={maxRangeEnd}
                  step={0.1}
                  value={Number(rangeStartSec).toFixed(1)}
                  onChange={(e) => commitRangeStart(e.target.value)}
                  className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] font-medium text-cs2-text-muted">结束时间</span>
                <input
                  type="number"
                  min={0.1}
                  max={maxRangeEnd}
                  step={0.1}
                  value={Number(rangeEndSec).toFixed(1)}
                  onChange={(e) => commitRangeEnd(e.target.value)}
                  className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary"
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
      <PaneSection title="画布适配" defaultOpen={false}>
        <div className="grid grid-cols-3 gap-1.5">
          {fitOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => commitSize({ canvas_fit: opt.id })}
              className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${
                canvasFit === opt.id
                  ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent"
                  : "border-cs2-border/60 text-cs2-text-muted hover:border-cs2-border-focus"
              }`}
            >
              <span className="block text-[10px] font-bold">{opt.label}</span>
              <span className="block whitespace-normal text-[9px] leading-snug opacity-75">{opt.desc}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">底色</span>
            <div className="flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input px-2 py-1.5">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : "#000000"}
                onChange={(e) => commitSize({ background_color: e.target.value })}
                className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
              />
              <span className="font-mono text-[10px] text-cs2-text-secondary">{backgroundColor || "#000000"}</span>
            </div>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-cs2-text-muted">模糊强度</span>
            <input
              type="range"
              min={4}
              max={80}
              step={1}
              value={Math.max(4, Math.min(80, Number(blurAmount) || 24))}
              onChange={(e) => commitSize({ blur_amount: Math.max(4, Math.min(80, Number(e.target.value) || 24)) })}
              className="mt-3 h-1 w-full accent-cs2-accent"
            />
          </label>
        </div>
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
            {window.electron?.chooseDirectory ? (
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
                    <span className="min-w-0 truncate font-mono text-[9px] text-cs2-text-muted">{item.output_path || item.error || "-"}</span>
                    {item.output_path ? (
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
    </div>
  );
}

export default function LiteCutPropertyPanel({
  defaultTab = "clip",
  selectedMedia = null,
  streamUrl = null,
  clipPreviewSourceTime = 0,
  clipPreviewKey = null,
  clipPreviewPlaying = false,
  transitionType = "fade",
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
  brightness = 0,
  contrast = 0,
  saturation = 0,
  onColorChange,
  filterPreset = "esports",
  onFilterPresetChange,
  onApplyColorScope,
  canApplyColorTrack = false,
  canApplyColorAll = false,
  textStyleId = "clutch",
  onTextStyleChange,
  text = "CLUTCH",
  onTextChange,
  onAddText,
  textFontFamily,
  textFontFile,
  textFontSize,
  textAnimIn = "",
  textAnimOut = "",
  fontAssets = [],
  audioAssets = [],
  onTextPatch,
  onImportSubtitles,
  subtitleCount = 0,
  onApplySubtitleStyle,
  onTabChange,
  outputDir = "",
  outputDirHint = "",
  outputFilename = "lite_cut_export.mp4",
  outputWidth = 1920,
  outputHeight = 1080,
  outputFps = 60,
  outputEncoder = "auto",
  outputEncoderTier = "quality",
  outputCanvasFit = "contain",
  outputBackgroundColor = "#000000",
  outputBlurAmount = 24,
  outputRangeMode = "full",
  outputRangeStartSec = 0,
  outputRangeEndSec = 1,
  outputRangeValid = true,
  selectedExportRange = null,
  timelineTotalSec = 0,
  currentPlayheadSec = 0,
  onOutputDirChange,
  onOutputFilenameChange,
  onOutputSettingsChange,
  onExport,
  exporting = false,
  exportError = null,
  exportProgress = 0,
  exportStage = "",
  exportStatus = "",
  exportHistory = [],
  onRefreshExportHistory,
  onCancelExport,
  v1ClipCount = 0,
  isOverlay = false,
  overlayTransform = null,
  overlayFadeInSec = 0,
  overlayFadeOutSec = 0,
  overlayTransitionType = "cut",
  overlayTransitionInSec = 0,
  overlayTransitionOutSec = 0,
  onOverlayPatch,
  onOverlayTransformChange,
  onApplyMotionPreset,
  overlayHasKeyframe = false,
  onAddOverlayKeyframe,
  onRemoveOverlayKeyframe,
  clipSpeed = 1,
  onClipSpeedChange,
  clipSpeedKeyframes = [],
  clipTrimIn = 0,
  onClipSpeedKeyframesChange,
  clipPreservePitch = true,
  onClipPreservePitchChange,
  clipReverse = false,
  onClipReverseChange,
  clipFreezeFrameSec = 0,
  onClipFreezeFrameChange,
  clipVolume = 1,
  onClipVolumeChange,
  clipHasAudioKeyframe = false,
  onAddClipAudioKeyframe,
  onRemoveClipAudioKeyframe,
  isAudioClip = false,
  clipMuted = false,
  clipFadeInSec = 0,
  clipFadeOutSec = 0,
  clipVisibleDuration = 0,
  clipCanvasFit = null,
  projectCanvasFit = "contain",
  onClipCanvasFitChange,
  clipFlipHorizontal = false,
  clipFlipVertical = false,
  clipTransform = null,
  onClipTransformChange,
  clipHasKeyframe = false,
  onAddClipKeyframe,
  onRemoveClipKeyframe,
  clipCrop = null,
  onClipCropChange,
  isVideoLayer = false,
  masterVolume = 1,
  onMasterVolumeChange,
  bgm = null,
  onBgmChange,
  onClipAudioPatch,
  selectedClipSourceDuration = 0,
  audioTargetIsAudioClip = isAudioClip,
  audioTargetFadeInSec = clipFadeInSec,
  audioTargetFadeOutSec = clipFadeOutSec,
  audioTargetSourceDuration = selectedClipSourceDuration,
  audioTargetTrimIn = clipTrimIn,
  selectedClipLabel = "",
  clipAudioUrl = null,
  trackVolume = 1,
  trackLabel = "Track",
  onTrackVolumeChange,
}) {
  const t = useT();
  const [tab, setTab] = useState(defaultTab);
  useEffect(() => setTab(defaultTab), [defaultTab]);
  const media = selectedMedia;
  const setTabBoth = (id) => {
    setTab(id);
    onTabChange?.(id);
  };
  const paneTitle = {
    clip: t("liteCut.inspector.clip"),
    text: t("liteCut.inspector.text"),
    color: t("liteCut.inspector.color"),
    audio: t("liteCut.inspector.audio"),
    speed: t("liteCut.inspector.speed"),
    export: t("liteCut.inspector.export"),
  }[tab];
  const paneDescription = {
    clip: t("liteCut.inspector.clipDescription"),
    text: t("liteCut.inspector.textDescription"),
    color: t("liteCut.inspector.colorDescription"),
    audio: t("liteCut.inspector.audioDescription"),
    speed: t("liteCut.inspector.speedDescription"),
    export: t("liteCut.inspector.exportDescription"),
  }[tab];
  return (
    <ConfigProvider theme={{ token: { colorPrimary: "#ff8c00", colorPrimaryHover: "#ffa500", colorPrimaryActive: "#e67e00", colorBgContainer: "var(--cs2-bg-card)", colorBgElevated: "var(--cs2-bg-elevated)", colorBorder: "var(--cs2-border)", colorText: "var(--cs2-text-primary)", colorTextSecondary: "var(--cs2-text-secondary)", borderRadius: 8 }, components: { Collapse: { headerBg: "transparent", contentBg: "transparent" }, Slider: { railBg: "var(--cs2-bg-elevated)", railHoverBg: "var(--cs2-surface-3)", handleColor: "var(--cs2-accent)", handleActiveColor: "var(--cs2-accent-light)", dotActiveBorderColor: "var(--cs2-accent)", trackBg: "var(--cs2-accent)", trackHoverBg: "var(--cs2-accent-light)" }, InputNumber: { activeBorderColor: "var(--cs2-accent)", hoverBorderColor: "var(--cs2-accent-light)" } } }}>
    <aside data-litecut-property-panel className="litecut-property-panel flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-sidebar">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-cs2-border/80">
        <header className="litecut-inspector-header flex h-11 shrink-0 items-center border-b border-cs2-border px-3.5">
          <p className="text-[12px] font-bold text-cs2-accent">{paneTitle}</p>
          <span className="sr-only">{paneDescription}</span>
        </header>
        <div className="litecut-inspector-scroll min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {tab === "clip" ? (
            <ClipPane
              media={media}
              streamUrl={streamUrl}
              previewSourceTime={clipPreviewSourceTime}
              previewKey={clipPreviewKey}
              previewPlaying={clipPreviewPlaying}
              transitionType={transitionType}
              transitionDuration={transitionDuration}
              transitionInDuration={transitionInDuration}
              transitionOutDuration={transitionOutDuration}
              onTransitionChange={onTransitionChange}
              onTransitionDurationChange={onTransitionDurationChange}
              onTransitionInDurationChange={onTransitionInDurationChange}
              onTransitionOutDurationChange={onTransitionOutDurationChange}
              onApplyTransitionScope={onApplyTransitionScope}
              canApplyTransitionTrack={canApplyTransitionTrack}
              canApplyTransitionAll={canApplyTransitionAll}
              isOverlay={isOverlay}
              overlayTransform={overlayTransform}
              overlayFadeInSec={overlayFadeInSec}
              overlayFadeOutSec={overlayFadeOutSec}
              overlayTransitionType={overlayTransitionType}
              overlayTransitionInSec={overlayTransitionInSec}
              overlayTransitionOutSec={overlayTransitionOutSec}
              onOverlayPatch={onOverlayPatch}
              onOverlayTransformChange={onOverlayTransformChange}
              onApplyMotionPreset={onApplyMotionPreset}
              overlayHasKeyframe={overlayHasKeyframe}
              onAddOverlayKeyframe={onAddOverlayKeyframe}
              onRemoveOverlayKeyframe={onRemoveOverlayKeyframe}
              clipFadeInSec={clipFadeInSec}
              clipFadeOutSec={clipFadeOutSec}
              clipDuration={clipVisibleDuration}
              clipCanvasFit={clipCanvasFit}
              projectCanvasFit={projectCanvasFit}
              onClipCanvasFitChange={onClipCanvasFitChange}
              onClipPatch={onClipAudioPatch}
              clipFlipHorizontal={clipFlipHorizontal}
              clipFlipVertical={clipFlipVertical}
              clipTransform={clipTransform}
              onClipTransformChange={onClipTransformChange}
              clipHasKeyframe={clipHasKeyframe}
              onAddClipKeyframe={onAddClipKeyframe}
              onRemoveClipKeyframe={onRemoveClipKeyframe}
              clipHasAudioKeyframe={clipHasAudioKeyframe}
              onAddClipAudioKeyframe={onAddClipAudioKeyframe}
              onRemoveClipAudioKeyframe={onRemoveClipAudioKeyframe}
              clipCrop={clipCrop}
              onClipCropChange={onClipCropChange}
              isVideoLayer={isVideoLayer}
              isAudioClip={isAudioClip}
              clipVolume={clipVolume}
              onClipVolumeChange={onClipVolumeChange}
              outputWidth={outputWidth}
              outputHeight={outputHeight}
            />
          ) : null}
          {tab === "text" ? (
            <TextPane
              textStyleId={textStyleId}
              onTextStyleChange={onTextStyleChange}
              text={text}
              onTextChange={onTextChange}
              onAddText={onAddText}
              fontFamily={textFontFamily}
              fontFile={textFontFile}
              fontSize={textFontSize}
              animIn={textAnimIn}
              animOut={textAnimOut}
              fontAssets={fontAssets}
              onTextPatch={onTextPatch}
              onImportSubtitles={onImportSubtitles}
              subtitleCount={subtitleCount}
              onApplySubtitleStyle={onApplySubtitleStyle}
              overlayTransform={overlayTransform}
              overlayDuration={selectedMedia?.duration || 3}
              overlayFadeInSec={overlayFadeInSec}
              overlayFadeOutSec={overlayFadeOutSec}
              onOverlayTransformChange={onOverlayTransformChange}
              onOverlayPatch={onOverlayPatch}
              flipHorizontal={clipFlipHorizontal}
              flipVertical={clipFlipVertical}
            />
          ) : null}
          {tab === "color" ? (
            <ColorPropertyPane
              brightness={brightness}
              contrast={contrast}
              saturation={saturation}
              onColorChange={onColorChange}
              filterPreset={filterPreset}
              onFilterPresetChange={onFilterPresetChange}
              onApplyColorScope={onApplyColorScope}
              canApplyColorTrack={canApplyColorTrack}
              canApplyColorAll={canApplyColorAll}
            />
          ) : null}
          {tab === "audio" ? (
            <AudioPane
              volume={clipVolume}
              onVolumeChange={onClipVolumeChange}
              isAudioClip={audioTargetIsAudioClip}
              muted={clipMuted}
              fadeInSec={audioTargetFadeInSec}
              fadeOutSec={audioTargetFadeOutSec}
              masterVolume={masterVolume}
              onMasterVolumeChange={onMasterVolumeChange}
              bgm={bgm}
              audioAssets={audioAssets}
              onBgmChange={onBgmChange}
              clipDuration={audioTargetSourceDuration}
              trimIn={audioTargetTrimIn}
              onAudioPatch={onClipAudioPatch}
              clipHasAudioKeyframe={clipHasAudioKeyframe}
              onAddClipAudioKeyframe={onAddClipAudioKeyframe}
              onRemoveClipAudioKeyframe={onRemoveClipAudioKeyframe}
              clipLabel={selectedClipLabel || media?.title || t("liteCut.inspector.selectedClip")}
              sourceUrl={clipAudioUrl}
              trackVolume={trackVolume}
              trackLabel={trackLabel}
              onTrackVolumeChange={onTrackVolumeChange}
            />
          ) : null}
          {tab === "speed" ? (
            <SpeedPropertyPane
              speed={clipSpeed}
              onSpeedChange={onClipSpeedChange}
              speedKeyframes={clipSpeedKeyframes}
              trimIn={clipTrimIn}
              onSpeedKeyframesChange={onClipSpeedKeyframesChange}
              preservePitch={clipPreservePitch}
              onPreservePitchChange={onClipPreservePitchChange}
              reverse={clipReverse}
              onReverseChange={onClipReverseChange}
              sourceDuration={selectedClipSourceDuration}
              timelineDuration={clipVisibleDuration}
              freezeFrameSec={clipFreezeFrameSec}
              onFreezeFrameChange={onClipFreezeFrameChange}
              isAudioClip={isAudioClip}
            />
          ) : null}
          {tab === "export" ? (
            <ExportPane
              outputDir={outputDir}
              outputDirHint={outputDirHint}
              filename={outputFilename}
              width={outputWidth}
              height={outputHeight}
              fps={outputFps}
              encoder={outputEncoder}
              encoderTier={outputEncoderTier}
              canvasFit={outputCanvasFit}
              backgroundColor={outputBackgroundColor}
              blurAmount={outputBlurAmount}
              rangeMode={outputRangeMode}
              rangeStartSec={outputRangeStartSec}
              rangeEndSec={outputRangeEndSec}
              rangeValid={outputRangeValid}
              selectedExportRange={selectedExportRange}
              timelineTotalSec={timelineTotalSec}
              currentPlayheadSec={currentPlayheadSec}
              onOutputDirChange={onOutputDirChange}
              onFilenameChange={onOutputFilenameChange}
              onOutputSettingsChange={onOutputSettingsChange}
              onExport={onExport}
              exporting={exporting}
              exportError={exportError}
              exportProgress={exportProgress}
              exportStage={exportStage}
              exportStatus={exportStatus}
              exportHistory={exportHistory}
              onRefreshExportHistory={onRefreshExportHistory}
              onCancelExport={onCancelExport}
              clipCount={v1ClipCount}
            />
          ) : null}
        </div>
      </div>
      <nav className="litecut-inspector-rail flex w-[58px] shrink-0 flex-col items-center gap-1 border-l border-cs2-border bg-cs2-bg-card px-1.5 py-2">
        {RAIL.map((item) => (
          <button
            key={item.id}
            type="button"
            title={t(item.labelKey)}
            onClick={() => setTabBoth(item.id)}
            className={`relative flex w-11 flex-col items-center gap-1.5 rounded-md border py-2.5 text-[9px] font-medium transition-all ${
              tab === item.id ? "border-cs2-accent/25 bg-cs2-accent-soft text-cs2-accent shadow-sm" : "border-transparent text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
            }`}
          >
            {tab === item.id ? <span className="absolute -left-2 top-0 bottom-0 w-0.5 rounded-full bg-cs2-accent" /> : null}
            <item.icon className="h-[18px] w-[18px]" />
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
      </div>
    </aside>
    </ConfigProvider>
  );
}
