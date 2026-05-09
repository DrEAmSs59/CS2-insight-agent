import { Copy, CheckCircle2 } from "lucide-react";
import { buildShareText } from "../../utils/montageUtils";

export default function MontageExportResult({ result, themeId, clipCount, durationText, onCopyPath, onCopyShare }) {
  if (!result?.ok || !result.output_path) return null;

  const share = buildShareText({
    themeId,
    clipCount,
    durationText,
    outputPath: result.output_path,
  });

  return (
    <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/25 p-4 text-[11px] text-emerald-100">
      <div className="flex items-center gap-2 font-semibold text-emerald-200">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        导出完成
      </div>
      <p className="mt-2 text-[10px] text-zinc-500">
        {Number(clipCount) || 0} 段 · 时长约 {durationText || "未知"}
      </p>
      <p className="mt-2 text-[10px] text-zinc-400">视频路径</p>
      <p className="mt-1 break-all font-mono text-[10px] text-zinc-200">{result.output_path}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCopyPath?.(result.output_path)}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-900/30 px-3 py-1.5 text-[11px] font-medium hover:bg-emerald-900/50"
        >
          <Copy className="h-3.5 w-3.5" />
          复制路径
        </button>
        <button
          type="button"
          onClick={() => onCopyShare?.(share)}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/30 px-3 py-1.5 text-[11px] font-medium text-zinc-200 hover:border-cs2-orange/40"
        >
          <Copy className="h-3.5 w-3.5" />
          复制群聊文案
        </button>
      </div>
      <p className="mt-3 text-[10px] text-zinc-500">
        提示：本页无法直接打开系统文件夹时，请用资源管理器粘贴路径访问。
      </p>
    </div>
  );
}
