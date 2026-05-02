import { useState } from "react";
import { ChevronDown, ChevronUp, Save, X } from "lucide-react";

function PathField({ label, hint, value, onChange, onClear, placeholder, example }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">{label}</span>
        {value ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
          >
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
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border border-white/10 bg-black/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[12px] font-semibold text-zinc-200 hover:bg-white/[0.04]"
      >
        <span>导出设置</span>
        {open ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
      </button>
      {open ? (
        <div className="space-y-4 border-t border-white/10 px-3 py-4">
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
            <div className="flex gap-2">
              <input
                value={outputDir}
                onChange={(e) => onOutputDirChange(e.target.value)}
                placeholder="C:\Users\YourName\Videos"
                className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
              />
              {outputDir ? (
                <button
                  type="button"
                  onClick={() => onOutputDirChange("")}
                  className="shrink-0 rounded border border-white/10 px-2 py-2 text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
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

          <button
            type="button"
            disabled={savingDraft}
            onClick={() => onSaveDraft?.()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2.5 text-[11px] font-semibold text-zinc-200 hover:border-cs2-orange/40 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {savingDraft ? "保存中…" : "保存草稿"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
