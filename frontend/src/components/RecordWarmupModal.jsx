import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  aspectExportHint,
  aspectHint,
  effectiveSpectatorFlashbangOpacity,
  formatResolutionSummary,
  SPECTATOR_FLASHBANG_OPACITY_DEFAULT,
  validateWarmupResolution,
} from "../utils/warmupDefaults";
import ExperimentalPovSection from "./ExperimentalPovSection";
import Cs2LaunchConsoleFields, { countInjectConsoleLines } from "./Cs2LaunchConsoleFields";
import { POV_CONFLICT_HUD, RecordingHudCard } from "./RecordingHudCard";
import { useT } from "../i18n/useT.js";

/** 拼装随观战选项变化的 cvar（顺序与后端一致）；固定 cvar 见 record_inject_console_lines 配置 */
export function buildWarmupConsoleCommands(o) {
  // 固定性能/预测 cvar 已迁至配置 record_inject_console_lines（可在「附加预热控制台」增删），
  // 不再随 console_cmds 注入；此处仅拼装随观战选项变化的 cvar。
  const lines = [];
  lines.push(
    o.cl_draw_only_deathnotices
      ? "cl_draw_only_deathnotices true"
      : "cl_draw_only_deathnotices false"
  );
  lines.push(o.hud_showtargetid_hide ? "hud_showtargetid 0" : "hud_showtargetid 1");
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
    lines.push(
      "cam_command 1",
      "cam_idealdist 30",
      "cam_idealyaw 0",
      "cam_idealpitch 0",
      "c_thirdpersonshoulder 1",
      "c_thirdpersonshoulderaimdist 300",
      "c_thirdpersonshoulderdist 40",
      "c_thirdpersonshoulderheight 2",
      "c_thirdpersonshoulderoffset 20",
    );
  }
  const flashOpacity = effectiveSpectatorFlashbangOpacity(
    o,
    !!(o.pov_hud_enabled || o.experimental_pov_enabled),
  );
  if (flashOpacity != null) {
    lines.push(`r_spectator_flashbang_opacity ${flashOpacity}`);
  }
  const vf = o.voice_filter ?? "mute";
  if (vf === "mute" || vf === "all") {
    lines.push(
      "tv_listen_voice_indices 0",
      "tv_listen_voice_indices_h 0",
      "voice_modenable 0",
      "snd_voipvolume 0",
    );
  } else if (vf === "open") {
    lines.push(
      "voice_modenable 1",
      "snd_voipvolume 1",
      "tv_listen_voice_indices -1",
      "tv_listen_voice_indices_h -1",
    );
  } else if (vf === "off") {
    // 不注入语音指令
  } else {
    // "team" / "enemy"：先静音，per-segment 按当前 POV SteamID 成功解析后再放行。
    lines.push(
      "tv_listen_voice_indices 0",
      "tv_listen_voice_indices_h 0",
      "voice_modenable 1",
      "snd_voipvolume 1",
    );
  }
  if (o.hide_grenade_trajectory_pip) {
    lines.push("sv_grenade_trajectory 0");
    lines.push("sv_grenade_trajectory_prac_pipreview 0");
    lines.push("sv_grenade_trajectory_time_spectator 0");
  }
  return lines;
}

export const RECORD_WARMUP_DEFAULT_OPTIONS = {
  cl_draw_only_deathnotices: true,
  hud_showtargetid_hide: true,
  tv_nochat: true,
  spec_show_xray: false,
  apply_fov: false,
  fov_cs_debug: 90,
  viewmodel_fov_68: false,
  third_person_camera: false,
  apply_spectator_flashbang_opacity: false,
  spectator_flashbang_opacity: SPECTATOR_FLASHBANG_OPACITY_DEFAULT,
  voice_filter: "mute",
  hide_demo_playback_ui: true,
  hide_grenade_trajectory_pip: true,
  aspect_ratio: "",
  resolution_width: "",
  resolution_height: "",
  /** POV：cl_drawhud_force_radar，-1 隐藏，0 显示（与 POV 成片默认「开雷达」一致） */
  pov_radar_mode: 0,
  /** POV：true 正上方显示存活人数；false 显示双方十人头像（默认关存活人数条） */
  pov_teamcounter_numeric: false,
};

/** 录制预热弹窗每次打开时的 OBS 转场推荐默认值；勾选关闭则提交 null 沿用服务器全局配置 */
export const RECORD_WARMUP_DEFAULT_OBS_TRANSITION = {
  enabled: true,
  name: "Fade",
  durationMs: 200,
};

export function SectionHeader({ en, zh }) {
  return (
    <div className="mb-2 flex items-end gap-2 px-0.5">
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cs2-text-muted">{en}</p>
        <p className="text-[11px] font-semibold text-cs2-text-secondary">{zh}</p>
      </div>
      <div className="mb-1 h-px min-w-[2rem] flex-1 bg-gradient-to-r from-white/[0.12] via-white/[0.06] to-transparent" />
    </div>
  );
}

export function OptionRow({ checked, onChange, title, code, disabled = false, disabledReason }) {
  const t = useT();
  return (
    <label
      title={disabled && disabledReason ? t(disabledReason) : undefined}
      className={`flex items-start gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5 transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-45"
          : "cursor-pointer hover:border-cs2-accent/25"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (disabled) return;
          onChange(e.target.checked);
        }}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-50"
      />
      <span className="min-w-0 text-sm leading-snug text-cs2-text-primary">
        {title}{" "}
        <code className="whitespace-pre-wrap break-all text-[11px] text-cs2-accent/90">{code}</code>
      </span>
    </label>
  );
}

/**
 * 一键录制前：分组观战 / 摄像机 / 音频与启动项；提交时生成 console_cmds 供后端注入。
 * 初始值来自常用参数（配置文件）；本次修改仅随 onConfirm 提交，不写入 JSON。
 */
export default function RecordWarmupModal({
  open,
  onClose,
  onConfirm,
  defaultOverrides,
  experimentalPovEnabled = false,
  cs2ExtraLaunchArgs = "",
  recordInjectConsoleLines = "",
  initObsTransEnabled = false,
  initObsTransName = "Fade",
  initObsTransDurationMs = 200,
  initKbOverlayEnabled = false,
  initKbOverlayTickOffset = 6,
  initKbOverlayPosition = "bottom_center",
  initKillFxEnabled = false,
  initKillFxTickOffset = 6,
}) {
  const t = useT();
  const [opts, setOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [resolutionError, setResolutionError] = useState("");
  const [obsTransEnabled, setObsTransEnabled] = useState(null);  // null = use global
  const [obsTransName, setObsTransName] = useState(null);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(null);
  const [kbOverlayEnabled, setKbOverlayEnabled] = useState(false);
  const [kbOverlayTickOffset, setKbOverlayTickOffset] = useState(6);
  const [kbOverlayPosition, setKbOverlayPosition] = useState("bottom_center");
  const [killFxEnabled, setKillFxEnabled] = useState(false);
  const [killFxTickOffset, setKillFxTickOffset] = useState(6);
  const [sessionPovEnabled, setSessionPovEnabled] = useState(false);
  const [sessionCs2ExtraLaunchArgs, setSessionCs2ExtraLaunchArgs] = useState("");
  const [sessionRecordInjectConsoleLines, setSessionRecordInjectConsoleLines] = useState("");

  useEffect(() => {
    if (!open) return;
    const base = { ...RECORD_WARMUP_DEFAULT_OPTIONS };
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
    setOpts(base);
    setResolutionError("");
    setObsTransEnabled(!!initObsTransEnabled);
    setObsTransName(initObsTransName || "Fade");
    setObsTransDurationMs(Number(initObsTransDurationMs) || 200);
    setKbOverlayEnabled(!!initKbOverlayEnabled);
    setKbOverlayTickOffset(
      Number.isFinite(Number(initKbOverlayTickOffset))
        ? Number(initKbOverlayTickOffset)
        : 6,
    );
    setKbOverlayPosition(initKbOverlayPosition || "bottom_center");
    setKillFxEnabled(!!initKillFxEnabled);
    setKillFxTickOffset(Number(initKillFxTickOffset) || 0);
    setSessionPovEnabled(!!experimentalPovEnabled);
    setSessionCs2ExtraLaunchArgs(cs2ExtraLaunchArgs);
    setSessionRecordInjectConsoleLines(recordInjectConsoleLines);
  }, [
    open,
    defaultOverrides,
    initObsTransEnabled,
    initObsTransName,
    initObsTransDurationMs,
    experimentalPovEnabled,
    initKbOverlayEnabled,
    initKbOverlayTickOffset,
    initKbOverlayPosition,
    initKillFxEnabled,
    initKillFxTickOffset,
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
  ]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const vr = validateWarmupResolution(opts);
      setResolutionError(vr.ok ? "" : t(vr.messageKey, vr.messageParams));
    }, 400);
    return () => clearTimeout(timer);
  }, [open, opts.aspect_ratio, opts.resolution_width, opts.resolution_height, t]);

  const injectExtraCount = useMemo(
    () => countInjectConsoleLines(sessionRecordInjectConsoleLines),
    [sessionRecordInjectConsoleLines],
  );

  const baseWarmupCmdCount = useMemo(
    () =>
      buildWarmupConsoleCommands({
        ...opts,
        spec_show_xray: !!opts.spec_show_xray,
      }).length,
    [opts],
  );

  const set = useCallback((patch) => {
    setOpts((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSubmit = () => {
    const vr = validateWarmupResolution(opts);
    if (!vr.ok) {
      setResolutionError(t(vr.messageKey, vr.messageParams));
      return;
    }

    const arRaw = String(opts.aspect_ratio || "").trim();
    /** @type {"" | "4:3" | "16:9" | "16:10"} */
    const ar =
      arRaw === "4:3" || arRaw === "16:9" || arRaw === "16:10" ? arRaw : "";

    const w = String(opts.resolution_width || "").trim();
    const h = String(opts.resolution_height || "").trim();
    const rw = w ? parseInt(w, 10) : null;
    const rh = h ? parseInt(h, 10) : null;

    const apiShape = {
      cl_draw_only_deathnotices: opts.cl_draw_only_deathnotices,
      hud_showtargetid_hide: opts.hud_showtargetid_hide,
      tv_nochat: opts.tv_nochat,
      spec_show_xray: opts.spec_show_xray ? 1 : 0,
      fov_cs_debug: opts.apply_fov ? Number(opts.fov_cs_debug) || 90 : null,
      viewmodel_fov_68: opts.viewmodel_fov_68,
      third_person_camera: opts.third_person_camera,
      spectator_flashbang_opacity: effectiveSpectatorFlashbangOpacity(opts, sessionPovEnabled),
      voice_filter: opts.voice_filter ?? "mute",
      hide_demo_playback_ui: opts.hide_demo_playback_ui,
      hide_grenade_trajectory_pip: opts.hide_grenade_trajectory_pip,
      resolution_width: rw,
      resolution_height: rh,
      aspect_ratio: ar || null,
      pov_radar_mode: opts.pov_radar_mode === 0 ? 0 : -1,
      pov_teamcounter_numeric: !!opts.pov_teamcounter_numeric,
    };
    const console_cmds = buildWarmupConsoleCommands({
      ...opts,
      spec_show_xray: !!opts.spec_show_xray,
      experimental_pov_enabled: sessionPovEnabled,
    });

    onConfirm({
        ...apiShape,
        console_cmds,
        obs_transition_enabled: obsTransEnabled,
        obs_transition_name: obsTransName,
        obs_transition_duration_ms: obsTransDurationMs,
        kb_overlay_enabled: kbOverlayEnabled,
        kb_overlay_tick_offset: Number(kbOverlayTickOffset) || 0,
        kb_overlay_position: kbOverlayPosition,
        kill_fx_enabled: killFxEnabled,
        kill_fx_tick_offset: Number(killFxTickOffset) || 0,
        experimental_pov_enabled: sessionPovEnabled,
        session_cs2_extra_launch_args: sessionCs2ExtraLaunchArgs,
        session_record_inject_console_lines: sessionRecordInjectConsoleLines,
      });
  };

  if (!open) return null;

  const resSummaryRaw = formatResolutionSummary(
    opts.aspect_ratio,
    opts.resolution_width,
    opts.resolution_height,
  );
  // formatResolutionSummary returns a "record.*" key when no actual resolution is set
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

  const vf = opts.voice_filter ?? "mute";
  const selectedVf = VF_OPTIONS.find((o) => o.value === vf) ?? VF_OPTIONS[3];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-warmup-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[min(96vh,1080px)] w-full max-w-[min(92vw,1400px)] flex-col overflow-hidden rounded-xl border border-cs2-border-subtle bg-cs2-bg-card shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-input/50 hover:text-cs2-text-secondary"
          aria-label={t("record.warmupArClose")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 pb-4 @container/params">
        <h2 id="record-warmup-title" className="mb-1 pr-8 text-lg font-bold tracking-tight text-cs2-text-primary">
          {t("record.warmupTitle")}
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-cs2-text-muted">
          <strong className="text-cs2-text-secondary">{t("record.warmupIntro")}</strong>
          <span className="mt-1 block text-cs2-text-muted">
            {t("record.warmupIntroPersistNote")}
          </span>
        </p>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="min-w-0 space-y-4">
          <section aria-labelledby="sec-obs-fade">
            <SectionHeader en="OBS Transition" zh={t("record.warmupSecObs")} />
            <div id="sec-obs-fade" className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={obsTransEnabled === true}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    if (!checked) {
                      setObsTransEnabled(null);
                      return;
                    }
                    setObsTransEnabled(true);
                    if (obsTransDurationMs == null || obsTransDurationMs === "") {
                      setObsTransDurationMs(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.durationMs);
                    }
                    if (!obsTransName) setObsTransName(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.name);
                  }}
                  className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                />
                <span className="text-sm text-cs2-text-primary">{t("record.warmupObsEnable")}</span>
              </label>
              <p className="mt-2 pl-7 text-xs leading-relaxed text-cs2-text-muted">
                {t("record.warmupObsDesc")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
                <select
                  value={obsTransName ?? ""}
                  onChange={(e) => setObsTransName(e.target.value || null)}
                  disabled={obsTransEnabled !== true}
                  className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-sm text-cs2-text-primary disabled:opacity-40"
                >
                  <option value="Fade">{t("record.warmupObsFade")}</option>
                  <option value="Cut">{t("record.warmupObsCut")}</option>
                  <option value="Swipe">{t("record.warmupObsSwipe")}</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  step={50}
                  placeholder="200"
                  value={obsTransDurationMs ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setObsTransDurationMs(v === "" ? null : Number(v));
                  }}
                  disabled={obsTransEnabled !== true}
                  className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                />
              </div>
            </div>
          </section>

          <section aria-labelledby="sec-overlays">
            <SectionHeader en="Keyboard & KillFX" zh={t("record.commonSecOverlays")} />
            <div id="sec-overlays" className="grid gap-3 xl:grid-cols-2">
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                <h4 className="mb-2 text-sm font-semibold text-cs2-text-primary">{t("record.warmupSecKb")}</h4>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={kbOverlayEnabled}
                    onChange={(e) => setKbOverlayEnabled(e.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                  />
                  <span className="text-sm text-cs2-text-primary">{t("record.warmupKbEnable")}</span>
                </label>
                <p className="mt-2 pl-7 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.warmupKbDesc")}
                </p>
                {kbOverlayEnabled && (
                  <div className="mt-3 pl-7 flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-cs2-text-secondary whitespace-nowrap">{t("record.warmupKbPosition")}</span>
                      {KB_POSITIONS.map(({ value, labelKey }) => (
                        <label key={value} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="kb-pos-warmup"
                            value={value}
                            checked={kbOverlayPosition === value}
                            onChange={() => setKbOverlayPosition(value)}
                            className="accent-cs2-orange"
                          />
                          <span className="text-xs text-cs2-text-primary">{t(labelKey)}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
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
                      {t("record.warmupKbSyncHint")}
                    </p>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                <h4 className="mb-2 text-sm font-semibold text-cs2-text-primary">{t("record.warmupSecKillFx")}</h4>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={killFxEnabled}
                    onChange={(e) => setKillFxEnabled(e.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                  />
                  <span className="text-sm text-cs2-text-primary">{t("record.warmupKillFxEnable")}</span>
                </label>
                <p className="mt-2 pl-7 text-xs leading-relaxed text-cs2-text-muted">
                  {t("record.warmupKillFxDesc")}
                </p>
                {killFxEnabled && (
                  <div className="mt-3 pl-7 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-xs text-cs2-text-secondary whitespace-nowrap">{t("record.warmupKillFxSyncAdjust")}</span>
                      <input
                        type="number"
                        value={killFxTickOffset}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setKillFxTickOffset(raw === "" ? "" : Number(raw));
                        }}
                        onBlur={() => {
                          if (killFxTickOffset === "" || Number.isNaN(Number(killFxTickOffset))) {
                            setKillFxTickOffset(0);
                          }
                        }}
                        min="-120"
                        max="120"
                        step="1"
                        className="w-20 rounded border border-cs2-border bg-cs2-bg-elevated px-2 py-1 text-sm text-cs2-text-primary text-center"
                      />
                      <span className="text-xs text-cs2-text-muted tabular-nums">
                        ≈ {Math.round(Math.abs(Number(killFxTickOffset) || 0) / 64 * 1000)} ms{Number(killFxTickOffset) > 0 ? t("record.warmupKbAhead") : Number(killFxTickOffset) < 0 ? t("record.warmupKbBehind") : t("record.warmupKbNoCompensation")}
                      </span>
                    </div>
                    <p className="text-xs text-cs2-text-muted leading-relaxed">
                      {t("record.warmupKillFxSyncHint")}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="sec-visuals">
            <SectionHeader en="Visuals & HUD" zh={t("record.warmupSecVisuals")} />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">{t("record.warmupVisualsSection")}</p>
            <div id="sec-visuals" className="grid gap-3 sm:grid-cols-2">
              <RecordingHudCard
                title={t("record.hudSimplifyTitle")}
                code="cl_draw_only_deathnotices true"
                description={t("record.hudSimplifyDesc")}
                checked={opts.cl_draw_only_deathnotices}
                onChange={(v) => set({ cl_draw_only_deathnotices: v })}
                outcomeOn={t("record.hudSimplifyOutcome")}
                disabled={!!sessionPovEnabled}
                disabledReason={POV_CONFLICT_HUD}
              />
              <RecordingHudCard
                title={t("record.hudHideTargetTitle")}
                code="hud_showtargetid 0"
                description={t("record.hudHideTargetDesc")}
                checked={opts.hud_showtargetid_hide}
                onChange={(v) => set({ hud_showtargetid_hide: v })}
                outcomeOn={t("record.hudHideTargetOutcome")}
              />
              <RecordingHudCard
                title={t("record.hudNoChatTitle")}
                code="tv_nochat 1"
                description={t("record.hudNoChatDesc")}
                checked={opts.tv_nochat}
                onChange={(v) => set({ tv_nochat: v })}
                outcomeOn={t("record.hudNoChatOutcome")}
              />
              <RecordingHudCard
                title={t("record.hudHideGrenadeTitle")}
                code="sv_grenade_trajectory 0; …"
                description={t("record.hudHideGrenadeDesc")}
                checked={opts.hide_grenade_trajectory_pip}
                onChange={(v) => set({ hide_grenade_trajectory_pip: v })}
                outcomeOn={t("record.hudHideGrenadeOutcome")}
              />
            </div>

            <div className="my-4 border-t border-cs2-border" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">{t("record.warmupDemoSection")}</p>
            <div className="space-y-4">
              <RecordingHudCard
                title={t("record.hudHideDemoUiTitle")}
                code="sv_cheats 1 → demoui false"
                description={t("record.hudHideDemoUiDesc")}
                checked={opts.hide_demo_playback_ui}
                onChange={(v) => set({ hide_demo_playback_ui: v })}
                outcomeOn={t("record.hudHideDemoUiOutcome")}
              />
              <RecordingHudCard
                title={t("record.hudXrayTitle")}
                code="spec_show_xray 1 / 0"
                description={t("record.hudXrayDesc")}
                checked={opts.spec_show_xray}
                onChange={(v) => set({ spec_show_xray: v })}
                outcomeOn={t("record.hudXrayOutcome")}
              />
            </div>
          </section>

          <section aria-labelledby="sec-camera">
            <SectionHeader en="Camera & Viewmodel" zh={t("record.warmupSecCamera")} />
            <div id="sec-camera" className="space-y-4">
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={opts.apply_fov}
                    onChange={(e) => set({ apply_fov: e.target.checked })}
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
                    value={opts.fov_cs_debug}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      const n = parseInt(e.target.value, 10);
                      set({ fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)) });
                    }}
                    disabled={!opts.apply_fov}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">{t("record.warmupFovDefault")}</span>
                </div>
                {opts.apply_fov ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-[11px] leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.warmupFovOutcome")}
                  </p>
                ) : null}
              </div>
              <OptionRow
                checked={opts.viewmodel_fov_68}
                onChange={(v) => set({ viewmodel_fov_68: v })}
                title={t("record.warmupViewmodelTitle")}
                code="viewmodel_fov 68"
              />
              {opts.viewmodel_fov_68 ? (
                <p className="-mt-1 ml-1 text-[11px] leading-relaxed text-emerald-400/85">
                  {t("record.warmupViewmodelOutcome")}
                </p>
              ) : null}
              <OptionRow
                checked={opts.third_person_camera}
                onChange={(v) => set({ third_person_camera: v })}
                title={t("record.warmupThirdPersonTitle")}
                code="cam_command 1; cam_idealdist 30; c_thirdpersonshoulder 1"
              />
              {opts.third_person_camera ? (
                <p className="-mt-1 ml-1 text-[11px] leading-relaxed text-emerald-400/85">
                  {t("record.commonThirdPersonOutcome")}
                </p>
              ) : null}
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                <label
                  className={`flex items-center gap-3 ${
                    sessionPovEnabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={sessionPovEnabled || opts.apply_spectator_flashbang_opacity}
                    disabled={sessionPovEnabled}
                    onChange={(e) => set({ apply_spectator_flashbang_opacity: e.target.checked })}
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
                    value={sessionPovEnabled ? 1 : opts.spectator_flashbang_opacity}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      const n = parseFloat(e.target.value, 10);
                      set({
                        spectator_flashbang_opacity: Number.isNaN(n)
                          ? SPECTATOR_FLASHBANG_OPACITY_DEFAULT
                          : Math.min(1, Math.max(0.2, n)),
                      });
                    }}
                    disabled={sessionPovEnabled || !opts.apply_spectator_flashbang_opacity}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">{t("record.warmupFlashRange")}</span>
                </div>
                {sessionPovEnabled ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-[11px] leading-relaxed text-cs2-amber-on-surface">
                    {t("record.warmupFlashPovActive")}
                  </p>
                ) : opts.apply_spectator_flashbang_opacity ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-[11px] leading-relaxed text-cs2-emerald-on-surface">
                    {t("record.warmupFlashOutcome")}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
          </div>

          <div className="min-w-0 space-y-4">
          <ExperimentalPovSection
            visible={open}
            experimentalPovEnabled={sessionPovEnabled}
            onExperimentalPovChange={setSessionPovEnabled}
            povRadarMode={opts.pov_radar_mode}
            onPovRadarModeChange={(v) => set({ pov_radar_mode: v })}
            povTeamcounterNumeric={opts.pov_teamcounter_numeric}
            onPovTeamcounterNumericChange={(v) => set({ pov_teamcounter_numeric: v })}
          />

          <section aria-labelledby="sec-audio">
            <SectionHeader en="Audio & canvas" zh={t("record.warmupSecAudio")} />
            <div id="sec-audio" className="space-y-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">{t("record.warmupVoiceSectionLabel")}</p>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {VF_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set({ voice_filter: opt.value })}
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
              <p className={`mb-4 mt-1.5 ml-0.5 text-[11px] leading-relaxed ${vf === "open" ? "text-cs2-text-muted" : "text-emerald-400/85"}`}>
                {t(selectedVf.descKey)}
              </p>

              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                {t("record.warmupResSection")}
              </p>
              <div
                className={`rounded-xl border px-4 py-4 ${
                  resolutionError
                    ? "border-rose-500/45 bg-cs2-rose-surface"
                    : "border-cs2-border bg-cs2-bg-input/50"
                }`}
              >
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  {AR_TAGS.map(({ ar, sample, tagKey }) => {
                    const selected = opts.aspect_ratio === ar;
                    return (
                      <button
                        key={ar}
                        type="button"
                        onClick={() => set({ aspect_ratio: ar })}
                        className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? "border-cs2-accent/60 bg-cs2-accent/10"
                            : "border-cs2-border bg-cs2-bg-input/40 hover:border-cs2-border"
                        }`}
                      >
                        <p className="font-mono text-lg font-bold text-cs2-text-primary">{ar}</p>
                        <p className="mt-1 font-mono text-[11px] text-cs2-text-secondary">{sample}</p>
                        <p className="mt-1 text-[10px] text-cs2-text-muted">{t(tagKey)}</p>
                      </button>
                    );
                  })}
                </div>

                <label className="mb-3 block">
                  <span className="mb-1 block text-[11px] text-cs2-text-muted">
                    {t("record.warmupResAspectLabel")}
                  </span>
                  <select
                    value={opts.aspect_ratio}
                    onChange={(e) => set({ aspect_ratio: e.target.value })}
                    className="w-full max-w-md rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary outline-none focus:border-cs2-accent/50"
                  >
                    <option value="">{t("record.warmupResAspectNone")}</option>
                    <option value="4:3">4 : 3</option>
                    <option value="16:9">16 : 9</option>
                    <option value="16:10">16 : 10</option>
                  </select>
                </label>

                <div className="mb-3 rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-cs2-text-muted">{t("record.warmupResCurrentLabel")}</p>
                  <p className="mt-1 text-sm text-cs2-text-primary">
                    {t("record.warmupResAspectPrefix")}{" "}
                    <span className="font-mono text-cs2-accent">
                      {opts.aspect_ratio || t("record.warmupResAspectUnset")}
                    </span>
                    {" · "}
                    {t("record.warmupResValuePrefix")}{" "}
                    <span className="font-mono text-cs2-text-secondary">
                      {resSummaryDisplay}
                    </span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
                    {t(aspectHint(opts.aspect_ratio))}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
                    {t("record.warmupResExportPrefix")}{t(aspectExportHint(opts.aspect_ratio))}
                  </p>
                </div>

                <p className="mb-2 text-[11px] text-cs2-text-secondary">
                  {t("record.warmupResLaunchParamsHint")}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-cs2-text-muted">-w</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={opts.resolution_width}
                    onChange={(e) => set({ resolution_width: e.target.value })}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted"
                  />
                  <span className="font-mono text-xs text-cs2-text-muted">-h</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={opts.resolution_height}
                    onChange={(e) => set({ resolution_height: e.target.value })}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted"
                  />
                </div>
                {resolutionError ? (
                  <p className="mt-2 text-[11px] leading-snug text-rose-400">{resolutionError}</p>
                ) : (
                  <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-muted">
                    {t("record.warmupResLeaveBlankHint")}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="sec-launch">
            <SectionHeader en="Launch & console" zh={t("record.warmupSecLaunch")} />
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">
              {t("record.warmupCmdLabel")}
            </p>
            <Cs2LaunchConsoleFields
              cs2ExtraLaunchArgs={sessionCs2ExtraLaunchArgs}
              onCs2ExtraLaunchArgsChange={setSessionCs2ExtraLaunchArgs}
              recordInjectConsoleLines={sessionRecordInjectConsoleLines}
              onRecordInjectConsoleLinesChange={setSessionRecordInjectConsoleLines}
            />
          </section>

          </div>
        </div>

          <p className="mt-4 font-mono text-[11px] leading-relaxed text-cs2-text-muted">
            {t("record.warmupWarmupCount", {
              base: baseWarmupCmdCount,
              extra: injectExtraCount,
              total: baseWarmupCmdCount + injectExtraCount,
            })}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-cs2-border bg-cs2-bg-input/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-cs2-border px-4 py-2 text-sm font-semibold text-cs2-text-secondary hover:bg-cs2-bg-input/50"
            >
              {t("record.warmupBtnCancel")}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={Boolean(resolutionError)}
              className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t("record.warmupBtnStart")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
