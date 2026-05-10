import {
  Copy,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Music,
  Film,
  Trash2,
  ScanEye,
  X,
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
      className={`rounded-lg border bg-black/35 p-2 ${filled ? "border-white/12" : "border-dashed border-white/15"}`}
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
      <div className="flex items-center gap-1.5">
        <Film className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
        <p className="text-[10px] font-semibold text-zinc-300">{label}</p>
        {filled ? (
          <p className="ml-auto max-w-[10rem] truncate font-mono text-[10px] text-zinc-400" title={path}>
            {base || path}
          </p>
        ) : (
          <p className="ml-1 text-[10px] text-zinc-600">拖入视频 / 图片或粘贴路径</p>
        )}
      </div>
      {isImg ? (
        <div className="mt-1.5 flex items-center gap-2">
          <p className="text-[10px] text-violet-300/80">图片渐入渐出 · 时长</p>
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
            className="w-16 rounded border border-white/10 bg-black/50 px-2 py-0.5 font-mono text-[10px] text-zinc-200 outline-none focus:border-violet-400/50"
          />
          <span className="text-[10px] text-zinc-600">秒</span>
        </div>
      ) : null}
      <div className="mt-1.5 flex gap-2">
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-1 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600"
        />
        {onBrowse ? (
          <button
            type="button"
            onClick={onBrowse}
            title="浏览文件"
            className="inline-flex shrink-0 items-center rounded border border-white/12 px-2 py-1 text-[10px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
        ) : null}
        {filled ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center rounded border border-white/12 px-2 py-1 text-[10px] text-zinc-500 hover:border-red-500/35 hover:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ExportCheckRow({ ok, optional, label }) {
  const dot =
    ok === true ? "bg-emerald-400" : optional ? "bg-amber-400/90" : "bg-zinc-500";
  const text = ok === true ? "已完成" : optional ? "可选 · 未填" : "必填 · 未填";
  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-400">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} title={text} />
      <span className="text-zinc-300">{label}</span>
      <span className="ml-auto font-medium text-zinc-500">{text}</span>
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
  // overlay
  radarOverlayEnabled,
  onRadarOverlayEnabledChange,
  hasPovClips = false,
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

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-white/10 bg-gradient-to-b from-zinc-950/80 to-black/40 xl:border-l">
      <div className="shrink-0 border-b border-white/10 px-3 py-2.5">
        <p className="text-[12px] font-bold text-white">合辑成片控制台</p>
        <p className="mt-0.5 text-[10px] text-zinc-500">BGM、片头片尾与雷达覆盖；转场在中间「合集结构」里点衔接处编辑</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-5">
          {exportingBanner ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-100">
              正在导出合辑，请不要关闭程序…
            </div>
          ) : null}
          {!exportingBanner && exportOk ? (
            <div className="relative rounded-lg border border-emerald-500/35 bg-emerald-950/25 p-3 pr-9 text-[11px] text-emerald-100">
              <div className="flex items-center gap-2 font-semibold text-emerald-200">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                导出完成
              </div>
              <button
                type="button"
                onClick={() => onDismissExportSuccess?.()}
                className="absolute right-2 top-2 rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
                aria-label="关闭"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
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
          {!exportingBanner && lastExport && !lastExport.ok ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-100">
              导出失败：{String(lastExport.err)}
            </div>
          ) : null}

          <CollapsibleSection
            title="媒体资源"
            hint="BGM、片头与片尾（均可选）"
            defaultOpen={bgmFilled || introFilled || outroFilled}
          >
            <div
              className={`rounded-lg border p-2 ${bgmPath.trim() ? "border-violet-500/25 bg-violet-950/15" : "border-dashed border-white/15 bg-black/30"}`}
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
              <div className="flex items-center gap-1.5">
                <Music className="h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden />
                <p className="text-[10px] font-semibold text-zinc-300">背景音乐</p>
                {bgmPath.trim() ? (
                  <p className="ml-auto max-w-[12rem] truncate font-mono text-[10px] text-zinc-400" title={bgmPath}>
                    {pathBasename(bgmPath)}
                  </p>
                ) : (
                  <p className="ml-1 text-[10px] text-zinc-600">拖入音频或粘贴路径 · 导出时混音</p>
                )}
              </div>
              <div className="mt-2">
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
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-zinc-500">从第</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={bgmStartSec ?? 0}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    onBgmStartSecChange?.(Number.isFinite(v) && v >= 0 ? v : 0);
                  }}
                  className="w-16 rounded border border-white/10 bg-black/50 px-2 py-0.5 font-mono text-[10px] text-zinc-200 outline-none focus:border-violet-400/50"
                />
                <span className="text-[10px] text-zinc-500">秒开始</span>
              </div>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={bgmPath}
                  onChange={(e) => onBgmPathChange(e.target.value)}
                  placeholder="例如 D:\Music\bgm.mp3"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-1 font-mono text-[10px] text-zinc-200"
                />
                {onFilePick ? (
                  <button
                    type="button"
                    onClick={() => onFilePick("audio", onBgmPathChange)}
                    title="浏览音频文件"
                    className="inline-flex shrink-0 items-center rounded border border-white/12 px-2 py-1 text-[10px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
                  >
                    <FolderOpen className="h-3 w-3" />
                  </button>
                ) : null}
                {bgmPath.trim() ? (
                  <button
                    type="button"
                    onClick={onBgmClear}
                    className="inline-flex shrink-0 items-center rounded border border-white/12 px-2 py-1 text-[10px] text-zinc-500 hover:text-red-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            </div>

            <MediaVideoSlotCard
              label="片头"
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
              label="片尾"
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
          </CollapsibleSection>

          <section className="space-y-2.5">
            <StyleBlockTitle title="画面覆盖" subtitle="仅展示已接入能力" />
            <div
              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${
                hasPovClips
                  ? "border-white/[0.07] bg-black/35"
                  : "border-white/[0.04] bg-black/20 opacity-50"
              }`}
              title={hasPovClips ? "" : "需要至少一个 POV HUD 录制的片段（pov_hud_enabled）才能启用雷达覆盖"}
            >
              <div className="flex items-center gap-2">
                <ScanEye className={`h-4 w-4 ${hasPovClips ? "text-sky-300" : "text-zinc-600"}`} aria-hidden />
                <div>
                  <p className="text-[11px] font-medium text-zinc-200">回放小地图 / 雷达叠层</p>
                  <p className="text-[9px] text-zinc-600">
                    {hasPovClips ? "从 Demo 解析位置，颜色与游戏一致" : "需含 POV HUD 录制片段"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={!hasPovClips}
                onClick={() => hasPovClips && onRadarOverlayEnabledChange(!radarOverlayEnabled)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-bold transition-colors ${
                  !hasPovClips
                    ? "cursor-not-allowed border border-white/10 bg-zinc-900 text-zinc-600"
                    : radarOverlayEnabled
                    ? "bg-cs2-orange text-black"
                    : "border border-white/12 bg-zinc-900 text-zinc-400"
                }`}
              >
                {radarOverlayEnabled && hasPovClips ? "开" : "关"}
              </button>
            </div>
          </section>

          <CollapsibleSection
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>导出设置</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                    readyTag
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-100"
                  }`}
                >
                  {readyTag ? "就绪" : "未完成"}
                </span>
              </span>
            }
            hint="成片文件名、目录与配置检查"
            defaultOpen
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-white/[0.07] bg-black/35 px-2.5 py-2">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">已编排</p>
                <p className="mt-0.5 font-mono text-[15px] font-bold tabular-nums text-white">{Number(clipCount) || 0}</p>
                <p className="text-[9px] text-zinc-600">段</p>
              </div>
              <div className="rounded-lg border border-white/[0.07] bg-black/35 px-2.5 py-2">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">预计总时长</p>
                <p className="mt-0.5 font-mono text-[14px] font-bold tabular-nums text-cs2-orange">{durationText}</p>
                <p className="text-[9px] text-zinc-600">编排内合计</p>
              </div>
            </div>

            <label className="mt-3 block space-y-1">
              <span className="text-[10px] text-zinc-500">视频名称</span>
              <input
                value={outputFilename}
                onChange={(e) => onOutputFilenameChange(e.target.value)}
                placeholder={defaultFilenamePlaceholder}
                className="w-full rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[11px] text-zinc-200"
              />
            </label>

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

            <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/40 px-2.5 py-2">
              <p className="text-[10px] font-semibold text-zinc-400">配置检查</p>
              <div className="mt-2 space-y-1.5">
                <ExportCheckRow ok={dirOk} optional={false} label="输出目录" />
                <ExportCheckRow ok={nameOk} optional={false} label="视频名称" />
                <ExportCheckRow ok={bgmFilled} optional label="背景音乐" />
                <ExportCheckRow ok={introFilled} optional label="片头（视频 / 图片）" />
                <ExportCheckRow ok={outroFilled} optional label="片尾（视频 / 图片）" />
              </div>
            </div>

            <div className="mt-3 space-y-1">
              <span className="text-[11px] font-medium text-zinc-300">草稿名称（可选）</span>
              <input
                value={draftName}
                onChange={(e) => onDraftNameChange(e.target.value)}
                placeholder={draftNamePlaceholder}
                className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 text-[11px] text-zinc-200"
              />
            </div>

            <button
              type="button"
              disabled={savingDraft}
              onClick={() => onSaveDraft?.()}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-white/20 disabled:opacity-45"
            >
              保存草稿
            </button>

            <button
              type="button"
              disabled={exporting}
              onClick={onExport}
              className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-orange/50 bg-cs2-orange/15 px-3 py-2.5 text-[12px] font-bold text-cs2-orange shadow-sm hover:bg-cs2-orange/22 disabled:opacity-45"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              开始导出
            </button>

            <div className="mt-3 space-y-1">
              <span className="text-[10px] font-medium text-zinc-500">完整输出路径</span>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={fullOutputPathPreview || ""}
                  placeholder="填写目录与文件名后显示"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-2 py-2 font-mono text-[10px] text-zinc-300"
                />
                <button
                  type="button"
                  disabled={!fullOutputPathPreview}
                  onClick={() => fullOutputPathPreview && onCopyText?.(fullOutputPathPreview)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-white/12 bg-black/40 px-2.5 py-2 text-[10px] font-medium text-zinc-300 hover:border-cs2-orange/35 disabled:opacity-35"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </button>
              </div>
            </div>
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
        <p className="mt-2 text-[9px] leading-snug text-zinc-600">导出与成片路径请在上方「导出设置」中操作。</p>
      </div>
    </aside>
  );
}
