import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Save } from "lucide-react";

function PathField({ label, hint, value, onChange, onClear, placeholder, example }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">{label}</span>
        {value ? (
          <button type="button" onClick={onClear} className="text-[10px] text-zinc-500 hover:text-zinc-300">
            清空
          </button>
        ) : null}
      </div>
      <p className="text-[10px] leading-relaxed text-zinc-500">{hint}</p>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600"
      />
      {example ? <p className="text-[10px] text-zinc-600">示例：{example}</p> : null}
    </div>
  );
}

function CheckRow({ ok, optional, label }) {
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

export default function MontageExportSettings({
  videoName,
  onVideoNameChange,
  outputDir,
  onOutputDirChange,
  bgmPath,
  onBgmChange,
  introPath,
  onIntroChange,
  outroPath,
  onOutroChange,
  draftName,
  onDraftNameChange,
  draftNamePlaceholder,
  onSaveDraft,
  savingDraft,
  clipCount,
  totalDurationText,
  exportReady,
  fullOutputPath,
  onCopyOutputPath,
  onStartExport,
  exporting,
}) {
  const [open, setOpen] = useState(true);

  const checklist = useMemo(() => {
    const dirOk = Boolean(String(outputDir || "").trim());
    const nameOk = Boolean(String(videoName || "").trim());
    const bgmOk = Boolean(String(bgmPath || "").trim());
    const introOk = Boolean(String(introPath || "").trim());
    const outroOk = Boolean(String(outroPath || "").trim());
    return {
      dirOk,
      nameOk,
      bgmOk,
      introOk,
      outroOk,
    };
  }, [outputDir, videoName, bgmPath, introPath, outroPath]);

  const ready = exportReady !== undefined ? Boolean(exportReady) : checklist.dirOk && checklist.nameOk && Number(clipCount) > 0;

  return (
    <div className="rounded-lg border border-white/10 bg-black/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-white/[0.04]"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-zinc-200">导出设置</span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
              ready ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-100"
            }`}
          >
            {ready ? "就绪" : "未完成"}
          </span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-zinc-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />}
      </button>
      {open ? (
        <div className="space-y-4 border-t border-white/10 px-3 py-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/[0.07] bg-black/35 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">已编排</p>
              <p className="mt-0.5 font-mono text-[15px] font-bold tabular-nums text-white">{Number(clipCount) || 0}</p>
              <p className="text-[9px] text-zinc-600">段</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-black/35 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">预计总时长</p>
              <p className="mt-0.5 font-mono text-[14px] font-bold tabular-nums text-cs2-orange">{totalDurationText || "—"}</p>
              <p className="text-[9px] text-zinc-600">含未知则显示「未知」</p>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-zinc-300">视频名称</span>
            <p className="text-[10px] text-zinc-500">导出后的视频文件名，不需要填写 .mp4 也可以。</p>
            <input
              value={videoName}
              onChange={(e) => onVideoNameChange(e.target.value)}
              className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
              placeholder="CS2-高光合集-2026-05-02"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-zinc-300">输出位置</span>
            <p className="text-[10px] text-zinc-500">视频会保存到这个文件夹。</p>
            <input
              value={outputDir}
              onChange={(e) => onOutputDirChange(e.target.value)}
              placeholder="C:\Users\YourName\Videos"
              className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
            />
          </div>

          <PathField
            label="背景音乐，可选"
            hint="请选择你有使用权的音乐文件。"
            value={bgmPath}
            onChange={onBgmChange}
            onClear={() => onBgmChange("")}
            placeholder="C:\Users\YourName\Music\bgm.mp3"
            example="C:\Users\YourName\Music\bgm.mp3"
          />
          <PathField
            label="片头视频，可选"
            hint="建议 3-5 秒。"
            value={introPath}
            onChange={onIntroChange}
            onClear={() => onIntroChange("")}
            placeholder="C:\Users\YourName\Videos\intro.mp4"
            example="C:\Users\YourName\Videos\intro.mp4"
          />
          <PathField
            label="片尾视频，可选"
            hint="可以放 Logo 或关注提示。"
            value={outroPath}
            onChange={onOutroChange}
            onClear={() => onOutroChange("")}
            placeholder="C:\Users\YourName\Videos\outro.mp4"
            example="C:\Users\YourName\Videos\outro.mp4"
          />

          <div className="rounded-lg border border-white/[0.06] bg-black/40 px-2.5 py-2">
            <p className="text-[10px] font-semibold text-zinc-400">配置检查</p>
            <div className="mt-2 space-y-1.5">
              <CheckRow ok={checklist.dirOk} optional={false} label="输出目录" />
              <CheckRow ok={checklist.nameOk} optional={false} label="视频名称" />
              <CheckRow ok={checklist.bgmOk} optional label="背景音乐" />
              <CheckRow ok={checklist.introOk} optional label="片头" />
              <CheckRow ok={checklist.outroOk} optional label="片尾" />
            </div>
          </div>

          <div className="space-y-1 border-t border-white/10 pt-4">
            <span className="text-[11px] font-medium text-zinc-300">草稿名称（可选）</span>
            <p className="text-[10px] text-zinc-500">保存草稿时使用；留空则使用当前视频名称。</p>
            <input
              value={draftName}
              onChange={(e) => onDraftNameChange(e.target.value)}
              placeholder={draftNamePlaceholder || "与视频名称同步"}
              className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 text-[11px] text-zinc-200"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={savingDraft}
              onClick={() => onSaveDraft?.()}
              className="inline-flex flex-1 min-w-[120px] items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-white/20 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingDraft ? "保存中…" : "保存草稿"}
            </button>
          </div>

          <button
            type="button"
            disabled={exporting}
            onClick={() => onStartExport?.()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-orange/50 bg-cs2-orange/15 px-3 py-2.5 text-[12px] font-bold text-cs2-orange shadow-sm hover:bg-cs2-orange/22 disabled:opacity-45"
          >
            开始导出
          </button>

          <div className="space-y-1">
            <span className="text-[10px] font-medium text-zinc-500">完整输出路径</span>
            <div className="flex gap-2">
              <input
                readOnly
                value={fullOutputPath || ""}
                placeholder="填写目录与文件名后显示"
                className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-2 py-2 font-mono text-[10px] text-zinc-300"
              />
              <button
                type="button"
                disabled={!fullOutputPath}
                onClick={() => onCopyOutputPath?.(fullOutputPath)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-white/12 bg-black/40 px-2.5 py-2 text-[10px] font-medium text-zinc-300 hover:border-cs2-orange/35 disabled:opacity-35"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
