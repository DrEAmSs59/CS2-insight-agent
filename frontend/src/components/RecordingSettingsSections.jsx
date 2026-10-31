import { useT } from "../i18n/useT.js";
import { aspectHint, SPECTATOR_FLASHBANG_OPACITY_DEFAULT } from "../utils/warmupDefaults";
import { RECORD_WARMUP_DEFAULT_OPTIONS } from "./recordingQueue/recordingWarmupDefaults.js";
import { RECORDING_PRESET_SECTIONS } from "../pages/settings/recordingPresetSections.js";
import { NumberInput, Segmented, SettingsBadge, SettingsGroup, SettingsRow, SettingsSubhead, Switch, TextInput } from "../pages/settings/SettingsControls.jsx";
import ExperimentalPovSection from "./ExperimentalPovSection";
import Cs2LaunchConsoleFields from "./Cs2LaunchConsoleFields";
const SECTION_TITLES = Object.fromEntries(RECORDING_PRESET_SECTIONS.map(section => [section.id, section.labelKey]));
const AR_OPTIONS = [{
  ar: "4:3",
  sample: "1920×1440",
  tagKey: "record.arTag43"
}, {
  ar: "16:9",
  sample: "1920×1080",
  tagKey: "record.arTag169"
}, {
  ar: "16:10",
  sample: "1920×1200",
  tagKey: "record.arTag1610"
}];
const HUD_ROWS = [{
  key: "cl_draw_only_deathnotices",
  titleKey: "record.hudSimplifyTitle",
  descKey: "record.hudSimplifyDesc",
  code: "cl_draw_only_deathnotices true",
  povLock: true
}, {
  key: "hud_showtargetid_hide",
  titleKey: "record.hudHideTargetTitle",
  descKey: "record.hudHideTargetDesc",
  code: "hud_showtargetid 0"
}, {
  key: "hide_clan_tags",
  titleKey: "record.hudHideClanTagsTitle",
  descKey: "record.hudHideClanTagsDesc",
  code: "cl_show_clan_in_death_notice 0"
}, {
  key: "persistent_killfeed",
  titleKey: "record.hudPersistentKillfeedTitle",
  descKey: "settings.presetKillfeedDesc",
  tooltipKey: "record.hudPersistentKillfeedDesc"
}, {
  key: "tv_nochat",
  titleKey: "record.hudNoChatTitle",
  descKey: "record.hudNoChatDesc",
  code: "tv_nochat 1"
}, {
  key: "hide_grenade_trajectory_pip",
  titleKey: "record.hudHideGrenadeTitle",
  descKey: "record.hudHideGrenadeDesc",
  code: "sv_grenade_trajectory 0; …"
}];

/** Shared rows for recording presets and the per-recording settings dialog. */
export default function RecordingSettingsSections({
  idPrefix = "rp",
  visible = true,
  batchRecording = false,
  saveDisabled = false,
  warmupOpts,
  patchWarmup,
  warmupResolutionError,
  povEnabled,
  setPovEnabled,
  skyboxId,
  setSkyboxId,
  mapMaterialId,
  setMapMaterialId,
  weatherEffectId,
  setWeatherEffectId,
  obsTransEnabled,
  setObsTransEnabled,
  obsTransName,
  setObsTransName,
  obsTransDurationMs,
  setObsTransDurationMs,
  obsTransitionDefaultDuration = 100,
  localCs2ExtraLaunchArgs,
  setLocalCs2ExtraLaunchArgs,
  localRecordInjectLines,
  setLocalRecordInjectLines,
  experimentalContent = null
}) {
  const t = useT();
  const flashChecked = povEnabled || warmupOpts.apply_spectator_flashbang_opacity;
  const presetGroupProps = id => ({
    id: id.replace("rp-", `${idPrefix}-`),
    title: t(SECTION_TITLES[id])
  });
  return <>
      <SettingsGroup {...presetGroupProps("rp-camera", t)} badge={null}>
        <SettingsRow label={t("settings.presetFovLabel")} description={t("settings.presetFovDesc")} tooltip={"fov_cs_debug"}>
          <NumberInput ariaLabel={t("settings.presetFovValue")} min={60} max={120} step={1} unit={t("settings.presetFovDefault")} value={warmupOpts.fov_cs_debug} defaultValue={RECORD_WARMUP_DEFAULT_OPTIONS.fov_cs_debug} disabled={!warmupOpts.apply_fov} onChange={n => {
          if (n === "") return;
          patchWarmup({
            fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, Math.round(n)))
          });
        }} />
          <Switch ariaLabel={t("record.warmupFovLabel")} checked={!!warmupOpts.apply_fov} onChange={checked => patchWarmup({
          apply_fov: checked
        })} />
        </SettingsRow>
        {<SettingsRow label={t("record.warmupViewmodelTitle")} description={t("settings.presetViewmodelDesc")} tooltip="viewmodel_fov 68">
            <Switch ariaLabel={t("record.warmupViewmodelTitle")} checked={!!warmupOpts.viewmodel_fov_68} onChange={checked => patchWarmup({
          viewmodel_fov_68: checked
        })} />
          </SettingsRow>}
        <SettingsRow label={t("record.commonThirdPersonTitle")} description={t("settings.presetThirdPersonDesc")} tooltip="cam_command 1; cam_idealdist 30; c_thirdpersonshoulder 1">
          <Switch ariaLabel={t("record.commonThirdPersonTitle")} checked={!!warmupOpts.third_person_camera} onChange={checked => patchWarmup({
          third_person_camera: checked
        })} />
        </SettingsRow>
        <SettingsRow label={t("settings.presetFlashLabel")} description={t(povEnabled ? "settings.presetFlashPovDesc" : "settings.presetFlashDesc")} tooltip="r_spectator_flashbang_opacity">
          <NumberInput ariaLabel={t("settings.presetFlashValue")} min={0.2} max={1} step={0.1} unit={t("record.commonFlashRange")} value={povEnabled ? 1 : warmupOpts.spectator_flashbang_opacity} defaultValue={SPECTATOR_FLASHBANG_OPACITY_DEFAULT} disabled={povEnabled || batchRecording || !warmupOpts.apply_spectator_flashbang_opacity} onChange={n => {
          if (n === "") return;
          patchWarmup({
            spectator_flashbang_opacity: Number.isNaN(n) ? SPECTATOR_FLASHBANG_OPACITY_DEFAULT : Math.min(1, Math.max(0.2, n))
          });
        }} />
          <Switch ariaLabel={t("record.warmupFlashLabel")} checked={flashChecked} disabled={povEnabled || batchRecording} onChange={checked => patchWarmup({
          apply_spectator_flashbang_opacity: checked
        })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup {...presetGroupProps("rp-experimental", t)} badge={<SettingsBadge tone="amber">{t("record.commonExpBadge")}</SettingsBadge>} description={t("settings.presetExperimentalDesc")} testId={`${idPrefix === "rp" ? "recording-preset" : "recording-session"}-experimental`}>
        <ExperimentalPovSection embedded omitEyebrow omitDisclaimer layout="rows" visible={visible} experimentalPovEnabled={povEnabled} onExperimentalPovChange={setPovEnabled} checkboxDisabled={batchRecording} povTeamcounterNumeric={warmupOpts.pov_teamcounter_numeric} onPovTeamcounterNumericChange={v => patchWarmup({
        pov_teamcounter_numeric: v
      })} povVoiceMode={warmupOpts.pov_voice_mode} onPovVoiceModeChange={v => patchWarmup({
        pov_voice_mode: v
      })} inputHudEnabled={warmupOpts.input_hud_enabled} inputHudPosition={warmupOpts.input_hud_position} inputHudDisplayMode={warmupOpts.input_hud_display_mode} onInputHudEnabledChange={v => patchWarmup({
        input_hud_enabled: v
      })} onInputHudPositionChange={v => patchWarmup({
        input_hud_position: v
      })} onInputHudDisplayModeChange={v => patchWarmup({
        input_hud_display_mode: v
      })} recordingSkybox={skyboxId} onRecordingSkyboxChange={setSkyboxId} skyboxResources={undefined} recordingMapMaterial={mapMaterialId} onRecordingMapMaterialChange={setMapMaterialId} recordingWeatherEffect={weatherEffectId} onRecordingWeatherEffectChange={setWeatherEffectId} />
        {experimentalContent}
      </SettingsGroup>

      <SettingsGroup {...presetGroupProps("rp-hud", t)} description={t("settings.presetHudDesc")}>
        <SettingsSubhead>{t("settings.presetHudSpectator")}</SettingsSubhead>
        {HUD_ROWS.map(row => {
        const locked = Boolean(row.povLock && povEnabled);
        return <SettingsRow key={row.key} label={t(row.titleKey)} description={locked ? t("settings.presetHudPovLocked") : t(row.descKey)} tooltip={row.tooltipKey ? t(row.tooltipKey) : row.code} disabled={locked}>
              <Switch ariaLabel={t(row.titleKey)} checked={!locked && !!warmupOpts[row.key]} disabled={locked} onChange={checked => patchWarmup({
            [row.key]: checked
          })} />
            </SettingsRow>;
      })}
        <SettingsSubhead>{t("settings.presetHudReplay")}</SettingsSubhead>
        <SettingsRow label={t("record.hudHideDemoUiTitle")} description={t("record.hudHideDemoUiDesc")} tooltip={"sv_cheats 1 → demoui false"}>
          <Switch ariaLabel={t("record.hudHideDemoUiTitle")} checked={!!warmupOpts.hide_demo_playback_ui} onChange={checked => patchWarmup({
          hide_demo_playback_ui: checked
        })} />
        </SettingsRow>
        <SettingsRow label={t("record.hudXrayTitle")} description={t("record.hudXrayDesc")} tooltip="spec_show_xray 1 / 0">
          <Switch ariaLabel={t("record.hudXrayTitle")} checked={!!warmupOpts.spec_show_xray} onChange={checked => patchWarmup({
          spec_show_xray: checked
        })} />
        </SettingsRow>
      </SettingsGroup>

      {<SettingsGroup {...presetGroupProps("rp-canvas", t)}>
          <SettingsRow label={t("settings.presetAspectLabel")} description={warmupOpts.aspect_ratio ? t(aspectHint(warmupOpts.aspect_ratio)) : t("settings.presetAspectFollowDesc")}>
            <Segmented ariaLabel={t("record.warmupResAspectLabel")} value={warmupOpts.aspect_ratio || ""} onChange={aspect_ratio => patchWarmup({
          aspect_ratio
        })} options={[{
          value: "",
          label: t("settings.presetAspectFollow")
        }, ...AR_OPTIONS.map(({
          ar,
          sample,
          tagKey
        }) => ({
          value: ar,
          label: ar,
          title: `${sample} · ${t(tagKey)}`
        }))]} />
          </SettingsRow>
          <SettingsRow label={t("settings.presetResolutionLabel")} description={warmupResolutionError ? <span className="text-cs2-rose-on-surface">{warmupResolutionError}</span> : t("settings.presetResolutionDesc")} tooltip={t("record.commonResLeaveBlankHint")}>
            <TextInput ariaLabel={t("settings.presetResolutionWidth")} value={warmupOpts.resolution_width} onChange={resolution_width => patchWarmup({
          resolution_width
        })} placeholder={t("settings.presetResolutionWidth")} mono className="w-20 text-right" />
            <span className="text-xs text-cs2-text-muted" aria-hidden>×</span>
            <TextInput ariaLabel={t("settings.presetResolutionHeight")} value={warmupOpts.resolution_height} onChange={resolution_height => patchWarmup({
          resolution_height
        })} placeholder={t("settings.presetResolutionHeight")} mono className="w-20 text-right" />
          </SettingsRow>
          <SettingsRow label={t("record.commonSecObs")} description={t("settings.presetTransitionDesc")}>
            <Segmented ariaLabel={t("record.warmupSecObs")} value={obsTransName} disabled={!obsTransEnabled} onChange={setObsTransName} options={[{
          value: "Fade",
          label: t("record.warmupObsFade")
        }, {
          value: "Cut",
          label: t("record.warmupObsCut")
        }, {
          value: "Swipe",
          label: t("record.warmupObsSwipe")
        }]} />
            <Switch ariaLabel={t("record.warmupObsEnable")} checked={obsTransEnabled} onChange={setObsTransEnabled} />
          </SettingsRow>
          <SettingsRow indent label={t("settings.presetTransitionDuration")} disabled={!obsTransEnabled}>
            <NumberInput ariaLabel={t("settings.presetTransitionDuration")} min={0} max={2000} step={50} unit={t("settings.unitMs")} value={obsTransDurationMs} defaultValue={obsTransitionDefaultDuration} disabled={!obsTransEnabled} onChange={n => setObsTransDurationMs(Number(n))} />
          </SettingsRow>
        </SettingsGroup>}

      <SettingsGroup {...presetGroupProps("rp-launch", t)}>
        <Cs2LaunchConsoleFields layout="rows" cs2ExtraLaunchArgs={localCs2ExtraLaunchArgs} onCs2ExtraLaunchArgsChange={setLocalCs2ExtraLaunchArgs} recordInjectConsoleLines={localRecordInjectLines} onRecordInjectConsoleLinesChange={setLocalRecordInjectLines} />
      </SettingsGroup>
  </>;
}
