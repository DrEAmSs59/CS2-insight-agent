import { Film, Monitor, Type, SlidersHorizontal, Volume2, Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../../i18n/useT.js";
import ColorPropertyPane from "./ColorPropertyPane.jsx";
import SpeedPropertyPane from "./SpeedPropertyPane.jsx";
import {
  AudioPane,
  CanvasPane,
  ClipPane,
  ExportPane,
  TextPane,
} from "./LiteCutPropertyPanes.jsx";

export {
  AudioPane,
  CanvasPane,
  ClipPane,
  ExportPane,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  clampTextFontSize,
} from "./LiteCutPropertyPanes.jsx";

const RAIL = [
  { id: "canvas", labelKey: "liteCut.inspector.canvas", icon: Monitor },
  { id: "clip", labelKey: "liteCut.inspector.clip", icon: Film },
  { id: "text", labelKey: "liteCut.inspector.text", icon: Type },
  { id: "color", labelKey: "liteCut.inspector.color", icon: SlidersHorizontal },
  { id: "audio", labelKey: "liteCut.inspector.audio", icon: Volume2 },
  { id: "speed", labelKey: "liteCut.inspector.speed", icon: Gauge },
];


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
  textAlign = "center",
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
  outputFrameMeldEnabled = false,
  outputFrameMeldAvailable = false,
  framemeldSourceItems = [],
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
  const paneDescription = {
    canvas: t("liteCut.inspector.canvasDescription"),
    clip: t("liteCut.inspector.clipDescription"),
    text: t("liteCut.inspector.textDescription"),
    color: t("liteCut.inspector.colorDescription"),
    audio: t("liteCut.inspector.audioDescription"),
    speed: t("liteCut.inspector.speedDescription"),
    export: t("liteCut.inspector.exportDescription"),
  }[tab];
  return (
    <aside data-litecut-property-panel className="litecut-property-panel flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-sidebar">
      <nav
        data-litecut-inspector-tabs
        className="litecut-inspector-tabs grid h-[58px] shrink-0 grid-cols-6 border-b border-cs2-border bg-cs2-bg-card px-1.5 py-1.5"
      >
        {RAIL.map((item) => (
          <button
            key={item.id}
            type="button"
            title={t(item.labelKey)}
            onClick={() => setTabBoth(item.id)}
            className={`relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md border text-[8px] font-medium transition-colors ${
              tab === item.id
                ? "border-cs2-accent/25 bg-cs2-accent-soft text-cs2-accent"
                : "border-transparent text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
            }`}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="litecut-inspector-tab-label max-w-full truncate">{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="litecut-inspector-scroll min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          <span className="sr-only">{paneDescription}</span>
          {tab === "canvas" ? (
            <CanvasPane
              width={outputWidth}
              height={outputHeight}
              canvasFit={outputCanvasFit}
              backgroundColor={outputBackgroundColor}
              blurAmount={outputBlurAmount}
              onOutputSettingsChange={onOutputSettingsChange}
            />
          ) : null}
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
              textAlign={textAlign}
              animIn={textAnimIn}
              animOut={textAnimOut}
              fontAssets={fontAssets}
              onTextPatch={onTextPatch}
              onImportSubtitles={onImportSubtitles}
              subtitleCount={subtitleCount}
              onApplySubtitleStyle={onApplySubtitleStyle}
              overlayTransform={overlayTransform}
              overlayDuration={selectedMedia?.duration || 3}
              maxTextDuration={Math.max(60, Number(timelineTotalSec) || 60)}
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
              framemeldEnabled={outputFrameMeldEnabled}
              framemeldRuntimeAvailable={outputFrameMeldAvailable}
              framemeldSourceItems={framemeldSourceItems}
              encoder={outputEncoder}
              encoderTier={outputEncoderTier}
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
      </div>
    </aside>
  );
}
