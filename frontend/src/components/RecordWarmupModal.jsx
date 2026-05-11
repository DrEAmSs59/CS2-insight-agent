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
  const lines = ["cl_hud_telemetry_frametime_show 0"];
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
  if (o.snd_voipvolume_mute) {
    lines.push("snd_voipvolume 0");
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
  snd_voipvolume_mute: true,
  hide_demo_playback_ui: true,
  hide_grenade_trajectory_pip: true,
  aspect_ratio: "",
  resolution_width: "",
  resolution_height: "",
  /** POV：cl_drawhud_force_radar，-1 隐藏，0 显示 */
  pov_radar_mode: -1,
  /** POV：true 正上方显示存活人数；false 显示双方十人头像 */
  pov_teamcounter_numeric: true,
};

export function SectionHeader({ en, zh }) {
  return (
    <div className="mb-2 flex items-end gap-2 px-0.5">
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-zinc-500">{en}</p>
        <p className="text-[11px] font-semibold text-zinc-400">{zh}</p>
      </div>
      <div className="mb-1 h-px min-w-[2rem] flex-1 bg-gradient-to-r from-white/[0.12] via-white/[0.06] to-transparent" />
    </div>
  );
}

export function OptionRow({ checked, onChange, title, code, disabled = false, disabledReason }) {
  return (
    <label
      title={disabled ? disabledReason : undefined}
      className={`flex items-start gap-3 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5 transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-45"
          : "cursor-pointer hover:border-cs2-orange/25"
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
      <span className="min-w-0 text-sm leading-snug text-zinc-200">
        {title}{" "}
        <code className="whitespace-pre-wrap break-all text-[11px] text-cs2-orange/90">{code}</code>
      </span>
    </label>
  );
}

/**
 * 一键录制前：分组观战 / 摄像机 / 音频与启动项；提交时生成 console_cmds 供后端注入。
 * 额外启动参数与附加控制台与「常用参数」共用配置，由 onPersistCs2RecordExtras 防抖写入。
 */
export default function RecordWarmupModal({
  open,
  onClose,
  onConfirm,
  defaultOverrides,
  experimentalPovEnabled = false,
  onExperimentalPovChange,
  cs2ExtraLaunchArgs = "",
  onCs2ExtraLaunchArgsChange,
  recordInjectConsoleLines = "",
  onRecordInjectConsoleLinesChange,
  onPersistCs2RecordExtras,
}) {
  const [opts, setOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [resolutionError, setResolutionError] = useState("");

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
  }, [open, defaultOverrides]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const vr = validateWarmupResolution(opts);
      setResolutionError(vr.ok ? "" : vr.message);
    }, 400);
    return () => clearTimeout(t);
  }, [open, opts.aspect_ratio, opts.resolution_width, opts.resolution_height]);

  useEffect(() => {
    if (!open || !onPersistCs2RecordExtras) return;
    const t = setTimeout(() => {
      void onPersistCs2RecordExtras({
        cs2_extra_launch_args: cs2ExtraLaunchArgs,
        record_inject_console_lines: recordInjectConsoleLines,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [
    open,
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
    onPersistCs2RecordExtras,
  ]);

  const injectExtraCount = useMemo(
    () => countInjectConsoleLines(recordInjectConsoleLines),
    [recordInjectConsoleLines],
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
      snd_voipvolume_mute: opts.snd_voipvolume_mute,
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

    onConfirm({ ...apiShape, console_cmds });
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
      <div className="relative flex max-h-[min(94vh,920px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/[0.1] bg-cs2-bg-card shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 pb-4 @container/params">
        <h2 id="record-warmup-title" className="mb-1 pr-8 text-lg font-bold tracking-tight text-white">
          录制前观战选项
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-zinc-500">
          以下命令在首次跳转 tick 前的<strong className="text-zinc-400">预热阶段</strong>
          注入（与空格预热同批控制台）。隐藏 Demo 条需 <code className="text-cs2-orange/90">sv_cheats 1</code>{" "}
          与 <code className="text-cs2-orange/90">demoui false</code>（启动已带 <code className="text-zinc-500">-insecure</code>
          ）。分辨率以 <code className="text-cs2-orange/90">-w</code> / <code className="text-cs2-orange/90">-h</code>{" "}
          附加到本次 CS2 进程。
          <span className="mt-1 block text-zinc-500">
            下方「额外启动参数 / 附加预热控制台」与常用参数页一致，写入同一配置文件。
          </span>
        </p>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="min-w-0 space-y-4">
          <section aria-labelledby="sec-visuals">
            <SectionHeader en="Visuals & HUD" zh="视觉与 UI" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">录制画面效果</p>
            <div id="sec-visuals" className="grid gap-3 sm:grid-cols-2">
              <RecordingHudCard
                title="简化观战 HUD"
                code="cl_draw_only_deathnotices true"
                description="仅保留击杀公告等核心提示，弱化其余观战 UI。"
                checked={opts.cl_draw_only_deathnotices}
                onChange={(v) => set({ cl_draw_only_deathnotices: v })}
                outcomeOn="成片观战 HUD 以精简样式呈现，减少界面干扰。"
                disabled={!!experimentalPovEnabled}
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

            <div className="my-4 border-t border-white/[0.08]" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Demo 条与透视</p>
            <div className="space-y-3">
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
            <div id="sec-camera" className="space-y-3">
              <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={opts.apply_fov}
                    onChange={(e) => set({ apply_fov: e.target.checked })}
                    className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                  />
                  <span className="text-sm text-zinc-200">
                    应用 FOV（<code className="text-xs text-cs2-orange">fov_cs_debug</code>）
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
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40"
                  />
                  <span className="text-xs text-zinc-500">默认 90</span>
                </div>
                {opts.apply_fov ? (
                  <p className="mt-2 border-t border-white/[0.06] pt-2 pl-7 text-[10px] leading-relaxed text-emerald-400/90">
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
                <p className="-mt-1 ml-1 text-[10px] leading-relaxed text-emerald-400/85">
                  成片预期：手臂与枪械模型更贴近画面边缘，竞技剪辑常见「拉伸持枪」观感。
                </p>
              ) : null}
            </div>
          </section>
          </div>

          <div className="min-w-0 space-y-4">
          <section aria-labelledby="sec-launch">
            <SectionHeader en="Launch & console" zh="启动与控制台" />
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              命令行与控制台
            </p>
            <Cs2LaunchConsoleFields
              cs2ExtraLaunchArgs={cs2ExtraLaunchArgs}
              onCs2ExtraLaunchArgsChange={onCs2ExtraLaunchArgsChange}
              recordInjectConsoleLines={recordInjectConsoleLines}
              onRecordInjectConsoleLinesChange={onRecordInjectConsoleLinesChange}
            />
          </section>

          <section aria-labelledby="sec-audio">
            <SectionHeader en="Audio & canvas" zh="音频与画布" />
            <div id="sec-audio" className="space-y-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">采集与静音</p>
              <OptionRow
                checked={opts.snd_voipvolume_mute}
                onChange={(v) => set({ snd_voipvolume_mute: v })}
                title="静音游戏内玩家语音"
                code="snd_voipvolume 0"
              />
              {opts.snd_voipvolume_mute ? (
                <p className="mb-4 ml-1 text-[10px] leading-relaxed text-emerald-400/85">
                  成片预期：录制轨中不包含其他玩家语音（仍可能包含游戏内其他音效，取决于游戏与 OBS）。
                </p>
              ) : (
                <p className="mb-4 ml-1 text-[10px] text-zinc-600">
                  成片预期：可能录到队内语音（取决于游戏内语音与 OBS 音轨设置）。
                </p>
              )}

              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                录制输出比例
              </p>
              <div
                className={`rounded-xl border px-4 py-4 ${
                  resolutionError
                    ? "border-rose-500/45 bg-rose-950/25"
                    : "border-white/[0.08] bg-black/30"
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
                            ? "border-cs2-orange/60 bg-cs2-orange/10"
                            : "border-white/[0.06] bg-black/25 hover:border-white/15"
                        }`}
                      >
                        <p className="font-mono text-lg font-bold text-white">{ar}</p>
                        <p className="mt-1 font-mono text-[11px] text-zinc-400">{sample}</p>
                        <p className="mt-1 text-[10px] text-zinc-500">{tag}</p>
                      </button>
                    );
                  })}
                </div>

                <label className="mb-3 block">
                  <span className="mb-1 block text-[11px] text-zinc-500">
                    屏幕比例（与 -w / -h 联动校验）
                  </span>
                  <select
                    value={opts.aspect_ratio}
                    onChange={(e) => set({ aspect_ratio: e.target.value })}
                    className="w-full max-w-md rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white outline-none focus:border-cs2-orange/50"
                  >
                    <option value="">不填写启动分辨率</option>
                    <option value="4:3">4 : 3</option>
                    <option value="16:9">16 : 9</option>
                    <option value="16:10">16 : 10</option>
                  </select>
                </label>

                <div className="mb-3 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-zinc-500">当前解析</p>
                  <p className="mt-1 text-sm text-zinc-200">
                    比例{" "}
                    <span className="font-mono text-cs2-orange">
                      {opts.aspect_ratio || "（未选）"}
                    </span>
                    {" · "}
                    分辨率{" "}
                    <span className="font-mono text-zinc-300">
                      {formatResolutionSummary(
                        opts.aspect_ratio,
                        opts.resolution_width,
                        opts.resolution_height,
                      )}
                    </span>
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    {aspectHint(opts.aspect_ratio)}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                    最终导出方向：{aspectExportHint(opts.aspect_ratio)}
                  </p>
                </div>

                <p className="mb-2 text-[11px] text-zinc-400">
                  启动参数（可选，不填则为本机当前游戏分辨率）
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">-w</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={opts.resolution_width}
                    onChange={(e) => set({ resolution_width: e.target.value })}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                  />
                  <span className="font-mono text-xs text-zinc-500">-h</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={opts.resolution_height}
                    onChange={(e) => set({ resolution_height: e.target.value })}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                  />
                </div>
                {resolutionError ? (
                  <p className="mt-2 text-[11px] leading-snug text-rose-400">{resolutionError}</p>
                ) : (
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                    留空宽高则沿用当前分辨率；若填写宽高须选择比例且化简后须匹配（4:3 含游戏内同组的 5:4，如
                    1280×1024）。
                  </p>
                )}
              </div>
            </div>
          </section>

          <ExperimentalPovSection
            visible={open}
            experimentalPovEnabled={experimentalPovEnabled}
            onExperimentalPovChange={onExperimentalPovChange}
            checkboxDisabled={!onExperimentalPovChange}
            povRadarMode={opts.pov_radar_mode}
            onPovRadarModeChange={(v) => set({ pov_radar_mode: v })}
            povTeamcounterNumeric={opts.pov_teamcounter_numeric}
            onPovTeamcounterNumericChange={(v) => set({ pov_teamcounter_numeric: v })}
          />

          </div>
        </div>

          <p className="mt-4 font-mono text-[10px] leading-relaxed text-zinc-600">
            首片段预热：基础控制台 {baseWarmupCmdCount} 条 + 附加有效行 {injectExtraCount} 条，合计约{" "}
            {baseWarmupCmdCount + injectExtraCount} 条（# // 注释行不计入附加）
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-white/[0.08] bg-black/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-cs2-border px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-white/[0.04]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={Boolean(resolutionError)}
              className="rounded-lg bg-cs2-orange px-4 py-2 text-sm font-extrabold text-black hover:bg-cs2-orange-light disabled:cursor-not-allowed disabled:opacity-45"
            >
              开始录制
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
