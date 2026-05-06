import {
  Clapperboard,
  Copy,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Music,
  Film,
  Trash2,
  ScanEye,
} from "lucide-react";
import { CollapsibleSection } from "./MontageWorkbenchPanels";

function pathBasename(path) {
  const s = String(path || "").trim();
  if (!s) return "";
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

function StyleBlockTitle({ title, subtitle }) {
  return (
    <div className="border-b border-cs2-orange/25 pb-2">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-cs2-orange">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[10px] leading-snug text-zinc-600">{subtitle}</p> : null}
    </div>
  );
}

function MediaVideoSlotCard({
  label,
  path,
  onPathChange,
  onClear,
  placeholder,
  onVideoDrop,
  accentClass,
}) {
  const filled = Boolean(path.trim());
  const base = pathBasename(path);
  return (
    <div
      className={`rounded-xl border bg-black/35 p-2.5 shadow-sm ${filled ? "border-white/12" : "border-dashed border-white/15"}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        if (!String(f.type || "").startsWith("video/")) {
          onVideoDrop?.(null, "请拖入视频文件");
          return;
        }
        onVideoDrop?.(f.name, null);
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold text-zinc-400">{label}</p>
          {filled ? (
            <p className="mt-1 truncate font-mono text-[11px] text-zinc-200" title={path}>
              {base || path}
            </p>
          ) : (
            <p className="mt-1 text-[10px] text-zinc-600">拖入视频或粘贴路径 · 浏览器需手动填写完整路径</p>
          )}
        </div>
        <div
          className={`flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-gradient-to-br ${accentClass} opacity-90`}
        >
          <Film className="h-6 w-6 text-white/25" aria-hidden />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <span>时长</span>
        <span className="rounded border border-white/[0.06] bg-black/40 px-1.5 py-0.5 font-mono text-zinc-400">导出时读取</span>
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600"
        />
        {filled ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-white/12 px-2 py-1.5 text-[10px] text-zinc-400 hover:border-red-500/35 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MontageStyleConsole({
  // media
  bgmPath,
  onBgmPathChange,
  onBgmClear,
  bgmVolume,
  onBgmVolumeChange,
  introPath,
  onIntroPathChange,
  onIntroClear,
  outroPath,
  onOutroPathChange,
  onOutroClear,
  onMediaDropHint,
  // overlay
  radarOverlayEnabled,
  onRadarOverlayEnabledChange,
  // export footer
  clipCount,
  durationText,
  resolutionLabel,
  exporting,
  onExport,
  // technical / collapsed
  outputFilename,
  onOutputFilenameChange,
  defaultFilenamePlaceholder,
  onOpenExportPreview,
  draftName,
  onDraftNameChange,
  draftNamePlaceholder,
  outputDir,
  onOutputDirChange,
  onOutputDirClear,
  effectiveOutputDirHint,
  exportingBanner,
  exportOk,
  lastExport,
  exportDirForButton,
  onCopyText,
  onCopyShare,
}) {
  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-white/10 bg-gradient-to-b from-zinc-950/80 to-black/40 xl:border-l">
      <div className="shrink-0 border-b border-white/10 px-3 py-2.5">
        <p className="text-[12px] font-bold text-white">合辑成片控制台</p>
        <p className="mt-0.5 text-[10px] text-zinc-500">BGM、片头片尾与雷达覆盖；转场在中间「合集结构」里点衔接处编辑</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-5">
          <section className="space-y-2.5">
            <StyleBlockTitle title="媒体资源" subtitle="片头片尾与背景音乐" />
            <div
              className={`rounded-xl border p-2.5 ${bgmPath.trim() ? "border-violet-500/25 bg-violet-950/15" : "border-dashed border-white/15 bg-black/30"}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (!f) return;
                if (!String(f.type || "").startsWith("audio/")) {
                  onMediaDropHint?.("请拖入音频文件");
                  return;
                }
                onMediaDropHint?.(`已识别「${f.name}」· 请粘贴完整路径到下方`);
              }}
            >
              <div className="flex items-start gap-2">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200">
                  <Music className="h-5 w-5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-zinc-200">背景音乐</p>
                  {bgmPath.trim() ? (
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400" title={bgmPath}>
                      {pathBasename(bgmPath)}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[10px] text-zinc-600">拖入音频或粘贴路径 · 导出时混音</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                    <span className="rounded border border-white/[0.07] bg-black/40 px-1.5 py-0.5 text-zinc-500">
                      循环对齐成片
                    </span>
                    <span className="rounded border border-white/[0.07] bg-black/40 px-1.5 py-0.5 font-mono text-zinc-400">
                      时长 — 
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                  <span>音量</span>
                  <span className="font-mono text-zinc-400">{bgmVolume}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bgmVolume}
                  onChange={(e) => onBgmVolumeChange(Number(e.target.value))}
                  className="mt-1 h-1.5 w-full accent-violet-400"
                />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={bgmPath}
                  onChange={(e) => onBgmPathChange(e.target.value)}
                  placeholder="例如 D:\Music\bgm.mp3"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[10px] text-zinc-200"
                />
                {bgmPath.trim() ? (
                  <button
                    type="button"
                    onClick={onBgmClear}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-white/12 px-2 py-1.5 text-[10px] text-zinc-400 hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>

            <MediaVideoSlotCard
              label="片头"
              path={introPath}
              onPathChange={onIntroPathChange}
              onClear={onIntroClear}
              placeholder="例如 D:\Videos\intro.mp4"
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(`已识别「${name}」· 请粘贴完整视频路径`);
              }}
              accentClass="from-amber-900/40 to-zinc-900"
            />
            <MediaVideoSlotCard
              label="片尾"
              path={outroPath}
              onPathChange={onOutroPathChange}
              onClear={onOutroClear}
              placeholder="例如 D:\Videos\outro.mp4"
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(`已识别「${name}」· 请粘贴完整视频路径`);
              }}
              accentClass="from-sky-900/35 to-zinc-900"
            />
          </section>

          <section className="space-y-2.5">
            <StyleBlockTitle title="画面覆盖" subtitle="仅展示已接入能力" />
            <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.07] bg-black/35 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <ScanEye className="h-4 w-4 text-sky-300" aria-hidden />
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">回放小地图 / 雷达叠层</p>
                  <p className="text-[9px] text-zinc-600">导出链路已支持</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRadarOverlayEnabledChange(!radarOverlayEnabled)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-bold ${
                  radarOverlayEnabled ? "bg-cs2-orange text-black" : "border border-white/12 bg-zinc-900 text-zinc-400"
                }`}
              >
                {radarOverlayEnabled ? "开" : "关"}
              </button>
            </div>
          </section>

          <CollapsibleSection title="FFmpeg 与容器" hint="技术说明 · 默认折叠" defaultOpen={false}>
            <p className="text-[10px] leading-relaxed text-zinc-500">
              成片经过标准化编码：片段链 xfade / concat，最终混流为 H.264 + AAC 的 MP4（faststart）。无需在此选择编码器。
            </p>
          </CollapsibleSection>

          <CollapsibleSection title="输出格式与分辨率" hint="跟随源素材" defaultOpen={false}>
            <p className="text-[10px] text-zinc-500">
              分辨率与帧率由首段素材与归一化阶段决定；此处无法强制覆盖（避免无效任务）。
            </p>
            <p className="mt-2 font-mono text-[10px] text-zinc-400">{resolutionLabel}</p>
          </CollapsibleSection>

          <CollapsibleSection title="高级编码" hint="占位 · 后续版本" defaultOpen={false}>
            <p className="text-[10px] text-zinc-600">CRF / preset / 硬件编码等将在后续版本暴露。</p>
          </CollapsibleSection>

          <CollapsibleSection title="输出路径与文件名" hint="草稿与磁盘输出" defaultOpen={false}>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">文件名</span>
              <input
                value={outputFilename}
                onChange={(e) => onOutputFilenameChange(e.target.value)}
                placeholder={defaultFilenamePlaceholder}
                className="w-full rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[11px] text-zinc-200"
              />
            </label>
            <button
              type="button"
              onClick={onOpenExportPreview}
              className="mt-2 h-8 w-full rounded-md border border-white/12 bg-white/[0.05] text-[11px] font-medium text-zinc-200 hover:border-white/20"
            >
              编排结构预览
            </button>
            <div className="mt-3 space-y-1">
              <span className="text-[11px] font-medium text-zinc-300">草稿名称</span>
              <input
                value={draftName}
                onChange={(e) => onDraftNameChange(e.target.value)}
                placeholder={draftNamePlaceholder}
                className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 text-[11px] text-zinc-200"
              />
            </div>
            <div className="mt-3 space-y-1">
              <span className="text-[11px] font-medium text-zinc-300">输出目录</span>
              <div className="flex gap-2">
                <input
                  value={outputDir}
                  onChange={(e) => onOutputDirChange(e.target.value)}
                  placeholder="留空则用片段目录下的 exports/montage"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
                />
                {outputDir ? (
                  <button
                    type="button"
                    onClick={onOutputDirClear}
                    className="shrink-0 rounded border border-white/10 px-2 py-2 text-zinc-500 hover:text-zinc-300"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              {effectiveOutputDirHint ? (
                <p className="text-[10px] text-zinc-600">
                  将导出至：
                  <span className="break-all font-mono text-zinc-500">{effectiveOutputDirHint}</span>
                </p>
              ) : null}
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="调试与导出日志" hint="最近一次导出" defaultOpen={false}>
            {exportingBanner ? (
              <div className="rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-100">
                正在导出合辑，请不要关闭程序…
              </div>
            ) : null}
            {exportOk ? (
              <div className="mt-2 rounded-lg border border-emerald-500/35 bg-emerald-950/25 p-3 text-[11px] text-emerald-100">
                <div className="flex items-center gap-2 font-semibold text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  导出完成
                </div>
                <p className="mt-2 text-[10px] text-zinc-400">输出路径</p>
                <p className="mt-1 break-all font-mono text-[10px] text-zinc-200">{lastExport.output_path}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onCopyText(lastExport.output_path)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-900/30 px-2.5 py-1.5 text-[10px] font-medium hover:bg-emerald-900/50"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制路径
                  </button>
                  <button
                    type="button"
                    onClick={() => void onCopyShare()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 hover:border-cs2-orange/40"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制群聊文案
                  </button>
                  {exportDirForButton ? (
                    <button
                      type="button"
                      onClick={() => void onCopyText(exportDirForButton)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 hover:border-cs2-orange/40"
                      title="复制上级文件夹路径"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      复制文件夹路径
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {lastExport && !lastExport.ok ? (
              <div className="mt-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-100">
                导出失败：{String(lastExport.err)}
              </div>
            ) : null}
            {!exportingBanner && !exportOk && !(lastExport && !lastExport.ok) ? (
              <p className="text-[11px] text-zinc-600">尚无导出记录。</p>
            ) : null}
          </CollapsibleSection>
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 bg-black/55 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">总时长</p>
            <p className="font-mono text-[13px] font-bold tabular-nums text-white">{durationText}</p>
            <p className="mt-0.5 text-[10px] text-zinc-600">{clipCount} 片段</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-zinc-500">分辨率</p>
            <p className="text-[11px] font-medium text-zinc-300">{resolutionLabel}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={onExport}
          className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-cs2-orange/45 bg-cs2-orange/16 text-[12px] font-bold text-cs2-orange shadow-md shadow-black/30 hover:bg-cs2-orange/24 disabled:opacity-40"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
          导出合集
        </button>
      </div>
    </aside>
  );
}
