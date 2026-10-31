import { useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  Segmented, SelectInput, SettingsButton, SettingsNote, SettingsRow, SettingsSubhead, Switch,
} from "../pages/settings/SettingsControls.jsx";
import RecordingSkyboxControl from "./RecordingSkyboxControl.jsx";
import { normalizePovVoiceMode, POV_VOICE_MODES } from "../utils/povVoiceMode.js";
import { INPUT_HUD_PLACEMENTS, inputHudStateFromPlacement } from "../utils/inputHudPlacement.js";
import {
  DEFAULT_RECORDING_MAP_APPEARANCE,
  RAIN_RECORDING_MAP_APPEARANCE,
  WAXED_RECORDING_MAP_APPEARANCE,
  applyRecordingMapAppearanceSelection,
} from "../utils/recordingMapAppearance.js";

/** Pro's row presentation, restricted to existing Free controls. */
export default function ExperimentalPovRows({
  t,
  experimentalPovEnabled,
  onExperimentalPovChange,
  checkboxDisabled,
  povTeamcounterNumeric,
  onPovTeamcounterNumericChange,
  povVoiceMode,
  onPovVoiceModeChange,
  inputHudSelection,
  onInputHudEnabledChange,
  onInputHudDisplayModeChange,
  onInputHudPositionChange,
  canChangeMapAppearance,
  selectedMapAppearance,
  waxedSelected,
  rainSelected,
  onRecordingMapMaterialChange,
  onRecordingWeatherEffectChange,
  recordingSkybox,
  skyboxResources,
  skyboxResourcesError,
  onRecordingSkyboxChange,
  contentAfterVoice,
  povStatusError,
  povStatusLoading,
  loadPovStatus,
  povNeedsRestore,
  povStatus,
  restoreNeededKey,
  povRestoreResult,
  povRestoreBusy,
  restorePov,
}) {
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const povOn = !!experimentalPovEnabled;
  const mapAppearanceFooter = waxedSelected ? (
    <p className="text-xs text-cs2-text-muted" title={t("record.mapMaterialOutcome")}>
      {t("record.mapMaterialSupportedMaps")} {t("settings.presetWaxedTip")}
    </p>
  ) : rainSelected ? (
    <p className="text-xs text-cs2-text-muted" title={t("record.weatherEffectRainOutcome")}>
      {t("record.weatherEffectRainSupportedMaps")}
    </p>
  ) : null;

  return (
    <>
      <SettingsRow
        testId="experimental-pov-card"
        label={t("pov.checkboxTitle")}
        description={t("settings.presetPovDesc")}
        tooltip={t("pov.checkboxDescMain")}
      >
        <Switch
          checked={povOn}
          onChange={onExperimentalPovChange}
          disabled={checkboxDisabled || !onExperimentalPovChange}
          ariaLabel={t("pov.checkboxTitle")}
        />
      </SettingsRow>
      <SettingsNote tone="amber" icon={AlertTriangle} testId="experimental-pov-note">
        <p>
          {t("settings.presetPovNote")}{" "}
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            aria-expanded={disclaimerOpen}
            onClick={() => setDisclaimerOpen((open) => !open)}
          >
            {t(disclaimerOpen ? "settings.hideDetails" : "settings.showDetails")}
          </button>
        </p>
        {disclaimerOpen ? <p className="mt-1.5 text-cs2-text-secondary">{t("pov.disclaimer")}</p> : null}
      </SettingsNote>

      {povStatusError && !povStatusLoading ? (
        <SettingsNote tone="amber" icon={AlertTriangle}>
          <p>{t("pov.statusError")}</p>
          <p className="mt-1 break-all opacity-85">{povStatusError}</p>
          <SettingsButton className="mt-2" onClick={() => void loadPovStatus()}>{t("pov.statusRetryBtn")}</SettingsButton>
        </SettingsNote>
      ) : null}

      {povNeedsRestore && !povStatusLoading ? (
        <SettingsNote tone="rose" icon={XCircle}>
          <p className="font-semibold">{t(restoreNeededKey)}</p>
          <p className="mt-1 opacity-85">{povStatus?.cs2_running ? t("pov.restoreCloseCs2") : t("pov.restoreReady")}</p>
          {povRestoreResult?.tone === "error" ? (
            <p className="mt-1 break-all">{t("pov.restoreFailed", { msg: povRestoreResult.message })}</p>
          ) : null}
          <SettingsButton className="mt-2" disabled={povRestoreBusy} busy={povRestoreBusy} onClick={() => void restorePov()}>
            {povRestoreBusy ? t("pov.restoringBtn") : t("pov.restoreBtn")}
          </SettingsButton>
        </SettingsNote>
      ) : null}

      {!povNeedsRestore && povRestoreResult?.tone === "success" ? (
        <SettingsNote tone="emerald" icon={CheckCircle2}>{t(povRestoreResult.messageKey)}</SettingsNote>
      ) : null}

      {povOn && onPovTeamcounterNumericChange ? (
        <SettingsRow indent label={t("settings.presetTeamcounterLabel")} tooltip="cl_teamcounter_playercount_instead_of_avatars">
          <Segmented
            ariaLabel={t("pov.teamcounterTitle")}
            value={!!povTeamcounterNumeric}
            disabled={checkboxDisabled}
            onChange={onPovTeamcounterNumericChange}
            options={[
              { value: false, label: t("pov.teamcounterStrongOff") },
              { value: true, label: t("pov.teamcounterStrongOn") },
            ]}
          />
        </SettingsRow>
      ) : null}

      {onPovVoiceModeChange ? (
        <SettingsRow
          testId="experimental-voice-card"
          label={t("pov.voiceModeLabel")}
          description={t("settings.presetVoiceDesc")}
          tooltip={t("pov.voiceModeHint")}
        >
          <Segmented
            ariaLabel={t("pov.voiceModeLabel")}
            value={normalizePovVoiceMode(povVoiceMode)}
            disabled={checkboxDisabled}
            onChange={onPovVoiceModeChange}
            options={POV_VOICE_MODES.map((mode) => ({ value: mode, label: t(`pov.voiceMode.${mode}`) }))}
          />
        </SettingsRow>
      ) : null}

      {contentAfterVoice ? <div className="px-4 py-3" data-testid="experimental-after-voice-content">{contentAfterVoice}</div> : null}

      {onInputHudEnabledChange && onInputHudDisplayModeChange && onInputHudPositionChange ? (
        <SettingsRow
          testId="experimental-input-hud-card"
          label={t("settings.presetInputHudLabel")}
          description={t("settings.presetInputHudDesc")}
        >
          <SelectInput
            ariaLabel={t("record.warmupInputHudDisplayMode")}
            value={inputHudSelection}
            disabled={checkboxDisabled}
            onChange={(value) => {
              if (value === "hidden") {
                onInputHudEnabledChange(false);
                return;
              }
              const next = inputHudStateFromPlacement(value);
              onInputHudEnabledChange(true);
              onInputHudPositionChange(next.position);
              onInputHudDisplayModeChange("hybrid");
            }}
            options={INPUT_HUD_PLACEMENTS.map((placement) => ({
              value: placement,
              label: t(`record.warmupInputHudPlacement.${placement}`),
            }))}
          />
        </SettingsRow>
      ) : null}

      {canChangeMapAppearance || onRecordingSkyboxChange ? (
        <SettingsSubhead>{t("settings.presetSceneEffects")}</SettingsSubhead>
      ) : null}

      {canChangeMapAppearance ? (
        <SettingsRow
          testId="experimental-map-material-card"
          label={t("record.mapMaterialTitle")}
          description={t("settings.presetMapMaterialDesc")}
          tooltip={t("record.mapMaterialSubtitle")}
          footer={mapAppearanceFooter}
        >
          <SelectInput
            ariaLabel={t("record.mapMaterialSelectLabel")}
            value={selectedMapAppearance}
            disabled={checkboxDisabled}
            onChange={(value) => applyRecordingMapAppearanceSelection(value, {
              onRecordingMapMaterialChange,
              onRecordingWeatherEffectChange,
              onRecordingSkyboxChange,
            })}
            options={[
              { value: DEFAULT_RECORDING_MAP_APPEARANCE, label: t("record.mapMaterialDefault") },
              { value: WAXED_RECORDING_MAP_APPEARANCE, label: t("record.mapMaterialWaxedReflection") },
              { value: RAIN_RECORDING_MAP_APPEARANCE, label: t("record.weatherEffectRain") },
            ]}
          />
        </SettingsRow>
      ) : null}

      {onRecordingSkyboxChange ? (
        <RecordingSkyboxControl
          recordingSkybox={recordingSkybox}
          resources={skyboxResources}
          resourcesError={skyboxResourcesError}
          onRecordingSkyboxChange={onRecordingSkyboxChange}
          checkboxDisabled={checkboxDisabled}
          rainSelected={rainSelected}
        />
      ) : null}
    </>
  );
}
