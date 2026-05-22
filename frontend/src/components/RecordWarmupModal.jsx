import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  aspectExportHint,
  aspectHint,
  formatResolutionSummary,
  validateWarmupResolution,
} from "../utils/warmupDefaults";
import ExperimentalPovSection from "./ExperimentalPovSection";
import Cs2LaunchConsoleFields, { countInjectConsoleLines } from "./Cs2LaunchConsoleFields";
import { POV_CONFLICT_HUD, RecordingHudCard } from "./RecordingHudCard";

/** 与后端 `RecordingWarmupExtras._recording_warmup_console_lines` 拼装顺序一致（无 console_cmds 覆盖时） */
export function buildWarmupConsoleCommands(o) {
  const lines = [
    "cl_hud_telemetry_frametime_show 0",
    "engine_no_focus_sleep 0",
    "cl_demo_predict 0",
    "fps_max 0",
  ];
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
  const vf = o.voice_filter ?? "mute";
  if (vf === "mute" || vf === "all") {
    lines.push("snd_voipvolume 0");
  } else if (vf === "open") {
    lines.push("snd_voipvolume 1");
    lines.push("tv_listen_voice_indices -1");
  } else if (vf === "off") {
    // 不注入语音指令
  } else {
    // "team" / "enemy"：先打开全员基线，per-segment 再收窄到掩码
    // all_players 为空时以"全部可听"降级，而不是静音
    lines.push("snd_voipvolume 1");
    lines.push("tv_listen_voice_indices -1");
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
  return (
    <label
      title={disabled ? disabledReason : undefined}
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
}) {
  const [opts, setOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [resolutionError, setResolutionError] = useState("");
  const [obsTransEnabled, setObsTransEnabled] = useState(null);  // null = use global
  const [obsTransName, setObsTransName] = useState(null);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(null);
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
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
  ]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const vr = validateWarmupResolution(opts);
      setResolutionError(vr.ok ? "" : vr.message);
    }, 400);
    return () => clearTimeout(t);
  }, [open, opts.aspect_ratio, opts.resolution_width, opts.resolution_height]);

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
      setResolutionError(vr.message);
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
    });

    onConfirm({
        ...apiShape,
        console_cmds,
        obs_transition_enabled: obsTransEnabled,
        obs_transition_name: obsTransName,
        obs_transition_duration_ms: obsTransDurationMs,
        experimental_pov_enabled: sessionPovEnabled,
        session_cs2_extra_launch_args: sessionCs2ExtraLaunchArgs,
        session_record_inject_console_lines: sessionRecordInjectConsoleLines,
      });
  };

  if (!open) return null;

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
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 pb-4 @container/params">
        <h2 id="record-warmup-title" className="mb-1 pr-8 text-lg font-bold tracking-tight text-cs2-text-primary">
          录制前观战选项
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-cs2-text-muted">
          以下命令在首次跳转 tick 前的<strong className="text-cs2-text-secondary">预热阶段</strong>
          注入（与空格预热同批控制台）。隐藏 Demo 条需 <code className="text-cs2-accent/90">sv_cheats 1</code>{" "}
          与 <code className="text-cs2-accent/90">demoui false</code>（启动已带 <code className="text-cs2-text-muted">-insecure</code>
          ）。分辨率以 <code className="text-cs2-accent/90">-w</code> / <code className="text-cs2-accent/90">-h</code>{" "}
          附加到本次 CS2 进程。
          <span className="mt-1 block text-cs2-text-muted">
            默认选项来自「常用参数」；此处修改仅作用于本次录制，不会写入配置文件。
          </span>
        </p>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="min-w-0 space-y-4">
          <section aria-labelledby="sec-obs-fade">
            <SectionHeader en="OBS Transition" zh="OBS 转场" />
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
                <span className="text-sm text-cs2-text-primary">启用黑场渐入渐出</span>
              </label>
              <p className="mt-2 pl-7 text-xs leading-relaxed text-cs2-text-muted">
                切换视角之间的转场效果。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
                <select
                  value={obsTransName ?? ""}
                  onChange={(e) => setObsTransName(e.target.value || null)}
                  disabled={obsTransEnabled !== true}
                  className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-sm text-cs2-text-primary disabled:opacity-40"
                >
                  <option value="Fade">淡入淡出</option>
                  <option value="Cut">直切</option>
                  <option value="Swipe">滑动</option>
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

          <section aria-labelledby="sec-visuals">
            <SectionHeader en="Visuals & HUD" zh="视觉与 UI" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">录制画面效果</p>
            <div id="sec-visuals" className="grid gap-3 sm:grid-cols-2">
              <RecordingHudCard
                title="简化观战 HUD"
                code="cl_draw_only_deathnotices true"
                description="仅保留击杀公告等核心提示，弱化其余观战 UI。"
                checked={opts.cl_draw_only_deathnotices}
                onChange={(v) => set({ cl_draw_only_deathnotices: v })}
                outcomeOn="成片观战 HUD 以精简样式呈现，减少界面干扰。"
                disabled={!!sessionPovEnabled}
                disabledReason={POV_CONFLICT_HUD}
              />
              <RecordingHudCard
                title="隐藏准星目标信息"
                code="hud_showtargetid 0"
                description="准星指向玩家时不再弹出名称与血量提示。"
                checked={opts.hud_showtargetid_hide}
                onChange={(v) => set({ hud_showtargetid_hide: v })}
                outcomeOn="最终画面中不出现准星下的 ID / 血量条提示。"
              />
              <RecordingHudCard
                title="屏蔽文字聊天"
                code="tv_nochat 1"
                description="隐藏观战文字聊天区域。"
                checked={opts.tv_nochat}
                onChange={(v) => set({ tv_nochat: v })}
                outcomeOn="导出视频中不显示文字聊天栏。"
              />
              <RecordingHudCard
                title="隐藏投掷物轨迹与画中窗"
                code="sv_grenade_trajectory 0; …"
                description="关闭投掷物轨迹、练习画中窗与时间轴。"
                checked={opts.hide_grenade_trajectory_pip}
                onChange={(v) => set({ hide_grenade_trajectory_pip: v })}
                outcomeOn="画面中不出现投掷物轨迹线与辅助画中窗。"
              />
            </div>

            <div className="my-4 border-t border-cs2-border" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">Demo 条与透视</p>
            <div className="space-y-4">
              <RecordingHudCard
                title="隐藏 Demo 进度条与回放控制条"
                code="sv_cheats 1 → demoui false"
                description="预热阶段关闭 Demo UI 条，需临时开启作弊指令通道。"
                checked={opts.hide_demo_playback_ui}
                onChange={(v) => set({ hide_demo_playback_ui: v })}
                outcomeOn="回放进度条与控制台 Demo 控制条不会出现在采集画面中。"
              />
              <RecordingHudCard
                title="开启 X 光透视"
                code="spec_show_xray 1 / 0"
                description="观战穿透显示轮廓（竞技裁判视角常用）。"
                checked={opts.spec_show_xray}
                onChange={(v) => set({ spec_show_xray: v })}
                outcomeOn="墙后可透视敌方轮廓，成片更具「上帝视角」信息密度。"
              />
            </div>
          </section>

          <section aria-labelledby="sec-camera">
            <SectionHeader en="Camera & Viewmodel" zh="摄像机与持枪" />
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
                    应用 FOV（<code className="text-xs text-cs2-accent">fov_cs_debug</code>）
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
                      const n = parseInt(e.target.value, 10);
                      set({ fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)) });
                    }}
                    disabled={!opts.apply_fov}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">默认 90</span>
                </div>
                {opts.apply_fov ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-[11px] leading-relaxed text-cs2-emerald-on-surface">
                    成片预期：视野角度按设定值渲染，影响镜头透视与边缘拉伸感。
                  </p>
                ) : null}
              </div>
              <OptionRow
                checked={opts.viewmodel_fov_68}
                onChange={(v) => set({ viewmodel_fov_68: v })}
                title="开启极限持枪视角"
                code="viewmodel_fov 68"
              />
              {opts.viewmodel_fov_68 ? (
                <p className="-mt-1 ml-1 text-[11px] leading-relaxed text-emerald-400/85">
                  成片预期：手臂与枪械模型更贴近画面边缘，竞技剪辑常见「拉伸持枪」观感。
                </p>
              ) : null}
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
            <SectionHeader en="Audio & canvas" zh="音频与画布" />
            <div id="sec-audio" className="space-y-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">采集与静音</p>
              {(() => {
                const vf = opts.voice_filter ?? "mute";
                const VF_OPTIONS = [
                  { value: "open",  label: "所有玩家",   code: "tv_listen_voice_indices -1",     desc: "录制轨包含所有玩家语音。" },
                  { value: "team",  label: "第一视角我方", code: "tv_listen_voice_indices <mask>", desc: "只保留主角所在队伍的语音。" },
                  { value: "enemy", label: "第一视角敌方", code: "tv_listen_voice_indices <mask>", desc: "只保留对方队伍的语音。" },
                  { value: "mute",  label: "全部静音",   code: "snd_voipvolume 0",              desc: "录制轨不含任何玩家语音。" },
                ];
                const selected = VF_OPTIONS.find((o) => o.value === vf) ?? VF_OPTIONS[3];
                return (
                  <>
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
                          <p className="text-[11px] font-semibold text-cs2-text-primary">{opt.label}</p>
                          <p className="mt-0.5 font-mono text-[9px] text-cs2-text-muted">{opt.code}</p>
                        </button>
                      ))}
                    </div>
                    <p className={`mb-4 mt-1.5 ml-0.5 text-[11px] leading-relaxed ${vf === "open" ? "text-cs2-text-muted" : "text-emerald-400/85"}`}>
                      {selected.desc}
                    </p>
                  </>
                );
              })()}

              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                录制输出比例
              </p>
              <div
                className={`rounded-xl border px-4 py-4 ${
                  resolutionError
                    ? "border-rose-500/45 bg-cs2-rose-surface"
                    : "border-cs2-border bg-cs2-bg-input/50"
                }`}
              >
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  {[
                    { ar: "4:3", sample: "1920×1440", tag: "赛事 / 复古构图" },
                    { ar: "16:9", sample: "1920×1080", tag: "流媒体默认" },
                    { ar: "16:10", sample: "1920×1200", tag: "宽屏显示器" },
                  ].map(({ ar, sample, tag }) => {
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
                        <p className="mt-1 text-[10px] text-cs2-text-muted">{tag}</p>
                      </button>
                    );
                  })}
                </div>

                <label className="mb-3 block">
                  <span className="mb-1 block text-[11px] text-cs2-text-muted">
                    屏幕比例（与 -w / -h 联动校验）
                  </span>
                  <select
                    value={opts.aspect_ratio}
                    onChange={(e) => set({ aspect_ratio: e.target.value })}
                    className="w-full max-w-md rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary outline-none focus:border-cs2-accent/50"
                  >
                    <option value="">不填写启动分辨率</option>
                    <option value="4:3">4 : 3</option>
                    <option value="16:9">16 : 9</option>
                    <option value="16:10">16 : 10</option>
                  </select>
                </label>

                <div className="mb-3 rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-cs2-text-muted">当前解析</p>
                  <p className="mt-1 text-sm text-cs2-text-primary">
                    比例{" "}
                    <span className="font-mono text-cs2-accent">
                      {opts.aspect_ratio || "（未选）"}
                    </span>
                    {" · "}
                    分辨率{" "}
                    <span className="font-mono text-cs2-text-secondary">
                      {formatResolutionSummary(
                        opts.aspect_ratio,
                        opts.resolution_width,
                        opts.resolution_height,
                      )}
                    </span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
                    {aspectHint(opts.aspect_ratio)}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
                    最终导出方向：{aspectExportHint(opts.aspect_ratio)}
                  </p>
                </div>

                <p className="mb-2 text-[11px] text-cs2-text-secondary">
                  启动参数（可选，不填则为本机当前游戏分辨率）
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
                    留空宽高则沿用当前分辨率；若填写宽高须选择比例且化简后须匹配（4:3 含游戏内同组的 5:4，如
                    1280×1024）。
                  </p>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="sec-launch">
            <SectionHeader en="Launch & console" zh="启动与控制台" />
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">
              命令行与控制台
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
            首片段预热：基础控制台 {baseWarmupCmdCount} 条 + 附加有效行 {injectExtraCount} 条，合计约{" "}
            {baseWarmupCmdCount + injectExtraCount} 条（# // 注释行不计入附加）
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-cs2-border bg-cs2-bg-input/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-cs2-border px-4 py-2 text-sm font-semibold text-cs2-text-secondary hover:bg-cs2-bg-input/50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={Boolean(resolutionError)}
              className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-45"
            >
              开始录制
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
