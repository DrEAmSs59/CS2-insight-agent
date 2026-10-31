import RecordingSettingsSections from "./RecordingSettingsSections.jsx";
import { RECORD_WARMUP_DEFAULT_OPTIONS, RECORD_WARMUP_DEFAULT_OBS_TRANSITION } from "./recordingQueue/recordingWarmupDefaults.js";
import { RECORDING_SESSION_SECTIONS } from "../pages/settings/recordingPresetSections.js";
import RecordingSectionMenu, { useRecordingSectionNavigation } from "./recordingQueue/RecordingSectionMenu.jsx";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { effectiveSpectatorFlashbangOpacity, validateWarmupResolution, warmupUiOptsToPersisted } from "../utils/warmupDefaults";
import PlayerAliasesSection from "./PlayerAliasesSection.jsx";
import { DEFAULT_INPUT_HUD_POSITION, normalizeInputHudPosition } from "../utils/inputHudPlacement.js";
import { hasInvalidPlayerAliases, PLAYER_ALIAS_ENTRY_VISIBLE, playerAliasMaps } from "../utils/playerAliases.js";
import { useT } from "../i18n/useT.js";
import { normalizeRecordingSkyboxId } from "../utils/recordingSkybox.js";
import { DEFAULT_RECORDING_MAP_MATERIAL, normalizeRecordingMapMaterialId } from "../utils/recordingMapMaterial.js";
import { DEFAULT_RECORDING_WEATHER_EFFECT, normalizeRecordingWeatherEffectId } from "../utils/recordingWeatherEffect.js";
import { normalizePovVoiceMode } from "../utils/povVoiceMode.js";
/** 拼装随观战选项变化的 cvar（顺序与后端一致）；固定 cvar 见 record_inject_console_lines 配置 */
export function buildWarmupConsoleCommands(o) {
  // 固定性能/预测 cvar 已迁至配置 record_inject_console_lines（可在「附加预热控制台」增删），
  // 不再随 console_cmds 注入；此处仅拼装随观战选项变化的 cvar。
  const lines = [];
  lines.push(o.cl_draw_only_deathnotices ? "cl_draw_only_deathnotices true" : "cl_draw_only_deathnotices false");
  // GOTV demos replay the recorded mp_forcecamera=1 NetSetConVar. The local
  // controller stays on spectator team, so 1 hides teammates on the native
  // radar; 0 lets CCSGO_HudRadar follow the observed player's relationship.
  lines.push("mp_forcecamera 0");
  lines.push(o.hud_showtargetid_hide ? "hud_showtargetid 0" : "hud_showtargetid 1");
  lines.push(o.hide_clan_tags !== false ? "cl_show_clan_in_death_notice 0" : "cl_show_clan_in_death_notice 1");
  lines.push(o.tv_nochat ? "tv_nochat 1" : "tv_nochat 0");
  if (o.hide_demo_playback_ui) {
    lines.push("sv_cheats 1");
    lines.push("demoui false");
  }
  lines.push(o.spec_show_xray ? "spec_show_xray 1" : "spec_show_xray 0");
  lines.push("cl_grenadepreview 0");
  if (o.apply_fov && o.fov_cs_debug != null && !Number.isNaN(Number(o.fov_cs_debug))) {
    lines.push(`fov_cs_debug ${Number(o.fov_cs_debug)}`);
  }
  if (o.viewmodel_fov_68) {
    lines.push("viewmodel_fov 68");
  }
  if (o.third_person_camera) {
    lines.push("cam_command 1", "cam_idealdist 30", "cam_idealyaw 0", "cam_idealpitch 0", "c_thirdpersonshoulder 1", "c_thirdpersonshoulderaimdist 300", "c_thirdpersonshoulderdist 40", "c_thirdpersonshoulderheight 2", "c_thirdpersonshoulderoffset 20");
  }
  const flashOpacity = effectiveSpectatorFlashbangOpacity(o, !!(o.pov_hud_enabled || o.experimental_pov_enabled));
  if (flashOpacity != null) {
    lines.push(`r_spectator_flashbang_opacity ${flashOpacity}`);
  }
  if (o.hide_grenade_trajectory_pip) {
    lines.push("sv_grenade_trajectory 0");
    lines.push("sv_grenade_trajectory_prac_pipreview 0");
    lines.push("sv_grenade_trajectory_time_spectator 0");
  }
  return lines;
}
export { RECORD_WARMUP_DEFAULT_OPTIONS, RECORD_WARMUP_DEFAULT_OBS_TRANSITION } from "./recordingQueue/recordingWarmupDefaults.js";
export default function RecordWarmupModal({
  open,
  onClose,
  onConfirm,
  onSaveSettings,
  aliasDemos = [],
  defaultOverrides,
  experimentalPovEnabled = false,
  recordingSkybox = "default",
  recordingMapMaterial = DEFAULT_RECORDING_MAP_MATERIAL,
  recordingWeatherEffect = DEFAULT_RECORDING_WEATHER_EFFECT,
  cs2ExtraLaunchArgs = "",
  recordInjectConsoleLines = "",
  initObsTransEnabled = false,
  initObsTransName = "Fade",
  initObsTransDurationMs = 200
}) {
  const t = useT();
  const [opts, setOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [resolutionError, setResolutionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [aliasEditor, setAliasEditor] = useState({
    enabled: false,
    drafts: {}
  });
  const [aliasesReady, setAliasesReady] = useState(false);
  const aliasesBlocked = PLAYER_ALIAS_ENTRY_VISIBLE && aliasEditor.enabled && (!aliasesReady || hasInvalidPlayerAliases(aliasEditor));
  const [obsTransEnabled, setObsTransEnabled] = useState(null); // null = use global
  const [obsTransName, setObsTransName] = useState(null);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(null);
  const [sessionPovEnabled, setSessionPovEnabled] = useState(false);
  const [sessionInputHudEnabled, setSessionInputHudEnabled] = useState(true);
  const [sessionInputHudPosition, setSessionInputHudPosition] = useState(DEFAULT_INPUT_HUD_POSITION);
  const [sessionInputHudDisplayMode, setSessionInputHudDisplayMode] = useState("hybrid");
  const [sessionInputAudioEnabled, setSessionInputAudioEnabled] = useState(false);
  const [sessionCombatStatsHudEnabled, setSessionCombatStatsHudEnabled] = useState(true);
  const [sessionSkybox, setSessionSkybox] = useState("default");
  const [sessionMapMaterial, setSessionMapMaterial] = useState(DEFAULT_RECORDING_MAP_MATERIAL);
  const [sessionWeatherEffect, setSessionWeatherEffect] = useState(DEFAULT_RECORDING_WEATHER_EFFECT);
  const [sessionCs2ExtraLaunchArgs, setSessionCs2ExtraLaunchArgs] = useState("");
  const [sessionRecordInjectConsoleLines, setSessionRecordInjectConsoleLines] = useState("");
  const povEnabled = sessionPovEnabled;
  const {
    scrollRef,
    activeSection,
    jumpToSection
  } = useRecordingSectionNavigation(RECORDING_SESSION_SECTIONS, open);
  useEffect(() => {
    setAliasEditor({
      enabled: false,
      drafts: {}
    });
    setAliasesReady(false);
    if (!open) return;
    const base = {
      ...RECORD_WARMUP_DEFAULT_OPTIONS
    };
    const o = defaultOverrides;
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
    setOpts(base);
    setResolutionError("");
    setObsTransEnabled(!!initObsTransEnabled);
    setObsTransName(initObsTransName || "Fade");
    setObsTransDurationMs(Number(initObsTransDurationMs) || 200);
    setSessionPovEnabled(!!experimentalPovEnabled);
    setSessionInputHudEnabled(o?.input_hud_enabled !== false);
    setSessionInputHudPosition(normalizeInputHudPosition(o?.input_hud_position));
    setSessionInputHudDisplayMode("hybrid");
    setSessionInputAudioEnabled(false);
    setSessionCombatStatsHudEnabled(o?.combat_stats_hud_enabled !== false);
    setSessionSkybox(normalizeRecordingSkyboxId(recordingSkybox));
    setSessionMapMaterial(normalizeRecordingMapMaterialId(recordingMapMaterial));
    setSessionWeatherEffect(normalizeRecordingWeatherEffectId(recordingWeatherEffect));
    setSessionCs2ExtraLaunchArgs(cs2ExtraLaunchArgs);
    setSessionRecordInjectConsoleLines(recordInjectConsoleLines);
  }, [open, defaultOverrides, initObsTransEnabled, initObsTransName, initObsTransDurationMs, experimentalPovEnabled, recordingSkybox, recordingMapMaterial, recordingWeatherEffect, cs2ExtraLaunchArgs, recordInjectConsoleLines]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const vr = validateWarmupResolution(opts);
      setResolutionError(vr.ok ? "" : t(vr.messageKey, vr.messageParams));
    }, 400);
    return () => clearTimeout(timer);
  }, [open, opts.aspect_ratio, opts.resolution_width, opts.resolution_height, t]);
  const set = useCallback(patch => {
    setOpts(prev => ({
      ...prev,
      ...patch
    }));
  }, []);
  const savePreferences = async () => {
    const error = "";
    const resolution = validateWarmupResolution(opts);
    if (!resolution.ok) {
      setSaveMessage(t(resolution.messageKey, resolution.messageParams));
      return false;
    }
    setSaving(true);
    try {
      const result = await onSaveSettings({
        default_record_warmup: warmupUiOptsToPersisted({
          ...opts,
          input_hud_enabled: sessionInputHudEnabled,
          input_hud_position: sessionInputHudPosition,
          input_hud_display_mode: sessionInputHudDisplayMode,
          input_audio_enabled: sessionInputAudioEnabled,
          combat_stats_hud_enabled: sessionCombatStatsHudEnabled
        }),
        experimental_pov_enabled: sessionPovEnabled,
        recording_skybox: sessionSkybox,
        recording_map_material: sessionMapMaterial,
        recording_weather_effect: sessionWeatherEffect,
        cs2_extra_launch_args: sessionCs2ExtraLaunchArgs,
        record_inject_console_lines: sessionRecordInjectConsoleLines,
        obs_transition_enabled: obsTransEnabled,
        obs_transition_name: obsTransName,
        obs_transition_duration_ms: obsTransDurationMs
      });
      setSaveMessage(result?.ok ? t("record.settingsRemembered") : result?.error || t("app.saveFailed"));
      return result?.ok === true;
    } catch (error) {
      setSaveMessage(error.message || t("app.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const handleSubmit = async () => {
    if (aliasesBlocked || false || saving || false) return;
    const vr = validateWarmupResolution(opts);
    if (!vr.ok) {
      setResolutionError(t(vr.messageKey, vr.messageParams));
      return;
    }
    const arRaw = String(opts.aspect_ratio || "").trim();
    /** @type {"" | "4:3" | "16:9" | "16:10"} */
    const ar = arRaw === "4:3" || arRaw === "16:9" || arRaw === "16:10" ? arRaw : "";
    const w = String(opts.resolution_width || "").trim();
    const h = String(opts.resolution_height || "").trim();
    const rw = w ? parseInt(w, 10) : null;
    const rh = h ? parseInt(h, 10) : null;
    const apiShape = {
      cl_draw_only_deathnotices: opts.cl_draw_only_deathnotices,
      hud_showtargetid_hide: opts.hud_showtargetid_hide,
      hide_clan_tags: opts.hide_clan_tags,
      persistent_killfeed: opts.persistent_killfeed,
      tv_nochat: opts.tv_nochat,
      spec_show_xray: opts.spec_show_xray ? 1 : 0,
      fov_cs_debug: opts.apply_fov ? Number(opts.fov_cs_debug) || 90 : null,
      viewmodel_fov_68: opts.viewmodel_fov_68,
      third_person_camera: opts.third_person_camera,
      spectator_flashbang_opacity: effectiveSpectatorFlashbangOpacity(opts, povEnabled),
      hide_demo_playback_ui: opts.hide_demo_playback_ui,
      hide_grenade_trajectory_pip: opts.hide_grenade_trajectory_pip,
      resolution_width: rw,
      resolution_height: rh,
      aspect_ratio: ar || null,
      pov_radar_mode: 0,
      pov_teamcounter_numeric: !!opts.pov_teamcounter_numeric,
      pov_voice_mode: normalizePovVoiceMode(opts.pov_voice_mode)
    };
    const console_cmds = buildWarmupConsoleCommands({
      ...opts,
      spec_show_xray: !!opts.spec_show_xray,
      experimental_pov_enabled: povEnabled
    });
    const payload = {
      player_aliases_by_demo: PLAYER_ALIAS_ENTRY_VISIBLE ? playerAliasMaps(aliasEditor) : {},
      ...apiShape,
      console_cmds,
      obs_transition_enabled: obsTransEnabled,
      obs_transition_name: obsTransName,
      obs_transition_duration_ms: obsTransDurationMs,
      input_hud_enabled: sessionInputHudEnabled,
      input_hud_position: sessionInputHudPosition,
      input_hud_display_mode: sessionInputHudDisplayMode,
      input_audio_enabled: sessionInputAudioEnabled,
      combat_stats_hud_enabled: sessionCombatStatsHudEnabled,
      experimental_pov_enabled: povEnabled,
      recording_skybox: normalizeRecordingSkyboxId(sessionSkybox),
      recording_map_material: normalizeRecordingMapMaterialId(sessionMapMaterial),
      recording_weather_effect: normalizeRecordingWeatherEffectId(sessionWeatherEffect),
      session_cs2_extra_launch_args: sessionCs2ExtraLaunchArgs,
      session_record_inject_console_lines: sessionRecordInjectConsoleLines
    };
    if (onSaveSettings && !(await savePreferences())) return;
    onConfirm(payload);
  };
  if (!open) return null;
  const sessionWarmup = {
    ...opts,
    input_hud_enabled: sessionInputHudEnabled,
    input_hud_position: sessionInputHudPosition,
    input_hud_display_mode: sessionInputHudDisplayMode,
    combat_stats_hud_enabled: sessionCombatStatsHudEnabled
  };
  const patchSessionWarmup = patch => {
    set(patch);
    const setters = {
      input_hud_enabled: setSessionInputHudEnabled,
      input_hud_position: setSessionInputHudPosition,
      input_hud_display_mode: setSessionInputHudDisplayMode,
      combat_stats_hud_enabled: setSessionCombatStatsHudEnabled
    };
    for (const [key, setter] of Object.entries(setters)) {
      if (Object.hasOwn(patch, key)) setter(patch[key]);
    }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-cs2-bg-overlay p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="record-warmup-title" onClick={event => {
    if (!saving && event.target === event.currentTarget) onClose();
  }}>
      <div className="flex h-[min(92vh,1000px)] w-full max-w-[min(92vw,1400px)] flex-col overflow-hidden rounded-xl border border-cs2-border-subtle bg-cs2-bg-card shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-cs2-border-subtle px-6 py-4">
          <h2 id="record-warmup-title" className="text-lg font-bold tracking-tight text-cs2-text-primary">{t("record.warmupTitle")}</h2>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary" aria-label={t("record.warmupArClose")}><X className="h-4 w-4" /></button>
        </header>
        <p className="shrink-0 border-b border-cs2-border-subtle px-6 py-2 text-xs text-cs2-text-muted">{t("record.warmupSessionHint")}</p>
        <fieldset disabled={saving} className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label={t("record.settingsNavLabel")} className="shrink-0 border-b border-cs2-border-subtle bg-cs2-bg-sidebar px-4 py-5 sm:w-48 sm:overflow-y-auto sm:border-b-0 sm:border-r">
            <p className="mb-3 text-[13px] font-semibold text-cs2-text-primary">{t("record.warmupTitle")}</p>
            <RecordingSectionMenu sections={RECORDING_SESSION_SECTIONS} activeSection={activeSection} onSelect={jumpToSection} className="ml-2 max-sm:flex-row max-sm:flex-wrap" />
          </nav>
          <div ref={scrollRef} data-testid="recording-session-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden @container/params" style={{
          scrollbarGutter: "stable"
        }}>
            <div className="mx-auto w-full max-w-[1040px] px-5 pb-6 pt-5 sm:px-7" data-testid="recording-session-content">
              {null}
              <RecordingSettingsSections idPrefix="rw" visible={open} batchRecording={saving} saveDisabled={saving} warmupOpts={sessionWarmup} patchWarmup={patchSessionWarmup} warmupResolutionError={resolutionError} povEnabled={povEnabled} setPovEnabled={setSessionPovEnabled} skyboxId={sessionSkybox} setSkyboxId={setSessionSkybox} mapMaterialId={sessionMapMaterial} setMapMaterialId={setSessionMapMaterial} weatherEffectId={sessionWeatherEffect} setWeatherEffectId={setSessionWeatherEffect} obsTransEnabled={obsTransEnabled === true} setObsTransEnabled={enabled => {
              setObsTransEnabled(enabled ? true : null);
              if (enabled && obsTransDurationMs == null) setObsTransDurationMs(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.durationMs);
              if (enabled && !obsTransName) setObsTransName(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.name);
            }} obsTransName={obsTransName} setObsTransName={setObsTransName} obsTransDurationMs={obsTransDurationMs} setObsTransDurationMs={setObsTransDurationMs} obsTransitionDefaultDuration={RECORD_WARMUP_DEFAULT_OBS_TRANSITION.durationMs} localCs2ExtraLaunchArgs={sessionCs2ExtraLaunchArgs} setLocalCs2ExtraLaunchArgs={setSessionCs2ExtraLaunchArgs} localRecordInjectLines={sessionRecordInjectConsoleLines} setLocalRecordInjectLines={setSessionRecordInjectConsoleLines} experimentalContent={PLAYER_ALIAS_ENTRY_VISIBLE ? <PlayerAliasesSection demos={aliasDemos} value={aliasEditor} onChange={setAliasEditor} onReadyChange={setAliasesReady} disabled={saving} layout="rows" /> : null} />
              {null}
            </div>
          </div>
        </fieldset>

        <div className="flex shrink-0 flex-col gap-2 border-t border-cs2-border bg-cs2-bg-input/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          {saveMessage ? <p role="status" className="text-xs text-cs2-text-secondary">{saveMessage}</p> : null}
          <div className="flex justify-end gap-2">
            {onSaveSettings ? <button type="button" onClick={savePreferences} disabled={saving} className="rounded-lg border border-cs2-border px-4 py-2 text-sm font-semibold text-cs2-text-secondary disabled:opacity-45">
              {t(saving ? "record.settingsSaving" : "record.saveSettings")}
            </button> : null}
            <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-cs2-border px-4 py-2 text-sm font-semibold text-cs2-text-secondary hover:bg-cs2-bg-input/50">
              {t("record.warmupBtnCancel")}
            </button>
            <button type="button" onClick={handleSubmit} disabled={saving || Boolean(resolutionError) || aliasesBlocked || false} className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-45">
              {t("record.warmupBtnStart")}
            </button>
          </div>
        </div>
      </div>
    </div>;
}
