import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { OptionRow, RECORD_WARMUP_DEFAULT_OPTIONS } from "./RecordWarmupModal";
import ExperimentalPovSection from "./ExperimentalPovSection";
import { BACKEND_DEFAULT_PACING, useRecordingQueue } from "../stores/recordingQueueStore";
import Cs2LaunchConsoleFields from "./Cs2LaunchConsoleFields";
import { POV_CONFLICT_HUD, RecordingHudCard } from "./RecordingHudCard";
import {
  aspectExportHint,
  aspectHint,
  formatResolutionSummary,
  warmupUiOptsToPersisted,
  validateWarmupResolution,
} from "../utils/warmupDefaults";

/** 未写入配置时的展示用回退（与队列微调面板一致） */
const FB_VIC_PRE = 1.5;
const FB_VIC_POST = 1.0;
const FB_KILL_PRE = 3.0;
const FB_KILL_POST = 1.5;

function WorkflowSection({ title, subtitle, badge, defaultOpen = true, accentClass = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`rounded-xl border border-white/[0.08] bg-black/20 shadow-sm ${accentClass}`.trim()}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03] sm:px-5"
      >
        <span className="mt-0.5 shrink-0 text-zinc-500">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold tracking-tight text-white">{title}</h3>
            {badge}
          </div>
          {subtitle ? (
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{subtitle}</p>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="border-t border-white/[0.06] px-4 py-4 sm:px-5 sm:py-5">{children}</div>
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
    <label className="block text-[10px] text-zinc-500">
      {label}
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onCommit(parseFloat(e.target.value))}
          className={`min-w-0 flex-1 disabled:opacity-40 ${accentClass}`}
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
          className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
        />
      </div>
    </label>
  );
}

/**
 * 常用参数：内联编辑「全局节奏（数值）+ 入队默认 POV」与「录制前观战默认选项」，写入 data/cs2-insight.config.json。
 */
export default function CommonParamsModal({
  open,
  onClose,
  variant = "modal",
  batchRecording,
  savedWarmupDefaults,
  onPersistWarmupDefaults,
  experimentalPovEnabled,
  onExperimentalPovChange,
  cs2ExtraLaunchArgs = "",
  onCs2ExtraLaunchArgsChange,
  recordInjectConsoleLines = "",
  onRecordInjectConsoleLinesChange,
  onPersistCs2RecordExtras,
  specPlayerVerify,
  patchSpecPlayerVerify,
}) {
  const isPage = variant === "page";
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetNumericGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);

  const post = globalPacing.post_last_sec ?? BACKEND_DEFAULT_PACING.post_last_sec;
  const pre = globalPacing.pre_first_sec ?? BACKEND_DEFAULT_PACING.pre_first_sec;
  const gap = globalPacing.max_gap_sec ?? BACKEND_DEFAULT_PACING.max_gap_sec;

  const victimPovPre = globalPacing.victim_pov_pre_sec ?? FB_VIC_PRE;
  const victimPovPost = globalPacing.victim_pov_post_sec ?? FB_VIC_POST;
  const killerPovPre = globalPacing.killer_pov_pre_sec ?? FB_KILL_PRE;
  const killerPovPost = globalPacing.killer_pov_post_sec ?? FB_KILL_POST;

  const commitPacingNumbers = useCallback(
    (partial) => {
      const next = Object.fromEntries(
        Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      );
      if (Object.keys(next).length) setGlobalPacing(next);
    },
    [setGlobalPacing]
  );

  const [warmupOpts, setWarmupOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [warmupResolutionError, setWarmupResolutionError] = useState("");

  useEffect(() => {
    if (!open && !isPage) return;
    setWarmupResolutionError("");
  }, [open, isPage]);

  useEffect(() => {
    if (!open && !isPage) return;
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
  }, [open, isPage]);

  const patchWarmup = useCallback((patch) => {
    setWarmupOpts((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    if ((!open && !isPage) || !onPersistWarmupDefaults) return;
    const t = setTimeout(() => {
      const vr = validateWarmupResolution(warmupOpts);
      if (!vr.ok) {
        setWarmupResolutionError(vr.message);
        return;
      }
      setWarmupResolutionError("");
      onPersistWarmupDefaults(warmupUiOptsToPersisted(warmupOpts));
    }, 500);
    return () => clearTimeout(t);
  }, [warmupOpts, open, isPage, onPersistWarmupDefaults]);

  useEffect(() => {
    if ((!open && !isPage) || !onPersistCs2RecordExtras) return;
    const t = setTimeout(() => {
      void onPersistCs2RecordExtras({
        cs2_extra_launch_args: cs2ExtraLaunchArgs,
        record_inject_console_lines: recordInjectConsoleLines,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
    open,
    isPage,
    onPersistCs2RecordExtras,
  ]);

  if (!open && !isPage) return null;

  const outerClass = isPage
    ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
    : "flex max-h-[min(94vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl";

  const preFlex = Math.max(pre, 0.35);
  const postFlex = Math.max(post, 0.35);
  const midFlex = 1.6;

  const body = (
    <>
      <div className={outerClass}>
        {!isPage ? (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0 pr-2">
            <h2 id="common-params-title" className="text-sm font-bold text-white">
              录制行为控制台
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              在此定义<strong className="text-zinc-400">全局录制节奏</strong>、
              <strong className="text-zinc-400">默认镜头逻辑</strong>与
              <strong className="text-zinc-400">预热阶段画面规则</strong>。数值写入{" "}
              <span className="font-mono text-zinc-400">data/cs2-insight.config.json</span>
              ；节奏与入队默认视角影响<strong className="text-zinc-400">之后新加入队列</strong>
              的片段，预热选项在批量录制确认时沿用。
            </p>
          </div>
          {!isPage ? (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4">
          <div className="@container/params w-full min-w-0">
            <div className="grid min-w-0 grid-cols-1 gap-3 pb-2 @min-[52rem]/params:grid-cols-2 @min-[52rem]/params:items-start @min-[52rem]/params:gap-5 @min-[52rem]/params:pb-4">
              <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/params:gap-4">
          {/* A1 时间与多段节奏 */}
          <WorkflowSection
            title="时间与多段节奏"
            subtitle="成片击杀前/击杀后预留、多段衔接阈值与全局节奏重置；决定导出片的时间结构。"
            defaultOpen
          >
            <div className="mb-5 overflow-hidden rounded-lg border border-white/[0.07] bg-black/35 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                片段时间流
              </p>
              <div className="mb-2 flex min-h-[3rem] w-full overflow-hidden rounded-md">
                <div
                  style={{ flex: preFlex }}
                  className="flex min-w-0 flex-col justify-center border-r border-black/30 bg-gradient-to-br from-cs2-orange/35 to-cs2-orange/10 px-2 py-1.5"
                >
                  <span className="text-[9px] font-bold uppercase tracking-wide text-white/90">
                    击杀前预留
                  </span>
                  <span className="font-mono text-[11px] text-white">{pre}s</span>
                </div>
                <div
                  style={{ flex: midFlex }}
                  className="flex min-w-[5.5rem] flex-col items-center justify-center border-r border-black/30 bg-white/[0.06] px-2 py-1.5 text-center"
                >
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
                    精彩片段
                  </span>
                  <span className="mt-0.5 text-[9px] leading-snug text-zinc-500">
                    解析得到的击杀 / 高光主体段
                  </span>
                </div>
                <div
                  style={{ flex: postFlex }}
                  className="flex min-w-0 flex-col justify-center bg-gradient-to-bl from-cyan-500/25 to-cyan-500/5 px-2 py-1.5"
                >
                  <span className="text-[9px] font-bold uppercase tracking-wide text-white/90">
                    击杀后预留
                  </span>
                  <span className="font-mono text-[11px] text-white">{post}s</span>
                </div>
              </div>
              <p className="text-[10px] leading-relaxed text-zinc-500">
                左段为击杀前预留、右段为击杀后预留；中间为解析得到的高光主体（时长由片段本身决定）。左右数值即每段击杀前回拨与每次击杀后收束的松紧；智能跳剪各段一致。
              </p>
            </div>

            <div className="mb-4 grid gap-4 sm:grid-cols-2">
              <PacingSlider
                label="击杀前预留 (秒)"
                min={0}
                max={20}
                step={0.1}
                value={pre}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ pre_first_sec: n })}
              />
              <PacingSlider
                label="击杀后预留 (秒)"
                min={0}
                max={10}
                step={0.1}
                value={post}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ post_last_sec: n })}
              />
            </div>

            <div className="rounded-lg border border-amber-500/15 bg-amber-950/10 px-3 py-2.5">
              <PacingSlider
                label="防跳剪阈值 (秒) — 相邻片段间隔小于该值时合并为一段成片"
                min={2}
                max={70}
                step={0.5}
                value={gap}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ max_gap_sec: n })}
                accentClass="accent-amber-500"
              />
              <p className="mt-2 text-[10px] text-zinc-500">
                成片预期：间隔极短的连续击杀更适合连成一段，避免频繁硬切；阈值越大合并越积极。
              </p>
            </div>

            <button
              type="button"
              disabled={batchRecording}
              onClick={() => resetNumericGlobalPacing()}
              className="mt-4 text-[9px] text-zinc-600 hover:text-zinc-400 disabled:opacity-40"
            >
              恢复数值类节奏为后端内置默认（保留入队默认视角与 POV 时序默认值）
            </button>
          </WorkflowSection>

          <WorkflowSection
            title="观战槽位 GSI 校验"
            subtitle="注入 spec_player 后用 GSI 核对当前观战是否为目标 Steam；校验阶段的 demo 倍率过小可避免准备耗时吃掉「击杀后预留」时间轴。"
            defaultOpen={false}
            accentClass="ring-1 ring-emerald-500/10"
          >
            <div className="mb-3 text-[10px] leading-relaxed text-zinc-500">
              写入 <span className="font-mono text-zinc-400">spec_player_verify</span>{" "}
              配置块；与全局节奏、POV 时序同级持久化。
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <PacingSlider
                label="校验期 demo_timescale（越小越不推进时间轴，默认 0.05）"
                min={0.01}
                max={0.5}
                step={0.01}
                value={specPlayerVerify.demo_timescale}
                disabled={batchRecording}
                onCommit={(n) => patchSpecPlayerVerify({ demo_timescale: n })}
                accentClass="accent-emerald-500"
              />
              <PacingSlider
                label="单次重试最长等待 GSI（秒）"
                min={0.1}
                max={3}
                step={0.05}
                value={specPlayerVerify.per_retry_timeout_sec}
                disabled={batchRecording}
                onCommit={(n) => patchSpecPlayerVerify({ per_retry_timeout_sec: n })}
                accentClass="accent-emerald-500"
              />
              <PacingSlider
                label="每次 spec 注入后等待（秒）"
                min={0}
                max={0.5}
                step={0.02}
                value={specPlayerVerify.settle_sec}
                disabled={batchRecording}
                onCommit={(n) => patchSpecPlayerVerify({ settle_sec: n })}
                accentClass="accent-emerald-500"
              />
              <PacingSlider
                label="最多重试次数（依次 spec_player+1）"
                min={1}
                max={16}
                step={1}
                value={specPlayerVerify.max_retries}
                disabled={batchRecording}
                onCommit={(n) => patchSpecPlayerVerify({ max_retries: Math.round(n) })}
                accentClass="accent-emerald-500"
              />
            </div>
          </WorkflowSection>

          {/* A2 镜头与 POV */}
          <WorkflowSection
            title="镜头与 POV"
            subtitle="受害者 / 击杀者追加视角、FOV 与持枪模型、实验性 POV；入队默认与解析名单类型相关。"
            defaultOpen
            accentClass="ring-1 ring-white/[0.04]"
          >
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border-l-4 border-cyan-500/55 bg-cyan-950/15 pl-4 pr-3 py-3">
                <p className="text-[11px] font-bold text-cyan-200/95">受害者镜头</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  击杀前 / 死亡后停留，形成「先看你被杀」的镜头切换逻辑。
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={globalPacing.default_victim_pov === true}
                    onChange={(e) => setGlobalPacing({ default_victim_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cyan-500 disabled:opacity-40"
                  />
                  <span className="text-[11px] leading-snug text-zinc-300">
                    新入队片段默认开启「追加受害者视角」（高光 / 合集高光等适用）
                  </span>
                </label>
                {globalPacing.default_victim_pov ? (
                  <p className="mt-2 text-[10px] leading-relaxed text-emerald-400/90">
                    成片预期：适用片段在击杀后会短暂切到受害者 POV，突出「被击杀瞬间」。
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label="击杀前预留 (秒)"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={victimPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_pre_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                  <PacingSlider
                    label="死亡后停留 (秒)"
                    min={0}
                    max={5}
                    step={0.5}
                    value={victimPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_post_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                </div>
              </div>

              <div className="rounded-xl border-l-4 border-amber-500/55 bg-amber-950/15 pl-4 pr-3 py-3">
                <p className="text-[11px] font-bold text-amber-200/95">击杀者镜头</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  击杀前 / 击杀后停留，与受害者侧对照，形成「谁在动手」的镜头叙事。
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={globalPacing.default_killer_pov === true}
                    onChange={(e) => setGlobalPacing({ default_killer_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-amber-500 disabled:opacity-40"
                  />
                  <span className="text-[11px] leading-snug text-zinc-300">
                    新入队片段默认开启「追加击杀者视角」（死亡合集 / 带击杀者的失误等适用）
                  </span>
                </label>
                {globalPacing.default_killer_pov ? (
                  <p className="mt-2 text-[10px] leading-relaxed text-emerald-400/90">
                    成片预期：适用片段会插入击杀者视角段，强调击杀发起方。
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label="击杀前预留 (秒)"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={killerPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_pre_sec: n })}
                    accentClass="accent-amber-500"
                  />
                  <PacingSlider
                    label="死亡后停留 (秒)"
                    min={0}
                    max={5}
                    step={0.5}
                    value={killerPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_post_sec: n })}
                    accentClass="accent-amber-500"
                  />
                </div>
              </div>
            </div>

            <div className="my-5 border-t border-white/[0.08]" />
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              视野、持枪与实验性 POV
            </p>
            <div className="mb-5 rounded-xl border-2 border-amber-500/40 bg-gradient-to-br from-amber-950/45 via-black/40 to-black/60 p-4 shadow-[0_0_40px_-12px_rgba(245,158,11,0.35)]">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-amber-500/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-100">
                  实验性
                </span>
                <h4 className="text-sm font-bold text-white">实验功能：POV HUD</h4>
              </div>
              <p className="mb-1 text-[11px] leading-relaxed text-amber-100/90">
                影响说明：启用后以更接近真实第一人称的 HUD 资源录制本地 Demo，与普通观战 HUD 管线不同。
              </p>
              <p className="mb-3 text-[10px] leading-relaxed text-zinc-500">
                当前状态：{experimentalPovEnabled ? "已启用 POV 特殊录制模式" : "未启用（使用标准观战 HUD 管线）"}
                。兼容性：需本地 Demo、临时改写 gameinfo 与 pov.vpk，仅用于离线回放；勿连接联机服务器。
              </p>
              <ExperimentalPovSection
                visible={open || isPage}
                experimentalPovEnabled={experimentalPovEnabled}
                onExperimentalPovChange={onExperimentalPovChange}
                checkboxDisabled={batchRecording || !onExperimentalPovChange}
                povRadarMode={warmupOpts.pov_radar_mode}
                onPovRadarModeChange={(v) => patchWarmup({ pov_radar_mode: v })}
                povTeamcounterNumeric={warmupOpts.pov_teamcounter_numeric}
                onPovTeamcounterNumericChange={(v) => patchWarmup({ pov_teamcounter_numeric: v })}
                omitEyebrow
                className="rounded-lg border border-amber-500/30 bg-black/35 p-3"
              />
            </div>

            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              基础镜头参数
            </p>
            <div className="space-y-3">
              <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={warmupOpts.apply_fov}
                    onChange={(e) => patchWarmup({ apply_fov: e.target.checked })}
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
                    value={warmupOpts.fov_cs_debug}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      patchWarmup({
                        fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)),
                      });
                    }}
                    disabled={!warmupOpts.apply_fov}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40"
                  />
                  <span className="text-xs text-zinc-500">默认 90</span>
                </div>
                {warmupOpts.apply_fov ? (
                  <p className="mt-2 border-t border-white/[0.06] pt-2 pl-7 text-[10px] leading-relaxed text-emerald-400/90">
                    成片预期：视野角度按设定值渲染，影响镜头透视与边缘拉伸感。
                  </p>
                ) : null}
              </div>
              <OptionRow
                checked={warmupOpts.viewmodel_fov_68}
                onChange={(v) => patchWarmup({ viewmodel_fov_68: v })}
                title="开启极限持枪视角"
                code="viewmodel_fov 68"
              />
              {warmupOpts.viewmodel_fov_68 ? (
                <p className="-mt-1 ml-1 text-[10px] leading-relaxed text-emerald-400/85">
                  成片预期：手臂与枪械模型更贴近画面边缘，竞技剪辑常见「拉伸持枪」观感。
                </p>
              ) : null}
            </div>
          </WorkflowSection>

            </div>
            <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/params:gap-4">
              <WorkflowSection
                title="观战画面与调试"
                subtitle="HUD / UI、Demo 调试条与 X 光；决定采集画面与预热注入内容。"
                defaultOpen
              >
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  录制画面效果
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <RecordingHudCard
                    title="简化观战 HUD"
                    code="cl_draw_only_deathnotices true"
                    description="仅保留击杀公告等核心提示，弱化其余观战 UI。"
                    checked={warmupOpts.cl_draw_only_deathnotices}
                    onChange={(v) => patchWarmup({ cl_draw_only_deathnotices: v })}
                    outcomeOn="成片观战 HUD 以精简样式呈现，减少界面干扰。"
                    disabled={!!experimentalPovEnabled}
                    disabledReason={POV_CONFLICT_HUD}
                  />
                  <RecordingHudCard
                    title="隐藏准星目标信息"
                    code="hud_showtargetid 0"
                    description="准星指向玩家时不再弹出名称与血量提示。"
                    checked={warmupOpts.hud_showtargetid_hide}
                    onChange={(v) => patchWarmup({ hud_showtargetid_hide: v })}
                    outcomeOn="最终画面中不出现准星下的 ID / 血量条提示。"
                  />
                  <RecordingHudCard
                    title="屏蔽文字聊天"
                    code="tv_nochat 1"
                    description="隐藏观战文字聊天区域。"
                    checked={warmupOpts.tv_nochat}
                    onChange={(v) => patchWarmup({ tv_nochat: v })}
                    outcomeOn="导出视频中不显示文字聊天栏。"
                  />
                  <RecordingHudCard
                    title="隐藏投掷物轨迹与画中窗"
                    code="sv_grenade_trajectory 0; …"
                    description="关闭投掷物轨迹、练习画中窗与时间轴。"
                    checked={warmupOpts.hide_grenade_trajectory_pip}
                    onChange={(v) => patchWarmup({ hide_grenade_trajectory_pip: v })}
                    outcomeOn="画面中不出现投掷物轨迹线与辅助画中窗。"
                  />
                </div>

                <div className="my-5 border-t border-white/[0.08]" />
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Demo 条与透视
                </p>
                <div className="space-y-3">
                  <RecordingHudCard
                    title="隐藏 Demo 进度条与回放控制条"
                    code="sv_cheats 1 → demoui false"
                    description="预热阶段关闭 Demo UI 条，需临时开启作弊指令通道。"
                    checked={warmupOpts.hide_demo_playback_ui}
                    onChange={(v) => patchWarmup({ hide_demo_playback_ui: v })}
                    outcomeOn="回放进度条与控制台 Demo 控制条不会出现在采集画面中。"
                  />
                  <RecordingHudCard
                    title="开启 X 光透视"
                    code="spec_show_xray 1 / 0"
                    description="观战穿透显示轮廓（竞技裁判视角常用）。"
                    checked={warmupOpts.spec_show_xray}
                    onChange={(v) => patchWarmup({ spec_show_xray: v })}
                    outcomeOn="墙后可透视敌方轮廓，成片更具「上帝视角」信息密度。"
                  />
                </div>
              </WorkflowSection>

              <WorkflowSection
                title="启动、音频与画布"
                subtitle="命令行与预热控制台、语音静音与录制分辨率（-w / -h）。"
                defaultOpen
              >
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  命令行与控制台
                </p>
                <Cs2LaunchConsoleFields
                  cs2ExtraLaunchArgs={cs2ExtraLaunchArgs}
                  onCs2ExtraLaunchArgsChange={onCs2ExtraLaunchArgsChange}
                  recordInjectConsoleLines={recordInjectConsoleLines}
                  onRecordInjectConsoleLinesChange={onRecordInjectConsoleLinesChange}
                />

                <div className="my-5 border-t border-white/[0.08]" />
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  采集与静音
                </p>
            <OptionRow
              checked={warmupOpts.snd_voipvolume_mute}
              onChange={(v) => patchWarmup({ snd_voipvolume_mute: v })}
              title="静音游戏内玩家语音"
              code="snd_voipvolume 0"
            />
            {warmupOpts.snd_voipvolume_mute ? (
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
                warmupResolutionError
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
                  const selected = warmupOpts.aspect_ratio === ar;
                  return (
                    <button
                      key={ar}
                      type="button"
                      onClick={() => patchWarmup({ aspect_ratio: ar })}
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
                  value={warmupOpts.aspect_ratio}
                  onChange={(e) => patchWarmup({ aspect_ratio: e.target.value })}
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
                    {warmupOpts.aspect_ratio || "（未选）"}
                  </span>
                  {" · "}
                  分辨率{" "}
                  <span className="font-mono text-zinc-300">
                    {formatResolutionSummary(
                      warmupOpts.aspect_ratio,
                      warmupOpts.resolution_width,
                      warmupOpts.resolution_height
                    )}
                  </span>
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                  {aspectHint(warmupOpts.aspect_ratio)}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                  最终导出方向：{aspectExportHint(warmupOpts.aspect_ratio)}
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
                  value={warmupOpts.resolution_width}
                  onChange={(e) => patchWarmup({ resolution_width: e.target.value })}
                  className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                />
                <span className="font-mono text-xs text-zinc-500">-h</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={warmupOpts.resolution_height}
                  onChange={(e) => patchWarmup({ resolution_height: e.target.value })}
                  className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                />
              </div>
              {warmupResolutionError ? (
                <p className="mt-2 text-[11px] leading-snug text-rose-400">{warmupResolutionError}</p>
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                  留空宽高则沿用当前分辨率；若填写宽高须选择比例且化简后须匹配（4:3 含游戏内同组的 5:4，如
                  1280×1024）。
                </p>
              )}
            </div>
          </WorkflowSection>

            </div>
          </div>
        </div>
        </div>

        {!isPage ? (
          <div className="shrink-0 border-t border-white/[0.08] bg-black/35 px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-cs2-orange py-2 text-sm font-extrabold text-black hover:bg-cs2-orange-light sm:w-auto sm:px-6"
            >
              完成
            </button>
          </div>
        ) : null}
      </div>
    </>
  );

  if (isPage) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-cs2-bg-dark">
        <header className="shrink-0 border-b border-white/10 bg-cs2-bg-dark/95 px-4 py-3 backdrop-blur-sm sm:px-5">
          <div className="w-full min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-white">常用参数</h1>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-zinc-500">
              全局节奏、观战默认与预热画面写入{" "}
              <span className="font-mono text-zinc-400">data/cs2-insight.config.json</span>
            </p>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 px-3 py-6 backdrop-blur-sm sm:px-4"
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
