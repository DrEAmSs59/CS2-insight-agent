import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../api/api";
import { useSkyboxResources } from "../api/skyboxResources";
import { useT } from "../i18n/useT.js";
import {
  DEFAULT_RECORDING_SKYBOX,
  normalizeRecordingSkyboxId,
  isCustomRecordingSkyboxId,
  partitionBuiltinRecordingSkyboxes,
  recordingSkyboxDisplayName,
  recordingSkyboxPreviewUrl,
  RECORDING_SKYBOX_OPTIONS,
  sortBuiltinRecordingSkyboxes,
} from "../utils/recordingSkybox.js";
import { normalizePovVoiceMode, POV_VOICE_MODES } from "../utils/povVoiceMode.js";
import {
  DEFAULT_RECORDING_MAP_MATERIAL,
  normalizeRecordingMapMaterialId,
  WAXED_REFLECTION_MAP_MATERIAL,
} from "../utils/recordingMapMaterial.js";
import {
  DEFAULT_RECORDING_WEATHER_EFFECT,
  normalizeRecordingWeatherEffectId,
  RAIN_RECORDING_WEATHER_EFFECT,
} from "../utils/recordingWeatherEffect.js";

/**
 * 实验性 POV：与常用参数 / 录制前观战弹窗共用；勾选写入 experimental.pov_enabled。
 * POV、语音、昵称、键鼠、地图材质和天空盒在同一区域中独立配置。
 */
export default function ExperimentalPovSection({
  visible,
  experimentalPovEnabled,
  onExperimentalPovChange,
  checkboxDisabled = false,
  povTeamcounterNumeric = false,
  onPovTeamcounterNumericChange,
  povVoiceMode = "team",
  onPovVoiceModeChange,
  inputHudEnabled = true,
  onInputHudEnabledChange,
  onInputHudDisplayModeChange,
  recordingSkybox = "default",
  onRecordingSkyboxChange,
  recordingMapMaterial = DEFAULT_RECORDING_MAP_MATERIAL,
  onRecordingMapMaterialChange,
  recordingWeatherEffect = DEFAULT_RECORDING_WEATHER_EFFECT,
  onRecordingWeatherEffectChange,
  contentAfterVoice = null,
  omitEyebrow = false,
  omitDisclaimer = false,
  embedded = false,
  className,
}) {
  const t = useT();
  const [povStatus, setPovStatus] = useState(null);
  const [povStatusLoading, setPovStatusLoading] = useState(false);
  const [povStatusError, setPovStatusError] = useState("");
  const [povRestoreBusy, setPovRestoreBusy] = useState(false);
  const [povRestoreResult, setPovRestoreResult] = useState(null);
  const {
    items: skyboxResources,
    error: skyboxResourcesError,
  } = useSkyboxResources(Boolean(visible && onRecordingSkyboxChange));
  const catalogBuiltinSkyboxOptions = useMemo(
    () => sortBuiltinRecordingSkyboxes(
      skyboxResources.filter((item) => item.source === "builtin" && item.available),
    ),
    [skyboxResources],
  );
  const builtinSkyboxOptions = catalogBuiltinSkyboxOptions.length
    ? catalogBuiltinSkyboxOptions
    : RECORDING_SKYBOX_OPTIONS.slice(1).map((option) => ({ id: option.value }));
  const {
    solidColor: solidColorSkyboxOptions,
    standard: standardBuiltinSkyboxOptions,
  } = partitionBuiltinRecordingSkyboxes(builtinSkyboxOptions);
  const customSkyboxOptions = useMemo(
    () => skyboxResources.filter((item) => item.source === "custom" && item.available),
    [skyboxResources],
  );
  const selectedSkyboxId = normalizeRecordingSkyboxId(recordingSkybox);
  const selectedMapMaterial = normalizeRecordingMapMaterialId(recordingMapMaterial);
  const selectedWeatherEffect = normalizeRecordingWeatherEffectId(recordingWeatherEffect);
  const inputHudSelection = inputHudEnabled ? "visible" : "hidden";
  const rainSelected = selectedWeatherEffect === RAIN_RECORDING_WEATHER_EFFECT;
  const effectiveSkyboxId = selectedSkyboxId;
  const selectedCustomSkyboxAvailable = customSkyboxOptions.some(
    (item) => item.id === effectiveSkyboxId,
  );
  const selectedSkyboxPreview = recordingSkyboxPreviewUrl(effectiveSkyboxId, skyboxResources);

  const loadPovStatus = useCallback(async () => {
    setPovStatusLoading(true);
    setPovStatusError("");
    try {
      const { data } = await API.get("experimental/pov/status");
      setPovStatus(data && typeof data === "object" ? data : null);
    } catch (error) {
      setPovStatus(null);
      setPovStatusError(
        error?.response?.data?.detail || error?.message || t("pov.statusError"),
      );
    } finally {
      setPovStatusLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!visible) return;
    setPovRestoreResult(null);
    void loadPovStatus();
  }, [visible, experimentalPovEnabled, loadPovStatus]);

  const povNeedsRestore = Boolean(povStatus?.needs_restore);
  const restoreState = String(povStatus?.state || "managed").toLowerCase();
  const restoreNeededKey = restoreState === "orphaned"
    ? "pov.restoreOrphaned"
    : restoreState === "corrupted"
      ? "pov.restoreCorrupted"
      : "pov.restoreManaged";

  const rootClass = className ?? "min-w-0";

  return (
    <div className={rootClass}>
      <section
        className={embedded ? "min-w-0" : "min-w-0 rounded-lg border border-amber-500/25 bg-cs2-amber-surface p-3"}
        data-testid="experimental-feature-card"
      >
      {!omitEyebrow ? (
        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-cs2-amber-on-surface">{t("pov.eyebrowLabel")}</p>
      ) : null}
      <div data-testid="experimental-pov-card">
      <label className="flex cursor-pointer items-start gap-2 py-1">
        <input
          type="checkbox"
          disabled={checkboxDisabled || !onExperimentalPovChange}
          checked={!!experimentalPovEnabled}
          onChange={(e) => onExperimentalPovChange?.(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
        />
        <span className="min-w-0 text-[12px] leading-snug text-cs2-text-primary">
          <span className="font-semibold text-cs2-amber-on-surface/95">{t("pov.checkboxTitle")}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cs2-text-muted">
            {t("pov.checkboxDescMain")}<br />{t("pov.checkboxDescNote")}
          </span>
        </span>
      </label>
      {experimentalPovEnabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">
          {t("pov.enabledNote")}
        </p>
      ) : null}

      {experimentalPovEnabled && onPovTeamcounterNumericChange ? (
        <div className="mt-3 rounded-lg border border-cs2-border bg-cs2-bg-elevated px-3 py-2.5">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-card px-2 py-2">
            <input
              type="checkbox"
              checked={!!povTeamcounterNumeric}
              onChange={(e) => onPovTeamcounterNumericChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
            />
            <span className="min-w-0 text-[11px] leading-snug text-cs2-text-secondary">
              <span className="font-semibold text-cs2-text-primary">{t("pov.teamcounterTitle")}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-cs2-text-muted">
                <code className="text-cs2-accent/90">cl_teamcounter_playercount_instead_of_avatars</code>
                {t("pov.teamcounterHintPre")}<strong className="text-cs2-text-secondary">{t("pov.teamcounterStrongOn")}</strong>{t("pov.teamcounterHintMid")}<strong className="text-cs2-text-secondary">{t("pov.teamcounterStrongOff")}</strong>{t("pov.teamcounterHintPost")}
              </span>
            </span>
          </label>
        </div>
      ) : null}

      {!omitDisclaimer ? (
        <div
          className="mt-2 rounded border border-cs2-border bg-cs2-bg-card px-2.5 py-2 text-[11px] leading-relaxed text-cs2-text-muted"
          data-testid="experimental-pov-disclaimer"
        >
          {t("pov.disclaimer")}
        </div>
      ) : null}

      {povStatusError && !povStatusLoading ? (
        <div className="mt-3 rounded border border-amber-500/35 bg-cs2-amber-surface px-2.5 py-2 text-[11px] text-cs2-amber-on-surface">
          <p>{t("pov.statusError")}</p>
          <p className="mt-1 break-all text-[10px] opacity-85">{povStatusError}</p>
          <button
            type="button"
            onClick={() => void loadPovStatus()}
            className="mt-2 rounded border border-amber-400/40 px-2 py-1 text-[11px] font-semibold hover:bg-cs2-amber-surface"
          >
            {t("pov.statusRetryBtn")}
          </button>
        </div>
      ) : null}

      {povNeedsRestore && !povStatusLoading ? (
        <div className="mt-3 rounded border border-rose-500/35 bg-cs2-rose-surface px-2.5 py-2 text-[11px] text-cs2-rose-on-surface">
          <p className="font-semibold">{t(restoreNeededKey)}</p>
          <p className="mt-1 text-[10px] opacity-85">
            {povStatus?.cs2_running ? t("pov.restoreCloseCs2") : t("pov.restoreReady")}
          </p>
          {povRestoreResult?.tone === "error" ? (
            <p className="mt-2 break-all rounded border border-rose-400/30 bg-cs2-rose-surface px-2 py-1.5 text-[10px]">
              {t("pov.restoreFailed", { msg: povRestoreResult.message })}
            </p>
          ) : null}
          <button
            type="button"
            disabled={povRestoreBusy}
            onClick={async () => {
              setPovRestoreBusy(true);
              setPovRestoreResult(null);
              try {
                const { data } = await API.post("experimental/pov/restore");
                const restore = data?.restore && typeof data.restore === "object"
                  ? data.restore
                  : {};
                if (data?.ok !== true || restore.verified !== true) {
                  throw new Error(restore.error || t("pov.restoreUnverified"));
                }
                const mode = String(restore.verification_mode || "none").toLowerCase();
                const messageKey = mode === "strict"
                  ? "pov.restoreStrictSuccess"
                  : mode === "semantic"
                    ? "pov.restoreSemanticSuccess"
                    : "pov.restoreNoneSuccess";
                setPovRestoreResult({ tone: "success", messageKey });
                setPovStatus((current) => ({
                  ...(current || {}),
                  state: "clean",
                  needs_restore: false,
                  installed: false,
                  gameinfo_patched: false,
                  manifest_exists: false,
                  backup_exists: false,
                }));
              } catch (error) {
                setPovRestoreResult({
                  tone: "error",
                  message: error?.response?.data?.detail || error?.message || t("common.requestFail"),
                });
              } finally {
                setPovRestoreBusy(false);
              }
            }}
            className="mt-2 rounded border border-rose-400/40 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-cs2-rose-surface disabled:opacity-40"
          >
            {povRestoreBusy ? t("pov.restoringBtn") : t("pov.restoreBtn")}
          </button>
        </div>
      ) : null}

      {!povNeedsRestore && povRestoreResult?.tone === "success" ? (
        <div className="mt-3 rounded border border-emerald-500/35 bg-cs2-emerald-surface px-2.5 py-2 text-[11px] text-cs2-emerald-on-surface">
          {t(povRestoreResult.messageKey)}
        </div>
      ) : null}
      </div>

      {onPovVoiceModeChange ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-voice-card"
        >
          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="mb-1 block font-semibold text-cs2-text-primary">{t("pov.voiceModeLabel")}</span>
            <select
              aria-label={t("pov.voiceModeLabel")}
              value={normalizePovVoiceMode(povVoiceMode)}
              disabled={checkboxDisabled}
              onChange={(event) => onPovVoiceModeChange(event.target.value)}
              className="mt-1 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50 disabled:opacity-40"
            >
              {POV_VOICE_MODES.map((mode) => (
                <option key={mode} value={mode}>{t(`pov.voiceMode.${mode}`)}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              {t("pov.voiceModeHint")}
            </span>
          </label>
        </div>
      ) : null}

      {contentAfterVoice ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-after-voice-content"
        >
          {contentAfterVoice}
        </div>
      ) : null}

      {onInputHudEnabledChange && onInputHudDisplayModeChange ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-input-hud-card"
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-cs2-text-primary">
                {t("record.warmupInputHudTitle")}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">
                {t("record.warmupInputHudDesc")}
              </p>
            </div>
            <select
              aria-label={t("record.warmupInputHudDisplayMode")}
              value={inputHudSelection}
              disabled={checkboxDisabled}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "hidden") {
                  onInputHudEnabledChange(false);
                  return;
                }
                onInputHudEnabledChange(true);
                onInputHudDisplayModeChange("hybrid");
              }}
              className="min-w-44 max-w-[48%] rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs font-semibold text-cs2-text-primary outline-none focus:border-cs2-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <option value="visible">{t("record.warmupInputHudShow")}</option>
              <option value="hidden">{t("record.warmupInputHudHide")}</option>
            </select>
          </div>
          {/* Virtual key sounds stay supported by the VPK but are temporarily hidden. */}
        </div>
      ) : null}

      {onRecordingMapMaterialChange ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-map-material-card"
        >
          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="block font-semibold text-cs2-text-primary">
              {t("record.mapMaterialTitle")}
            </span>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              {t("record.mapMaterialSubtitle")}
            </span>
            <select
              aria-label={t("record.mapMaterialSelectLabel")}
              value={selectedMapMaterial}
              disabled={checkboxDisabled || rainSelected}
              onChange={(event) => {
                const nextMaterial = normalizeRecordingMapMaterialId(event.target.value);
                onRecordingMapMaterialChange(nextMaterial);
              }}
              className="mt-2 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50 disabled:opacity-40"
            >
              <option value={DEFAULT_RECORDING_MAP_MATERIAL}>
                {t("record.mapMaterialDefault")}
              </option>
              <option value={WAXED_REFLECTION_MAP_MATERIAL}>
                {t("record.mapMaterialWaxedReflection")}
              </option>
            </select>
          </label>
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">
            {t("record.mapMaterialSupportedMaps")}
          </p>
          {selectedMapMaterial !== DEFAULT_RECORDING_MAP_MATERIAL ? (
            <p className="mt-2 text-[10px] leading-relaxed text-cs2-amber-on-surface">
              {t("record.mapMaterialOutcome")}
            </p>
          ) : null}
        </div>
      ) : null}

      {onRecordingWeatherEffectChange ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-weather-effect-card"
        >
          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="block font-semibold text-cs2-text-primary">
              {t("record.weatherEffectTitle")}
            </span>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              {t("record.weatherEffectSubtitle")}
            </span>
            <select
              aria-label={t("record.weatherEffectSelectLabel")}
              value={selectedWeatherEffect}
              disabled={checkboxDisabled || selectedMapMaterial !== DEFAULT_RECORDING_MAP_MATERIAL}
              onChange={(event) => {
                const nextWeather = normalizeRecordingWeatherEffectId(event.target.value);
                onRecordingWeatherEffectChange(nextWeather);
              }}
              className="mt-2 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50 disabled:opacity-40"
            >
              <option value={DEFAULT_RECORDING_WEATHER_EFFECT}>
                {t("record.weatherEffectDefault")}
              </option>
              <option value={RAIN_RECORDING_WEATHER_EFFECT}>
                {t("record.weatherEffectRain")}
              </option>
            </select>
          </label>
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">
            {t("record.weatherEffectRainSupportedMaps")}
          </p>
          {rainSelected ? (
            <p className="mt-2 text-[10px] leading-relaxed text-cs2-amber-on-surface">
              {t("record.weatherEffectRainOutcome")}
            </p>
          ) : null}
        </div>
      ) : null}

      {onRecordingSkyboxChange ? (
        <div
          className="mt-4 border-t border-amber-500/20 pt-4"
          data-testid="experimental-skybox-card"
        >
          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="block font-semibold text-cs2-text-primary">
              {t("record.skyboxTitle")}
            </span>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              {t(rainSelected ? "record.skyboxRainSelectable" : "record.skyboxSubtitle")}
            </span>
            <select
              aria-label={t("record.skyboxSelectLabel")}
              value={effectiveSkyboxId}
              disabled={checkboxDisabled}
              onChange={(event) => onRecordingSkyboxChange(event.target.value)}
              className="mt-2 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50 disabled:opacity-40"
            >
              <option value={DEFAULT_RECORDING_SKYBOX}>
                {t(rainSelected ? "record.skyboxRainDefault" : "record.skyboxDefault")}
              </option>
              <optgroup label={t("record.skyboxSolidColorOptions")}>
                {solidColorSkyboxOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {recordingSkyboxDisplayName(item.id, item.display_name, t)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("record.skyboxBuiltinOptions")}>
                {standardBuiltinSkyboxOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {recordingSkyboxDisplayName(item.id, item.display_name, t)}
                  </option>
                ))}
              </optgroup>
              {customSkyboxOptions.length ? (
                <optgroup label={t("record.skyboxCustomOptions")}>
                  {customSkyboxOptions.map((item) => (
                    <option key={item.id} value={item.id}>{item.display_name}</option>
                  ))}
                </optgroup>
              ) : null}
              {isCustomRecordingSkyboxId(effectiveSkyboxId) && !selectedCustomSkyboxAvailable ? (
                <option value={effectiveSkyboxId} disabled>
                  {t("record.skyboxMissingCustom")}
                </option>
              ) : null}
            </select>
            {selectedSkyboxPreview ? (
              <img
                data-testid="recording-skybox-preview"
                src={selectedSkyboxPreview}
                alt={t("settings.skyboxPreviewAlt", {
                  name: recordingSkyboxDisplayName(
                    effectiveSkyboxId,
                    skyboxResources.find((item) => item.id === effectiveSkyboxId)?.display_name,
                    t,
                  ),
                })}
                className="mt-2 aspect-[2/1] w-full rounded-md border border-cs2-border object-cover"
              />
            ) : null}
          </label>
          {skyboxResourcesError ? (
            <p className="mt-2 text-[10px] leading-relaxed text-amber-300">
              {t("record.skyboxCatalogUnavailable")}
            </p>
          ) : null}
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">
            {t("record.skyboxSupportedMaps")}
          </p>
          {effectiveSkyboxId !== DEFAULT_RECORDING_SKYBOX ? (
            <p className="mt-2 text-[10px] leading-relaxed text-cs2-amber-on-surface">
              {t("record.skyboxOutcome")}
            </p>
          ) : null}
        </div>
      ) : null}
      </section>
    </div>
  );
}
