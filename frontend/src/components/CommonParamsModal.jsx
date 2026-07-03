import { useCallback, useEffect, useRef, useState } from "react";
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

function WorkflowSection({ title, subtitle, badge, defaultOpen = true, accentClass = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm transition-all ${accentClass}`.trim()}
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
          className={`min-w-0 flex-1 disabled:opacity-40 cursor-pointer ${accentClass}`}
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
  cs2ExtraLaunchArgs = "",
  recordInjectConsoleLines = "",
  obsTransitionEnabled: initObsTransitionEnabled = false,
  obsTransitionName: initObsTransitionName = "Fade",
  obsTransitionDurationMs: initObsTransitionDurationMs = 100,
  kbOverlayEnabled: initKbOverlayEnabled = false,
  kbOverlayTickOffset: initKbOverlayTickOffset = 6,
  kbOverlayPosition: initKbOverlayPosition = "bottom_center",
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
  const resetPresetPacing = useRecordingQueue((s) => s.resetPresetPacing);
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
  const [kbOverlayEnabled, setKbOverlayEnabled] = useState(() => !!initKbOverlayEnabled);
  const [kbOverlayTickOffset, setKbOverlayTickOffset] = useState(() => Number(initKbOverlayTickOffset));
  const [kbOverlayPosition, setKbOverlayPosition] = useState(() => initKbOverlayPosition || "bottom_center");
  const [povEnabled, setPovEnabled] = useState(() => !!experimentalPovEnabled);
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
    setWarmupOpts(base);
    setObsTransEnabled(!!initObsTransitionEnabled);
    setObsTransName(initObsTransitionName);
    setObsTransDurationMs(Number(initObsTransitionDurationMs));
    setKbOverlayEnabled(!!initKbOverlayEnabled);
    setKbOverlayTickOffset(Number(initKbOverlayTickOffset));
    setKbOverlayPosition(initKbOverlayPosition || "bottom_center");
    setPovEnabled(!!experimentalPovEnabled);
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
    initKbOverlayEnabled,
    initKbOverlayTickOffset,
    initKbOverlayPosition,
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
      kb_overlay_enabled: kbOverlayEnabled,
      kb_overlay_tick_offset: Number(kbOverlayTickOffset) || 0,
      kb_overlay_position: kbOverlayPosition,
      experimental_pov_enabled: povEnabled,
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
    kbOverlayEnabled,
    kbOverlayTickOffset,
    kbOverlayPosition,
    povEnabled,
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
    kb_overlay_enabled: kbOverlayEnabled,
    kb_overlay_tick_offset: Number(kbOverlayTickOffset) || 0,
    kb_overlay_position: kbOverlayPosition,
    experimental_pov_enabled: povEnabled,
  }), [
    presetPacing,
    warmupOpts,
    localCs2ExtraLaunchArgs,
    localRecordInjectLines,
    obsTransEnabled,
    obsTransName,
    obsTransDurationMs,
    kbOverlayEnabled,
    kbOverlayTickOffset,
    kbOverlayPosition,
    povEnabled,
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
      setKbOverlayEnabled(parsed.kb_overlay_enabled);
      setKbOverlayTickOffset(parsed.kb_overlay_tick_offset);
      setKbOverlayPosition(parsed.kb_overlay_position);
      setPovEnabled(parsed.experimental_pov_enabled);
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

  const VF_OPTIONS = [
    { value: "open",  labelKey: "record.warmupVoiceOpen",  code: "tv_listen_voice_indices -1",     descKey: "record.warmupVoiceOpenDesc" },
    { value: "team",  labelKey: "record.warmupVoiceTeam",  code: "tv_listen_voice_indices <mask>", descKey: "record.warmupVoiceTeamDesc" },
    { value: "enemy", labelKey: "record.warmupVoiceEnemy", code: "tv_listen_voice_indices <mask>", descKey: "record.warmupVoiceEnemyDesc" },
    { value: "mute",  labelKey: "record.warmupVoiceMute",  code: "snd_voipvolume 0",              descKey: "record.warmupVoiceMuteDesc" },
  ];

  const KB_POSITIONS = [
    { value: "bottom_center", labelKey: "record.warmupKbPosBottomCenter" },
    { value: "minimap_below", labelKey: "record.warmupKbPosMinimapBelow" },
    { value: "weapon_right",  labelKey: "record.warmupKbPosWeaponRight" },
  ];

  const AR_TAGS = [
    { ar: "4:3",   sample: "1920×1440", tagKey: "record.arTag43" },
    { ar: "16:9",  sample: "1920×1080", tagKey: "record.arTag169" },
    { ar: "16:10", sample: "1920×1200", tagKey: "record.arTag1610" },
  ];

  const vf = warmupOpts.voice_filter ?? "mute";
  const selectedVf = VF_OPTIONS.find((o) => o.value === vf) ?? VF_OPTIONS[3];

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

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4">
          <div className="@container/params mx-auto w-full max-w-4xl min-w-0">
            <div className="mb-3 flex flex-col gap-3 rounded-xl border border-cs2-accent/25 bg-cs2-accent/[0.05] p-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="min-w-0">
                <p className="text-sm font-bold text-cs2-text-primary">{t("record.presetShareTitle")}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-cs2-text-muted">{t("record.presetShareDesc")}</p>
                {shareMessage ? (
                  <p className={`mt-1.5 text-xs ${shareMessage.tone === "ok" ? "text-emerald-400" : "text-rose-400"}`} role="status">
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
                  className="inline-flex items-center gap-2 rounded-lg border border-cs2-accent/40 bg-cs2-accent/10 px-3 py-2 text-xs font-semibold text-cs2-accent hover:bg-cs2-accent/15 disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {t("record.presetExportBtn")}
                </button>
              </div>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 pb-2 sm:gap-4 sm:pb-4">
              <div className="flex min-w-0 flex-col gap-3 sm:gap-4">
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
                  className="flex min-w-0 flex-col justify-center border-r border-cs2-border-subtle bg-gradient-to-br from-cs2-accent/35 to-cs2-accent/10 px-2 py-1.5"
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
                  className="flex min-w-0 flex-col justify-center bg-gradient-to-bl from-cyan-500/25 to-cyan-500/5 px-2 py-1.5"
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

            <button
              type="button"
              disabled={batchRecording}
              onClick={() => resetPresetPacing()}
              className="mt-4 text-xs text-cs2-text-muted hover:text-cs2-text-secondary disabled:opacity-40"
            >
              {t("record.commonPacingResetBtn")}
            </button>
          </WorkflowSection>

          {/* A2 镜头与 POV */}
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

            <div className="my-5 border-t border-cs2-border" />
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              {t("record.commonSecFovPov")}
            </p>
            <div className="mb-5 rounded-xl border border-amber-500/30 bg-gradient-to-br from-cs2-surface-1 to-cs2-surface-2 p-4 shadow-md">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cs2-amber-on-surface">
                  {t("record.commonExpBadge")}
                </span>
                <h4 className="text-sm font-bold text-cs2-text-primary">{t("record.commonExpTitle")}</h4>
              </div>
              <p className="mb-1 text-xs leading-relaxed text-cs2-amber-on-surface/90">
                {t("record.commonExpDesc")}
              </p>
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
                povRadarMode={warmupOpts.pov_radar_mode}
                onPovRadarModeChange={(v) => patchWarmup({ pov_radar_mode: v })}
                povTeamcounterNumeric={warmupOpts.pov_teamcounter_numeric}
                onPovTeamcounterNumericChange={(v) => patchWarmup({ pov_teamcounter_numeric: v })}
                omitEyebrow
                className="rounded-lg border border-amber-500/20 bg-cs2-bg-input/60 p-3"
              />
            </div>

            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              {t("record.commonSecBasicCamera")}
            </p>
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
                <p className="-mt-1 ml-1 text-xs leading-relaxed text-emerald-400/85">
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
                <p className="-mt-1 ml-1 text-xs leading-relaxed text-emerald-400/85">
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

            </div>
            <div className="flex min-w-0 flex-col gap-3 sm:gap-4">
              <WorkflowSection
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
                title={t("record.commonSecKb")}
                subtitle={t("record.commonSecKbSubtitle")}
                defaultOpen
              >
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={kbOverlayEnabled}
                    onChange={(e) => setKbOverlayEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-cs2-border accent-cs2-orange"
                  />
                  <span className="text-sm text-cs2-text-primary">{t("record.warmupKbEnable")}</span>
                </label>
                <p className="mt-2 pl-7 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.commonKbDesc")}
                </p>
                {kbOverlayEnabled && (
                  <div className="mt-3 pl-7 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-cs2-text-secondary whitespace-nowrap">{t("record.warmupKbPosition")}</span>
                      {KB_POSITIONS.map(({ value, labelKey }) => (
                        <label key={value} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="kb-pos-common"
                            value={value}
                            checked={kbOverlayPosition === value}
                            onChange={() => setKbOverlayPosition(value)}
                            className="accent-cs2-orange"
                          />
                          <span className="text-xs text-cs2-text-primary">{t(labelKey)}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-cs2-text-secondary whitespace-nowrap">{t("record.warmupKbSyncAdjust")}</span>
                      <input
                        type="number"
                        value={kbOverlayTickOffset}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setKbOverlayTickOffset(raw === "" ? "" : Number(raw));
                        }}
                        onBlur={() => {
                          if (kbOverlayTickOffset === "" || Number.isNaN(Number(kbOverlayTickOffset))) {
                            setKbOverlayTickOffset(0);
                          }
                        }}
                        min="-120"
                        max="120"
                        step="1"
                        className="w-20 rounded border border-cs2-border bg-cs2-bg-elevated px-2 py-1 text-sm text-cs2-text-primary text-center"
                      />
                      <span className="text-xs text-cs2-text-muted tabular-nums">
                        ≈ {Math.round(Math.abs(Number(kbOverlayTickOffset) || 0) / 64 * 1000)} ms{Number(kbOverlayTickOffset) > 0 ? t("record.warmupKbAhead") : Number(kbOverlayTickOffset) < 0 ? t("record.warmupKbBehind") : t("record.warmupKbNoCompensation")}
                      </span>
                    </div>
                    <p className="text-xs text-cs2-text-muted leading-relaxed">
                      {t("record.commonKbSyncHint")}
                    </p>
                  </div>
                )}
              </WorkflowSection>

              <WorkflowSection
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

                <div className="my-5 border-t border-cs2-border" />
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("record.commonCaptureLabel")}
                </p>
            {(() => {
              const selectedVfLocal = VF_OPTIONS.find((o) => o.value === vf) ?? VF_OPTIONS[3];
              return (
                <>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {VF_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => patchWarmup({ voice_filter: opt.value })}
                        className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                          vf === opt.value
                            ? "border-cs2-accent/60 bg-cs2-accent/10"
                            : "border-cs2-border bg-cs2-bg-input/40 hover:border-cs2-border-focus"
                        }`}
                      >
                        <p className="text-[11px] font-semibold text-cs2-text-primary">{t(opt.labelKey)}</p>
                        <p className="mt-0.5 font-mono text-[9px] text-cs2-text-muted">{opt.code}</p>
                      </button>
                    ))}
                  </div>
                  <p className={`mb-4 mt-1.5 ml-0.5 text-xs leading-relaxed ${vf === "open" ? "text-cs2-text-muted" : "text-emerald-400/85"}`}>
                    {t(selectedVfLocal.descKey)}
                  </p>
                </>
              );
            })()}

            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              {t("record.commonResSection")}
            </p>
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
                          ? "border-cs2-accent bg-cs2-accent-soft shadow-sm"
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
                <p className="mt-2.5 text-xs leading-snug text-rose-400">{warmupResolutionError}</p>
              ) : (
                <p className="mt-2.5 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.commonResLeaveBlankHint")}
                </p>
              )}
            </div>
          </WorkflowSection>

            </div>
          </div>
        </div>
        </div>

        {isModal ? (
          <div className="shrink-0 border-t border-cs2-border bg-cs2-bg-input/60 px-4 py-3 sm:px-5">
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
        <header className="shrink-0 border-b border-cs2-border bg-cs2-bg-page/95 px-4 py-3 backdrop-blur-sm sm:px-5">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-cs2-text-primary">{t("record.commonPageTitle")}</h1>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-cs2-text-muted">
              {t("record.commonPageSubtitle")}
            </p>
            {saveError ? (
              <p className="mt-2 text-xs leading-snug text-rose-400">{saveError}</p>
            ) : null}
            {!configReady ? (
              <p className="mt-2 text-xs text-cs2-text-muted">{t("record.commonLoadingConfig")}</p>
            ) : null}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
        <div className="shrink-0 px-3 pb-3 sm:px-5 sm:pb-4">
          <div className="flex flex-col items-stretch gap-3 rounded-xl border border-cs2-orange/25 bg-cs2-orange/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
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
