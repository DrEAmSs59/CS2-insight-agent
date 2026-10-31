import { useMemo } from "react";
import { useT } from "../i18n/useT.js";
import { SelectInput, SettingsRow } from "../pages/settings/SettingsControls.jsx";
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

/** Compact skybox setting used by the recording preset and session rows. */
export default function RecordingSkyboxControl({
  recordingSkybox = "default",
  onRecordingSkyboxChange,
  checkboxDisabled = false,
  rainSelected = false,
  resources = [],
  resourcesError = "",
}) {
  const t = useT();
  const catalogBuiltinSkyboxOptions = useMemo(
    () => sortBuiltinRecordingSkyboxes(
      resources.filter((item) => item.source === "builtin" && item.available),
    ),
    [resources],
  );
  const builtinSkyboxOptions = catalogBuiltinSkyboxOptions.length
    ? catalogBuiltinSkyboxOptions
    : RECORDING_SKYBOX_OPTIONS.slice(1).map((option) => ({ id: option.value }));
  const { solidColor, standard } = partitionBuiltinRecordingSkyboxes(builtinSkyboxOptions);
  const customSkyboxOptions = useMemo(
    () => resources.filter((item) => item.source === "custom" && item.available),
    [resources],
  );
  const effectiveSkyboxId = normalizeRecordingSkyboxId(recordingSkybox);
  const selectedCustomSkyboxAvailable = customSkyboxOptions.some(
    (item) => item.id === effectiveSkyboxId,
  );
  const selectedSkyboxPreview = recordingSkyboxPreviewUrl(effectiveSkyboxId, resources);
  const selectedSkyboxName = recordingSkyboxDisplayName(
    effectiveSkyboxId,
    resources.find((item) => item.id === effectiveSkyboxId)?.display_name,
    t,
  );
  const custom = effectiveSkyboxId !== DEFAULT_RECORDING_SKYBOX;

  return (
    <SettingsRow
      testId="experimental-skybox-card"
      label={t("record.skyboxTitle")}
      description={t(rainSelected ? "record.skyboxRainSelectable" : "settings.presetSkyboxDesc")}
      tooltip={t("record.skyboxSubtitle")}
      footer={selectedSkyboxPreview || resourcesError || custom ? (
        <div className="space-y-2">
          {selectedSkyboxPreview ? (
            <img
              data-testid="recording-skybox-preview"
              src={selectedSkyboxPreview}
              alt={t("settings.skyboxPreviewAlt", { name: selectedSkyboxName })}
              className="aspect-[2/1] w-full max-w-md rounded-md border border-cs2-border-subtle object-cover"
            />
          ) : null}
          {resourcesError ? (
            <p className="text-xs text-cs2-amber-on-surface">{t("record.skyboxCatalogUnavailable")}</p>
          ) : null}
          {custom ? (
            <p className="text-xs text-cs2-text-muted" title={t("record.skyboxOutcome")}>{t("record.skyboxSupportedMaps")}</p>
          ) : null}
        </div>
      ) : null}
    >
      <SelectInput
        ariaLabel={t("record.skyboxSelectLabel")}
        value={effectiveSkyboxId}
        disabled={checkboxDisabled}
        onChange={onRecordingSkyboxChange}
      >
        <option value={DEFAULT_RECORDING_SKYBOX}>
          {t(rainSelected ? "record.skyboxRainDefault" : "record.skyboxDefault")}
        </option>
        <optgroup label={t("record.skyboxSolidColorOptions")}>
          {solidColor.map((item) => (
            <option key={item.id} value={item.id}>
              {recordingSkyboxDisplayName(item.id, item.display_name, t)}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("record.skyboxBuiltinOptions")}>
          {standard.map((item) => (
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
          <option value={effectiveSkyboxId} disabled>{t("record.skyboxMissingCustom")}</option>
        ) : null}
      </SelectInput>
    </SettingsRow>
  );
}
