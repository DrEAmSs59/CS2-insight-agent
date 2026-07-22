import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  Loader2,
  LockKeyhole,
  Monitor,
  Power,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import {
  applyObsTuningPlan,
  bootstrapObsTuningEnvironment,
  createObsTuningPlan,
  discoverObsTuningEnvironment,
  recommendObsTuningGoal,
  restoreObsTuningBackup,
} from "../api/obsTuning";
import {
  GoalScreen,
  ScreenNav,
} from "../pages/ObsAiTuningPreviewPage";

const BOOTSTRAP_STATUS_TEXT = {
  connected: "OBS 已连接，可以开始设置录制效果。",
  install_not_found: "没有找到 OBS。请先确认电脑上已经安装 OBS Studio。",
  needs_password: "你的 OBS 设置了连接密码，请输入自己设置的密码。",
  invalid_password: "密码不正确，请检查后再试一次。",
  needs_safe_restart: "OBS 已经打开，但连接功能没有开启。请先正常关闭 OBS，然后再点一次连接。",
  needs_websocket_enable: "需要先开启 OBS 的连接功能。",
  needs_launch: "需要先打开 OBS。",
  launch_failed: "OBS 没有成功打开，请确认它能否正常启动。",
  connection_failed: "OBS 已打开，但仍然连不上。请在 OBS 中打开“工具 → WebSocket 服务器设置”，勾选“启用 WebSocket 服务器”，然后回来重试。",
  websocket_config_failed: "自动开启 OBS 连接功能失败。其他 OBS 设置没有被修改。",
  websocket_config_unavailable: "没有找到 OBS 的连接设置，请先手动打开一次 OBS 后再试。",
};

const BOOTSTRAP_STEP_TEXT = {
  detect_install: "识别安装",
  check_process: "检查进程",
  inspect_websocket: "检查连接功能",
  enable_websocket: "开启连接功能",
  launch_obs: "启动 OBS",
  connect_websocket: "连接 OBS",
};

const BOOTSTRAP_EVENT_STATUS_TEXT = {
  ok: "完成",
  warning: "需要注意",
  pending: "等待中",
  blocked: "需要处理",
  failed: "失败",
  skipped: "无需处理",
};

function resolutionKey(width, height, fallback = "current") {
  if (Number(width) === 1920 && Number(height) === 1440) return "four-three";
  if (Number(width) === 1920 && Number(height) === 1080) return "full-hd";
  return fallback;
}

function selectedOutputDimensions(goal, discovery) {
  if (goal.resolution === "four-three") return { width: 1920, height: 1440 };
  if (goal.resolution === "full-hd") return { width: 1920, height: 1080 };
  const current = discovery?.obs?.video || {};
  return {
    width: Number(current.output_width || current.base_width || 2560),
    height: Number(current.output_height || current.base_height || 1440),
  };
}

function buildFallbackRecommendation(goal) {
  const dimensions = goal.resolution === "four-three"
    ? [1920, 1440]
    : goal.resolution === "full-hd"
      ? [1920, 1080]
      : [2560, 1440];
  const throughput = Math.round((dimensions[0] * dimensions[1] * goal.fps) / 1_000_000);
  const encoderLoad = Math.min(99, Math.max(8, Math.round(throughput / 20)));
  const renderLoad = Math.min(99, Math.max(10, Math.round(throughput / 22)));
  const score = Math.max(24, Math.min(96, 100 - Math.max(0, encoderLoad - 60) - Math.max(0, renderLoad - 60)));
  const recommendedFps = goal.fps > 240 ? 240 : goal.fps;
  const recommendedResolution = goal.fps >= 480 && goal.resolution === "current" ? "full-hd" : goal.resolution;
  const saferResolution = recommendedResolution === "full-hd" ? "1920 × 1080" : `${dimensions[0]} × ${dimensions[1]}`;
  const tone = score >= 85 ? "success" : score >= 68 ? "accent" : score >= 48 ? "warning" : "danger";
  return {
    score,
    label: score >= 85 ? "推荐" : score >= 68 ? "可以尝试" : score >= 48 ? "探索性方案" : "不推荐直接使用",
    verdict: score >= 68 ? "预计可以运行，但稳定性必须由真实录制证明。" : "预计存在卡顿风险，建议先测试保守起点。",
    tone,
    encoderLoad,
    renderLoad,
    headroom: Math.max(0, 100 - Math.max(encoderLoad, renderLoad)),
    megapixelsPerSecond: throughput,
    risks: ["真实稳定性仍需短录制和 OBS 日志验证"],
    bottleneck: encoderLoad >= renderLoad ? "硬件编码吞吐" : "OBS 渲染线程",
    recommendedFps,
    recommendedResolution,
    saferResolution,
    fileEstimate: "等待本机数据",
  };
}

function toWorkspaceRecommendation(raw, fallback) {
  if (!raw) return fallback;
  const safer = raw.safer_start || {};
  const target = raw.target || {};
  const loads = raw.loads || {};
  const low = raw.file_size?.low_gb_per_10_min;
  const high = raw.file_size?.high_gb_per_10_min;
  const tone = raw.level === "recommended"
    ? "success"
    : raw.level === "not_recommended"
      ? "danger"
      : raw.level === "experimental"
        ? "warning"
        : "accent";
  return {
    ...fallback,
    ...raw,
    tone,
    renderLoad: loads.render_percent ?? fallback.renderLoad,
    encoderLoad: loads.encoder_percent ?? fallback.encoderLoad,
    headroom: loads.headroom_percent ?? fallback.headroom,
    megapixelsPerSecond: loads.megapixels_per_second ?? fallback.megapixelsPerSecond,
    recommendedFps: safer.fps_num ?? target.fps_num ?? fallback.recommendedFps,
    recommendedResolution: resolutionKey(safer.width, safer.height, fallback.recommendedResolution),
    saferResolution: safer.width && safer.height ? `${safer.width} × ${safer.height}` : fallback.saferResolution,
    fileEstimate: low != null && high != null ? `${low}–${high} GB / 10 分钟` : fallback.fileEstimate,
    risks: raw.risks?.length ? raw.risks : fallback.risks,
  };
}

function ConnectionStatus({ icon: Icon, label, value, ok, loading = false }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-cs2-border/75 bg-cs2-bg-input/45 p-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${loading ? "bg-cs2-accent/10 text-cs2-accent" : ok ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-cs2-text-muted">{label}</div>
        <div className="mt-0.5 truncate text-[11px] font-semibold text-cs2-text-primary">{value}</div>
      </div>
    </div>
  );
}

function ConnectionDialog({
  autoPrepare,
  bootstrapLoading,
  bootstrapPassword,
  bootstrapResult,
  discovery,
  discoveryLoading,
  errorMessage,
  ffmpegReady,
  onAutoPrepareChange,
  onBootstrap,
  onClose,
  onPasswordChange,
  onRefresh,
}) {
  const passwordNeeded = ["needs_password", "invalid_password"].includes(bootstrapResult?.status);
  const installDetected = Boolean(discovery?.obs?.install_detected);
  const connected = discovery ? Boolean(discovery?.obs?.connected) : Boolean(bootstrapResult?.ok);
  const primaryLabel = bootstrapResult?.status === "needs_safe_restart"
    ? "我已关闭 OBS，再试一次"
    : passwordNeeded
      ? "使用这个密码连接"
      : "自动打开并连接 OBS";

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="obs-connection-title">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-cs2-accent/35 bg-cs2-bg-card shadow-2xl shadow-black/50">
        <div className="border-b border-cs2-border bg-[radial-gradient(circle_at_top_right,rgba(255,140,0,0.18),transparent_48%)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent">
                {discoveryLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <RadioTower className="h-5 w-5" />}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="obs-connection-title" className="text-base font-bold text-cs2-text-primary">
                    {discoveryLoading ? "正在检查 OBS" : connected ? "OBS 已经准备好了" : "还没有连接到 OBS"}
                  </h2>
                  {!discoveryLoading && !connected && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold text-amber-300">连接后才能继续</span>}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-secondary">
                  点击下面的橙色按钮，我们会自动打开 OBS 并完成连接。大多数情况下不需要你手动设置。
                </p>
              </div>
            </div>
            {!discoveryLoading && !bootstrapLoading && (
              <button type="button" onClick={onClose} aria-label="关闭提示" className="rounded-lg p-1.5 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <ConnectionStatus icon={Monitor} label="OBS 程序" loading={discoveryLoading} ok={installDetected} value={discoveryLoading ? "正在查找" : installDetected ? "已经找到" : "没有找到"} />
            <ConnectionStatus icon={Power} label="OBS 是否打开" loading={bootstrapLoading} ok={connected} value={bootstrapLoading ? "正在打开 OBS" : connected ? "已经打开" : "等待连接"} />
            <ConnectionStatus icon={RadioTower} label="连接状态" loading={discoveryLoading || bootstrapLoading} ok={connected} value={connected ? "连接成功" : "还没有连接"} />
          </div>

          {!discoveryLoading && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-cs2-border bg-cs2-bg-input/30 p-4">
                <div className="flex items-center gap-2 text-[11px] font-bold text-cs2-text-primary"><WandSparkles className="h-4 w-4 text-cs2-accent" />我们会帮你完成</div>
                <ol className="mt-3 space-y-2 text-[10px] leading-relaxed text-cs2-text-secondary">
                  <li className="flex gap-2"><span className="font-mono text-cs2-accent">01</span><span>找到这台电脑上的 OBS。</span></li>
                  <li className="flex gap-2"><span className="font-mono text-cs2-accent">02</span><span>打开 OBS，并开启应用连接功能。</span></li>
                  <li className="flex gap-2"><span className="font-mono text-cs2-accent">03</span><span>读取现在的画质、帧率和电脑配置。</span></li>
                </ol>
              </div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
                <div className="flex items-center gap-2 text-[11px] font-bold text-cs2-text-success"><LockKeyhole className="h-4 w-4" />不会动你的这些设置</div>
                <ul className="mt-3 space-y-2 text-[10px] leading-relaxed text-cs2-text-secondary">
                  {["不会修改 OBS 连接密码", "不会改场景、画面来源和声音", "不会改直播平台和推流设置", "这里只负责连接，不会马上改画质和帧率"].map((item) => (
                    <li key={item} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-cs2-text-success" />{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {bootstrapResult && !bootstrapResult.ok && (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-3.5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold text-amber-200">还差一步</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-secondary">{BOOTSTRAP_STATUS_TEXT[bootstrapResult.status] || "自动连接没有完成，请按提示处理后再试。"}</p>
                  {(bootstrapResult.events || []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {bootstrapResult.events.map((event) => (
                        <span key={`${event.step}-${event.status}`} title={event.message} className="rounded-full border border-cs2-border bg-black/10 px-2 py-1 text-[9px] text-cs2-text-secondary">
                          {BOOTSTRAP_STEP_TEXT[event.step] || "连接步骤"} · {BOOTSTRAP_EVENT_STATUS_TEXT[event.status] || "未完成"}
                        </span>
                      ))}
                    </div>
                  )}
                  {bootstrapResult.backup_path && <p className="mt-2 break-all font-mono text-[9px] text-cs2-text-muted">备份：{bootstrapResult.backup_path}</p>}
                </div>
              </div>
            </div>
          )}

          {passwordNeeded && (
            <div>
              <label htmlFor="obs-agent-password" className="text-[10px] font-bold text-cs2-text-primary">OBS 连接密码</label>
              <input id="obs-agent-password" type="password" value={bootstrapPassword} onChange={(event) => onPasswordChange(event.target.value)} placeholder="输入你在 OBS 中设置的密码" className="mt-1.5 w-full rounded-xl border border-cs2-border bg-cs2-bg-input px-3 py-2.5 text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent/60" />
            </div>
          )}

          {errorMessage && <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.05] px-3 py-2.5 text-[10px] text-cs2-rose-on-surface">{errorMessage}</div>}

          {!discoveryLoading && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-cs2-border/70 bg-cs2-bg-input/25 px-3 py-2.5 text-[10px] text-cs2-text-secondary">
              <input type="checkbox" checked={autoPrepare} onChange={(event) => onAutoPrepareChange?.(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-cs2-accent" />
              <span><strong className="font-semibold text-cs2-text-primary">下次进入时自动打开并连接 OBS</strong><span className="mt-0.5 block text-[9px] text-cs2-text-muted">如果需要密码，仍会先询问你。</span></span>
            </label>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-cs2-border/70 pt-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} disabled={discoveryLoading || bootstrapLoading} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary disabled:opacity-40">稍后再说</button>
            <button type="button" onClick={onRefresh} disabled={discoveryLoading || bootstrapLoading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${discoveryLoading ? "animate-spin" : ""}`} />再检查一次</button>
            <button type="button" onClick={onBootstrap} disabled={bootstrapLoading || (passwordNeeded && !bootstrapPassword.trim())} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45">
              {bootstrapLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              {bootstrapLoading ? "正在连接，请稍等" : primaryLabel}
            </button>
          </div>
          {!ffmpegReady && <p className="text-right text-[9px] text-cs2-text-muted">FFmpeg 尚未配置；这不阻塞 OBS 连接，但会阻塞后续测试文件验收。</p>}
        </div>
      </div>
    </div>
  );
}

function LockedWorkspace({ discoveryLoading, onOpen }) {
  return (
    <div className="rounded-2xl border border-dashed border-cs2-accent/35 bg-[radial-gradient(circle_at_top_right,rgba(255,140,0,0.09),transparent_45%)] p-8 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-cs2-accent/25 bg-cs2-accent/10 text-cs2-accent">
        {discoveryLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <LockKeyhole className="h-5 w-5" />}
      </span>
      <h3 className="mt-4 text-sm font-bold text-cs2-text-primary">{discoveryLoading ? "正在检查 OBS" : "先连接 OBS，再选择录制效果"}</h3>
      <p className="mx-auto mt-1 max-w-xl text-[11px] leading-relaxed text-cs2-text-secondary">连接后，我们才能知道你现在的清晰度、帧率和电脑配置，并给出不会轻易卡顿的推荐。</p>
      {!discoveryLoading && <button type="button" onClick={onOpen} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent"><RadioTower className="h-4 w-4" />连接 OBS</button>}
    </div>
  );
}

function friendlyCurrentEncoder(raw) {
  const value = String(raw || "").trim();
  const lower = value.toLowerCase();
  if (!value) return "尚未读取";
  if (lower.includes("nvenc") || lower === "jim_nvenc") return "NVIDIA NVENC H.264";
  if (lower.includes("qsv")) return "Intel QSV 硬件编码";
  if (lower.includes("amf")) return "AMD AMF 硬件编码";
  if (lower.includes("x264")) return "CPU x264 编码";
  if (lower.includes("stream")) return "与直播使用相同编码器";
  return value;
}

function friendlyCurrentFormat(raw) {
  const value = String(raw || "").trim();
  const lower = value.toLowerCase();
  if (!value) return "尚未读取";
  if (lower === "hybrid_mp4") return "Hybrid MP4";
  if (lower.includes("fragmented_mp4")) return "分段 MP4";
  return value.toUpperCase();
}

function CurrentObsConfiguration({ discovery, previewMode, refreshing, kept, onKeep, onRefresh, onUseAi }) {
  const fallback = previewMode ? {
    video: { base_width: 2560, base_height: 1440, output_width: 2560, output_height: 1440, fps_num: 60, fps_den: 1 },
    recording: { output_mode: "Simple", encoder: "jim_nvenc", format: "hybrid_mp4" },
    active_profile: "CS2",
  } : {};
  const obs = discovery?.obs || fallback;
  const video = obs.video || {};
  const recording = obs.recording || {};
  const outputWidth = Number(video.output_width || 0);
  const outputHeight = Number(video.output_height || 0);
  const baseWidth = Number(video.base_width || 0);
  const baseHeight = Number(video.base_height || 0);
  const fpsNum = Number(video.fps_num || 0);
  const fpsDen = Number(video.fps_den || 1);
  const hasVideo = outputWidth > 0 && outputHeight > 0 && fpsNum > 0;
  const rows = [
    [Monitor, "当前输出分辨率", hasVideo ? `${outputWidth} × ${outputHeight}` : "尚未读取", baseWidth && baseHeight ? `OBS 画布：${baseWidth} × ${baseHeight}` : "等待 OBS 返回画布大小"],
    [RadioTower, "当前录制帧率", fpsNum ? `${fpsNum} / ${fpsDen} FPS` : "尚未读取", fpsDen === 1 ? "整数帧率" : "非整数帧率"],
    [ShieldCheck, "当前录制方式", friendlyCurrentEncoder(recording.encoder), recording.output_mode ? `${recording.output_mode} 输出模式` : "等待 OBS 返回录制模式"],
    [FileCheck2, "当前文件格式", friendlyCurrentFormat(recording.format), obs.active_profile ? `OBS 配置：${obs.active_profile}` : "当前 OBS Profile"],
  ];
  return (
    <section className="overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card">
      <div className="border-b border-cs2-border bg-[radial-gradient(circle_at_top_right,rgba(255,140,0,0.12),transparent_45%)] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-cs2-text-success"><CheckCircle2 className="h-5 w-5" /></span>
            <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-bold text-cs2-text-primary">OBS 已连接，这是你现在的录制设置</h2><span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-bold text-emerald-300">只读查看</span></div><p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-cs2-text-secondary">先确认当前设置是否已经满足需要。只有你主动选择“使用 AI 调整”，系统才会进入分辨率和帧率选择；留在这里不会修改 OBS。</p></div>
          </div>
          <button type="button" onClick={onRefresh} disabled={refreshing || previewMode} className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[10px] font-semibold text-cs2-text-secondary disabled:opacity-45"><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />重新读取</button>
        </div>
      </div>
      <div className="p-5">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map(([Icon, label, value, detail]) => <div key={label} className="rounded-xl border border-cs2-border bg-cs2-bg-input/35 p-4"><div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em] text-cs2-text-muted"><Icon className="h-3.5 w-3.5 text-cs2-accent" />{label}</div><div className="mt-2 break-words font-mono text-[13px] font-bold text-cs2-text-primary">{value}</div><div className="mt-1 text-[9px] text-cs2-text-muted">{detail}</div></div>)}
        </div>
        {kept && <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] px-3 py-2.5 text-[10px] text-cs2-text-secondary"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cs2-text-success" /><span><strong className="text-cs2-text-success">已经保持当前设置。</strong> 系统没有修改 OBS；以后需要时仍可让 AI 帮你调整。</span></div>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" onClick={onKeep} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">保持当前设置</button>
          <button type="button" onClick={onUseAi} disabled={!hasVideo} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent disabled:cursor-not-allowed disabled:opacity-45"><WandSparkles className="h-4 w-4" />使用 AI 检查并调整</button>
        </div>
        {!hasVideo && <p className="mt-2 text-right text-[9px] text-amber-300">还没有读到有效的分辨率和帧率，请重新读取后再使用 AI 调整。</p>}
      </div>
    </section>
  );
}

function friendlyChangeLabel(key) {
  if (key === "video.fps") return "视频帧率";
  if (key === "video.output_resolution") return "视频清晰度";
  if (key === "recording.encoder") return "显卡录制方式";
  if (key === "recording.format") return "录像文件格式";
  return key;
}

function PlanWorkspace({ plan, loading, onApply, onBack }) {
  if (loading || !plan) {
    return <div className="flex min-h-64 items-center justify-center rounded-2xl border border-cs2-border bg-cs2-bg-card text-[11px] text-cs2-text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />AI 正在结合本机配置分析</div>;
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-bold text-cs2-text-primary">准备使用这些设置</h2><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${plan.can_apply ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-amber-400/30 bg-amber-400/10 text-amber-300"}`}>{plan.can_apply ? "可以继续" : "需要先处理问题"}</span></div>
            <p className="mt-1 text-[11px] text-cs2-text-secondary">现在只是让你确认，点击下一步前不会修改 OBS。</p>
          </div>
          <span className="rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 font-mono text-[9px] text-cs2-text-muted">{plan.plan_id}</span>
        </div>

        {plan.blockers?.length > 0 && <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2.5 text-[10px] text-amber-200"><div className="font-bold">还差几项准备</div><ul className="mt-1.5 space-y-1">{plan.blockers.map((item) => <li key={item}>· {item}</li>)}</ul></div>}
        <div className="mt-4 overflow-hidden rounded-xl border border-cs2-border">
          <div className="grid grid-cols-[1.1fr_0.85fr_0.85fr] gap-2 border-b border-cs2-border bg-cs2-bg-input/60 px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted"><span>设置项目</span><span>现在</span><span>准备改成</span></div>
          {(plan.changes || []).map((change) => (
            <div key={change.key} className="grid grid-cols-[1.1fr_0.85fr_0.85fr] gap-2 border-b border-cs2-border/60 px-3 py-3 text-[10px] last:border-0"><span className="font-semibold text-cs2-text-secondary">{friendlyChangeLabel(change.key)}</span><span className="truncate font-mono text-cs2-text-muted">{change.current}</span><span className="truncate font-mono font-semibold text-cs2-accent">{change.target}</span></div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回重新选择</button>
          <button type="button" onClick={onApply} disabled={!plan.can_apply} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"><ShieldCheck className="h-4 w-4" />自动设置并完成测试</button>
        </div>
      </section>
      <aside className="space-y-3">
        <div className={`rounded-2xl border p-4 ${plan.ai_review?.used ? "border-cs2-accent/25 bg-cs2-accent/[0.05]" : "border-cs2-border bg-cs2-bg-card"}`}>
          <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-primary"><Sparkles className="h-4 w-4 text-cs2-accent" />设置分析</div><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${plan.ai_review?.used ? "border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent" : "border-cs2-border bg-cs2-bg-input text-cs2-text-muted"}`}>{plan.ai_review?.used ? plan.ai_review.model || "AI 已完成" : "本机检测结果"}</span></div>
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">{plan.ai_review?.summary || plan.ai_review?.message || "已根据这台电脑和 OBS 的实际设置生成建议。"}</p>
          {!plan.ai_review?.used && <p className="mt-2 text-[9px] leading-relaxed text-cs2-text-muted">这里不决定最终是否流畅；系统仍会通过真实短录制和掉帧检查给出结论。</p>}
          {plan.ai_review?.reasons?.length > 0 && <ul className="mt-2 space-y-1 text-[9px] leading-relaxed text-cs2-text-muted">{plan.ai_review.reasons.map((item) => <li key={item}>· {item}</li>)}</ul>}
        </div>
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
          <div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-success"><ShieldCheck className="h-4 w-4" />设置时会自动保护</div>
          <ul className="mt-3 space-y-2 text-[10px] leading-relaxed text-cs2-text-secondary">{["修改前保存一份当前设置", "确认 OBS 没在录制或直播", "修改后马上读取实际结果", "失败时尝试恢复原来的视频设置"].map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0 text-cs2-text-success" />{item}</li>)}</ul>
        </div>
        <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-primary"><FileCheck2 className="h-4 w-4 text-cs2-accent" />不会改动</div>
          <p className="mt-2 text-[9px] leading-relaxed text-cs2-text-muted">直播平台、推流密钥、场景、画面来源、麦克风、耳机、音轨和 OBS 连接密码。</p>
        </div>
      </aside>
    </div>
  );
}

const APPLY_STEPS = [
  "重新检查电脑和 OBS",
  "检查 OBS 是否正在录制或直播",
  "保存现在的设置",
  "应用分辨率和帧率",
  "确认设置已经生效",
  "设置显卡录制方式",
  "进行短录制测试",
  "检查测试视频和掉帧",
];

function estimatedApplyProgress(elapsedSeconds, testSeconds) {
  const recordingStart = 6;
  const recordingEnd = recordingStart + Number(testSeconds || 10);
  if (elapsedSeconds < 1) return { index: 0, detail: "正在重新读取 OBS 和电脑配置。" };
  if (elapsedSeconds < 2) return { index: 1, detail: "正在确认 OBS 没有录制或直播。" };
  if (elapsedSeconds < 3) return { index: 2, detail: "正在保存修改前的设置。" };
  if (elapsedSeconds < 4) return { index: 3, detail: "正在写入分辨率和帧率。" };
  if (elapsedSeconds < 5) return { index: 4, detail: "正在读取 OBS 的实际生效值。" };
  if (elapsedSeconds < recordingStart) return { index: 5, detail: "正在设置硬件录制方式。" };
  if (elapsedSeconds < recordingEnd) return { index: 6, detail: `正在进行 ${testSeconds} 秒短录制：约第 ${Math.max(1, elapsedSeconds - recordingStart + 1)} 秒。` };
  return { index: 7, detail: elapsedSeconds < recordingEnd + 15 ? "短录制已结束，正在保存视频并检查帧率、掉帧和日志。" : "OBS 保存或媒体检查比平时更久，系统仍在等待明确结果，最长等待 2 分钟。" };
}

function ApplyWorkspace({ result, loading, elapsedSeconds = 0, testSeconds = 10, onBack, onRetry, onViewReport }) {
  const video = result?.actual?.video;
  const success = Boolean(result?.ok);
  const tested = Boolean(result?.validation || result?.test_file);
  const unstable = result?.status === "unstable";
  const events = result?.events || [];
  const reconnectNeeded = ["connection_lost", "connection_failed", "video_settings_unavailable"].includes(result?.status);
  const reconfirmNeeded = ["stale_plan", "environment_changed"].includes(result?.status);
  const liveProgress = estimatedApplyProgress(elapsedSeconds, testSeconds);
  const liveEvents = APPLY_STEPS.map((label, index) => ({
    step: String(index),
    label,
    status: index === liveProgress.index ? "running" : index < liveProgress.index ? "estimated" : "pending",
    detail: index < liveProgress.index ? "预计已经处理，等待 OBS 返回后确认" : index === liveProgress.index ? liveProgress.detail : "等待上一步完成",
  }));
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className={`rounded-2xl border bg-cs2-bg-card p-5 ${success ? "border-emerald-400/25" : result ? "border-amber-400/25" : "border-cs2-border"}`}>
        <div className="flex items-start gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${success ? "border-emerald-400/25 bg-emerald-400/10 text-cs2-text-success" : result ? "border-amber-400/25 bg-amber-400/10 text-amber-300" : "border-cs2-accent/25 bg-cs2-accent/10 text-cs2-accent"}`}>
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : success ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-cs2-text-primary">{loading ? "正在设置并测试 OBS" : success ? "设置与真实录制测试已通过" : unstable ? "测试完成，但没有稳定达标" : "这次执行没有完整完成"}</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-secondary">{loading ? liveProgress.detail : result?.message || "正在准备执行。"}</p>
          </div>
        </div>

        {loading && <div className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-input/30 p-3"><div className="flex items-center justify-between text-[9px] text-cs2-text-muted"><span>预计进度 · 已经等待 {elapsedSeconds} 秒</span><span>录制结束后还需要保存和验收</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cs2-bg-card"><div className="h-full rounded-full bg-cs2-accent transition-all duration-500" style={{ width: `${Math.min(96, Math.max(5, elapsedSeconds / (Number(testSeconds || 10) + 18) * 100))}%` }} /></div></div>}

        <div className="mt-5 space-y-2">
          {(loading ? liveEvents : events).map((event) => {
            const done = event.status === "ok";
            const failed = ["failed", "blocked"].includes(event.status);
            return (
              <div key={`${event.step}-${event.label}`} className="flex items-start gap-3 rounded-xl border border-cs2-border/75 bg-cs2-bg-input/35 px-3 py-3">
                <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${done ? "bg-emerald-400/10 text-cs2-text-success" : failed ? "bg-amber-400/10 text-amber-300" : "bg-cs2-accent/10 text-cs2-accent"}`}>
                  {done ? <Check className="h-3.5 w-3.5" /> : failed ? <AlertTriangle className="h-3.5 w-3.5" /> : <Loader2 className={`h-3.5 w-3.5 ${event.status === "running" ? "animate-spin" : "opacity-35"}`} />}
                </span>
                <div className="min-w-0"><div className="text-[11px] font-bold text-cs2-text-primary">{event.label}</div><div className="mt-0.5 text-[9px] leading-relaxed text-cs2-text-muted">{event.detail}</div></div>
              </div>
            );
          })}
        </div>

        {video && (
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3"><div className="text-[9px] font-bold text-cs2-text-muted">实际清晰度</div><div className="mt-1 font-mono text-[14px] font-bold text-cs2-text-primary">{video.output_width} × {video.output_height}</div><div className="mt-1 text-[9px] text-cs2-text-muted">画布仍为 {video.base_width} × {video.base_height}</div></div>
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3"><div className="text-[9px] font-bold text-cs2-text-muted">实际帧率</div><div className="mt-1 font-mono text-[14px] font-bold text-cs2-text-primary">{video.fps_num} / {video.fps_den} FPS</div><div className="mt-1 text-[9px] text-cs2-text-muted">已按整数帧率回读确认</div></div>
            {result?.actual?.recording && <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3"><div className="text-[9px] font-bold text-cs2-text-muted">显卡录制方式</div><div className="mt-1 truncate text-[12px] font-bold text-cs2-text-primary">{result.actual.recording.encoder_label}</div><div className="mt-1 text-[9px] text-cs2-text-muted">Hybrid MP4</div></div>}
          </div>
        )}

        {!loading && (
          <div className="mt-5 flex flex-wrap justify-between gap-2">
            <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回推荐设置</button>
            <div className="flex flex-wrap gap-2">{!success && <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-bold text-cs2-text-secondary"><RefreshCw className="h-4 w-4" />{reconnectNeeded ? "重新连接 OBS" : reconfirmNeeded ? "重新确认设置" : "重新执行"}</button>}{tested && <button type="button" onClick={onViewReport} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent"><FileCheck2 className="h-4 w-4" />查看完整测试结果</button>}</div>
          </div>
        )}
      </section>

      <aside className="space-y-3">
        {result?.backup && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4"><div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-success"><ShieldCheck className="h-4 w-4" />原设置已保存</div><p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">如果后续发现问题，可以恢复到修改前。</p><p title={result.backup.path} className="mt-2 truncate font-mono text-[9px] text-cs2-text-muted">{result.backup.path}</p></div>}
        <div className={`rounded-2xl border p-4 ${result?.validation?.passed ? "border-emerald-400/20 bg-emerald-400/[0.04]" : "border-amber-400/20 bg-amber-400/[0.04]"}`}><div className={`flex items-center gap-2 text-[12px] font-bold ${result?.validation?.passed ? "text-cs2-text-success" : "text-amber-200"}`}><FileCheck2 className="h-4 w-4" />{result?.validation ? result.validation.passed ? "真实录制测试通过" : "真实录制测试未达标" : "等待真实录制测试"}</div><p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">{result?.validation ? result.validation.passed ? "ffprobe、实时帧率、渲染掉帧、编码掉帧和日志均已检查。" : "没有自动降低设置；请在完整报告中查看瓶颈和最小调整建议。" : "执行后会检查实际视频文件与 OBS 掉帧。"}</p></div>
      </aside>
    </div>
  );
}

function ReportWorkspace({ result, onBack, onRestore, restoreLoading, restoreResult }) {
  const validation = result?.validation || {};
  const media = result?.actual?.ffprobe || {};
  const mediaVideo = media.video || {};
  const stats = result?.actual?.stats || {};
  const logs = result?.actual?.logs || {};
  const passed = Boolean(validation.passed);
  return (
    <div className="space-y-4">
      <section className={`rounded-2xl border p-5 ${passed ? "border-emerald-400/25 bg-emerald-400/[0.035]" : "border-amber-400/25 bg-amber-400/[0.035]"}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3"><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${passed ? "bg-emerald-400/10 text-cs2-text-success" : "bg-amber-400/10 text-amber-300"}`}>{passed ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}</span><div><h2 className="text-base font-bold text-cs2-text-primary">{passed ? "稳定性测试通过" : "没有稳定达到目标"}</h2><p className="mt-1 text-[11px] leading-relaxed text-cs2-text-secondary">{result?.message}</p></div></div>
          <span className={`rounded-full border px-3 py-1 text-[10px] font-bold ${passed ? "border-emerald-400/30 bg-emerald-400/10 text-cs2-text-success" : "border-amber-400/30 bg-amber-400/10 text-amber-200"}`}>{passed ? "可以使用" : "建议调整后重测"}</span>
        </div>
        {!passed && validation.reasons?.length > 0 && <div className="mt-4 rounded-xl border border-amber-400/20 bg-black/10 p-3"><div className="text-[10px] font-bold text-amber-200">未通过原因</div><ul className="mt-2 space-y-1 text-[10px] text-cs2-text-secondary">{validation.reasons.map((item) => <li key={item}>· {item}</li>)}</ul>{validation.minimum_adjustment && <p className="mt-2 border-t border-cs2-border/60 pt-2 text-[10px] text-cs2-text-primary">最小调整：{validation.minimum_adjustment}</p>}</div>}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["视频文件帧率", `${mediaVideo.r_frame_rate || "未知"}`, `平均 ${mediaVideo.avg_frame_rate || "未知"}`, validation.r_frame_rate_ok && validation.avg_frame_rate_ok],
          ["视频分辨率", `${mediaVideo.width || 0} × ${mediaVideo.height || 0}`, mediaVideo.codec_name || "编码未知", validation.media_resolution_ok],
          ["渲染掉帧", stats.rendering_lag_percent == null ? "未知" : `${stats.rendering_lag_percent}%`, `${stats.render_skipped_frames || 0} / ${stats.render_total_frames || 0} 帧`, stats.rendering_lag_percent != null && stats.rendering_lag_percent <= 1],
          ["编码掉帧", stats.encoding_lag_percent == null ? "未知" : `${stats.encoding_lag_percent}%`, `${stats.output_skipped_frames || 0} / ${stats.output_total_frames || 0} 帧`, stats.encoding_lag_percent != null && stats.encoding_lag_percent <= 1],
        ].map(([label, value, detail, ok]) => <div key={label} className={`rounded-xl border p-3.5 ${ok ? "border-emerald-400/20 bg-emerald-400/[0.035]" : "border-amber-400/20 bg-cs2-bg-card"}`}><div className="text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted">{label}</div><div className="mt-2 font-mono text-[14px] font-bold text-cs2-text-primary">{value}</div><div className="mt-1 text-[9px] text-cs2-text-muted">{detail}</div></div>)}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <h3 className="text-[12px] font-bold text-cs2-text-primary">测试文件</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-xl border border-cs2-border bg-cs2-bg-input/35 p-3"><div className="text-[9px] text-cs2-text-muted">文件位置</div><div title={result?.test_file} className="mt-1 truncate font-mono text-[10px] text-cs2-text-secondary">{result?.test_file || "没有生成"}</div></div><div className="rounded-xl border border-cs2-border bg-cs2-bg-input/35 p-3"><div className="text-[9px] text-cs2-text-muted">时长 / 大小 / 音轨</div><div className="mt-1 text-[10px] text-cs2-text-secondary">{media.duration_seconds || 0} 秒 · {media.size_bytes ? `${(media.size_bytes / 1024 / 1024).toFixed(1)} MB` : "未知大小"} · {(media.audio_tracks || []).length} 条音轨</div></div></div>
          <div className="mt-3 rounded-xl border border-cs2-border bg-cs2-bg-input/25 p-3 text-[10px] leading-relaxed text-cs2-text-secondary">OBS 实时 FPS：<span className="font-mono text-cs2-text-primary">{stats.active_fps ?? "未知"}</span>；平均渲染耗时：<span className="font-mono text-cs2-text-primary">{stats.average_frame_render_time_ms ?? "未知"} ms</span>；日志中的编码过载：<span className="font-mono text-cs2-text-primary">{logs.encoding_overload_mentions ?? 0}</span> 次。</div>
        </section>
        <aside className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-primary"><ShieldCheck className="h-4 w-4 text-cs2-accent" />恢复原设置</div><p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">恢复完整备份前必须正常关闭 OBS，避免 OBS 同时写配置。</p>
          {restoreResult && <div className={`mt-3 rounded-lg border px-3 py-2 text-[9px] ${restoreResult.ok ? "border-emerald-400/20 text-cs2-text-success" : "border-amber-400/20 text-amber-200"}`}>{restoreResult.message}</div>}
          <button type="button" disabled={!result?.backup?.id || restoreLoading} onClick={onRestore} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-input px-3 py-2.5 text-[10px] font-bold text-cs2-text-secondary disabled:opacity-40">{restoreLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}恢复到测试前</button>
        </aside>
      </div>

      <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回执行详情</button>
    </div>
  );
}

export default function ObsAiSettingsPanel({
  obsPath,
  obsConnected,
  ffmpegReady,
  autoPrepare = false,
  onAutoPrepareChange,
  previewMode = false,
}) {
  const [goal, setGoal] = useState({ resolution: "current", fps: 60, fpsDraft: "60", priority: "balanced", useCase: "slowmo", codec: "auto", testSeconds: 10 });
  const [screen, setScreen] = useState("overview");
  const [keepCurrentConfirmed, setKeepCurrentConfirmed] = useState(false);
  const [discovery, setDiscovery] = useState(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(!previewMode);
  const [recommendationResult, setRecommendationResult] = useState(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyElapsedSeconds, setApplyElapsedSeconds] = useState(0);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState(null);
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [previewConnected, setPreviewConnected] = useState(Boolean(obsConnected));
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(!previewMode || !obsConnected);
  const [connectionDismissed, setConnectionDismissed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const autoPrepareAttemptedRef = useRef(false);

  const goalPayload = useMemo(() => ({
    resolution: goal.resolution,
    fps: goal.fps,
    use_case: goal.useCase,
    priority: goal.priority,
    codec: goal.codec,
    test_seconds: goal.testSeconds,
  }), [goal]);
  const fallbackRecommendation = useMemo(() => buildFallbackRecommendation(goal), [goal]);
  const recommendation = useMemo(() => toWorkspaceRecommendation(recommendationResult, fallbackRecommendation), [fallbackRecommendation, recommendationResult]);
  const selectedOutput = useMemo(() => selectedOutputDimensions(goal, discovery), [discovery, goal]);
  const effectiveConnected = previewMode
    ? previewConnected
    : discovery
      ? Boolean(discovery?.obs?.connected)
      : Boolean(bootstrapResult?.ok || obsConnected);
  const effectiveObsPath = discovery?.obs?.install_path || obsPath;
  const effectiveFfmpegReady = discovery?.ffmpeg?.usable ?? ffmpegReady;
  const effectiveFfprobeReady = discovery?.ffmpeg?.ffprobe_usable ?? ffmpegReady;
  const connectionDiscovery = discovery || {
    obs: {
      install_detected: Boolean(effectiveObsPath),
      install_path: effectiveObsPath,
      connected: effectiveConnected,
      host: "localhost",
      port: 4455,
    },
  };

  const refreshDiscovery = useCallback(async () => {
    if (previewMode) return;
    setDiscoveryLoading(true);
    setErrorMessage("");
    try {
      const next = await discoverObsTuningEnvironment();
      setDiscovery(next);
    } catch (error) {
      setErrorMessage(error?.response?.data?.detail || error?.message || "无法读取 OBS 调优环境");
    } finally {
      setDiscoveryLoading(false);
    }
  }, [previewMode]);

  useEffect(() => { void refreshDiscovery(); }, [refreshDiscovery]);

  useEffect(() => {
    if (discoveryLoading) return;
    if (effectiveConnected) {
      setConnectionDialogOpen(false);
      setConnectionDismissed(false);
    } else if (!connectionDismissed) {
      setConnectionDialogOpen(true);
    }
  }, [connectionDismissed, discoveryLoading, effectiveConnected]);

  const handleBootstrap = useCallback(async () => {
    if (bootstrapLoading) return;
    if (previewMode) {
      setBootstrapResult({ ok: true, status: "connected", events: [] });
      setPreviewConnected(true);
      setConnectionDialogOpen(false);
      return;
    }
    setBootstrapLoading(true);
    setErrorMessage("");
    try {
      const next = await bootstrapObsTuningEnvironment({ password: bootstrapPassword });
      setBootstrapResult(next);
      if (next.ok) {
        setBootstrapPassword("");
        await refreshDiscovery();
        setScreen("overview");
        setKeepCurrentConfirmed(false);
        setConnectionDialogOpen(false);
      }
    } catch (error) {
      setErrorMessage(error?.response?.data?.detail || error?.message || "Agent 无法准备 OBS");
    } finally {
      setBootstrapLoading(false);
    }
  }, [bootstrapLoading, bootstrapPassword, previewMode, refreshDiscovery]);

  useEffect(() => {
    if (previewMode || !autoPrepare || autoPrepareAttemptedRef.current || discoveryLoading || !discovery || effectiveConnected) return;
    autoPrepareAttemptedRef.current = true;
    void handleBootstrap();
  }, [autoPrepare, discovery, discoveryLoading, effectiveConnected, handleBootstrap, previewMode]);

  useEffect(() => {
    setPlan(null);
    setApplyResult(null);
    setRestoreResult(null);
    setScreen((current) => current === "overview" ? "overview" : "goal");
  }, [goalPayload]);

  useEffect(() => {
    if (!applyLoading) return undefined;
    setApplyElapsedSeconds(0);
    const timer = window.setInterval(() => setApplyElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [applyLoading]);

  useEffect(() => {
    if (previewMode || !discovery || !effectiveConnected) {
      setRecommendationResult(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setRecommendationLoading(true);
      try {
        const next = await recommendObsTuningGoal(goalPayload, discovery);
        if (!cancelled) setRecommendationResult(next);
      } catch (error) {
        if (!cancelled) setErrorMessage(error?.response?.data?.detail || error?.message || "无法生成硬件推荐");
      } finally {
        if (!cancelled) setRecommendationLoading(false);
      }
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [discovery, effectiveConnected, goalPayload, previewMode]);

  const handleCreatePlan = useCallback(async () => {
    setPlanLoading(true);
    setErrorMessage("");
    setScreen("plan");
    try {
      if (previewMode) {
        setPlan({
          plan_id: "obs_preview_8f3a42d1",
          plan_hash: "8f3a42d1f6e5c4b3a291807060504030",
          can_apply: true,
          blockers: [],
          changes: [
            { key: "video.fps", current: "60/1", target: `${goal.fps}/1` },
            { key: "video.output_resolution", current: "2560×1440", target: `${selectedOutput.width} × ${selectedOutput.height}` },
            { key: "recording.encoder", current: "与直播一致", target: "NVIDIA NVENC H.264" },
            { key: "recording.format", current: "MKV", target: "Hybrid MP4（异常中断可恢复）" },
          ],
          ai_review: {
            used: true,
            model: "演示模型",
            summary: "RTX 5070 具备高帧率硬件编码能力，但 480 FPS 仍必须通过真实短录制确认。",
            reasons: ["将优先使用 NVIDIA NVENC H.264", "不会自动降低你选择的分辨率或帧率"],
          },
          protected_fields: ["audio.track_mapping", "stream.key", "websocket.password", "ffmpeg.path"],
          safety_guards: ["执行前重新探测环境", "写入前创建 Profile 备份", "写入后回读实际设置", "失败时不静默降低 FPS"],
        });
      } else {
        setPlan(await createObsTuningPlan(goalPayload));
      }
    } catch (error) {
      setErrorMessage(error?.response?.data?.detail || error?.message || "无法生成安全变更计划");
      setScreen("goal");
    } finally {
      setPlanLoading(false);
    }
  }, [goal.fps, goalPayload, previewMode, selectedOutput.height, selectedOutput.width]);

  const startAiAdjustment = useCallback(() => {
    const current = discovery?.obs?.video || (previewMode ? { fps_num: 60 } : {});
    const currentFps = Number(current.fps_num || 60);
    setKeepCurrentConfirmed(false);
    setGoal((previous) => ({
      ...previous,
      resolution: "current",
      fps: currentFps,
      fpsDraft: String(currentFps),
    }));
    setScreen("goal");
  }, [discovery, previewMode]);

  const handleApplyPlan = useCallback(async () => {
    if (!plan?.plan_hash || applyLoading) return;
    setApplyLoading(true);
    setApplyResult(null);
    setErrorMessage("");
    setScreen("run");
    try {
      if (previewMode) {
        await Promise.resolve();
        setApplyResult({
          ok: true,
          status: "passed",
          message: `已完成真实短录制，稳定达到 ${goal.fps} FPS。`,
          events: [
            { step: "recheck", label: "重新检查电脑和 OBS", status: "ok", detail: "连接正常，确认内容没有变化。" },
            { step: "idle", label: "检查 OBS 是否正在录制或直播", status: "ok", detail: "OBS 当前没有录制、直播或运行其他输出，可以安全修改。" },
            { step: "backup", label: "保存现在的设置", status: "ok", detail: "已经创建恢复点。" },
            { step: "apply", label: "应用分辨率和帧率", status: "ok", detail: `已请求设置为 ${selectedOutput.width} × ${selectedOutput.height}、${goal.fps} FPS。` },
            { step: "verify", label: "确认设置已经生效", status: "ok", detail: `实际为 ${selectedOutput.width} × ${selectedOutput.height}、${goal.fps}/1 FPS。` },
            { step: "encoder", label: "设置显卡录制方式", status: "ok", detail: "已回读确认 NVIDIA NVENC H.264，容器为 Hybrid MP4。" },
            { step: "record", label: "进行短录制测试", status: "ok", detail: "已完成 10 秒测试录制。" },
            { step: "probe", label: "检查测试视频和掉帧", status: "ok", detail: "ffprobe、OBS Stats 与日志检查完成。" },
          ],
          backup: { id: "obs_preview", path: "C:\\Users\\Demo\\AppData\\Local\\CS2 Insight\\backups\\obs_preview" },
          test_file: "C:\\Users\\Demo\\Videos\\OBS_OUTPUT\\obs-test.mp4",
          validation: { passed: true, verdict: "stable", media_resolution_ok: true, r_frame_rate_ok: true, avg_frame_rate_ok: true, stats_ok: true, logs_ok: true, encoder_ok: true, reasons: [] },
          actual: {
            video: {
              base_width: 2560,
              base_height: 1440,
              output_width: selectedOutput.width,
              output_height: selectedOutput.height,
              fps_num: goal.fps,
              fps_den: 1,
            },
            recording: { encoder_label: "NVIDIA NVENC H.264", values: { RecEncoder: "jim_nvenc", RecFormat2: "hybrid_mp4" } },
            ffprobe: { duration_seconds: 10.04, size_bytes: 188743680, format_name: "mov,mp4", video: { codec_name: "h264", width: selectedOutput.width, height: selectedOutput.height, r_frame_rate: `${goal.fps}/1`, avg_frame_rate: `${goal.fps}/1` }, audio_tracks: [{ index: 1, codec_name: "aac", channels: 2, sample_rate: "48000" }] },
            stats: { active_fps: goal.fps, rendering_lag_percent: 0.08, render_skipped_frames: 4, render_total_frames: 4800, encoding_lag_percent: 0.04, output_skipped_frames: 2, output_total_frames: 4800, average_frame_render_time_ms: 1.12 },
            logs: { available: true, encoding_overload_mentions: 0, render_lag_mentions: 0, nvenc_mentions: 1 },
          },
        });
      } else {
        setApplyResult(await applyObsTuningPlan(goalPayload, plan.plan_hash));
      }
    } catch (error) {
      const timedOut = error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";
      const message = timedOut
        ? "OBS 保存测试视频或验收用时超过 2 分钟。请查看 OBS 是否仍在录制，再重新检查连接；系统不会自动降低你的设置。"
        : error?.response?.data?.detail || error?.message || "自动设置 OBS 时出现问题";
      setApplyResult({ ok: false, status: "request_failed", message, events: [] });
    } finally {
      setApplyLoading(false);
    }
  }, [applyLoading, goal.fps, goalPayload, plan, previewMode, selectedOutput.height, selectedOutput.width]);

  const handleApplyRecovery = useCallback(async () => {
    const status = applyResult?.status;
    if (["connection_lost", "connection_failed", "video_settings_unavailable"].includes(status)) {
      setBootstrapResult(null);
      setScreen("goal");
      setConnectionDismissed(false);
      setConnectionDialogOpen(true);
      await refreshDiscovery();
      return;
    }
    if (["stale_plan", "environment_changed"].includes(status)) {
      await handleCreatePlan();
      return;
    }
    await handleApplyPlan();
  }, [applyResult?.status, handleApplyPlan, handleCreatePlan, refreshDiscovery]);

  const handleRestore = useCallback(async () => {
    if (!applyResult?.backup?.id || restoreLoading) return;
    setRestoreLoading(true);
    setRestoreResult(null);
    try {
      if (previewMode) {
        setRestoreResult({ ok: true, message: "演示：原设置已经恢复；真实流程会要求先正常关闭 OBS。" });
      } else {
        setRestoreResult(await restoreObsTuningBackup(applyResult.backup.id));
      }
    } catch (error) {
      setRestoreResult({ ok: false, message: error?.response?.data?.detail || error?.message || "无法恢复原设置" });
    } finally {
      setRestoreLoading(false);
    }
  }, [applyResult?.backup?.id, previewMode, restoreLoading]);

  const closeConnectionDialog = () => {
    if (discoveryLoading || bootstrapLoading) return;
    setConnectionDismissed(true);
    setConnectionDialogOpen(false);
  };

  return (
    <section data-testid="obs-ai-settings-panel" className="space-y-4">
      <header className="flex flex-col gap-4 rounded-2xl border border-cs2-accent/25 bg-[radial-gradient(circle_at_top_right,rgba(255,140,0,0.12),transparent_45%)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent"><Sparkles className="h-5 w-5" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-bold text-cs2-text-primary">智能录制设置</h2><span className="rounded-full border border-cs2-accent/30 bg-cs2-accent/10 px-2 py-0.5 text-[9px] font-bold text-cs2-accent">由你决定是否使用 AI</span><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${effectiveConnected ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-amber-400/30 bg-amber-400/10 text-amber-300"}`}>{effectiveConnected ? "OBS 已连接" : "OBS 未连接"}</span></div>
            <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-secondary">连接后先展示当前 OBS 设置；只有你主动选择时，AI 才会帮助调整。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-2 text-[9px] font-semibold text-cs2-text-muted" title={effectiveObsPath || undefined}><Monitor className="h-3.5 w-3.5" />{effectiveObsPath ? "已经找到 OBS" : "正在查找 OBS"}</span>
          <button type="button" onClick={() => { if (effectiveConnected) void refreshDiscovery(); else { setConnectionDismissed(false); setConnectionDialogOpen(true); } }} className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[10px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35"><RadioTower className="h-3.5 w-3.5" />{effectiveConnected ? "重新检查电脑" : "连接 OBS"}</button>
        </div>
      </header>

      {effectiveConnected ? (
        <>
          {errorMessage && <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.05] px-3 py-2.5 text-[10px] text-cs2-rose-on-surface">{errorMessage}</div>}
          {screen === "overview" ? (
            <CurrentObsConfiguration discovery={discovery} previewMode={previewMode} refreshing={discoveryLoading} kept={keepCurrentConfirmed} onKeep={() => setKeepCurrentConfirmed(true)} onRefresh={() => void refreshDiscovery()} onUseAi={startAiAdjustment} />
          ) : (
            <>
              <ScreenNav active={screen} onChange={setScreen} enabledKeys={applyResult?.validation || applyResult?.test_file ? ["goal", "plan", "run", "report"] : applyResult || applyLoading ? ["goal", "plan", "run"] : plan || planLoading ? ["goal", "plan"] : ["goal"]} />
              {screen === "goal" ? (
                <GoalScreen goal={goal} setGoal={setGoal} recommendation={recommendation} recommendationLoading={recommendationLoading} environment={discovery} onBack={() => setScreen("overview")} onNext={() => void handleCreatePlan()} />
              ) : screen === "plan" ? (
                <PlanWorkspace plan={plan} loading={planLoading} onApply={() => void handleApplyPlan()} onBack={() => setScreen("goal")} />
              ) : screen === "run" ? (
                <ApplyWorkspace result={applyResult} loading={applyLoading} elapsedSeconds={applyElapsedSeconds} testSeconds={goal.testSeconds} onBack={() => setScreen("plan")} onRetry={() => void handleApplyRecovery()} onViewReport={() => setScreen("report")} />
              ) : (
                <ReportWorkspace result={applyResult} onBack={() => setScreen("run")} onRestore={() => void handleRestore()} restoreLoading={restoreLoading} restoreResult={restoreResult} />
              )}
              {!effectiveFfprobeReady && <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.04] px-3 py-2.5 text-[10px] text-cs2-text-secondary"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />没有找到 ffprobe，无法检查真实测试文件；请确认 FFmpeg 工具包中同时包含 ffprobe。</div>}
            </>
          )}
        </>
      ) : (
        <LockedWorkspace discoveryLoading={discoveryLoading} onOpen={() => { setConnectionDismissed(false); setConnectionDialogOpen(true); }} />
      )}

      {connectionDialogOpen && !effectiveConnected && (
        <ConnectionDialog
          autoPrepare={autoPrepare}
          bootstrapLoading={bootstrapLoading}
          bootstrapPassword={bootstrapPassword}
          bootstrapResult={bootstrapResult}
          discovery={connectionDiscovery}
          discoveryLoading={discoveryLoading}
          errorMessage={errorMessage}
          ffmpegReady={effectiveFfmpegReady}
          onAutoPrepareChange={onAutoPrepareChange}
          onBootstrap={() => void handleBootstrap()}
          onClose={closeConnectionDialog}
          onPasswordChange={setBootstrapPassword}
          onRefresh={() => void refreshDiscovery()}
        />
      )}
    </section>
  );
}
