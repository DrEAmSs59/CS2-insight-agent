import { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FolderOpen,
  Monitor,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import PageContainer from "../components/PageContainer";
import ObsAiSettingsPanel from "../components/ObsAiSettingsPanel";

function PreviewSection({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-cs2-border/70 bg-cs2-bg-card px-4 py-3.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
        {hint && <span className="text-[10px] text-cs2-text-muted">{hint}</span>}
      </div>
      <div className="divide-y divide-cs2-border/40">{children}</div>
    </section>
  );
}

function PreviewField({ label, hint, value, action }) {
  return (
    <div className="py-2.5">
      <div className="text-[10px] font-semibold text-cs2-text-secondary">{label}</div>
      {hint && <p className="mt-0.5 text-[9px] text-cs2-text-muted">{hint}</p>}
      <div className="mt-1.5 flex gap-2">
        <div className="min-w-0 flex-1 truncate rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[10px] text-cs2-text-secondary">{value}</div>
        {action && <button type="button" className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[10px] font-semibold text-cs2-text-muted">{action}</button>}
      </div>
    </div>
  );
}

function ManualObsArea() {
  return (
    <>
      <PreviewSection title="OBS 连接" hint="OBS WebSocket 连接参数与录制场景配置。">
        <div className="flex items-center justify-between py-2.5">
          <span className="text-[10px] font-semibold text-cs2-text-secondary">OBS 连接状态</span>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-1.5 text-[10px] font-semibold text-cs2-text-muted"><CheckCircle2 className="h-3 w-3" />配置检查</button>
        </div>
        <PreviewField label="OBS 主机" value="localhost" />
        <PreviewField label="OBS 端口" value="4455" />
        <PreviewField label="OBS 密码" value="OBS WebSocket password" />
      </PreviewSection>

      <PreviewSection title="一键校准" hint="检测并修正 OBS 录制环境中的常见配置问题。">
        <div className="flex items-center justify-between py-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />连接失败</span>
          <button type="button" className="inline-flex items-center gap-1 text-[10px] text-cs2-text-muted"><RefreshCw className="h-3 w-3" />刷新</button>
        </div>
        <div className="grid gap-2 py-2.5 sm:grid-cols-3">
          {["画布与输出", "录制场景", "高亮来源"].map((item) => (
            <div key={item} className="rounded-lg border border-cs2-border bg-cs2-bg-input/60 px-3 py-2">
              <div className="text-[9px] text-cs2-text-muted">{item}</div>
              <div className="mt-1 text-[10px] font-semibold text-cs2-text-secondary">等待连接后检查</div>
            </div>
          ))}
        </div>
      </PreviewSection>
    </>
  );
}

export default function ObsAiEntryPreviewPage() {
  const [aiEnabled, setAiEnabled] = useState(false);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_82%_0%,rgba(224,127,10,0.05),transparent_32%)]">
      <PageContainer className="!h-auto min-h-full max-w-[1380px] pb-10">
        <header className="border-b border-cs2-border/70 pb-4">
          <Link to="/settings?tab=video" className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-muted transition-colors hover:text-cs2-accent">
            <ArrowLeft className="h-3 w-3" />返回设置
          </Link>
          <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-cs2-text-primary">视频设置 · AI 条件预览</h1>
                <span className="rounded-full border border-cs2-accent/30 bg-cs2-accent/10 px-2 py-0.5 text-[9px] font-bold text-cs2-accent">交互原型</span>
                <span className="rounded-full border border-cs2-border bg-cs2-bg-input px-2 py-0.5 text-[9px] font-semibold text-cs2-text-muted">不修改真实设置</span>
              </div>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-cs2-text-secondary">
                页面骨架和 FFmpeg 设置不变；只有 OBS 专属区域会随 AI 洞察开关切换。
              </p>
            </div>
            <div className="flex rounded-xl border border-cs2-border bg-cs2-bg-card p-1" aria-label="AI 洞察状态预览">
              <button
                type="button"
                aria-pressed={!aiEnabled}
                onClick={() => setAiEnabled(false)}
                className={`rounded-lg px-3 py-2 text-[10px] font-bold transition ${!aiEnabled ? "bg-cs2-bg-input text-cs2-text-primary" : "text-cs2-text-muted"}`}
              >
                AI 关闭 · 原始界面
              </button>
              <button
                type="button"
                aria-pressed={aiEnabled}
                onClick={() => setAiEnabled(true)}
                className={`rounded-lg px-3 py-2 text-[10px] font-bold transition ${aiEnabled ? "bg-cs2-accent/15 text-cs2-accent" : "text-cs2-text-muted"}`}
              >
                AI 开启 · Agent 界面
              </button>
            </div>
          </div>
        </header>

        <nav aria-label="设置页签预览" className="mt-3 flex flex-wrap gap-1 border-b border-cs2-border/60 pb-2">
          {[
            [FolderOpen, "通用设置"],
            [Sparkles, "解析设置"],
            [Monitor, "视频设置"],
            [SlidersHorizontal, "录制预设"],
          ].map(([Icon, label]) => (
            <div key={label} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-semibold ${label === "视频设置" ? "bg-cs2-accent/15 text-cs2-accent" : "text-cs2-text-muted"}`}>
              <Icon className="h-3.5 w-3.5" />{label}
            </div>
          ))}
        </nav>

        <main className={`mt-4 space-y-4 ${aiEnabled ? "" : "mx-auto max-w-4xl"}`}>
          <PreviewSection
            title="程序路径"
            hint={aiEnabled ? "FFmpeg 是全局工具；OBS 安装位置改由 Agent 自动识别。" : "录制与合辑导出所需的外部程序路径。"}
          >
            {!aiEnabled && (
              <PreviewField
                label="OBS 可执行文件"
                hint="录制时自动启动 OBS；填写 obs64.exe 完整路径。"
                value="C:\\Program Files\\OBS Studio\\bin\\64bit\\obs64.exe"
                action="浏览…"
              />
            )}
            <PreviewField
              label="FFmpeg 可执行文件"
              hint={aiEnabled ? "保持为独立全局设置，用于合辑导出以及 Agent 录制后的媒体校验。" : "合辑导出使用；留空则使用 PATH 中的 ffmpeg。"}
              value="C:\\ffmpeg\\bin\\ffmpeg.exe"
              action="浏览…"
            />
          </PreviewSection>

          <PreviewSection title="FFmpeg 编码" hint="合辑导出使用的硬件编码器；不由 OBS Agent 修改。">
            <PreviewField label="合辑编码器" value="自动（主显卡硬编 → x264 保底）" />
          </PreviewSection>

          <div className="flex items-center gap-3 px-1">
            <div className="h-px flex-1 bg-cs2-border/60" />
            <span className={`rounded-full border px-2.5 py-1 text-[9px] font-bold ${aiEnabled ? "border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent" : "border-cs2-border bg-cs2-bg-input text-cs2-text-muted"}`}>
              {aiEnabled ? "以下 OBS 区域已切换为 Agent" : "以下保持原有 OBS 设置"}
            </span>
            <div className="h-px flex-1 bg-cs2-border/60" />
          </div>

          {aiEnabled ? (
            <ObsAiSettingsPanel
              obsPath="C:\\Program Files\\OBS Studio\\bin\\64bit\\obs64.exe"
              obsConnected={false}
              ffmpegReady
              previewMode
            />
          ) : (
            <ManualObsArea />
          )}

          <div className="flex items-start gap-2 rounded-xl border border-cs2-border bg-cs2-bg-card px-4 py-3 text-[10px] leading-relaxed text-cs2-text-secondary">
            <Settings2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cs2-accent" />
            {aiEnabled
              ? "AI 模式只替换 OBS 路径、连接和校准区域。FFmpeg 路径与合辑编码器留在固定位置，并明确不属于 Agent 的修改范围。"
              : "当前就是原始视频设置结构，不增加入口卡片，也不改变现有 OBS 手动配置流程。"}
          </div>
        </main>
      </PageContainer>
    </div>
  );
}
