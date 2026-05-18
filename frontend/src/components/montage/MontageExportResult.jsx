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
    <div className="rounded-lg border border-emerald-500/35 bg-cs2-emerald-surface p-4 text-[12px] text-cs2-emerald-on-surface">
      <div className="flex items-center gap-2 font-semibold text-cs2-emerald-on-surface">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        导出完成
      </div>
      <p className="mt-2 text-[11px] text-cs2-text-muted">
        {Number(clipCount) || 0} 段 · 时长约 {durationText || "未知"}
      </p>
      <p className="mt-2 text-[11px] text-cs2-text-secondary">视频路径</p>
      <p className="mt-1 break-all font-mono text-[11px] text-cs2-text-primary">{result.output_path}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCopyPath?.(result.output_path)}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-900/30 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-900/50"
        >
          <Copy className="h-3.5 w-3.5" />
          复制路径
        </button>
        <button
          type="button"
          onClick={() => onCopyShare?.(share)}
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input/50 px-3 py-1.5 text-[12px] font-medium text-cs2-text-primary hover:border-cs2-accent/40"
        >
          <Copy className="h-3.5 w-3.5" />
          复制群聊文案
        </button>
      </div>
      <p className="mt-3 text-[11px] text-cs2-text-muted">
        提示：本页无法直接打开系统文件夹时，请用资源管理器粘贴路径访问。
      </p>
    </div>
  );
}
