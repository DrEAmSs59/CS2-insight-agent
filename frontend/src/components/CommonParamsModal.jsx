import RecordingSettingsSections from "./RecordingSettingsSections.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Save, Upload, X } from "lucide-react";
import { RECORD_WARMUP_DEFAULT_OPTIONS } from "./recordingQueue/recordingWarmupDefaults.js";
import { BACKEND_DEFAULT_PACING, useRecordingQueue } from "../stores/recordingQueueStore";
import { MAX_EVENT_PREROLL_SECONDS, MAX_RECORDING_MERGE_GAP_SECONDS } from "../utils/recordingPacing.js";
import { warmupUiOptsToPersisted, validateWarmupResolution } from "../utils/warmupDefaults";
import { useT } from "../i18n/useT.js";
import { normalizeRecordingSkyboxId } from "../utils/recordingSkybox.js";
import { normalizeRecordingMapMaterialId } from "../utils/recordingMapMaterial.js";
import { DEFAULT_RECORDING_WEATHER_EFFECT, normalizeRecordingWeatherEffectId } from "../utils/recordingWeatherEffect.js";
import { normalizePovVoiceMode } from "../utils/povVoiceMode.js";
import { buildRecordingPresetFile, parseRecordingPresetFile, RECORDING_PRESET_MAX_BYTES } from "../utils/recordingPresetJson";
import { countChangedFields } from "../utils/settingsDiff.js";
import { NumberInput, RangeField, Segmented, SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow, Switch } from "../pages/settings/SettingsControls.jsx";
import { RECORDING_PRESET_SECTIONS } from "../pages/settings/recordingPresetSections.js";

/** 未写入配置时的展示用回退（与队列微调面板一致） */
const FB_VIC_PRE = 1.5;
const FB_VIC_POST = 1.5;
const FB_KILL_PRE = 1.5;
const FB_KILL_POST = 1.5;

/** 片段时间流示意图中间「主体段」参考秒数，与左右同为秒单位以便比例对齐 */
const PACING_STRIP_CORE_REF_SEC = 6;
const SECTION_TITLE_KEYS = Object.fromEntries(RECORDING_PRESET_SECTIONS.map(section => [section.id, section.labelKey]));
function presetGroupProps(id, t) {
  return {
    id,
    title: t(SECTION_TITLE_KEYS[id])
  };
}

/**
 * 常用参数：内联编辑「全局节奏（数值）+ 入队默认 POV」与「录制前观战默认选项」；
 * 由页面保存栏一次性写入 data/cs2-insight.config.json。
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
  onRegisterDiscard,
  onSaveUiChange
}) {
  const t = useT();
  const isPage = variant === "page";
  const isEmbedded = variant === "embedded";
  const isModal = !isPage && !isEmbedded;
  const presetPacing = useRecordingQueue(s => s.presetPacing);
  const setPresetPacing = useRecordingQueue(s => s.setPresetPacing);
  const hydratePresetPacing = useRecordingQueue(s => s.hydratePresetPacing);
  const post = presetPacing.post_last_sec ?? BACKEND_DEFAULT_PACING.post_last_sec;
  const pre = presetPacing.pre_first_sec ?? BACKEND_DEFAULT_PACING.pre_first_sec;
  const gap = presetPacing.max_gap_sec ?? BACKEND_DEFAULT_PACING.max_gap_sec;
  const victimPovPre = presetPacing.victim_pov_pre_sec ?? FB_VIC_PRE;
  const victimPovPost = presetPacing.victim_pov_post_sec ?? FB_VIC_POST;
  const killerPovPre = presetPacing.killer_pov_pre_sec ?? FB_KILL_PRE;
  const killerPovPost = presetPacing.killer_pov_post_sec ?? FB_KILL_POST;
  const commitPacingNumbers = useCallback(partial => {
    const next = Object.fromEntries(Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    if (Object.keys(next).length) setPresetPacing(next);
  }, [setPresetPacing]);
  const [warmupOpts, setWarmupOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [warmupResolutionError, setWarmupResolutionError] = useState("");
  const [obsTransEnabled, setObsTransEnabled] = useState(() => !!initObsTransitionEnabled);
  const [obsTransName, setObsTransName] = useState(() => initObsTransitionName);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(() => Number(initObsTransitionDurationMs));
  const [povEnabled, setPovEnabled] = useState(() => !!experimentalPovEnabled);
  const [skyboxId, setSkyboxId] = useState(() => normalizeRecordingSkyboxId(recordingSkybox));
  const [mapMaterialId, setMapMaterialId] = useState(() => normalizeRecordingMapMaterialId(recordingMapMaterial));
  const [weatherEffectId, setWeatherEffectId] = useState(() => normalizeRecordingWeatherEffectId(recordingWeatherEffect));
  const [localCs2ExtraLaunchArgs, setLocalCs2ExtraLaunchArgs] = useState(cs2ExtraLaunchArgs);
  const [localRecordInjectLines, setLocalRecordInjectLines] = useState(recordInjectConsoleLines);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [shareMessage, setShareMessage] = useState(null);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [baseline, setBaseline] = useState(null);
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
    const base = {
      ...RECORD_WARMUP_DEFAULT_OPTIONS
    };
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
    base.pov_voice_mode = normalizePovVoiceMode(o?.pov_voice_mode, o?.pov_voice_disabled === true);
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
    setBaselineVersion(v => v + 1);
  }, [configRefreshKey, open, isPage, configReady, savedWarmupDefaults, initObsTransitionEnabled, initObsTransitionName, initObsTransitionDurationMs, experimentalPovEnabled, recordingSkybox, recordingMapMaterial, recordingWeatherEffect, cs2ExtraLaunchArgs, recordInjectConsoleLines]);
  const patchWarmup = useCallback(patch => {
    setWarmupOpts(prev => ({
      ...prev,
      ...patch
    }));
  }, []);
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
    recording_weather_effect: weatherEffectId
  }), [presetPacing, warmupOpts, localCs2ExtraLaunchArgs, localRecordInjectLines, obsTransEnabled, obsTransName, obsTransDurationMs, povEnabled, skyboxId, mapMaterialId, weatherEffectId]);

  // Snapshot the hydrated values once React has applied them, so later edits
  // can be counted as unsaved changes and discarded back to this point.
  useEffect(() => {
    if (!baselineVersion) return;
    setBaseline({
      preset: currentPreset(),
      warmupOpts
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineVersion]);
  const handleSaveAll = useCallback(async () => {
    if (!onSaveAllCommonParams || !configReady || batchRecording || saveState === "saving") return;
    const captureError = "";
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
    const snapshot = {
      preset: currentPreset(),
      warmupOpts
    };
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
      recording_weather_effect: weatherEffectId
    });
    setSaveState(result?.ok ? "saved" : "error");
    if (!result?.ok && result?.error) setSaveError(String(result.error));
    if (result?.ok) {
      setBaseline(snapshot);
      setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [t, configReady, batchRecording, false, currentPreset, onSaveAllCommonParams, saveState, warmupOpts, presetPacing, localCs2ExtraLaunchArgs, localRecordInjectLines, obsTransEnabled, obsTransName, obsTransDurationMs, povEnabled, skyboxId, mapMaterialId, weatherEffectId]);
  const saveDisabled = !configReady || saveState === "saving" || batchRecording;
  const applyPreset = useCallback((preset, nextWarmupOpts) => {
    hydratePresetPacing(preset.recording_global_pacing);
    setWarmupOpts(nextWarmupOpts);
    setLocalCs2ExtraLaunchArgs(preset.cs2_extra_launch_args);
    setLocalRecordInjectLines(preset.record_inject_console_lines);
    setObsTransEnabled(preset.obs_transition_enabled);
    setObsTransName(preset.obs_transition_name);
    setObsTransDurationMs(preset.obs_transition_duration_ms);
    setPovEnabled(preset.experimental_pov_enabled);
    setSkyboxId(preset.recording_skybox);
    setMapMaterialId(preset.recording_map_material);
    setWeatherEffectId(preset.recording_weather_effect);
    setWarmupResolutionError("");
    setSaveError("");
    setSaveState("idle");
  }, [hydratePresetPacing]);
  const handleDiscard = useCallback(() => {
    if (!baseline) return;
    applyPreset(baseline.preset, baseline.warmupOpts);
    setShareMessage(null);
  }, [applyPreset, baseline]);
  const handleExportPreset = useCallback(() => {
    const vr = validateWarmupResolution(warmupOpts);
    if (!vr.ok) {
      setShareMessage({
        tone: "error",
        text: t(vr.messageKey, vr.messageParams)
      });
      return;
    }
    try {
      const shareFile = buildRecordingPresetFile(currentPreset());
      parseRecordingPresetFile(shareFile, RECORD_WARMUP_DEFAULT_OPTIONS);
      const json = JSON.stringify(shareFile, null, 2);
      const blob = new Blob([json], {
        type: "application/json;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cs2-insight-recording-preset-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setShareMessage({
        tone: "ok",
        text: t("record.presetExported")
      });
    } catch (error) {
      const detail = error?.field ? t("record.presetInvalidField", {
        field: error.field
      }) : error?.message || String(error);
      setShareMessage({
        tone: "error",
        text: t("record.presetExportFailed", {
          error: detail
        })
      });
    }
  }, [currentPreset, t, warmupOpts]);
  const handleImportPreset = useCallback(async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > RECORDING_PRESET_MAX_BYTES) {
      setShareMessage({
        tone: "error",
        text: t("record.presetFileTooLarge")
      });
      return;
    }
    try {
      const parsed = parseRecordingPresetFile(JSON.parse(await file.text()), RECORD_WARMUP_DEFAULT_OPTIONS);
      const vr = validateWarmupResolution(parsed.default_record_warmup);
      if (!vr.ok) throw new Error(t(vr.messageKey, vr.messageParams));
      applyPreset(parsed, parsed.default_record_warmup);
      setShareMessage({
        tone: "ok",
        text: t("record.presetImported")
      });
    } catch (error) {
      const detail = error?.field ? t("record.presetInvalidField", {
        field: error.field
      }) : error?.message || String(error);
      setShareMessage({
        tone: "error",
        text: t("record.presetImportFailed", {
          error: detail
        })
      });
    }
  }, [applyPreset, t]);
  const pendingChanges = baseline ? countChangedFields(currentPreset(), baseline.preset) : 0;
  useEffect(() => {
    onRegisterSave?.(handleSaveAll);
    return () => onRegisterSave?.(null);
  }, [handleSaveAll, onRegisterSave]);
  useEffect(() => {
    onRegisterDiscard?.(handleDiscard);
    return () => onRegisterDiscard?.(null);
  }, [handleDiscard, onRegisterDiscard]);
  useEffect(() => {
    onSaveUiChange?.({
      disabled: saveDisabled,
      state: saveState,
      changes: pendingChanges,
      error: saveError
    });
  }, [onSaveUiChange, saveDisabled, saveState, pendingChanges, saveError]);
  const saveButton = onSaveAllCommonParams ? <SettingsButton variant="primary" disabled={saveDisabled} busy={saveState === "saving"} icon={Save} onClick={() => void handleSaveAll()}>
      {saveState === "saving" ? t("record.commonSaving") : saveState === "saved" ? t("record.commonSaved") : t("record.commonSaveBtn")}
    </SettingsButton> : null;
  if (!open && !isPage && !isEmbedded) return null;
  const preFlex = Math.max(pre, 0.05);
  const postFlex = Math.max(post, 0.05);
  const secondsUnit = t("settings.unitSeconds");
  const importExportActions = <>
      <input ref={importFileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportPreset} />
      <SettingsButton icon={Upload} disabled={!configReady || batchRecording} title={t("record.presetShareDesc")} onClick={() => importFileRef.current?.click()}>
        {t("settings.presetImportBtn")}
      </SettingsButton>
      <SettingsButton icon={Download} disabled={!configReady} title={t("record.presetShareDesc")} onClick={handleExportPreset}>
        {t("settings.presetExportBtn")}
      </SettingsButton>
    </>;
  const content = <div className="w-full min-w-0" data-testid="recording-preset-content">
      <SettingsPageHeader title={t("settings.tabRecording")} description={t("settings.pageDescRecording")} actions={importExportActions} />
      {shareMessage ? <p className={`mt-2 text-xs ${shareMessage.tone === "ok" ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`} role="status">
          {shareMessage.text}
        </p> : null}
      {!configReady ? <p className="mt-2 text-xs text-cs2-text-muted">{t("record.commonLoadingConfig")}</p> : null}
      {saveError && !isPage ? <p role="alert" className="mt-2 text-xs text-cs2-rose-on-surface">{saveError}</p> : null}

      {null}

      <SettingsGroup {...presetGroupProps("rp-pacing", t)} description={t("settings.presetPacingDesc")}>
        <div className="px-4 py-3" aria-hidden>
          <div className="flex h-10 w-full overflow-hidden rounded-md border border-cs2-border-subtle text-[11px]">
            <div style={{
            flex: preFlex
          }} className="flex min-w-0 flex-col justify-center bg-cs2-accent-soft px-2.5 text-cs2-accent">
              <span className="truncate">{t("settings.presetPreShort")}</span>
              <span className="font-mono font-semibold">{pre}s</span>
            </div>
            <div style={{
            flex: PACING_STRIP_CORE_REF_SEC
          }} className="flex min-w-[5.5rem] flex-col items-center justify-center bg-cs2-bg-input px-2.5 text-center text-cs2-text-secondary">
              <span className="truncate">{t("record.commonPacingCore")}</span>
              <span className="truncate text-cs2-text-muted">{t("settings.presetCoreDesc")}</span>
            </div>
            <div style={{
            flex: postFlex
          }} className="flex min-w-0 flex-col justify-center bg-cs2-emerald-surface px-2.5 text-cs2-emerald-on-surface">
              <span className="truncate">{t("settings.presetPostShort")}</span>
              <span className="font-mono font-semibold">{post}s</span>
            </div>
          </div>
        </div>
        <SettingsRow label={t("settings.presetPreLabel")} description={t("settings.presetPreDesc")}>
          <RangeField ariaLabel={t("record.commonPacingPreSlider")} min={0} max={MAX_EVENT_PREROLL_SECONDS} step={0.1} unit={secondsUnit} value={pre} defaultValue={BACKEND_DEFAULT_PACING.pre_first_sec} disabled={batchRecording} onChange={n => commitPacingNumbers({
          pre_first_sec: n
        })} />
        </SettingsRow>
        <SettingsRow label={t("settings.presetPostLabel")} description={t("settings.presetPostDesc")}>
          <RangeField ariaLabel={t("record.commonPacingPostSlider")} min={0} max={10} step={0.1} unit={secondsUnit} value={post} defaultValue={BACKEND_DEFAULT_PACING.post_last_sec} disabled={batchRecording} onChange={n => commitPacingNumbers({
          post_last_sec: n
        })} />
        </SettingsRow>
        <SettingsRow label={t("settings.presetGapLabel")} description={t("settings.presetGapDesc")}>
          <RangeField ariaLabel={t("settings.presetGapLabel")} min={2} max={MAX_RECORDING_MERGE_GAP_SECONDS} step={0.5} unit={secondsUnit} value={gap} defaultValue={BACKEND_DEFAULT_PACING.max_gap_sec} disabled={batchRecording} onChange={n => commitPacingNumbers({
          max_gap_sec: n
        })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup {...presetGroupProps("rp-replay", t)} description={t("settings.presetReplayDesc")}>
        <SettingsRow label={t("record.commonVictimPovTitle")} description={t("settings.presetVictimDesc")}>
          <Switch ariaLabel={t("record.commonVictimPovTitle")} checked={presetPacing.default_victim_pov === true} disabled={batchRecording} onChange={checked => setPresetPacing({
          default_victim_pov: checked
        })} />
        </SettingsRow>
        <SettingsRow indent label={t("settings.presetReplayTiming")} disabled={presetPacing.default_victim_pov !== true}>
          <Segmented ariaLabel={t("settings.presetReplayTiming")} value={presetPacing.default_pov_interleaved === true} disabled={batchRecording || presetPacing.default_victim_pov !== true} onChange={value => setPresetPacing({
          default_pov_interleaved: value
        })} options={[{
          value: true,
          label: t("settings.presetReplayEach")
        }, {
          value: false,
          label: t("settings.presetReplayAfterAll")
        }]} />
        </SettingsRow>
        <SettingsRow indent label={t("settings.presetHoldLabel")} description={t("settings.presetHoldDesc")} disabled={presetPacing.default_victim_pov !== true}>
          <NumberInput ariaLabel={t("record.commonPovPreSlider")} min={0} max={5} step={0.1} unit={secondsUnit} value={victimPovPre} defaultValue={FB_VIC_PRE} disabled={batchRecording} onChange={n => commitPacingNumbers({
          victim_pov_pre_sec: n
        })} />
          <NumberInput ariaLabel={t("record.commonPovPostSlider")} min={0} max={5} step={0.1} unit={secondsUnit} value={victimPovPost} defaultValue={FB_VIC_POST} disabled={batchRecording} onChange={n => commitPacingNumbers({
          victim_pov_post_sec: n
        })} />
        </SettingsRow>
        <SettingsRow label={t("record.commonKillerPovTitle")} description={t("settings.presetKillerDesc")}>
          <Switch ariaLabel={t("record.commonKillerPovTitle")} checked={presetPacing.default_killer_pov === true} disabled={batchRecording} onChange={checked => setPresetPacing({
          default_killer_pov: checked
        })} />
        </SettingsRow>
        <SettingsRow indent label={t("settings.presetHoldLabel")} description={t("settings.presetHoldDesc")} disabled={presetPacing.default_killer_pov !== true}>
          <NumberInput ariaLabel={t("settings.presetKillerHoldBefore")} min={0} max={5} step={0.1} unit={secondsUnit} value={killerPovPre} defaultValue={FB_KILL_PRE} disabled={batchRecording} onChange={n => commitPacingNumbers({
          killer_pov_pre_sec: n
        })} />
          <NumberInput ariaLabel={t("settings.presetKillerHoldAfter")} min={0} max={5} step={0.1} unit={secondsUnit} value={killerPovPost} defaultValue={FB_KILL_POST} disabled={batchRecording} onChange={n => commitPacingNumbers({
          killer_pov_post_sec: n
        })} />
        </SettingsRow>
      </SettingsGroup>

      <RecordingSettingsSections visible={open || isPage || isEmbedded} batchRecording={batchRecording} saveDisabled={saveDisabled} warmupOpts={warmupOpts} patchWarmup={patchWarmup} warmupResolutionError={warmupResolutionError} povEnabled={povEnabled} setPovEnabled={setPovEnabled} skyboxId={skyboxId} setSkyboxId={setSkyboxId} mapMaterialId={mapMaterialId} setMapMaterialId={setMapMaterialId} weatherEffectId={weatherEffectId} setWeatherEffectId={setWeatherEffectId} obsTransEnabled={obsTransEnabled} setObsTransEnabled={setObsTransEnabled} obsTransName={obsTransName} setObsTransName={setObsTransName} obsTransDurationMs={obsTransDurationMs} setObsTransDurationMs={setObsTransDurationMs} localCs2ExtraLaunchArgs={localCs2ExtraLaunchArgs} setLocalCs2ExtraLaunchArgs={setLocalCs2ExtraLaunchArgs} localRecordInjectLines={localRecordInjectLines} setLocalRecordInjectLines={setLocalRecordInjectLines} />
    </div>;
  if (isEmbedded) return content;
  if (isPage) {
    return <div className="flex h-full min-h-0 w-full flex-col bg-cs2-bg-page">
        <div className="min-h-0 flex-1 overflow-y-auto" style={{
        scrollbarGutter: "stable"
      }}>
          <div className="max-w-[880px] px-4 pb-6 pt-6 sm:px-8 lg:px-10">{content}</div>
        </div>
        <div className="shrink-0 px-4 pb-4 sm:px-8 lg:px-10">
          <div className="flex max-w-[880px] flex-wrap items-center justify-between gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-elevated py-2 pl-4 pr-2">
            <p className="text-xs text-cs2-text-muted">
              {saveError ? <span className="text-cs2-rose-on-surface">{saveError}</span> : pendingChanges > 0 ? t("settings.unsavedCount", {
              n: pendingChanges
            }) : t("record.commonSaveFooterDesc")}
            </p>
            {saveButton}
          </div>
        </div>
      </div>;
  }
  return <div className="fixed inset-0 z-[95] flex items-center justify-center bg-cs2-bg-overlay px-3 py-6 backdrop-blur-sm sm:px-4" role="dialog" aria-modal="true" aria-labelledby="common-params-title" onClick={e => {
    if (e.target === e.currentTarget) onClose();
  }}>
      <div className="flex max-h-[min(94vh,900px)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-cs2-border px-4 py-4 sm:px-5">
          <h2 id="common-params-title" className="text-base font-bold text-cs2-text-primary">
            {t("record.commonTitle")}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {saveButton}
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-input hover:text-cs2-text-secondary" aria-label={t("record.commonArClose")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-cs2-bg-page px-4 py-5 sm:px-6">{content}</div>
        <div className="shrink-0 border-t border-cs2-border px-4 py-3 sm:px-5">
          <SettingsButton variant="primary" onClick={onClose}>
            {saveState === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {t("record.commonDone")}
          </SettingsButton>
        </div>
      </div>
    </div>;
}
