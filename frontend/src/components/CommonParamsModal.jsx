import { Children, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Save, Upload, X } from "lucide-react";
import { OptionRow, RECORD_WARMUP_DEFAULT_OPTIONS } from "./RecordWarmupModal";
import ExperimentalPovSection from "./ExperimentalPovSection";
import { BACKEND_DEFAULT_PACING, useRecordingQueue } from "../stores/recordingQueueStore";
import Cs2LaunchConsoleFields from "./Cs2LaunchConsoleFields";
import { POV_CONFLICT_HUD, RecordingHudCard } from "./RecordingHudCard";
import {
  aspectExportHint,
  aspectHint,
  formatResolutionSummary,
  SPECTATOR_FLASHBANG_OPACITY_DEFAULT,
  warmupUiOptsToPersisted,
  validateWarmupResolution,
} from "../utils/warmupDefaults";
import { useT } from "../i18n/useT.js";
import { normalizeRecordingSkyboxId } from "../utils/recordingSkybox.js";
import { normalizeRecordingMapMaterialId } from "../utils/recordingMapMaterial.js";
import {
  DEFAULT_RECORDING_WEATHER_EFFECT,
  normalizeRecordingWeatherEffectId,
} from "../utils/recordingWeatherEffect.js";
import { normalizePovVoiceMode } from "../utils/povVoiceMode.js";
import {
  buildRecordingPresetFile,
  parseRecordingPresetFile,
  RECORDING_PRESET_MAX_BYTES,
} from "../utils/recordingPresetJson";

/** 未写入配置时的展示用回退（与队列微调面板一致） */
const FB_VIC_PRE = 1.5;
const FB_VIC_POST = 1.5;
const FB_KILL_PRE = 1.5;
const FB_KILL_POST = 1.5;

/** 片段时间流示意图中间「主体段」参考秒数，与左右同为秒单位以便比例对齐 */
const PACING_STRIP_CORE_REF_SEC = 6;

function WorkflowSection({
  title,
  subtitle,
  badge,
  defaultOpen = true,
  surfaceClass = "bg-cs2-bg-card",
  accentClass = "",
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`rounded-xl border border-cs2-border ${surfaceClass} transition-all ${accentClass}`.trim()}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-cs2-surface-2 sm:px-5"
      >
        <span className="mt-1 shrink-0 text-cs2-text-muted">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold tracking-tight text-cs2-text-primary">{title}</h3>
            {badge}
          </div>
          {subtitle ? (
            <p className="mt-1 text-xs leading-relaxed text-cs2-text-secondary">{subtitle}</p>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="border-t border-cs2-border px-4 py-5 sm:px-5">{children}</div>
      ) : null}
    </section>
  );
}

function RecordingPresetColumns({ children }) {
  const [twoColumns, setTwoColumns] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setTwoColumns(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const items = Children.toArray(children).sort(
    (a, b) => (a.props.presetOrder ?? 0) - (b.props.presetOrder ?? 0),
  );
  if (!twoColumns) {
    return (
      <div
        className="flex min-w-0 flex-col gap-3 pb-2 sm:gap-4 sm:pb-4"
        data-testid="recording-preset-grid"
      >
        {items}
      </div>
    );
  }

  // Match the recording warmup layout: OBS, visuals, camera and launch stay on
  // the left; experimental features and recording canvas stay on the right.
  const leftColumnIndexes = new Set([0, 1, 2, 5]);
  const leftItems = items.filter((_, index) => leftColumnIndexes.has(index));
  const rightItems = items.filter((_, index) => !leftColumnIndexes.has(index));

  return (
    <div
      className="grid min-w-0 grid-cols-2 items-start gap-4 pb-4"
      data-testid="recording-preset-grid"
    >
      <div
        className="flex min-w-0 flex-col gap-4"
        data-testid="recording-preset-column-left"
      >
        {leftItems}
      </div>
      <div
        className="flex min-w-0 flex-col gap-4"
        data-testid="recording-preset-column-right"
      >
        {rightItems}
      </div>
    </div>
  );
}

function PacingSlider({
  label,
  min,
  max,
  step,
  value,
  disabled,
  onCommit,
  accentClass = "accent-cs2-orange",
}) {
  const range = Math.max(Number(max) - Number(min), 0);
  const progress = range > 0
    ? Math.min(100, Math.max(0, ((Number(value) - Number(min)) / range) * 100))
    : 0;
  const rangeAccent = accentClass.includes("cyan")
    ? "var(--cs2-info)"
    : accentClass.includes("amber")
      ? "var(--cs2-compilation)"
      : "var(--cs2-accent)";

  return (
    <label className="block text-xs font-medium text-cs2-text-secondary">
      {label}
      <div className="mt-1.5 flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onCommit(parseFloat(e.target.value))}
          className="cs2-data-slider min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            "--cs2-range-progress": `${progress}%`,
            "--cs2-range-accent": rangeAccent,
          }}
        />
        <input
          type="number"
          step={step}
          min={min}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) onCommit(n);
          }}
          className="w-20 rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent disabled:opacity-40 text-right"
        />
      </div>
    </label>
  );
}

/**
 * 常用参数：内联编辑「全局节奏（数值）+ 入队默认 POV」与「录制前观战默认选项」；
 * 由顶栏「保存」一次性写入 data/cs2-insight.config.json。
 */
export default function CommonParamsModal({
  open,
  onClose,
  variant = "modal",
  batchRecording,
  configReady = true,
  savedWarmupDefaults,
  onSaveAllCommonParams,
  experimentalPovEnabled = false,
  recordingSkybox = "default",
  recordingMapMaterial = "default",
  recordingWeatherEffect = DEFAULT_RECORDING_WEATHER_EFFECT,
  cs2ExtraLaunchArgs = "",
  recordInjectConsoleLines = "",
  obsTransitionEnabled: initObsTransitionEnabled = false,
  obsTransitionName: initObsTransitionName = "Fade",
  obsTransitionDurationMs: initObsTransitionDurationMs = 100,
  configRefreshKey = 0,
  onRegisterSave,
  onSaveUiChange,
}) {
  const t = useT();
  const isPage = variant === "page";
  const isEmbedded = variant === "embedded";
  const isModal = !isPage && !isEmbedded;
  const presetPacing = useRecordingQueue((s) => s.presetPacing);
  const setPresetPacing = useRecordingQueue((s) => s.setPresetPacing);
  const hydratePresetPacing = useRecordingQueue((s) => s.hydratePresetPacing);

  const post = presetPacing.post_last_sec ?? BACKEND_DEFAULT_PACING.post_last_sec;
  const pre = presetPacing.pre_first_sec ?? BACKEND_DEFAULT_PACING.pre_first_sec;
  const gap = presetPacing.max_gap_sec ?? BACKEND_DEFAULT_PACING.max_gap_sec;

  const victimPovPre = presetPacing.victim_pov_pre_sec ?? FB_VIC_PRE;
  const victimPovPost = presetPacing.victim_pov_post_sec ?? FB_VIC_POST;
  const killerPovPre = presetPacing.killer_pov_pre_sec ?? FB_KILL_PRE;
  const killerPovPost = presetPacing.killer_pov_post_sec ?? FB_KILL_POST;

  const commitPacingNumbers = useCallback(
    (partial) => {
      const next = Object.fromEntries(
        Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      );
      if (Object.keys(next).length) setPresetPacing(next);
    },
    [setPresetPacing]
  );

  const [warmupOpts, setWarmupOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [warmupResolutionError, setWarmupResolutionError] = useState("");
  const [obsTransEnabled, setObsTransEnabled] = useState(() => !!initObsTransitionEnabled);
  const [obsTransName, setObsTransName] = useState(() => initObsTransitionName);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(() => Number(initObsTransitionDurationMs));
  const [povEnabled, setPovEnabled] = useState(() => !!experimentalPovEnabled);
  const [skyboxId, setSkyboxId] = useState(() => normalizeRecordingSkyboxId(recordingSkybox));
  const [mapMaterialId, setMapMaterialId] = useState(
    () => normalizeRecordingMapMaterialId(recordingMapMaterial),
  );
  const [weatherEffectId, setWeatherEffectId] = useState(
    () => normalizeRecordingWeatherEffectId(recordingWeatherEffect),
  );
  const [localCs2ExtraLaunchArgs, setLocalCs2ExtraLaunchArgs] = useState(cs2ExtraLaunchArgs);
  const [localRecordInjectLines, setLocalRecordInjectLines] = useState(recordInjectConsoleLines);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [shareMessage, setShareMessage] = useState(null);
  const importFileRef = useRef(null);
  const lastHydratedRefreshKey = useRef(null);

  useEffect(() => {
    if (!open && !isPage && !isEmbedded) return;
    setWarmupResolutionError("");
  }, [open, isPage]);

  useEffect(() => {
    if (!configReady) return;
    if (!open && !isPage && !isEmbedded) return;
    if (lastHydratedRefreshKey.current === configRefreshKey) return;
    lastHydratedRefreshKey.current = configRefreshKey;
    const base = { ...RECORD_WARMUP_DEFAULT_OPTIONS };
    const o = savedWarmupDefaults;
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of Object.keys(RECORD_WARMUP_DEFAULT_OPTIONS)) {
        if (!Object.prototype.hasOwnProperty.call(o, k) || o[k] === undefined) continue;
        const v = o[k];
        if (k === "resolution_width" || k === "resolution_height") {
          base[k] = v != null && v !== "" ? String(v) : "";
        } else {
          base[k] = v;
        }
      }
    }
    base.pov_voice_mode = normalizePovVoiceMode(
      o?.pov_voice_mode,
      o?.pov_voice_disabled === true,
    );
    base.pov_radar_mode = 0;
    setWarmupOpts(base);
    setObsTransEnabled(!!initObsTransitionEnabled);
    setObsTransName(initObsTransitionName);
    setObsTransDurationMs(Number(initObsTransitionDurationMs));
    setPovEnabled(!!experimentalPovEnabled);
    setSkyboxId(normalizeRecordingSkyboxId(recordingSkybox));
    setMapMaterialId(normalizeRecordingMapMaterialId(recordingMapMaterial));
    setWeatherEffectId(normalizeRecordingWeatherEffectId(recordingWeatherEffect));
    setLocalCs2ExtraLaunchArgs(cs2ExtraLaunchArgs);
    setLocalRecordInjectLines(recordInjectConsoleLines);
    setWarmupResolutionError("");
    setSaveError("");
    setShareMessage(null);
  }, [
    configRefreshKey,
    open,
    isPage,
    configReady,
    savedWarmupDefaults,
    initObsTransitionEnabled,
    initObsTransitionName,
    initObsTransitionDurationMs,
    experimentalPovEnabled,
    recordingSkybox,
    recordingMapMaterial,
    recordingWeatherEffect,
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
  ]);

  const patchWarmup = useCallback((patch) => {
    setWarmupOpts((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSaveAll = useCallback(async () => {
    if (!onSaveAllCommonParams || saveState === "saving") return;
    const vr = validateWarmupResolution(warmupOpts);
    if (!vr.ok) {
      const msg = t(vr.messageKey, vr.messageParams);
      setWarmupResolutionError(msg);
      setSaveError(msg);
      return;
    }
    setWarmupResolutionError("");
    setSaveError("");
    setSaveState("saving");
    const result = await onSaveAllCommonParams({
      default_record_warmup: warmupUiOptsToPersisted(warmupOpts),
      recording_global_pacing: presetPacing,
      cs2_extra_launch_args: localCs2ExtraLaunchArgs,
      record_inject_console_lines: localRecordInjectLines,
      obs_transition_enabled: obsTransEnabled,
      obs_transition_name: obsTransName,
      obs_transition_duration_ms: obsTransDurationMs,
      experimental_pov_enabled: povEnabled,
      recording_skybox: skyboxId,
      recording_map_material: mapMaterialId,
      recording_weather_effect: weatherEffectId,
    });
    setSaveState(result?.ok ? "saved" : "error");
    if (!result?.ok && result?.error) setSaveError(String(result.error));
    if (result?.ok) {
      setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [
    t,
    onSaveAllCommonParams,
    saveState,
    warmupOpts,
    presetPacing,
    localCs2ExtraLaunchArgs,
    localRecordInjectLines,
    obsTransEnabled,
    obsTransName,
    obsTransDurationMs,
    povEnabled,
    skyboxId,
    mapMaterialId,
    weatherEffectId,
  ]);

  const saveDisabled = !configReady || saveState === "saving" || batchRecording;

  const currentPreset = useCallback(() => ({
    recording_global_pacing: presetPacing,
    default_record_warmup: warmupUiOptsToPersisted(warmupOpts),
    cs2_extra_launch_args: localCs2ExtraLaunchArgs,
    record_inject_console_lines: localRecordInjectLines,
    obs_transition_enabled: obsTransEnabled,
    obs_transition_name: obsTransName,
    obs_transition_duration_ms: Number(obsTransDurationMs),
    experimental_pov_enabled: povEnabled,
    recording_skybox: skyboxId,
    recording_map_material: mapMaterialId,
    recording_weather_effect: weatherEffectId,
  }), [
    presetPacing,
    warmupOpts,
    localCs2ExtraLaunchArgs,
    localRecordInjectLines,
    obsTransEnabled,
    obsTransName,
    obsTransDurationMs,
    povEnabled,
    skyboxId,
    mapMaterialId,
    weatherEffectId,
  ]);

  const handleExportPreset = useCallback(() => {
    const vr = validateWarmupResolution(warmupOpts);
    if (!vr.ok) {
      setShareMessage({ tone: "error", text: t(vr.messageKey, vr.messageParams) });
      return;
    }
    try {
      const shareFile = buildRecordingPresetFile(currentPreset());
      parseRecordingPresetFile(shareFile, RECORD_WARMUP_DEFAULT_OPTIONS);
      const json = JSON.stringify(shareFile, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cs2-insight-recording-preset-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setShareMessage({ tone: "ok", text: t("record.presetExported") });
    } catch (error) {
      const detail = error?.field
        ? t("record.presetInvalidField", { field: error.field })
        : (error?.message || String(error));
      setShareMessage({ tone: "error", text: t("record.presetExportFailed", { error: detail }) });
    }
  }, [currentPreset, t, warmupOpts]);

  const handleImportPreset = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > RECORDING_PRESET_MAX_BYTES) {
      setShareMessage({ tone: "error", text: t("record.presetFileTooLarge") });
      return;
    }
    try {
      const parsed = parseRecordingPresetFile(JSON.parse(await file.text()), RECORD_WARMUP_DEFAULT_OPTIONS);
      const vr = validateWarmupResolution(parsed.default_record_warmup);
      if (!vr.ok) throw new Error(t(vr.messageKey, vr.messageParams));
      hydratePresetPacing(parsed.recording_global_pacing);
      setWarmupOpts(parsed.default_record_warmup);
      setLocalCs2ExtraLaunchArgs(parsed.cs2_extra_launch_args);
      setLocalRecordInjectLines(parsed.record_inject_console_lines);
      setObsTransEnabled(parsed.obs_transition_enabled);
      setObsTransName(parsed.obs_transition_name);
      setObsTransDurationMs(parsed.obs_transition_duration_ms);
      setPovEnabled(parsed.experimental_pov_enabled);
      setSkyboxId(parsed.recording_skybox);
      setMapMaterialId(parsed.recording_map_material);
      setWeatherEffectId(parsed.recording_weather_effect);
      setWarmupResolutionError("");
      setSaveError("");
      setSaveState("idle");
      setShareMessage({ tone: "ok", text: t("record.presetImported") });
    } catch (error) {
      const detail = error?.field
        ? t("record.presetInvalidField", { field: error.field })
        : (error?.message || String(error));
      setShareMessage({ tone: "error", text: t("record.presetImportFailed", { error: detail }) });
    }
  }, [hydratePresetPacing, t]);

  useEffect(() => {
    onRegisterSave?.(handleSaveAll);
    return () => onRegisterSave?.(null);
  }, [handleSaveAll, onRegisterSave]);

  useEffect(() => {
    onSaveUiChange?.({
      disabled: saveDisabled,
      state: saveState,
    });
  }, [onSaveUiChange, saveDisabled, saveState]);

  const resSummaryRaw = formatResolutionSummary(
    warmupOpts.aspect_ratio,
    warmupOpts.resolution_width,
    warmupOpts.resolution_height,
  );
  const resSummaryDisplay = resSummaryRaw.startsWith("record.") ? t(resSummaryRaw) : resSummaryRaw;

  const AR_TAGS = [
    { ar: "4:3",   sample: "1920×1440", tagKey: "record.arTag43" },
    { ar: "16:9",  sample: "1920×1080", tagKey: "record.arTag169" },
    { ar: "16:10", sample: "1920×1200", tagKey: "record.arTag1610" },
  ];

  const saveButton = onSaveAllCommonParams ? (
    <button
      type="button"
      disabled={saveDisabled}
      onClick={() => void handleSaveAll()}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-45"
    >
      {saveState === "saving" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Save className="h-4 w-4" aria-hidden />
      )}
      {saveState === "saving"
        ? t("record.commonSaving")
        : saveState === "saved"
        ? t("record.commonSaved")
        : t("record.commonSaveBtn")}
    </button>
  ) : null;

  if (!open && !isPage && !isEmbedded) return null;

  const outerClass = isPage || isEmbedded
    ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
    : "flex max-h-[min(94vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl";

  const preFlex = Math.max(pre, 0.05);
  const postFlex = Math.max(post, 0.05);
  const midFlex = PACING_STRIP_CORE_REF_SEC;

  const body = (
    <>
      <div className={outerClass}>
        {isModal ? (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-cs2-border px-4 py-4 sm:px-5">
          <div className="min-w-0 pr-2">
            <h2 id="common-params-title" className="text-base font-bold text-cs2-text-primary">
              {t("record.commonTitle")}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-cs2-text-muted">
              {t("record.commonSubtitle")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {saveButton}
            {isModal ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-input hover:text-cs2-text-secondary"
                aria-label={t("record.commonArClose")}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
        ) : null}

        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
          style={{ scrollbarGutter: "stable both-edges" }}
        >
          <div
            className="@container/params w-full min-w-0"
            data-testid="recording-preset-content"
          >
            <div className="mb-3 flex flex-col gap-3 rounded-xl border border-cs2-border bg-cs2-bg-elevated p-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="min-w-0">
                <p className="text-sm font-bold text-cs2-text-primary">{t("record.presetShareTitle")}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-cs2-text-muted">{t("record.presetShareDesc")}</p>
                {shareMessage ? (
                  <p className={`mt-1.5 text-xs ${shareMessage.tone === "ok" ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`} role="status">
                    {shareMessage.text}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportPreset}
                />
                <button
                  type="button"
                  disabled={!configReady || batchRecording}
                  onClick={() => importFileRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-semibold text-cs2-text-primary hover:border-cs2-accent/50 disabled:opacity-40"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {t("record.presetImportBtn")}
                </button>
                <button
                  type="button"
                  disabled={!configReady}
                  onClick={handleExportPreset}
                  className="inline-flex items-center gap-2 rounded-lg border border-cs2-accent bg-cs2-accent-soft px-3 py-2 text-xs font-semibold text-cs2-accent transition-colors hover:bg-cs2-bg-active disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {t("record.presetExportBtn")}
                </button>
              </div>
            </div>
            <div
              className="grid min-w-0 gap-4 pb-4 xl:grid-cols-2 xl:items-start"
              data-testid="recording-preset-top-grid"
            >
          {/* A1 时间与多段节奏 */}
          <WorkflowSection
            title={t("record.commonSecPacing")}
            subtitle={t("record.commonSecPacingSubtitle")}
            defaultOpen
          >
            <div className="mb-5 overflow-hidden rounded-lg border border-cs2-border bg-cs2-surface-1 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
                {t("record.commonPacingStripTitle")}
              </p>
              <div className="mb-2 flex min-h-[3rem] w-full overflow-hidden rounded-md">
                <div
                  style={{ flex: preFlex }}
                  className="flex min-w-0 flex-col justify-center border-r border-cs2-border-subtle bg-cs2-accent-soft px-2 py-1.5"
                >
                  <span className="text-[10px] font-bold uppercase tracking-wide text-cs2-text-primary/90">
                    {t("record.commonPacingPreLabel")}
                  </span>
                  <span className="font-mono text-xs text-cs2-text-primary">{pre}s</span>
                </div>
                <div
                  style={{ flex: midFlex }}
                  className="flex min-w-[5.5rem] flex-col items-center justify-center border-r border-cs2-border-subtle bg-cs2-bg-input px-2 py-1.5 text-center"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                    {t("record.commonPacingCore")}
                  </span>
                  <span className="mt-0.5 text-[10px] leading-snug text-cs2-text-muted">
                    {t("record.commonPacingCoreDesc")}
                  </span>
                </div>
                <div
                  style={{ flex: postFlex }}
                  className="flex min-w-0 flex-col justify-center bg-cs2-cyan-surface px-2 py-1.5"
                >
                  <span className="text-[10px] font-bold uppercase tracking-wide text-cs2-text-primary/90">
                    {t("record.commonPacingPostLabel")}
                  </span>
                  <span className="font-mono text-xs text-cs2-text-primary">{post}s</span>
                </div>
              </div>
              <p className="text-[10px] leading-relaxed text-cs2-text-muted">
                {t("record.commonPacingStripHint")}
              </p>
            </div>

            <div className="mb-4 grid gap-4 sm:grid-cols-2">
              <PacingSlider
                label={t("record.commonPacingPreSlider")}
                min={0}
                max={20}
                step={0.1}
                value={pre}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ pre_first_sec: n })}
              />
              <PacingSlider
                label={t("record.commonPacingPostSlider")}
                min={0}
                max={10}
                step={0.1}
                value={post}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ post_last_sec: n })}
              />
            </div>

            <div className="rounded-lg border border-amber-500/15 bg-cs2-amber-surface px-3 py-3">
              <PacingSlider
                label={t("record.commonPacingGapSlider")}
                min={2}
                max={70}
                step={0.5}
                value={gap}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ max_gap_sec: n })}
                accentClass="accent-amber-500"
              />
              <p className="mt-2 text-xs text-cs2-text-muted">
                {t("record.commonPacingGapHint")}
              </p>
            </div>

          </WorkflowSection>

          {/* A2 录制预设专属的回看视角参数 */}
          <WorkflowSection
            title={t("record.commonSecCamera")}
            subtitle={t("record.commonSecCameraSubtitle")}
            defaultOpen
            accentClass="ring-1 ring-cs2-border-subtle"
          >
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border-l-4 border-cyan-500/55 bg-cs2-surface-1 p-4">
                <p className="text-xs font-bold text-cs2-cyan-on-surface">{t("record.commonVictimPovTitle")}</p>
                <p className="mt-0.5 text-xs text-cs2-text-muted">
                  {t("record.commonVictimPovDesc")}
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2.5">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={presetPacing.default_victim_pov === true}
                    onChange={(e) => setPresetPacing({ default_victim_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cyan-500 disabled:opacity-40"
                  />
                  <span className="text-xs leading-snug text-cs2-text-secondary">
                    {t("record.commonVictimPovCheckbox")}
                  </span>
                </label>
                {presetPacing.default_victim_pov ? (
                  <p className="mt-2 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.commonVictimPovOutcome")}
                  </p>
                ) : null}
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2.5">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={presetPacing.default_pov_interleaved === true}
                    onChange={(e) => setPresetPacing({ default_pov_interleaved: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cyan-500 disabled:opacity-40"
                  />
                  <span className="text-xs leading-snug text-cs2-text-secondary">
                    {t("record.commonPovInterleavedCheckbox")}
                  </span>
                </label>
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label={t("record.commonPovPreSlider")}
                    min={0}
                    max={5}
                    step={0.1}
                    value={victimPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_pre_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                  <PacingSlider
                    label={t("record.commonPovPostSlider")}
                    min={0}
                    max={5}
                    step={0.1}
                    value={victimPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_post_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                </div>
              </div>

              <div className="rounded-xl border-l-4 border-amber-500/55 bg-cs2-surface-1 p-4">
                <p className="text-xs font-bold text-cs2-amber-on-surface">{t("record.commonKillerPovTitle")}</p>
                <p className="mt-0.5 text-xs text-cs2-text-muted">
                  {t("record.commonKillerPovDesc")}
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2.5">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={presetPacing.default_killer_pov === true}
                    onChange={(e) => setPresetPacing({ default_killer_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-amber-500 disabled:opacity-40"
                  />
                  <span className="text-xs leading-snug text-cs2-text-secondary">
                    {t("record.commonKillerPovCheckbox")}
                  </span>
                </label>
                {presetPacing.default_killer_pov ? (
                  <p className="mt-2 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.commonKillerPovOutcome")}
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label={t("record.commonPovPreSlider")}
                    min={0}
                    max={5}
                    step={0.1}
                    value={killerPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_pre_sec: n })}
                    accentClass="accent-amber-500"
                  />
                  <PacingSlider
                    label={t("record.commonPovPostSlider")}
                    min={0}
                    max={5}
                    step={0.1}
                    value={killerPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_post_sec: n })}
                    accentClass="accent-amber-500"
                  />
                </div>
              </div>
            </div>
          </WorkflowSection>
        </div>

        <RecordingPresetColumns>
          <WorkflowSection
            presetOrder={3}
            title={t("record.commonExpTitle")}
            subtitle={t("pov.disclaimer")}
            badge={(
              <span className="rounded-md border border-cs2-border bg-cs2-bg-card px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cs2-amber-on-surface">
                {t("record.commonExpBadge")}
              </span>
            )}
            defaultOpen
            surfaceClass="bg-cs2-amber-surface"
            accentClass="border-amber-500/25"
          >
            <div>
              <p className="mb-3 text-xs leading-relaxed text-cs2-text-muted">
                {t("record.commonExpStatus", {
                  status: povEnabled
                    ? t("record.commonExpStatusOn")
                    : t("record.commonExpStatusOff"),
                })}
              </p>
              <ExperimentalPovSection
                visible={open || isPage}
                experimentalPovEnabled={povEnabled}
                onExperimentalPovChange={setPovEnabled}
                checkboxDisabled={batchRecording}
                povTeamcounterNumeric={warmupOpts.pov_teamcounter_numeric}
                onPovTeamcounterNumericChange={(v) => patchWarmup({ pov_teamcounter_numeric: v })}
                povVoiceMode={warmupOpts.pov_voice_mode}
                onPovVoiceModeChange={(v) => patchWarmup({ pov_voice_mode: v })}
                inputHudEnabled={warmupOpts.input_hud_enabled}
                inputHudDisplayMode={warmupOpts.input_hud_display_mode}
                onInputHudEnabledChange={(v) => patchWarmup({ input_hud_enabled: v })}
                onInputHudDisplayModeChange={(v) => patchWarmup({ input_hud_display_mode: v })}
                recordingSkybox={skyboxId}
                onRecordingSkyboxChange={setSkyboxId}
                recordingMapMaterial={mapMaterialId}
                onRecordingMapMaterialChange={setMapMaterialId}
                recordingWeatherEffect={weatherEffectId}
                onRecordingWeatherEffectChange={setWeatherEffectId}
                omitEyebrow
                omitDisclaimer
                embedded
              />
            </div>
          </WorkflowSection>

          <WorkflowSection
            presetOrder={2}
            title={t("record.commonSecFovPov")}
            subtitle={t("record.commonSecFovPovSubtitle")}
            defaultOpen
          >
            <div className="space-y-4">
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={warmupOpts.apply_fov}
                    onChange={(e) => patchWarmup({ apply_fov: e.target.checked })}
                    className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                  />
                  <span className="text-sm text-cs2-text-primary">
                    {t("record.warmupFovLabel")}
                  </span>
                </label>
                <div className="mt-2 flex items-center gap-2 pl-7">
                  <input
                    type="number"
                    min={60}
                    max={120}
                    step={1}
                    value={warmupOpts.fov_cs_debug}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      const n = parseInt(e.target.value, 10);
                      patchWarmup({
                        fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)),
                      });
                    }}
                    disabled={!warmupOpts.apply_fov}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">{t("record.commonFovDefault")}</span>
                </div>
                {warmupOpts.apply_fov ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.commonFovOutcome")}
                  </p>
                ) : null}
              </div>
              <OptionRow
                checked={warmupOpts.viewmodel_fov_68}
                onChange={(v) => patchWarmup({ viewmodel_fov_68: v })}
                title={t("record.warmupViewmodelTitle")}
                code="viewmodel_fov 68"
              />
              {warmupOpts.viewmodel_fov_68 ? (
                <p className="-mt-1 ml-1 text-xs leading-relaxed text-cs2-emerald-on-surface">
                  {t("record.commonViewmodelOutcome")}
                </p>
              ) : null}
              <OptionRow
                checked={warmupOpts.third_person_camera}
                onChange={(v) => patchWarmup({ third_person_camera: v })}
                title={t("record.commonThirdPersonTitle")}
                code="cam_command 1; cam_idealdist 30; c_thirdpersonshoulder 1"
              />
              {warmupOpts.third_person_camera ? (
                <p className="-mt-1 ml-1 text-xs leading-relaxed text-cs2-emerald-on-surface">
                  {t("record.commonThirdPersonOutcome")}
                </p>
              ) : null}
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-3">
                <label
                  className={`flex cursor-pointer items-center gap-3 ${
                    povEnabled ? "cursor-not-allowed opacity-60" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={povEnabled || warmupOpts.apply_spectator_flashbang_opacity}
                    disabled={povEnabled || batchRecording}
                    onChange={(e) =>
                      patchWarmup({ apply_spectator_flashbang_opacity: e.target.checked })
                    }
                    className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-50"
                  />
                  <span className="text-sm text-cs2-text-primary">
                    {t("record.warmupFlashLabel")}
                  </span>
                </label>
                <div className="mt-2 flex items-center gap-2 pl-7">
                  <input
                    type="number"
                    min={0.2}
                    max={1}
                    step={0.1}
                    value={povEnabled ? 1 : warmupOpts.spectator_flashbang_opacity}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      const n = parseFloat(e.target.value, 10);
                      patchWarmup({
                        spectator_flashbang_opacity: Number.isNaN(n)
                          ? SPECTATOR_FLASHBANG_OPACITY_DEFAULT
                          : Math.min(1, Math.max(0.2, n)),
                      });
                    }}
                    disabled={
                      povEnabled || batchRecording || !warmupOpts.apply_spectator_flashbang_opacity
                    }
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">{t("record.commonFlashRange")}</span>
                </div>
                {povEnabled ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-xs leading-relaxed text-cs2-amber-on-surface">
                    {t("record.commonFlashPovActive")}
                  </p>
                ) : warmupOpts.apply_spectator_flashbang_opacity ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.commonFlashOutcome")}
                  </p>
                ) : null}
              </div>
            </div>
          </WorkflowSection>

              <WorkflowSection
                presetOrder={0}
                title={t("record.commonSecObs")}
                subtitle={t("record.commonSecObsSubtitle")}
                defaultOpen
              >
                <div className="space-y-4">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={obsTransEnabled}
                      onChange={(e) => setObsTransEnabled(e.target.checked)}
                      className="h-4 w-4 rounded border-cs2-border accent-cs2-orange"
                    />
                    <span className="text-sm text-cs2-text-primary">{t("record.warmupObsEnable")}</span>
                  </label>

                  <label className="block text-xs font-medium text-cs2-text-secondary">
                    {t("record.warmupSecObs")}
                    <select
                      value={obsTransName}
                      onChange={(e) => setObsTransName(e.target.value)}
                      disabled={!obsTransEnabled}
                      className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
                    >
                      <option value="Fade">{t("record.warmupObsFade")}</option>
                      <option value="Cut">{t("record.warmupObsCut")}</option>
                      <option value="Swipe">{t("record.warmupObsSwipe")}</option>
                    </select>
                  </label>

                  <label className="block text-xs font-medium text-cs2-text-secondary">
                    ms
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      step={50}
                      value={obsTransDurationMs || ""}
                      onChange={(e) => setObsTransDurationMs(Number(e.target.value))}
                      disabled={!obsTransEnabled}
                      className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
                    />
                  </label>
                </div>
              </WorkflowSection>

              <WorkflowSection
                presetOrder={1}
                title={t("record.commonSecVisuals")}
                subtitle={t("record.commonSecVisualsSubtitle")}
                defaultOpen
              >
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("record.commonVisualsSection")}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <RecordingHudCard
                    title={t("record.hudSimplifyTitle")}
                    code="cl_draw_only_deathnotices true"
                    description={t("record.hudSimplifyDesc")}
                    checked={warmupOpts.cl_draw_only_deathnotices}
                    onChange={(v) => patchWarmup({ cl_draw_only_deathnotices: v })}
                    outcomeOn={t("record.hudSimplifyOutcome")}
                    disabled={!!povEnabled}
                    disabledReason={POV_CONFLICT_HUD}
                  />
                  <RecordingHudCard
                    title={t("record.hudHideTargetTitle")}
                    code="hud_showtargetid 0"
                    description={t("record.hudHideTargetDesc")}
                    checked={warmupOpts.hud_showtargetid_hide}
                    onChange={(v) => patchWarmup({ hud_showtargetid_hide: v })}
                    outcomeOn={t("record.hudHideTargetOutcome")}
                  />
                  <RecordingHudCard
                    title={t("record.hudNoChatTitle")}
                    code="tv_nochat 1"
                    description={t("record.hudNoChatDesc")}
                    checked={warmupOpts.tv_nochat}
                    onChange={(v) => patchWarmup({ tv_nochat: v })}
                    outcomeOn={t("record.hudNoChatOutcome")}
                  />
                  <RecordingHudCard
                    title={t("record.hudHideGrenadeTitle")}
                    code="sv_grenade_trajectory 0; …"
                    description={t("record.hudHideGrenadeDesc")}
                    checked={warmupOpts.hide_grenade_trajectory_pip}
                    onChange={(v) => patchWarmup({ hide_grenade_trajectory_pip: v })}
                    outcomeOn={t("record.hudHideGrenadeOutcome")}
                  />
                </div>

                <div className="my-5 border-t border-cs2-border" />
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("record.commonDemoSection")}
                </p>
                <div className="space-y-4">
                  <RecordingHudCard
                    title={t("record.hudHideDemoUiTitle")}
                    code="sv_cheats 1 → demoui false"
                    description={t("record.hudHideDemoUiDesc")}
                    checked={warmupOpts.hide_demo_playback_ui}
                    onChange={(v) => patchWarmup({ hide_demo_playback_ui: v })}
                    outcomeOn={t("record.hudHideDemoUiOutcome")}
                  />
                  <RecordingHudCard
                    title={t("record.hudXrayTitle")}
                    code="spec_show_xray 1 / 0"
                    description={t("record.hudXrayDesc")}
                    checked={warmupOpts.spec_show_xray}
                    onChange={(v) => patchWarmup({ spec_show_xray: v })}
                    outcomeOn={t("record.hudXrayOutcome")}
                  />
                </div>
              </WorkflowSection>

              <WorkflowSection
                presetOrder={5}
                title={t("record.commonSecLaunch")}
                subtitle={t("record.commonSecLaunchSubtitle")}
                defaultOpen
              >
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("record.commonLaunchCmdLabel")}
                </p>
                <Cs2LaunchConsoleFields
                  cs2ExtraLaunchArgs={localCs2ExtraLaunchArgs}
                  onCs2ExtraLaunchArgsChange={setLocalCs2ExtraLaunchArgs}
                  recordInjectConsoleLines={localRecordInjectLines}
                  onRecordInjectConsoleLinesChange={setLocalRecordInjectLines}
                />
              </WorkflowSection>

              <WorkflowSection
                presetOrder={4}
                title={t("record.commonSecCanvas")}
                subtitle={t("record.commonSecCanvasSubtitle")}
                defaultOpen
              >
            <div
              className={`rounded-xl border p-4 ${
                warmupResolutionError
                  ? "border-rose-500/45 bg-cs2-rose-surface"
                  : "border-cs2-border-subtle bg-cs2-surface-1"
              }`}
            >
              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                {AR_TAGS.map(({ ar, sample, tagKey }) => {
                  const selected = warmupOpts.aspect_ratio === ar;
                  return (
                    <button
                      key={ar}
                      type="button"
                      onClick={() => patchWarmup({ aspect_ratio: ar })}
                      className={`rounded-xl border p-3 text-left transition-all ${
                        selected
                          ? "border-cs2-accent bg-cs2-accent-soft"
                          : "border-cs2-border bg-cs2-bg-input hover:border-cs2-border-focus"
                      }`}
                    >
                      <p className="font-mono text-base font-bold text-cs2-text-primary">{ar}</p>
                      <p className="mt-1 font-mono text-xs text-cs2-text-secondary">{sample}</p>
                      <p className="mt-0.5 text-xs text-cs2-text-muted">{t(tagKey)}</p>
                    </button>
                  );
                })}
              </div>

              <label className="mb-3 block">
                <span className="mb-1 block text-xs text-cs2-text-muted">
                  {t("record.warmupResAspectLabel")}
                </span>
                <select
                  value={warmupOpts.aspect_ratio}
                  onChange={(e) => patchWarmup({ aspect_ratio: e.target.value })}
                  className="w-full max-w-md rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-sm text-cs2-text-primary outline-none focus:border-cs2-accent"
                >
                  <option value="">{t("record.warmupResAspectNone")}</option>
                  <option value="4:3">4 : 3</option>
                  <option value="16:9">16 : 9</option>
                  <option value="16:10">16 : 10</option>
                </select>
              </label>

              <div className="mb-4 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input p-3">
                <p className="text-xs uppercase tracking-wide text-cs2-text-muted">{t("record.commonResCurrentLabel")}</p>
                <p className="mt-1 text-sm text-cs2-text-primary font-medium">
                  {t("record.commonResAspectPrefix")}{" "}
                  <span className="font-mono text-cs2-accent font-bold">
                    {warmupOpts.aspect_ratio || t("record.commonResAspectUnset")}
                  </span>
                  {" · "}
                  {t("record.commonResValuePrefix")}{" "}
                  <span className="font-mono text-cs2-text-secondary">
                    {resSummaryDisplay}
                  </span>
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-cs2-text-muted">
                  {t(aspectHint(warmupOpts.aspect_ratio))}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.commonResExportPrefix")}{t(aspectExportHint(warmupOpts.aspect_ratio))}
                </p>
              </div>

              <p className="mb-2 text-xs text-cs2-text-secondary font-medium">
                {t("record.commonResLaunchParamsHint")}
              </p>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono text-xs font-semibold text-cs2-text-muted">-w</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={warmupOpts.resolution_width}
                  onChange={(e) => patchWarmup({ resolution_width: e.target.value })}
                  className="w-24 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent"
                />
                <span className="font-mono text-xs font-semibold text-cs2-text-muted">-h</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={warmupOpts.resolution_height}
                  onChange={(e) => patchWarmup({ resolution_height: e.target.value })}
                  className="w-24 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent"
                />
              </div>
              {warmupResolutionError ? (
                <p className="mt-2.5 text-xs leading-snug text-cs2-rose-on-surface">{warmupResolutionError}</p>
              ) : (
                <p className="mt-2.5 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.commonResLeaveBlankHint")}
                </p>
              )}
            </div>
          </WorkflowSection>

            </RecordingPresetColumns>
        </div>
        </div>

        {isModal ? (
          <div className="shrink-0 border-t border-cs2-border bg-cs2-bg-input px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-cs2-accent py-2 text-sm font-bold text-cs2-text-on-accent hover:brightness-110 sm:w-auto sm:px-6"
            >
              {t("record.commonDone")}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );

  if (isPage) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-cs2-bg-page">
        <header className="shrink-0 border-b border-cs2-border bg-cs2-bg-page px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-cs2-text-primary">{t("record.commonPageTitle")}</h1>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-cs2-text-muted">
              {t("record.commonPageSubtitle")}
            </p>
            {saveError ? (
              <p className="mt-2 text-xs leading-snug text-cs2-rose-on-surface">{saveError}</p>
            ) : null}
            {!configReady ? (
              <p className="mt-2 text-xs text-cs2-text-muted">{t("record.commonLoadingConfig")}</p>
            ) : null}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
        <div className="shrink-0 px-3 pb-3 sm:px-5 sm:pb-4">
          <div className="flex flex-col items-stretch gap-3 rounded-xl border border-cs2-border bg-cs2-bg-card p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <p className="text-[11px] leading-relaxed text-dynamic-zinc-400">
              {t("record.commonSaveFooterDesc")}
            </p>
            {saveButton}
          </div>
        </div>
      </div>
    );
  }

  if (isEmbedded) return body;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-cs2-bg-overlay px-3 py-6 backdrop-blur-sm sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="common-params-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {body}
    </div>
  );
}
