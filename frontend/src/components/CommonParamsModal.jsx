import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Save, X } from "lucide-react";
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
const FB_VIC_POST = 1.5;
const FB_KILL_PRE = 1.5;
const FB_KILL_POST = 1.5;

/** 片段时间流示意图中间「主体段」参考秒数，与左右同为秒单位以便比例对齐 */
const PACING_STRIP_CORE_REF_SEC = 6;

function WorkflowSection({ title, subtitle, badge, defaultOpen = true, accentClass = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`rounded-xl border border-cs2-border bg-cs2-bg-card shadow-sm transition-all ${accentClass}`.trim()}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-cs2-surface-2 sm:px-5"
      >
        <span className="mt-1 shrink-0 text-cs2-text-muted">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold tracking-tight text-cs2-text-primary">{title}</h3>
            {badge}
          </div>
          {subtitle ? (
            <p className="mt-1 text-xs leading-relaxed text-cs2-text-secondary">{subtitle}</p>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="border-t border-cs2-border px-4 py-5 sm:px-5">{children}</div>
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
    <label className="block text-xs font-medium text-cs2-text-secondary">
      {label}
      <div className="mt-1.5 flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onCommit(parseFloat(e.target.value))}
          className={`min-w-0 flex-1 disabled:opacity-40 cursor-pointer ${accentClass}`}
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
          className="w-20 rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent disabled:opacity-40 text-right"
        />
      </div>
    </label>
  );
}

/**
 * 常用参数：内联编辑「全局节奏（数值）+ 入队默认 POV」与「录制前观战默认选项」；
 * 由顶栏「保存」一次性写入 data/cs2-insight.config.json。
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
  cs2ExtraLaunchArgs = "",
  recordInjectConsoleLines = "",
  obsTransitionEnabled: initObsTransitionEnabled = false,
  obsTransitionName: initObsTransitionName = "Fade",
  obsTransitionDurationMs: initObsTransitionDurationMs = 100,
  configRefreshKey = 0,
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
  const [obsTransEnabled, setObsTransEnabled] = useState(() => !!initObsTransitionEnabled);
  const [obsTransName, setObsTransName] = useState(() => initObsTransitionName);
  const [obsTransDurationMs, setObsTransDurationMs] = useState(() => Number(initObsTransitionDurationMs));
  const [povEnabled, setPovEnabled] = useState(() => !!experimentalPovEnabled);
  const [localCs2ExtraLaunchArgs, setLocalCs2ExtraLaunchArgs] = useState(cs2ExtraLaunchArgs);
  const [localRecordInjectLines, setLocalRecordInjectLines] = useState(recordInjectConsoleLines);
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const lastHydratedRefreshKey = useRef(null);

  useEffect(() => {
    if (!open && !isPage) return;
    setWarmupResolutionError("");
  }, [open, isPage]);

  useEffect(() => {
    if (!configReady) return;
    if (!open && !isPage) return;
    if (lastHydratedRefreshKey.current === configRefreshKey) return;
    lastHydratedRefreshKey.current = configRefreshKey;
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
    setObsTransEnabled(!!initObsTransitionEnabled);
    setObsTransName(initObsTransitionName);
    setObsTransDurationMs(Number(initObsTransitionDurationMs));
    setPovEnabled(!!experimentalPovEnabled);
    setLocalCs2ExtraLaunchArgs(cs2ExtraLaunchArgs);
    setLocalRecordInjectLines(recordInjectConsoleLines);
    setWarmupResolutionError("");
    setSaveError("");
  }, [
    configRefreshKey,
    open,
    isPage,
    configReady,
    savedWarmupDefaults,
    initObsTransitionEnabled,
    initObsTransitionName,
    initObsTransitionDurationMs,
    experimentalPovEnabled,
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
  ]);

  const patchWarmup = useCallback((patch) => {
    setWarmupOpts((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSaveAll = useCallback(async () => {
    if (!onSaveAllCommonParams || saveState === "saving") return;
    const vr = validateWarmupResolution(warmupOpts);
    if (!vr.ok) {
      setWarmupResolutionError(vr.message);
      setSaveError(vr.message);
      return;
    }
    setWarmupResolutionError("");
    setSaveError("");
    setSaveState("saving");
    const result = await onSaveAllCommonParams({
      default_record_warmup: warmupUiOptsToPersisted(warmupOpts),
      recording_global_pacing: globalPacing,
      cs2_extra_launch_args: localCs2ExtraLaunchArgs,
      record_inject_console_lines: localRecordInjectLines,
      obs_transition_enabled: obsTransEnabled,
      obs_transition_name: obsTransName,
      obs_transition_duration_ms: obsTransDurationMs,
      experimental_pov_enabled: povEnabled,
    });
    setSaveState(result?.ok ? "saved" : "error");
    if (!result?.ok && result?.error) setSaveError(String(result.error));
    if (result?.ok) {
      setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [
    onSaveAllCommonParams,
    saveState,
    warmupOpts,
    globalPacing,
    localCs2ExtraLaunchArgs,
    localRecordInjectLines,
    obsTransEnabled,
    obsTransName,
    obsTransDurationMs,
    povEnabled,
  ]);

  const saveButton = onSaveAllCommonParams ? (
    <button
      type="button"
      disabled={!configReady || saveState === "saving" || batchRecording}
      onClick={() => void handleSaveAll()}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-45"
    >
      {saveState === "saving" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Save className="h-4 w-4" aria-hidden />
      )}
      {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "保存到配置文件"}
    </button>
  ) : null;

  if (!open && !isPage) return null;

  const outerClass = isPage
    ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
    : "flex max-h-[min(94vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl";

  const preFlex = Math.max(pre, 0.05);
  const postFlex = Math.max(post, 0.05);
  const midFlex = PACING_STRIP_CORE_REF_SEC;

  const body = (
    <>
      <div className={outerClass}>
        {!isPage ? (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-cs2-border px-4 py-4 sm:px-5">
          <div className="min-w-0 pr-2">
            <h2 id="common-params-title" className="text-base font-bold text-cs2-text-primary">
              录制行为控制台
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-cs2-text-muted">
              在此定义<strong className="text-cs2-text-secondary">全局录制节奏</strong>、
              <strong className="text-cs2-text-secondary">默认镜头逻辑</strong>与
              <strong className="text-cs2-text-secondary">预热阶段画面规则</strong>。修改后请点击
              <strong className="text-cs2-text-secondary">「保存到配置文件」</strong>写入{" "}
              <span className="font-mono text-cs2-text-secondary">data/cs2-insight.config.json</span>
              ；节奏与入队默认视角影响<strong className="text-cs2-text-secondary">之后新加入队列</strong>
              的片段，预热选项在批量录制确认时作为默认值。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {saveButton}
            {!isPage ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-input hover:text-cs2-text-secondary"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4">
          <div className="@container/params w-full min-w-0">
            <div className="grid min-w-0 grid-cols-1 gap-3 pb-2 @min-[52rem]/params:grid-cols-2 @min-[52rem]/params:items-start @min-[52rem]/params:gap-5 @min-[52rem]/params:pb-4">
              <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/params:gap-4">
          {/* A1 时间与多段节奏 */}
          <WorkflowSection
            title="时间与多段节奏"
            subtitle="成片击杀段前/击杀段后预留、跳剪间隔阈值与全局节奏重置；决定导出片的时间结构。"
            defaultOpen
          >
            <div className="mb-5 overflow-hidden rounded-lg border border-cs2-border bg-cs2-surface-1 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
                片段时间流
              </p>
              <div className="mb-2 flex min-h-[3rem] w-full overflow-hidden rounded-md">
                <div
                  style={{ flex: preFlex }}
                  className="flex min-w-0 flex-col justify-center border-r border-cs2-border-subtle bg-gradient-to-br from-cs2-accent/35 to-cs2-accent/10 px-2 py-1.5"
                >
                  <span className="text-[10px] font-bold uppercase tracking-wide text-cs2-text-primary/90">
                    击杀段前预留
                  </span>
                  <span className="font-mono text-xs text-cs2-text-primary">{pre}s</span>
                </div>
                <div
                  style={{ flex: midFlex }}
                  className="flex min-w-[5.5rem] flex-col items-center justify-center border-r border-cs2-border-subtle bg-cs2-bg-input px-2 py-1.5 text-center"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                    精彩片段
                  </span>
                  <span className="mt-0.5 text-[10px] leading-snug text-cs2-text-muted">
                    解析得到的击杀 / 高光主体段
                  </span>
                </div>
                <div
                  style={{ flex: postFlex }}
                  className="flex min-w-0 flex-col justify-center bg-gradient-to-bl from-cyan-500/25 to-cyan-500/5 px-2 py-1.5"
                >
                  <span className="text-[10px] font-bold uppercase tracking-wide text-cs2-text-primary/90">
                    击杀段后预留
                  </span>
                  <span className="font-mono text-xs text-cs2-text-primary">{post}s</span>
                </div>
              </div>
              <p className="text-[10px] leading-relaxed text-cs2-text-muted">
                左段为击杀段前预留、右段为击杀段后预留；中间为解析得到的高光主体（时长由片段本身决定）。左值为每段首杀前回拨，右值为每段末杀后收束（非每个击杀各加一段尾垫）；智能跳剪各段一致。
              </p>
            </div>

            <div className="mb-4 grid gap-4 sm:grid-cols-2">
              <PacingSlider
                label="击杀段前预留 (秒)"
                min={0}
                max={20}
                step={0.1}
                value={pre}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ pre_first_sec: n })}
              />
              <PacingSlider
                label="击杀段后预留 (秒)"
                min={0}
                max={10}
                step={0.1}
                value={post}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ post_last_sec: n })}
              />
            </div>

            <div className="rounded-lg border border-amber-500/15 bg-cs2-amber-surface px-3 py-3">
              <PacingSlider
                label="跳剪间隔阈值 (秒) — 相邻击杀间隔小于该值时合并为同一段成片"
                min={2}
                max={70}
                step={0.5}
                value={gap}
                disabled={batchRecording}
                onCommit={(n) => commitPacingNumbers({ max_gap_sec: n })}
                accentClass="accent-amber-500"
              />
              <p className="mt-2 text-xs text-cs2-text-muted">
                成片预期：间隔极短的连续击杀更适合连成一段，避免频繁硬切；阈值越大合并越积极。
              </p>
            </div>

            <button
              type="button"
              disabled={batchRecording}
              onClick={() => resetNumericGlobalPacing()}
              className="mt-4 text-xs text-cs2-text-muted hover:text-cs2-text-secondary disabled:opacity-40"
            >
              恢复数值类节奏为后端内置默认（保留入队默认视角与 POV 时序默认值）
            </button>
          </WorkflowSection>

          {/* A2 镜头与 POV */}
          <WorkflowSection
            title="镜头与 POV"
            subtitle="受害者 / 击杀者追加视角、FOV 与持枪模型、实验性 POV；入队默认与解析名单类型相关。"
            defaultOpen
            accentClass="ring-1 ring-cs2-border-subtle"
          >
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border-l-4 border-cyan-500/55 bg-cs2-surface-1 p-4">
                <p className="text-xs font-bold text-cs2-cyan-on-surface">受害者镜头</p>
                <p className="mt-0.5 text-xs text-cs2-text-muted">
                  击杀前 / 死亡后停留，形成「先看你被杀」的镜头切换逻辑。
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2.5">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={globalPacing.default_victim_pov === true}
                    onChange={(e) => setGlobalPacing({ default_victim_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cyan-500 disabled:opacity-40"
                  />
                  <span className="text-xs leading-snug text-cs2-text-secondary">
                    新入队片段默认开启「追加受害者视角」（高光 / 合集高光等适用）
                  </span>
                </label>
                {globalPacing.default_victim_pov ? (
                  <p className="mt-2 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    成片预期：适用片段在击杀后会短暂切到受害者 POV，突出「被击杀瞬间」。
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label="回看前停留 (秒)"
                    min={0}
                    max={5}
                    step={0.1}
                    value={victimPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_pre_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                  <PacingSlider
                    label="死亡后停留 (秒)"
                    min={0}
                    max={5}
                    step={0.1}
                    value={victimPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ victim_pov_post_sec: n })}
                    accentClass="accent-cyan-500"
                  />
                </div>
              </div>

              <div className="rounded-xl border-l-4 border-amber-500/55 bg-cs2-surface-1 p-4">
                <p className="text-xs font-bold text-cs2-amber-on-surface">击杀者镜头</p>
                <p className="mt-0.5 text-xs text-cs2-text-muted">
                  击杀前 / 击杀后停留，与受害者侧对照，形成「谁在动手」的镜头叙事。
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2.5">
                  <input
                    type="checkbox"
                    disabled={batchRecording}
                    checked={globalPacing.default_killer_pov === true}
                    onChange={(e) => setGlobalPacing({ default_killer_pov: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-amber-500 disabled:opacity-40"
                  />
                  <span className="text-xs leading-snug text-cs2-text-secondary">
                    新入队片段默认开启「追加击杀者视角」（死亡合集 / 带击杀者的失误等适用）
                  </span>
                </label>
                {globalPacing.default_killer_pov ? (
                  <p className="mt-2 text-xs leading-relaxed text-cs2-emerald-on-surface">
                    成片预期：适用片段会插入击杀者视角段，强调击杀发起方。
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3">
                  <PacingSlider
                    label="回看前停留 (秒)"
                    min={0}
                    max={5}
                    step={0.1}
                    value={killerPovPre}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_pre_sec: n })}
                    accentClass="accent-amber-500"
                  />
                  <PacingSlider
                    label="死亡后停留 (秒)"
                    min={0}
                    max={5}
                    step={0.1}
                    value={killerPovPost}
                    disabled={batchRecording}
                    onCommit={(n) => commitPacingNumbers({ killer_pov_post_sec: n })}
                    accentClass="accent-amber-500"
                  />
                </div>
              </div>
            </div>

            <div className="my-5 border-t border-cs2-border" />
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              视野、持枪与实验性 POV
            </p>
            <div className="mb-5 rounded-xl border border-amber-500/30 bg-gradient-to-br from-cs2-surface-1 to-cs2-surface-2 p-4 shadow-md">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cs2-amber-on-surface">
                  实验性
                </span>
                <h4 className="text-sm font-bold text-cs2-text-primary">实验功能：POV HUD</h4>
              </div>
              <p className="mb-1 text-xs leading-relaxed text-cs2-amber-on-surface/90">
                影响说明：启用后以更接近真实第一人称的 HUD 资源录制本地 Demo，与普通观战 HUD 管线不同。
              </p>
              <p className="mb-3 text-xs leading-relaxed text-cs2-text-muted">
                当前状态：{povEnabled ? "已启用 POV 特殊录制模式" : "未启用（使用标准观战 HUD 管线）"}
                。兼容性：需本地 Demo、临时改写 gameinfo 与 pov.vpk，仅用于离线回放；勿连接联机服务器。
              </p>
              <ExperimentalPovSection
                visible={open || isPage}
                experimentalPovEnabled={povEnabled}
                onExperimentalPovChange={setPovEnabled}
                checkboxDisabled={batchRecording}
                povRadarMode={warmupOpts.pov_radar_mode}
                onPovRadarModeChange={(v) => patchWarmup({ pov_radar_mode: v })}
                povTeamcounterNumeric={warmupOpts.pov_teamcounter_numeric}
                onPovTeamcounterNumericChange={(v) => patchWarmup({ pov_teamcounter_numeric: v })}
                omitEyebrow
                className="rounded-lg border border-amber-500/20 bg-cs2-bg-input/60 p-3"
              />
            </div>

            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              基础镜头参数
            </p>
            <div className="space-y-4">
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={warmupOpts.apply_fov}
                    onChange={(e) => patchWarmup({ apply_fov: e.target.checked })}
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
                    value={warmupOpts.fov_cs_debug}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      patchWarmup({
                        fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)),
                      });
                    }}
                    disabled={!warmupOpts.apply_fov}
                    className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-cs2-text-primary disabled:opacity-40"
                  />
                  <span className="text-xs text-cs2-text-muted">默认 90</span>
                </div>
                {warmupOpts.apply_fov ? (
                  <p className="mt-2 border-t border-cs2-border pt-2 pl-7 text-xs leading-relaxed text-cs2-emerald-on-surface">
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
                <p className="-mt-1 ml-1 text-xs leading-relaxed text-emerald-400/85">
                  成片预期：手臂与枪械模型更贴近画面边缘，竞技剪辑常见「拉伸持枪」观感。
                </p>
              ) : null}
            </div>
          </WorkflowSection>

            </div>
            <div className="flex min-w-0 flex-col gap-3 @min-[52rem]/params:gap-4">
              <WorkflowSection
                title="OBS 转场"
                subtitle="切换视角之间的转场效果。"
                defaultOpen
              >
                <div className="space-y-4">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={obsTransEnabled}
                      onChange={(e) => setObsTransEnabled(e.target.checked)}
                      className="h-4 w-4 rounded border-cs2-border accent-cs2-orange"
                    />
                    <span className="text-sm text-cs2-text-primary">启用黑场渐入渐出</span>
                  </label>

                  <label className="block text-xs font-medium text-cs2-text-secondary">
                    转场样式
                    <select
                      value={obsTransName}
                      onChange={(e) => setObsTransName(e.target.value)}
                      disabled={!obsTransEnabled}
                      className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
                    >
                      <option value="Fade">淡入淡出</option>
                      <option value="Cut">直切</option>
                      <option value="Swipe">滑动</option>
                    </select>
                  </label>

                  <label className="block text-xs font-medium text-cs2-text-secondary">
                    时长（ms）
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      step={50}
                      value={obsTransDurationMs}
                      onChange={(e) => setObsTransDurationMs(Number(e.target.value))}
                      disabled={!obsTransEnabled}
                      className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
                    />
                  </label>
                </div>
              </WorkflowSection>

              <WorkflowSection
                title="观战画面与调试"
                subtitle="HUD / UI、Demo 调试条与 X 光；决定采集画面与预热注入内容。"
                defaultOpen
              >
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
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
                    disabled={!!povEnabled}
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

                <div className="my-5 border-t border-cs2-border" />
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  Demo 条与透视
                </p>
                <div className="space-y-4">
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
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  命令行与控制台
                </p>
                <Cs2LaunchConsoleFields
                  cs2ExtraLaunchArgs={localCs2ExtraLaunchArgs}
                  onCs2ExtraLaunchArgsChange={setLocalCs2ExtraLaunchArgs}
                  recordInjectConsoleLines={localRecordInjectLines}
                  onRecordInjectConsoleLinesChange={setLocalRecordInjectLines}
                />

                <div className="my-5 border-t border-cs2-border" />
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  采集与静音
                </p>
            {(() => {
              const vf = warmupOpts.voice_filter ?? "mute";
              const VF_OPTIONS = [
                { value: "open",  label: "所有玩家",    code: "tv_listen_voice_indices -1",     desc: "录制轨包含所有玩家语音。" },
                { value: "team",  label: "第一视角我方", code: "tv_listen_voice_indices <mask>", desc: "只保留主角所在队伍的语音。" },
                { value: "enemy", label: "第一视角敌方", code: "tv_listen_voice_indices <mask>", desc: "只保留对方队伍的语音。" },
                { value: "mute",  label: "全部静音",    code: "snd_voipvolume 0",              desc: "录制轨不含任何玩家语音。" },
              ];
              const selected = VF_OPTIONS.find((o) => o.value === vf) ?? VF_OPTIONS[3];
              return (
                <>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {VF_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => patchWarmup({ voice_filter: opt.value })}
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
                  <p className={`mb-4 mt-1.5 ml-0.5 text-xs leading-relaxed ${vf === "open" ? "text-cs2-text-muted" : "text-emerald-400/85"}`}>
                    {selected.desc}
                  </p>
                </>
              );
            })()}

            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cs2-text-muted">
              录制输出比例
            </p>
            <div
              className={`rounded-xl border p-4 ${
                warmupResolutionError
                  ? "border-rose-500/45 bg-cs2-rose-surface"
                  : "border-cs2-border-subtle bg-cs2-surface-1"
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
                      className={`rounded-xl border p-3 text-left transition-all ${
                        selected
                          ? "border-cs2-accent bg-cs2-accent-soft shadow-sm"
                          : "border-cs2-border bg-cs2-bg-input hover:border-cs2-border-focus"
                      }`}
                    >
                      <p className="font-mono text-base font-bold text-cs2-text-primary">{ar}</p>
                      <p className="mt-1 font-mono text-xs text-cs2-text-secondary">{sample}</p>
                      <p className="mt-0.5 text-xs text-cs2-text-muted">{tag}</p>
                    </button>
                  );
                })}
              </div>

              <label className="mb-3 block">
                <span className="mb-1 block text-xs text-cs2-text-muted">
                  屏幕比例（与 -w / -h 联动校验）
                </span>
                <select
                  value={warmupOpts.aspect_ratio}
                  onChange={(e) => patchWarmup({ aspect_ratio: e.target.value })}
                  className="w-full max-w-md rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-sm text-cs2-text-primary outline-none focus:border-cs2-accent"
                >
                  <option value="">不填写启动分辨率</option>
                  <option value="4:3">4 : 3</option>
                  <option value="16:9">16 : 9</option>
                  <option value="16:10">16 : 10</option>
                </select>
              </label>

              <div className="mb-4 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input p-3">
                <p className="text-xs uppercase tracking-wide text-cs2-text-muted">当前解析</p>
                <p className="mt-1 text-sm text-cs2-text-primary font-medium">
                  比例{" "}
                  <span className="font-mono text-cs2-accent font-bold">
                    {warmupOpts.aspect_ratio || "（未选）"}
                  </span>
                  {" · "}
                  分辨率{" "}
                  <span className="font-mono text-cs2-text-secondary">
                    {formatResolutionSummary(
                      warmupOpts.aspect_ratio,
                      warmupOpts.resolution_width,
                      warmupOpts.resolution_height
                    )}
                  </span>
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-cs2-text-muted">
                  {aspectHint(warmupOpts.aspect_ratio)}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-cs2-text-muted">
                  最终导出方向：{aspectExportHint(warmupOpts.aspect_ratio)}
                </p>
              </div>

              <p className="mb-2 text-xs text-cs2-text-secondary font-medium">
                启动参数（可选，不填则为本机当前游戏分辨率）
              </p>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono text-xs font-semibold text-cs2-text-muted">-w</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={warmupOpts.resolution_width}
                  onChange={(e) => patchWarmup({ resolution_width: e.target.value })}
                  className="w-24 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent"
                />
                <span className="font-mono text-xs font-semibold text-cs2-text-muted">-h</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={warmupOpts.resolution_height}
                  onChange={(e) => patchWarmup({ resolution_height: e.target.value })}
                  className="w-24 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-1.5 font-mono text-sm text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent"
                />
              </div>
              {warmupResolutionError ? (
                <p className="mt-2.5 text-xs leading-snug text-rose-400">{warmupResolutionError}</p>
              ) : (
                <p className="mt-2.5 text-xs leading-relaxed text-cs2-text-muted">
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
          <div className="shrink-0 border-t border-cs2-border bg-cs2-bg-input/60 px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-cs2-accent py-2 text-sm font-bold text-cs2-text-on-accent hover:brightness-110 sm:w-auto sm:px-6"
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
      <div className="flex h-full min-h-0 w-full flex-col bg-cs2-bg-page">
        <header className="shrink-0 border-b border-cs2-border bg-cs2-bg-page/95 px-4 py-3 backdrop-blur-sm sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold tracking-tight text-cs2-text-primary">常用参数</h1>
              <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-cs2-text-muted">
                录制时的常用参数设置，修改后请点击「保存到配置文件」。
              </p>
              {saveError ? (
                <p className="mt-2 text-xs leading-snug text-rose-400">{saveError}</p>
              ) : null}
              {!configReady ? (
                <p className="mt-2 text-xs text-cs2-text-muted">正在加载配置…</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center self-center">{saveButton}</div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-cs2-bg-overlay px-3 py-6 backdrop-blur-sm sm:px-4"
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
