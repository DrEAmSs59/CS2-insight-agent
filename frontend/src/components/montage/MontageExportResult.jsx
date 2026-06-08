import { Copy, CheckCircle2 } from "lucide-react";
import { buildShareText } from "../../utils/montageUtils";
import { useT } from "../../i18n/useT.js";

export default function MontageExportResult({ result, themeId, clipCount, durationText, onCopyPath, onCopyShare }) {
  const t = useT();

  if (!result?.ok || !result.output_path) return null;

  const share = buildShareText({
    themeId,
    clipCount,
    durationText,
    outputPath: result.output_path,
    t,
  });

  return (
    <div className="rounded-lg border border-emerald-500/35 bg-cs2-emerald-surface p-4 text-[12px] text-cs2-emerald-on-surface">
      <div className="flex items-center gap-2 font-semibold text-cs2-emerald-on-surface">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {t("montage.exportDone")}
      </div>
      <p className="mt-2 text-[11px] text-cs2-text-muted">
        {t("montage.exportSegmentsDuration", { n: Number(clipCount) || 0, dur: durationText || t("montage.timelineUnknownDuration") })}
      </p>
      <p className="mt-2 text-[11px] text-cs2-text-secondary">{t("montage.exportVideoPath")}</p>
      <p className="mt-1 break-all font-mono text-[11px] text-cs2-text-primary">{result.output_path}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCopyPath?.(result.output_path)}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-900/30 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-900/50"
        >
          <Copy className="h-3.5 w-3.5" />
          {t("montage.exportCopyPath")}
        </button>
        <button
          type="button"
          onClick={() => onCopyShare?.(share)}
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input/50 px-3 py-1.5 text-[12px] font-medium text-cs2-text-primary hover:border-cs2-accent/40"
        >
          <Copy className="h-3.5 w-3.5" />
          {t("montage.exportCopyShare")}
        </button>
      </div>
      <p className="mt-3 text-[11px] text-cs2-text-muted">
        {t("montage.exportTip")}
      </p>
    </div>
  );
}
