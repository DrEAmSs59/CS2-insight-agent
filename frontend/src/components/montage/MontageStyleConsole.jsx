import { useState } from "react";
import {
  Copy,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Music,
  Film,
  Trash2,
  X,
} from "lucide-react";
import { CollapsibleSection } from "./MontageWorkbenchPanels";

function pathBasename(path) {
  const s = String(path || "").trim();
  if (!s) return "";
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"]);

function isImagePath(p) {
  const s = String(p || "").trim().toLowerCase();
  const dot = s.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(s.slice(dot));
}

function MediaVideoSlotCard({
  label,
  path,
  onPathChange,
  onClear,
  placeholder,
  onVideoDrop,
  onBrowse,
  imageDuration,
  onImageDurationChange,
}) {
  const filled = Boolean(path.trim());
  const base = pathBasename(path);
  const isImg = filled && isImagePath(path);
  return (
    <div
      className={`rounded-xl border p-3 transition-all ${filled ? "border-cs2-border bg-cs2-surface-1" : "border-dashed border-cs2-border-subtle bg-cs2-surface-1/40"}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        const type = String(f.type || "");
        const name = String(f.name || "");
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        if (!type.startsWith("video/") && !type.startsWith("image/") && !IMAGE_EXTS.has(ext)) {
          onVideoDrop?.(null, "请拖入视频或图片文件");
          return;
        }
        onVideoDrop?.(f.name, null);
      }}
    >
      <div className="flex items-center gap-2">
        <Film className="h-4 w-4 shrink-0 text-cs2-text-muted" aria-hidden />
        <p className="text-xs font-bold text-cs2-text-secondary">{label}</p>
        {filled ? (
          <p className="ml-auto max-w-[12rem] truncate font-mono text-xs text-cs2-text-secondary" title={path}>
            {base || path}
          </p>
        ) : (
          <p className="ml-1 text-xs text-cs2-text-muted">拖入视频 / 图片或粘贴路径</p>
        )}
      </div>
      {isImg ? (
        <div className="mt-2.5 flex items-center gap-2">
          <p className="text-xs text-violet-300 font-medium">图片渐入渐出时长</p>
          <input
            type="number"
            min={1}
            max={60}
            step={0.5}
            value={imageDuration ?? 3}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v >= 1) onImageDurationChange?.(v);
            }}
            className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-violet-400"
          />
          <span className="text-xs text-cs2-text-muted">秒</span>
        </div>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent transition-all"
        />
        {onBrowse ? (
          <button
            type="button"
            onClick={onBrowse}
            title="浏览文件"
            className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {filled ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-muted hover:border-rose-500/30 hover:text-rose-400 transition-all"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ExportCheckRow({ ok, optional, label }) {
  const dot =
    ok === true ? "bg-emerald-400" : optional ? "bg-amber-400" : "bg-zinc-500";
  const text = ok === true ? "已完成" : optional ? "可选 · 未填" : "必填 · 未填";
  return (
    <div className="flex items-center gap-2.5 text-xs text-cs2-text-secondary py-0.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} title={text} />
      <span className="text-cs2-text-secondary font-medium">{label}</span>
      <span className="ml-auto text-cs2-text-muted">{text}</span>
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
  bgmStartSec,
  onBgmStartSecChange,
  introPath,
  onIntroPathChange,
  onIntroClear,
  introDuration,
  onIntroDurationChange,
  outroPath,
  onOutroPathChange,
  onOutroClear,
  outroDuration,
  onOutroDurationChange,
  onMediaDropHint,
  onFilePick,
  // export footer
  clipCount,
  durationText,
  resolutionLabel,
  exporting,
  onExport,
  onSaveDraft,
  savingDraft,
  exportReady,
  fullOutputPathPreview,
  // technical / collapsed
  outputFilename,
  onOutputFilenameChange,
  defaultFilenamePlaceholder,
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
  onDismissExportSuccess,
}) {
  const dirOk = Boolean(String(outputDir || "").trim()) || Boolean(String(effectiveOutputDirHint || "").trim());
  const nameOk = Boolean(String(outputFilename || "").trim());
  const bgmFilled = Boolean(String(bgmPath || "").trim());
  const introFilled = Boolean(String(introPath || "").trim());
  const outroFilled = Boolean(String(outroPath || "").trim());
  const readyTag =
    exportReady !== undefined && exportReady !== null ? Boolean(exportReady) : dirOk && nameOk && Number(clipCount) > 0;

  const [activeTab, setActiveTab] = useState("media");
  const tabItems = [
    { id: "media", label: "媒体资源" },
    { id: "export", label: "导出设置" },
  ];

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-cs2-border bg-cs2-surface-1 xl:border-l">
      <div className="shrink-0 border-b border-cs2-border-subtle p-4">
        <p className="text-sm font-bold text-cs2-text-primary tracking-wide">合辑成片控制台</p>
        <div className="mt-3 flex gap-1.5">
          {tabItems.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                activeTab === t.id
                  ? "bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                  : "text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-5">
          {exportingBanner ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-medium text-amber-300">
              正在高效导出合辑，请保持程序平稳运行…
            </div>
          ) : null}
          {!exportingBanner && exportOk ? (
            <div className="relative rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-200">
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                合辑成片导出圆满完成
              </div>
              <button
                type="button"
                onClick={() => onDismissExportSuccess?.()}
                className="absolute right-3 top-3 rounded-lg p-1 text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary"
                aria-label="关闭"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              <p className="mt-3 text-xs text-cs2-text-muted">生成输出路径</p>
              <p className="mt-1 break-all font-mono text-xs font-semibold text-cs2-text-primary p-2 bg-cs2-surface-2 rounded-lg select-all border border-cs2-border-subtle">{lastExport.output_path}</p>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void onCopyText(lastExport.output_path)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-600 transition-all shadow-sm"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制文件路径
                </button>
                {exportDirForButton ? (
                  <button
                    type="button"
                    onClick={() => void onCopyText(exportDirForButton)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1.5 text-xs font-bold text-cs2-text-primary hover:border-cs2-border-focus transition-all"
                    title="复制上级文件夹路径"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    复制上级目录
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {!exportingBanner && lastExport && !lastExport.ok ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-medium text-rose-300">
              导出异常：{String(lastExport.err)}
            </div>
          ) : null}

          {activeTab === "media" && (<CollapsibleSection
            title="媒体资源"
            hint="BGM、片头与片尾（均可选）"
            defaultOpen
          >
            <div
              className={`rounded-xl border p-3 transition-all ${bgmPath.trim() ? "border-violet-500/40 bg-violet-500/[0.08]" : "border-dashed border-cs2-border-subtle bg-cs2-surface-1/40"}`}
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
              <div className="flex items-center gap-2">
                <Music className="h-4 w-4 shrink-0 text-violet-400" aria-hidden />
                <p className="text-xs font-bold text-cs2-text-secondary">背景音乐混流</p>
                {bgmPath.trim() ? (
                  <p className="ml-auto max-w-[14rem] truncate font-mono text-xs text-cs2-text-secondary" title={bgmPath}>
                    {pathBasename(bgmPath)}
                  </p>
                ) : (
                  <p className="ml-1 text-xs text-cs2-text-muted">拖入音频或直接填入绝对路径</p>
                )}
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between gap-2 text-xs text-cs2-text-muted">
                  <span>混音音量占比</span>
                  <span className="font-mono font-bold text-violet-400">{bgmVolume}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bgmVolume}
                  onChange={(e) => onBgmVolumeChange(Number(e.target.value))}
                  className="mt-1.5 h-2 w-full rounded-lg bg-cs2-bg-input accent-violet-400 cursor-pointer"
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-cs2-text-muted">起始播放秒数</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={bgmStartSec ?? 0}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    onBgmStartSecChange?.(Number.isFinite(v) && v >= 0 ? v : 0);
                  }}
                  className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-violet-400 transition-all"
                />
                <span className="text-xs text-cs2-text-muted">秒</span>
              </div>
              <div className="mt-2.5 flex gap-2">
                <input
                  value={bgmPath}
                  onChange={(e) => onBgmPathChange(e.target.value)}
                  placeholder="例如 D:\Music\bgm.mp3"
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
                />
                {onFilePick ? (
                  <button
                    type="button"
                    onClick={() => onFilePick("audio", onBgmPathChange)}
                    title="浏览音频文件"
                    className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {bgmPath.trim() ? (
                  <button
                    type="button"
                    onClick={onBgmClear}
                    className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-muted hover:border-rose-500/30 hover:text-rose-400 transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>

            <MediaVideoSlotCard
              label="片头专属插槽"
              path={introPath}
              onPathChange={onIntroPathChange}
              onClear={onIntroClear}
              placeholder="例如 D:\Videos\intro.mp4 或 D:\img.png"
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(`已识别「${name}」· 请粘贴完整路径`);
              }}
              onBrowse={onFilePick ? () => onFilePick("video_or_image", onIntroPathChange) : undefined}
              imageDuration={introDuration}
              onImageDurationChange={onIntroDurationChange}
            />
            <MediaVideoSlotCard
              label="片尾专属插槽"
              path={outroPath}
              onPathChange={onOutroPathChange}
              onClear={onOutroClear}
              placeholder="例如 D:\Videos\outro.mp4 或 D:\img.png"
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(`已识别「${name}」· 请粘贴完整路径`);
              }}
              onBrowse={onFilePick ? () => onFilePick("video_or_image", onOutroPathChange) : undefined}
              imageDuration={outroDuration}
              onImageDurationChange={onOutroDurationChange}
            />
          </CollapsibleSection>)}

          {activeTab === "export" && (<CollapsibleSection
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>渲染成片设定</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-bold tracking-wide ${
                    readyTag
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-amber-500/10 text-amber-300"
                  }`}
                >
                  {readyTag ? "配置就绪" : "信息待补全"}
                </span>
              </span>
            }
            hint="输出文件名、保存目录与渲染自检"
            defaultOpen
          >
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3">
                <p className="text-xs font-bold text-cs2-text-muted">已加入队列</p>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-mono text-base font-bold text-cs2-text-primary">{Number(clipCount) || 0}</span>
                  <span className="text-xs text-cs2-text-muted">段片段</span>
                </div>
              </div>
              <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3">
                <p className="text-xs font-bold text-cs2-text-muted">总计时间长</p>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-mono text-base font-bold text-cs2-accent">{durationText}</span>
                  <span className="text-xs text-cs2-text-muted">原片估计</span>
                </div>
              </div>
            </div>

            <label className="mt-4 block space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-muted">目标成片文件名</span>
              <input
                value={outputFilename}
                onChange={(e) => onOutputFilenameChange(e.target.value)}
                placeholder={defaultFilenamePlaceholder}
                className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
              />
            </label>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-secondary">独立保存目录</span>
              <div className="flex gap-2">
                <input
                  value={outputDir}
                  onChange={(e) => onOutputDirChange(e.target.value)}
                  placeholder="留空自动归档至 exports/montage"
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
                />
                {outputDir ? (
                  <button
                    type="button"
                    onClick={onOutputDirClear}
                    className="shrink-0 rounded-lg border border-cs2-border-subtle px-3 py-2 text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary transition-all"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              {effectiveOutputDirHint ? (
                <p className="text-xs text-cs2-text-muted mt-1 bg-cs2-surface-1/60 p-2 rounded-lg border border-cs2-border-subtle">
                  <span>目标位置：</span>
                  <span className="break-all font-mono text-cs2-text-secondary select-all">{effectiveOutputDirHint}</span>
                </p>
              ) : null}
            </div>

            <div className="mt-4 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
              <p className="text-xs font-bold text-cs2-text-primary border-b border-cs2-border-subtle pb-2 mb-2">渲染环境与依赖自检</p>
              <div className="space-y-1">
                <ExportCheckRow ok={dirOk} optional={false} label="有效输出路径分配" />
                <ExportCheckRow ok={nameOk} optional={false} label="安全文件名验证" />
                <ExportCheckRow ok={bgmFilled} optional label="定制背景音乐混流" />
                <ExportCheckRow ok={introFilled} optional label="前置片头包装挂载" />
                <ExportCheckRow ok={outroFilled} optional label="收尾片尾包装挂载" />
              </div>
            </div>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-secondary">保存草稿别名 (可选)</span>
              <input
                value={draftName}
                onChange={(e) => onDraftNameChange(e.target.value)}
                placeholder={draftNamePlaceholder}
                className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
              />
            </div>

            <button
              type="button"
              disabled={savingDraft}
              onClick={() => onSaveDraft?.()}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-4 py-2.5 text-xs font-bold text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all shadow-sm disabled:opacity-45"
            >
              保存至编排草稿箱
            </button>

            <button
              type="button"
              disabled={exporting}
              onClick={onExport}
              className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-accent px-4 py-3 text-sm font-bold text-cs2-text-on-accent shadow-glow-accent hover:opacity-95 transition-all disabled:opacity-45"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              启动合辑引擎流式导出
            </button>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-muted">综合成片绝对路径预览</span>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={fullOutputPathPreview || ""}
                  placeholder="完成路径及文件名配置后实时生成"
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-surface-2 px-3 py-2 font-mono text-xs text-cs2-text-muted select-all outline-none"
                />
                <button
                  type="button"
                  disabled={!fullOutputPathPreview}
                  onClick={() => fullOutputPathPreview && onCopyText?.(fullOutputPathPreview)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-2 text-xs font-bold text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all shadow-sm disabled:opacity-35"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </button>
              </div>
            </div>
          </CollapsibleSection>)}
        </div>
      </div>

      <div className="shrink-0 border-t border-cs2-border-subtle bg-cs2-surface-1 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-cs2-text-muted">合集预估总时长</p>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="font-mono text-sm font-bold text-cs2-text-primary">{durationText}</span>
              <span className="text-xs text-cs2-text-muted font-medium">({clipCount} 个切片节点)</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-cs2-text-muted">输出画质标准</p>
            <p className="text-xs font-bold text-cs2-text-secondary mt-0.5">{resolutionLabel}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
