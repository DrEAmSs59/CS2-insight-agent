import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Cpu,
  FileCheck2,
  Film,
  Gauge,
  HardDrive,
  LockKeyhole,
  Monitor,
  Play,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";
import PageContainer from "../components/PageContainer";

const SCREENS = [
  { key: "goal", label: "选择录制效果", caption: "分辨率和帧率" },
  { key: "plan", label: "确认推荐设置", caption: "看看系统准备怎么调" },
  { key: "run", label: "自动设置并测试", caption: "备份、写入、短录制" },
  { key: "report", label: "查看测试结果", caption: "是否流畅一目了然" },
];

const RESOLUTIONS = [
  { value: "current", label: "保持现在的清晰度", detail: "2560 × 1440", badge: "推荐" },
  { value: "four-three", label: "4:3 高清", detail: "1920 × 1440" },
  { value: "full-hd", label: "1080P", detail: "1920 × 1080" },
];

const FPS_OPTIONS = [60, 120, 240, 480];

const MACHINE_PROFILE = {
  gpu: "NVIDIA GeForce RTX 5070",
  cpu: "AMD Ryzen 9 9950X3D",
  memory: "32 GB DDR5",
  disk: "NVMe SSD · 1.8 TB 可用",
  diskWriteMbps: 6200,
  cs2FpsP10: 515,
};

const CODECS = [
  { value: "auto", label: "自动推荐（适合大多数玩家）" },
  { value: "h264", label: "H.264（最兼容）" },
  { value: "hevc", label: "HEVC（更省空间）" },
  { value: "av1", label: "AV1（画质和体积更好）" },
];

const RUN_STEPS = [
  { title: "创建配置快照", detail: "备份当前 Profile，并记录受保护字段指纹", icon: ShieldCheck },
  { title: "切换专属 Profile", detail: "确认所有 OBS 输出已停止后切换", icon: RadioTower },
  { title: "应用目标参数", detail: "WebSocket 写入并立即回读精确 FPS 与分辨率", icon: WandSparkles },
  { title: "短录制测试", detail: "录制 10 秒 CS2 动态画面，采集前后 Stats", icon: Film },
  { title: "媒体与日志验收", detail: "ffprobe + OBS 日志联合判断，不只相信 UI", icon: FileCheck2 },
];

function resolutionDimensions(resolution) {
  if (resolution === "four-three") return { width: 1920, height: 1440 };
  if (resolution === "full-hd") return { width: 1920, height: 1080 };
  return { width: 2560, height: 1440 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildHardwareRecommendation(goal) {
  const fps = Number(goal.fps) || 1;
  const { width, height } = resolutionDimensions(goal.resolution);
  const megapixelsPerSecond = (width * height * fps) / 1_000_000;
  const codec = goal.codec === "auto" ? "h264" : goal.codec;
  const codecCapacity = { h264: 2400, hevc: 2050, av1: 1800 }[codec] ?? 2200;
  const qualityFactor = { quality: 1.12, balanced: 1, performance: 0.88 }[goal.priority] ?? 1;
  const encoderLoad = clamp(Math.round((megapixelsPerSecond * qualityFactor / codecCapacity) * 100), 8, 99);
  const renderLoad = clamp(Math.round((megapixelsPerSecond / 2000) * 100), 10, 99);
  const targetAboveGameP10 = fps > MACHINE_PROFILE.cs2FpsP10;
  const ultraFpsPenalty = fps >= 480 ? 20 : fps >= 360 ? 10 : fps >= 300 ? 5 : 0;
  const useCasePenalty = goal.useCase === "archive" && fps > 240 ? 8 : 0;
  const gamePenalty = targetAboveGameP10 ? clamp(Math.round((fps - MACHINE_PROFILE.cs2FpsP10) / 3), 5, 24) : 0;
  const score = clamp(Math.round(
    100
      - Math.max(0, encoderLoad - 65) * 1.1
      - Math.max(0, renderLoad - 65) * 1.35
      - ultraFpsPenalty
      - useCasePenalty
      - gamePenalty,
  ), 18, 98);

  let level = "recommended";
  let label = "推荐";
  let verdict = "预计余量充足，适合作为默认方案";
  let tone = "success";
  if (score < 48) {
    level = "not_recommended";
    label = "不推荐直接使用";
    verdict = "大概率出现渲染或编码掉帧，建议先采用备选方案";
    tone = "danger";
  } else if (score < 68) {
    level = "experimental";
    label = "探索性方案";
    verdict = "有明显卡顿风险，只建议短测后决定";
    tone = "warning";
  } else if (score < 85) {
    level = "cautious";
    label = "可以尝试";
    verdict = "预计可运行，但稳定性必须由真实录制证明";
    tone = "accent";
  }

  const risks = [];
  if (fps >= 480) risks.push(`单帧预算仅 ${(1000 / fps).toFixed(2)} ms，瞬时抖动更容易造成跳帧`);
  if (renderLoad >= 80) risks.push("OBS 渲染线程余量偏小，复杂 Browser Source 或滤镜会放大风险");
  if (encoderLoad >= 80) risks.push("硬件编码吞吐接近启发式上限，需要真实 NVENC 短测");
  if (targetAboveGameP10) risks.push(`目标高于本机 CS2 基准 P10（${MACHINE_PROFILE.cs2FpsP10} FPS），有效独立帧可能不足`);
  if (!FPS_OPTIONS.includes(fps)) risks.push("这是自定义 FPS，需额外检查插件、容器和后处理链兼容性");
  if (goal.useCase === "archive" && fps > 240) risks.push("长时间归档采用超高帧率会显著增加容量和热负载");
  if (risks.length === 0) risks.push("未发现突出风险；仍需用短录制验证实际负载");

  const recommendedFps = goal.resolution === "current" ? 240 : goal.resolution === "four-three" ? 360 : 480;
  const recommendedResolution = fps >= 480 && goal.resolution === "current" ? "full-hd" : goal.resolution;
  const saferResolution = recommendedResolution === "full-hd" ? "1920 × 1080" : `${width} × ${height}`;
  const lowGb = Math.max(1, Math.round(megapixelsPerSecond * 0.18 * 600 / 8000));
  const highGb = Math.max(lowGb + 2, Math.round(megapixelsPerSecond * 0.42 * 600 / 8000));
  const bottleneck = renderLoad >= encoderLoad + 8
    ? "OBS 渲染线程"
    : encoderLoad >= renderLoad + 8
      ? `${codec.toUpperCase()} 硬件编码`
      : "GPU 渲染与编码并发";

  return {
    score,
    level,
    label,
    verdict,
    tone,
    encoderLoad,
    renderLoad,
    headroom: Math.max(0, 100 - Math.max(encoderLoad, renderLoad)),
    megapixelsPerSecond: Math.round(megapixelsPerSecond),
    risks,
    bottleneck,
    recommendedFps,
    recommendedResolution,
    saferResolution,
    fileEstimate: `${lowGb}–${highGb} GB / 10 分钟`,
  };
}

function Badge({ children, tone = "muted" }) {
  const tones = {
    accent: "border-cs2-accent/35 bg-cs2-accent/10 text-cs2-accent",
    success: "border-emerald-400/30 bg-emerald-400/10 text-cs2-text-success",
    warning: "border-amber-400/30 bg-amber-400/10 text-cs2-amber-on-surface",
    danger: "border-rose-400/30 bg-rose-400/10 text-cs2-rose-on-surface",
    muted: "border-cs2-border bg-cs2-bg-input text-cs2-text-muted",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone = "default" }) {
  const iconTone = tone === "accent" ? "text-cs2-accent" : tone === "success" ? "text-cs2-text-success" : "text-cs2-text-secondary";
  return (
    <div className="rounded-xl border border-cs2-border/80 bg-cs2-bg-card/90 p-3.5 shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-cs2-text-muted">
        <Icon className={`h-3.5 w-3.5 ${iconTone}`} />
        {label}
      </div>
      <div className="mt-2 font-mono text-[13px] font-semibold text-cs2-text-primary">{value}</div>
      <div className="mt-1 text-[11px] text-cs2-text-muted">{detail}</div>
    </div>
  );
}

function ChoiceCard({ selected, onClick, title, detail, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative rounded-xl border p-3 text-left transition-all ${
        selected
          ? "border-cs2-accent/70 bg-cs2-accent/10 shadow-[0_0_0_1px_rgba(224,127,10,0.08)]"
          : "border-cs2-border bg-cs2-bg-input/45 hover:border-cs2-accent/35 hover:bg-cs2-bg-hover"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[12px] font-bold text-cs2-text-primary">{title}</div>
          <div className="mt-1 font-mono text-[11px] text-cs2-text-muted">{detail}</div>
        </div>
        {selected ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cs2-accent text-cs2-text-on-accent">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        ) : badge ? (
          <Badge tone="accent">{badge}</Badge>
        ) : null}
      </div>
    </button>
  );
}

export function ScreenNav({ active, onChange, enabledKeys = null }) {
  const activeIndex = SCREENS.findIndex((item) => item.key === active);
  return (
    <div className="grid gap-2 lg:grid-cols-4" aria-label="原型页面切换">
      {SCREENS.map((item, index) => {
        const selected = item.key === active;
        const passed = index < activeIndex;
        const enabled = !enabledKeys || enabledKeys.includes(item.key);
        return (
          <button
            type="button"
            key={item.key}
            disabled={!enabled}
            onClick={() => enabled && onChange(item.key)}
            className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              selected
                ? "border-cs2-accent/55 bg-cs2-accent/10"
                : enabled
                  ? "border-cs2-border/75 bg-cs2-bg-card hover:border-cs2-accent/30"
                  : "cursor-not-allowed border-cs2-border/50 bg-cs2-bg-card/60 opacity-55"
            }`}
          >
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-bold ${
              selected
                ? "border-cs2-accent bg-cs2-accent text-cs2-text-on-accent"
                : passed
                  ? "border-emerald-400/40 bg-emerald-400/10 text-cs2-text-success"
                  : "border-cs2-border bg-cs2-bg-input text-cs2-text-muted"
            }`}>
              {passed ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-[12px] font-bold ${selected ? "text-cs2-accent" : "text-cs2-text-primary"}`}>{item.label}</span>
              <span className="mt-0.5 block truncate text-[10px] text-cs2-text-muted">{item.caption}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function pickPrimaryGpu(environment) {
  const preferred = environment?.hardware?.primary_gpu;
  if (preferred?.name) return preferred;
  const gpus = [...(environment?.hardware?.gpus || [])];
  return gpus.sort((a, b) => {
    const score = (gpu) => {
      const name = String(gpu?.name || "").toLowerCase();
      const dedicated = /\b(rtx|gtx|quadro|titan)\b|radeon\s+rx|intel\s+arc/.test(name) ? 100000 : 0;
      const integrated = /radeon\(tm\) graphics|\b(uhd|iris)\b|integrated/.test(name) ? -100000 : 0;
      return dedicated + integrated + Number(gpu?.memory_mb || 0);
    };
    return score(b) - score(a);
  })[0] || null;
}

function friendlyRecommendationLabel(score) {
  if (score >= 85) return "很适合这台电脑";
  if (score >= 68) return "可以先试试";
  if (score >= 48) return "建议先录一小段测试";
  return "这套设置可能会卡";
}

function friendlyRecommendationText(score) {
  if (score >= 85) return "电脑余量比较充足，可以把它作为第一次测试的设置。";
  if (score >= 68) return "预计可以录制，但最好先自动录一小段确认是否流畅。";
  if (score >= 48) return "对电脑压力比较大，正式录制前一定要先测试。";
  return "录制时可能出现掉帧，建议先使用更稳妥的设置。";
}

function friendlyBottleneck(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("render") || text.includes("渲染")) return "OBS 处理画面的速度";
  if (text.includes("encod") || text.includes("编码") || text.includes("h264") || text.includes("hevc") || text.includes("av1")) return "显卡录制视频的速度";
  if (text.includes("gpu") || text.includes("显卡")) return "显卡同时运行游戏和录制";
  return "电脑的整体性能";
}

export function DiscoveryRail({ recommendation, environment = null, recommendationLoading = false }) {
  const scoreBar = recommendation.score >= 85
    ? "bg-emerald-400"
    : recommendation.score >= 68
      ? "bg-cs2-accent"
      : recommendation.score >= 48
        ? "bg-amber-400"
        : "bg-rose-400";
  return (
    <aside className="space-y-3 xl:sticky xl:top-0 xl:self-start">
      <div className="overflow-hidden rounded-2xl border border-cs2-accent/25 bg-cs2-bg-card">
        <div className="bg-[radial-gradient(circle_at_top_right,rgba(224,127,10,0.14),transparent_56%)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-cs2-text-muted">
                <Sparkles className="h-3.5 w-3.5 text-cs2-accent" />这套设置适合你的电脑吗？
              </div>
              <div className="mt-2 text-[15px] font-bold text-cs2-text-primary">{friendlyRecommendationLabel(recommendation.score)}</div>
            </div>
            <Badge tone={recommendation.tone}>{recommendationLoading ? "计算中" : `${recommendation.score} / 100`}</Badge>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-cs2-text-secondary">{friendlyRecommendationText(recommendation.score)}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-cs2-bg-input">
            <div className={`h-full rounded-full transition-all ${scoreBar}`} style={{ width: `${recommendation.score}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {[
              ["画面处理压力", `${recommendation.renderLoad}%`],
              ["视频录制压力", `${recommendation.encoderLoad}%`],
              ["剩余性能", `${recommendation.headroom}%`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-cs2-border/70 bg-cs2-bg-input/35 p-2 text-center">
                <div className="font-mono text-[11px] font-bold text-cs2-text-primary">{value}</div>
                <div className="mt-0.5 text-[8px] text-cs2-text-muted">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg border border-cs2-border/70 bg-cs2-bg-input/30 px-2.5 py-2 text-[9px] leading-relaxed text-cs2-text-muted">
            <span className="font-semibold text-cs2-text-secondary">最可能卡在：</span>{friendlyBottleneck(recommendation.bottleneck)}<br />
            <span className="font-semibold text-cs2-text-secondary">预计占用空间：</span>{recommendation.fileEstimate}
          </div>
          <p className="mt-2 text-[8px] leading-relaxed text-cs2-text-muted">这里先根据电脑配置估算。稍后会自动录一小段，再告诉你实际会不会卡。</p>
        </div>
      </div>

      <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] font-bold text-cs2-text-primary">这台电脑</div>
          <Badge tone="success">已识别</Badge>
        </div>
        <div className="mt-4 space-y-3">
          {(() => {
            const primaryGpu = pickPrimaryGpu(environment);
            const allGpus = environment?.hardware?.gpus || [];
            const otherGpu = allGpus.find((gpu) => gpu?.name && gpu.name !== primaryGpu?.name);
            const gpuMemory = primaryGpu?.memory_mb ? `${(primaryGpu.memory_mb / 1024).toFixed(0)} GB 显存` : "显存大小未读取";
            const codecs = [...new Set((environment?.hardware?.encoders || []).filter((item) => String(item.id || "").startsWith("nvenc")).map((item) => String(item.codec || "").toUpperCase()))];
            const rows = environment ? [
              [Monitor, environment.obs?.version ? `OBS ${environment.obs.version}` : "OBS", "连接正常，可以开始自动设置"],
              [Zap, primaryGpu?.name || "没有识别到显卡", primaryGpu ? `${gpuMemory} · 支持 ${codecs.join(" / ") || "硬件"} 录制${otherGpu ? ` · 另有 ${otherGpu.name}` : ""}` : "请重新检测电脑配置"],
              [Cpu, environment.hardware?.cpu || "没有识别到处理器", `${environment.hardware?.memory_gb || "—"} GB 内存`],
              [Gauge, environment.limits?.game_fps_p10 ? `CS2 实测约 ${environment.limits.game_fps_p10} FPS` : "游戏性能还没测试", "完成一次短录制后，卡不卡会判断得更准"],
              [HardDrive, `录像磁盘还剩 ${environment.disk?.free_gb ?? "—"} GB`, "空间不足时会提前提醒你"],
            ] : [
              [Monitor, "OBS 32.1.0", "连接正常，可以开始自动设置"],
              [Zap, MACHINE_PROFILE.gpu, "12 GB 显存 · 支持 H.264 / HEVC / AV1 录制"],
              [Cpu, MACHINE_PROFILE.cpu, MACHINE_PROFILE.memory],
              [Gauge, `CS2 实测约 ${MACHINE_PROFILE.cs2FpsP10} FPS`, "电脑可以继续做高帧率录制测试"],
              [HardDrive, "录像磁盘还剩 1.8 TB", "空间不足时会提前提醒你"],
            ];
            return rows.map(([Icon, title, detail]) => (
            <div key={title} className="flex items-start gap-2.5">
              <span className="mt-0.5 rounded-lg bg-cs2-bg-input p-1.5 text-cs2-text-secondary">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold text-cs2-text-primary">{title}</div>
                <div className="mt-0.5 text-[10px] leading-relaxed text-cs2-text-muted">{detail}</div>
              </div>
            </div>
            ));
          })()}
        </div>
      </div>

      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
        <div className="flex items-center gap-2 text-[12px] font-bold text-cs2-text-success">
          <LockKeyhole className="h-4 w-4" />
          放心，我们不会动这些
        </div>
        <ul className="mt-3 space-y-2 text-[10px] leading-relaxed text-cs2-text-secondary">
          {[
            "你的直播平台和推流设置",
            "麦克风、耳机和音轨设置",
            "OBS 的连接密码",
            "不会偷偷降低清晰度或帧率",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-cs2-text-success" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function GoalScreen({ goal, setGoal, recommendation, onBack, onNext, environment = null, recommendationLoading = false }) {
  const fpsDraftNumber = Number(goal.fpsDraft);
  const fpsInvalid = goal.fpsDraft === "" || !Number.isInteger(fpsDraftNumber) || fpsDraftNumber < 1 || fpsDraftNumber > 1000;
  const fpsIsCustom = !FPS_OPTIONS.includes(Number(goal.fps));
  const currentVideo = environment?.obs?.video || {};
  const currentWidth = Number(currentVideo.output_width || currentVideo.base_width || 0);
  const currentHeight = Number(currentVideo.output_height || currentVideo.base_height || 0);
  const resolutionOptions = currentWidth && currentHeight
    ? RESOLUTIONS.map((item) => item.value === "current" ? { ...item, detail: `${currentWidth} × ${currentHeight}` } : item)
    : RESOLUTIONS;
  const applyRecommendedPreset = () => {
    setGoal((prev) => ({
      ...prev,
      fps: recommendation.recommendedFps,
      fpsDraft: String(recommendation.recommendedFps),
      resolution: recommendation.recommendedResolution,
      priority: prev.priority === "quality" ? "balanced" : prev.priority,
    }));
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card">
        <div className="border-b border-cs2-border bg-[radial-gradient(circle_at_top_right,rgba(224,127,10,0.12),transparent_42%)] px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-xl border border-cs2-accent/30 bg-cs2-accent/10 p-2 text-cs2-accent">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[15px] font-bold text-cs2-text-primary">选择帧率和分辨率</h2>
              <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-cs2-text-secondary">
                只需要选择这两项，其他录制设置会根据{environment ? "这台电脑的配置" : "模拟电脑配置"}自动完成。设置太高时，我们会直接提醒你。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5">
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-[0.13em] text-cs2-text-muted">视频清晰度</label>
              <span className="text-[10px] text-cs2-text-muted">不确定就保持现在的设置</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {resolutionOptions.map((item) => (
                <ChoiceCard
                  key={item.value}
                  selected={goal.resolution === item.value}
                  onClick={() => setGoal((prev) => ({ ...prev, resolution: item.value }))}
                  title={item.label}
                  detail={item.detail}
                  badge={item.badge}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-[0.13em] text-cs2-text-muted">视频帧率</label>
              <span className="text-[10px] text-cs2-text-muted">越高越适合慢放，也越吃电脑性能</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {FPS_OPTIONS.map((fps) => (
                <button
                  type="button"
                  key={fps}
                  onClick={() => setGoal((prev) => ({ ...prev, fps, fpsDraft: String(fps) }))}
                  className={`rounded-xl border px-2 py-3 text-center transition-colors ${
                    goal.fps === fps
                      ? "border-cs2-accent/70 bg-cs2-accent/10 text-cs2-accent"
                      : "border-cs2-border bg-cs2-bg-input/45 text-cs2-text-secondary hover:border-cs2-accent/35"
                  }`}
                >
                  <span className="block font-mono text-base font-bold tabular-nums">{fps}</span>
                  <span className="mt-0.5 block text-[9px] uppercase tracking-wider">FPS</span>
                </button>
              ))}
            </div>
            <div className={`mt-2.5 flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center ${
              fpsInvalid
                ? "border-rose-400/40 bg-rose-400/[0.04]"
                : fpsIsCustom
                  ? "border-cs2-accent/45 bg-cs2-accent/[0.05]"
                  : "border-cs2-border bg-cs2-bg-input/30"
            }`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="custom-fps" className="text-[11px] font-semibold text-cs2-text-primary">手动输入帧率</label>
                  {fpsIsCustom && !fpsInvalid ? <Badge tone="accent">自定义</Badge> : null}
                </div>
                <p className="mt-0.5 text-[9px] leading-relaxed text-cs2-text-muted">支持 1–1000；输入后会马上重新判断电脑能不能流畅录制。</p>
              </div>
              <div className="relative w-full sm:w-40">
                <input
                  id="custom-fps"
                  aria-label="手动输入 FPS"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  value={goal.fpsDraft}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const parsed = Number(raw);
                    const valid = raw !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
                    setGoal((prev) => ({ ...prev, fpsDraft: raw, ...(valid ? { fps: parsed } : {}) }));
                  }}
                  className="w-full rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2 pr-12 text-right font-mono text-sm font-bold text-cs2-text-primary outline-none transition focus:border-cs2-accent"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-semibold text-cs2-text-muted">FPS</span>
              </div>
            </div>
            {fpsInvalid ? <p className="mt-1.5 text-[9px] text-cs2-rose-on-surface">请输入 1–1000 之间的整数。</p> : null}
          </div>

          {recommendation.score < 85 ? (
            <div className={`rounded-xl border p-3 ${recommendation.score < 48 ? "border-rose-400/30 bg-rose-400/[0.04]" : "border-amber-400/30 bg-amber-400/[0.04]"}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${recommendation.score < 48 ? "text-cs2-rose-on-surface" : "text-cs2-amber-on-surface"}`} />
                  <div>
                    <div className="text-[11px] font-bold text-cs2-text-primary">这套设置可能会影响游戏或录制流畅度</div>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-cs2-text-muted">建议先试：{recommendation.saferResolution}、{recommendation.recommendedFps} FPS；确认流畅后再往上调。</p>
                  </div>
                </div>
                <button type="button" onClick={applyRecommendedPreset} className="shrink-0 rounded-lg border border-cs2-accent/40 bg-cs2-accent/10 px-3 py-2 text-[10px] font-bold text-cs2-accent hover:bg-cs2-accent/15">改用推荐设置</button>
              </div>
            </div>
          ) : null}

          <div className={`flex ${onBack ? "justify-between" : "justify-end"} gap-2`}>
            {onBack && <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回当前设置</button>}
            <button type="button" onClick={onNext} disabled={fpsInvalid} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[12px] font-bold text-cs2-text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
              看看推荐设置
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>
      <DiscoveryRail recommendation={recommendation} environment={environment} recommendationLoading={recommendationLoading} />
    </div>
  );
}

function PlanScreen({ goal, recommendation, onBack, onNext }) {
  const resolution = RESOLUTIONS.find((item) => item.value === goal.resolution)?.detail ?? "2560 × 1440";
  const codecLabel = CODECS.find((item) => item.value === goal.codec)?.label ?? "Agent 自动选择";
  const changes = [
    ["OBS Profile", "Streaming", "CS2 Insight Recording", "隔离创建"],
    ["整数 FPS", "60 / 1", `${goal.fps} / 1`, "WebSocket"],
    ["画布分辨率", "2560 × 1440", resolution, goal.resolution === "current" ? "保持" : "WebSocket"],
    ["输出分辨率", "2560 × 1440", resolution, goal.resolution === "current" ? "保持" : "WebSocket"],
    ["录像编码器", "与串流一致", codecLabel, "能力探测后选择"],
    ["容器", "MKV", "Hybrid MP4", "Profile 参数"],
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-cs2-text-primary">变更计划 #OBS-0248</h2>
              <Badge tone="accent">等待确认</Badge>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-secondary">只有下表列出的字段会被修改。执行前会重新检查活动输出，并校验此计划的哈希。</p>
          </div>
          <span className="rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 font-mono text-[9px] text-cs2-text-muted">plan 8f3a…42d1</span>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-cs2-border">
          <div className="grid grid-cols-[1.1fr_1fr_1fr_100px] gap-2 border-b border-cs2-border bg-cs2-bg-input/60 px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-cs2-text-muted">
            <span>配置项</span><span>当前</span><span>目标</span><span>方式</span>
          </div>
          {changes.map(([label, current, target, method]) => (
            <div key={label} className="grid grid-cols-[1.1fr_1fr_1fr_100px] gap-2 border-b border-cs2-border/60 px-3 py-2.5 text-[10px] last:border-0">
              <span className="font-semibold text-cs2-text-secondary">{label}</span>
              <span className="min-w-0 truncate font-mono text-cs2-text-muted">{current}</span>
              <span className={`min-w-0 truncate font-mono font-semibold ${current === target ? "text-cs2-text-muted" : "text-cs2-accent"}`}>{target}</span>
              <span className="text-cs2-text-muted">{method}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-bold text-cs2-text-success"><ShieldCheck className="h-4 w-4" />修改前保护</div>
            <ul className="mt-2.5 space-y-1.5 text-[10px] text-cs2-text-secondary">
              <li>• 备份 Profile、global.ini 与恢复清单</li>
              <li>• 对音频、直播、WebSocket 字段做前后指纹比对</li>
              <li>• 记录原 Profile，异常退出时自动对账</li>
            </ul>
          </div>
          <div className={`rounded-xl border p-3.5 ${recommendation.score < 48 ? "border-rose-400/25 bg-rose-400/[0.04]" : "border-amber-400/20 bg-amber-400/[0.04]"}`}>
            <div className={`flex items-center gap-2 text-[11px] font-bold ${recommendation.score < 48 ? "text-cs2-rose-on-surface" : "text-cs2-amber-on-surface"}`}><AlertTriangle className="h-4 w-4" />目标风险评估 · {recommendation.label}</div>
            <p className="mt-2.5 text-[10px] leading-relaxed text-cs2-text-secondary">{resolution} @ {goal.fps} FPS 的推荐分为 {recommendation.score}/100。预测瓶颈是 {recommendation.bottleneck}；只有真实短录制通过后才会标记“稳定”。</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35">返回修改目标</button>
          <button type="button" onClick={onNext} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110">
            <ShieldCheck className="h-4 w-4" />确认计划并查看执行预览
          </button>
        </div>
      </section>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-cs2-text-muted">Agent 的判断</div>
            <Badge tone={recommendation.tone}>{recommendation.label}</Badge>
          </div>
          <div className="mt-3 flex items-start gap-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cs2-accent" />
            <p className="text-[11px] leading-relaxed text-cs2-text-secondary">{recommendation.verdict} 我不会替你降低目标；测试失败后会先给出最小改动建议，再由你选择。</p>
          </div>
          <div className="mt-3 space-y-1.5">
            {recommendation.risks.slice(0, 3).map((risk) => (
              <div key={risk} className="flex items-start gap-1.5 text-[9px] leading-relaxed text-cs2-text-muted">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-cs2-amber-on-surface" />{risk}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-cs2-accent/25 bg-cs2-bg-card p-4">
          <div className="text-[11px] font-bold text-cs2-text-primary">双方案策略</div>
          <div className="mt-3 space-y-2">
            <div className="rounded-lg border border-cs2-accent/30 bg-cs2-accent/[0.05] p-2.5">
              <div className="text-[9px] font-semibold text-cs2-accent">A · 你的目标</div>
              <div className="mt-1 font-mono text-[10px] text-cs2-text-primary">{resolution} @ {goal.fps} FPS</div>
              <div className="mt-0.5 text-[9px] text-cs2-text-muted">先短测，失败不自动降级</div>
            </div>
            <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/30 p-2.5">
              <div className="text-[9px] font-semibold text-cs2-text-secondary">B · Agent 保守起点</div>
              <div className="mt-1 font-mono text-[10px] text-cs2-text-primary">{recommendation.saferResolution} @ {recommendation.recommendedFps} FPS</div>
              <div className="mt-0.5 text-[9px] text-cs2-text-muted">用于定位分辨率或 FPS 瓶颈</div>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <div className="text-[11px] font-bold text-cs2-text-primary">明确不变</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["音频采样率", "声道", "音轨映射", "直播服务", "串流密钥", "Scene Collection", "WebSocket 密码"].map((item) => <Badge key={item}>{item}</Badge>)}
          </div>
        </div>
      </aside>
    </div>
  );
}

function RunScreen({ goal, recommendation, demoDone, setDemoDone, onBack, onNext }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-cs2-text-primary">调优执行预览</h2>
              <Badge tone={demoDone ? "success" : "accent"}>{demoDone ? "模拟完成" : "等待演示"}</Badge>
            </div>
            <p className="mt-1 text-[11px] text-cs2-text-secondary">真实实现会由 SSE 持续更新；此原型不会调用 OBS 或写入任何文件。</p>
          </div>
          <div className="font-mono text-[10px] text-cs2-text-muted">{goal.fps}/1 FPS</div>
        </div>

        <div className="mt-5 space-y-2">
          {RUN_STEPS.map((step, index) => {
            const Icon = step.icon;
            const completed = demoDone || index < 2;
            const active = !demoDone && index === 2;
            const stepDetail = index === 3
              ? `录制 ${goal.testSeconds} 秒 CS2 动态画面，采集前后 Stats`
              : step.detail;
            return (
              <div key={step.title} className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${active ? "border-cs2-accent/45 bg-cs2-accent/[0.06]" : "border-cs2-border/75 bg-cs2-bg-input/25"}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${completed ? "bg-emerald-400/10 text-cs2-text-success" : active ? "bg-cs2-accent/10 text-cs2-accent" : "bg-cs2-bg-input text-cs2-text-muted"}`}>
                  {completed ? <CheckCircle2 className="h-4 w-4" /> : active ? <Activity className="h-4 w-4 animate-pulse" /> : <Icon className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold text-cs2-text-primary">{step.title}</div>
                  <div className="mt-0.5 text-[10px] text-cs2-text-muted">{stepDetail}</div>
                </div>
                <span className={`text-[9px] font-semibold uppercase tracking-wider ${completed ? "text-cs2-text-success" : active ? "text-cs2-accent" : "text-cs2-text-muted"}`}>
                  {completed ? "完成" : active ? "执行中" : "等待"}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-xl border border-cs2-border bg-[#0d0f10] p-3 font-mono text-[9px] leading-5 text-zinc-400">
          <div><span className="text-emerald-400">09:42:18</span> snapshot protected_fields=7 backup=ready</div>
          <div><span className="text-emerald-400">09:42:19</span> output_guard stream=false record=false replay=false</div>
          <div><span className="text-cs2-accent">09:42:20</span> SetVideoSettings fpsNumerator={goal.fps} fpsDenominator=1</div>
          <div><span className="text-zinc-600">09:42:20</span> waiting for readback confirmation…</div>
        </div>

        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回计划</button>
          {!demoDone ? (
            <button type="button" onClick={() => setDemoDone(true)} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110">
              <Play className="h-4 w-4" fill="currentColor" />播放完成态演示
            </button>
          ) : (
            <button type="button" onClick={onNext} className="inline-flex items-center gap-2 rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110">
              查看验收报告<ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </section>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
          <div className="flex items-center justify-between"><span className="text-[11px] font-bold text-cs2-text-primary">{demoDone ? "真实测试指标" : "测试前负载预测"}</span><Badge tone={demoDone ? "success" : recommendation.tone}>{demoDone ? "模拟通过" : recommendation.label}</Badge></div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(demoDone
              ? [
                  ["渲染跳帧", "0.04%"],
                  ["编码跳帧", "0.00%"],
                  ["平均帧率", `${goal.fps}.00`],
                  ["编码器", "NVENC"],
                ]
              : [
                  ["预测渲染负载", `${recommendation.renderLoad}%`],
                  ["预测编码负载", `${recommendation.encoderLoad}%`],
                  ["预计余量", `${recommendation.headroom}%`],
                  ["推荐分", `${recommendation.score}/100`],
                ]
            ).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-cs2-border/70 bg-cs2-bg-input/40 p-2.5">
                <div className="text-[9px] text-cs2-text-muted">{label}</div>
                <div className="mt-1 font-mono text-[11px] font-semibold text-cs2-text-primary">{value}</div>
              </div>
            ))}
          </div>
        </div>
        {!demoDone ? (
          <div className="rounded-2xl border border-cs2-accent/20 bg-cs2-accent/[0.04] p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold text-cs2-text-primary"><Gauge className="h-4 w-4 text-cs2-accent" />预测不是结论</div>
            <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">Agent 认为主要风险来自「{recommendation.bottleneck}」。接下来的短录制会用实际掉帧替换这组估算。</p>
          </div>
        ) : null}
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
          <div className="flex items-center gap-2 text-[11px] font-bold text-cs2-amber-on-surface"><AlertTriangle className="h-4 w-4" />可随时安全中止</div>
          <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-secondary">中止只会停止测试任务并执行收尾，不会删除录制文件。若已切换 Profile，会优先切回原 Profile。</p>
        </div>
      </aside>
    </div>
  );
}

function ReportScreen({ goal, recommendation, onBack, onReset }) {
  const resolution = RESOLUTIONS.find((item) => item.value === goal.resolution)?.detail ?? "2560 × 1440";
  const [width, height] = resolution.split(" × ");
  const codecName = goal.codec === "auto" ? "H.264" : String(goal.codec).toUpperCase();
  const expectedFrames = goal.fps * goal.testSeconds;
  const renderedSkipped = Math.max(2, Math.round(expectedFrames * 0.0004));
  const reportTitle = goal.testSeconds >= 60 ? "配置生效，稳定性确认测试通过" : "配置生效，快速稳定性测试通过";
  const reportExplanation = goal.testSeconds >= 60
    ? `测试证明当前场景能在 ${goal.testSeconds} 秒窗口内维持目标。正式生产时仍应保持相近的 CS2 与场景负载，并确认游戏实际渲染帧率不低于 ${goal.fps}。`
    : `快速测试证明当前场景能在 ${goal.testSeconds} 秒窗口内维持目标。若要把“稳定”用于长时间生产录制，建议继续完成 60 秒确认测试，并确保 CS2 实际渲染帧率不低于 ${goal.fps}。`;
  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-emerald-400/25 bg-cs2-bg-card">
        <div className="flex flex-col gap-4 bg-[radial-gradient(circle_at_top_right,rgba(74,222,128,0.11),transparent_46%)] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-emerald-400/10 p-2.5 text-cs2-text-success"><CheckCircle2 className="h-6 w-6" /></span>
            <div>
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-bold text-cs2-text-primary">{reportTitle}</h2><Badge tone="success">模拟报告</Badge></div>
              <p className="mt-1 text-[11px] text-cs2-text-secondary">{resolution} @ {goal.fps}/1 FPS · NVIDIA NVENC {codecName} · {goal.testSeconds} 秒测试</p>
            </div>
          </div>
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-2 text-right">
            <div className="text-[9px] uppercase tracking-[0.15em] text-cs2-text-muted">结论置信度</div>
            <div className="mt-0.5 font-mono text-lg font-bold text-cs2-text-success">PASS</div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Gauge} label="实际帧率" value={`${goal.fps}/1`} detail={`avg_frame_rate ${goal.fps}/1`} tone="success" />
        <MetricCard icon={Monitor} label="分辨率" value={`${width} × ${height}`} detail="画布与输出一致" />
        <MetricCard icon={Zap} label="硬件编码" value="NVIDIA NVENC" detail={`${codecName} · CQP · High Quality`} tone="accent" />
        <MetricCard icon={Activity} label="丢帧" value="0.04% / 0.00%" detail="rendering / encoding" tone="success" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[12px] font-bold text-cs2-text-primary">证据清单</h3>
            <span className="font-mono text-[9px] text-cs2-text-muted">session obs_20260722_094218</span>
          </div>
          <div className="mt-3 divide-y divide-cs2-border/60 overflow-hidden rounded-xl border border-cs2-border">
            {[
              ["配置回读", `fps_num=${goal.fps}, fps_den=1, output=${width}x${height}`, "通过"],
              ["Agent 预测", `${recommendation.label} ${recommendation.score}/100 → 由真实测试校正`, "已校正"],
              ["ffprobe", `r_frame_rate=${goal.fps}/1, avg_frame_rate=${goal.fps}/1`, "通过"],
              ["帧计数", `nb_read_frames=${expectedFrames}, duration=${goal.testSeconds}.000s`, "通过"],
              ["OBS Stats", `render skipped ${renderedSkipped}/${expectedFrames} · output skipped 0/${expectedFrames}`, "通过"],
              ["受保护字段", "audio / tracks / stream / websocket fingerprints unchanged", "通过"],
            ].map(([label, value, status]) => (
              <div key={label} className="grid grid-cols-[92px_minmax(0,1fr)_54px] gap-3 px-3 py-2.5 text-[10px]">
                <span className="font-semibold text-cs2-text-secondary">{label}</span>
                <span className="truncate font-mono text-cs2-text-muted">{value}</span>
                <span className="text-right font-semibold text-cs2-text-success">{status}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 text-[10px] leading-relaxed text-cs2-text-secondary">
            <span className="font-semibold text-cs2-amber-on-surface">解释：</span> {reportExplanation}
          </div>
        </section>

        <aside className="space-y-3">
          <div className="rounded-2xl border border-cs2-border bg-cs2-bg-card p-4">
            <h3 className="text-[11px] font-bold text-cs2-text-primary">交付信息</h3>
            <dl className="mt-3 space-y-3 text-[10px]">
              <div><dt className="text-cs2-text-muted">备份位置</dt><dd className="mt-1 break-all font-mono text-cs2-text-secondary">data/.obs_config_backups/20260722_094218_ai_tune</dd></div>
              <div><dt className="text-cs2-text-muted">测试文件</dt><dd className="mt-1 break-all font-mono text-cs2-text-secondary">D:\OBS\CS2IA-test-{goal.fps}fps.mp4</dd></div>
              <div><dt className="text-cs2-text-muted">当前 Profile</dt><dd className="mt-1 font-mono text-cs2-text-secondary">CS2 Insight Recording</dd></div>
            </dl>
          </div>
          <button type="button" className="flex w-full items-center justify-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-input px-3 py-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35">
            <RotateCcw className="h-4 w-4" />从本次备份回滚（原型）
          </button>
        </aside>
      </div>

      <div className="flex flex-wrap justify-between gap-2">
        <button type="button" onClick={onBack} className="rounded-xl border border-cs2-border bg-cs2-bg-input px-4 py-2.5 text-[11px] font-semibold text-cs2-text-secondary">返回执行进度</button>
        <button type="button" onClick={onReset} className="rounded-xl bg-cs2-accent px-4 py-2.5 text-[11px] font-bold text-cs2-text-on-accent hover:brightness-110">重新体验原型</button>
      </div>
    </div>
  );
}

export default function ObsAiTuningPreviewPage() {
  const [screen, setScreen] = useState("goal");
  const [demoDone, setDemoDone] = useState(false);
  const [goal, setGoal] = useState({
    resolution: "current",
    fps: 480,
    fpsDraft: "480",
    priority: "balanced",
    useCase: "slowmo",
    codec: "auto",
    testSeconds: 10,
  });
  const recommendation = useMemo(() => buildHardwareRecommendation(goal), [goal]);
  const activeIndex = useMemo(() => SCREENS.findIndex((item) => item.key === screen), [screen]);
  const goRelative = (offset) => {
    const next = SCREENS[Math.min(SCREENS.length - 1, Math.max(0, activeIndex + offset))];
    setScreen(next.key);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_82%_0%,rgba(224,127,10,0.07),transparent_32%)]">
      <PageContainer className="!h-auto min-h-full max-w-[1380px] pb-10">
        <header className="flex flex-col gap-4 border-b border-cs2-border/70 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link to="/obs-ai-entry-preview" className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-muted transition-colors hover:text-cs2-accent">
              <ArrowLeft className="h-3 w-3" />返回入口预览
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-cs2-text-primary">AI OBS 调优</h1>
              <Badge tone="accent">交互原型</Badge>
              <Badge>未连接本机 OBS</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-cs2-text-secondary">
              从目标访谈到真实录制验收的完整体验预览。页面中的硬件、路径和测试结果均为模拟数据，不会执行任何系统操作。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-cs2-border bg-cs2-bg-card px-3 py-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cs2-accent/10 text-cs2-accent"><Sparkles className="h-4 w-4" /></span>
            <div>
              <div className="text-[10px] font-bold text-cs2-text-primary">AI 洞察模式</div>
              <div className="mt-0.5 text-[9px] text-cs2-text-muted">Agent 负责询问与解释，执行器负责安全操作</div>
            </div>
          </div>
        </header>

        <div className="mt-4">
          <ScreenNav active={screen} onChange={setScreen} />
        </div>

        <main className="mt-4">
          {screen === "goal" && <GoalScreen goal={goal} setGoal={setGoal} recommendation={recommendation} onNext={() => goRelative(1)} />}
          {screen === "plan" && <PlanScreen goal={goal} recommendation={recommendation} onBack={() => goRelative(-1)} onNext={() => goRelative(1)} />}
          {screen === "run" && <RunScreen goal={goal} recommendation={recommendation} demoDone={demoDone} setDemoDone={setDemoDone} onBack={() => goRelative(-1)} onNext={() => goRelative(1)} />}
          {screen === "report" && <ReportScreen goal={goal} recommendation={recommendation} onBack={() => goRelative(-1)} onReset={() => { setDemoDone(false); setScreen("goal"); }} />}
        </main>
      </PageContainer>
    </div>
  );
}
