import { useEffect, useRef } from "react";
import { Download, Loader2, X, AlertCircle, CheckCircle2 } from "lucide-react";
import { downloadBlob } from "../../utils/rivalHubExport";

/**
 * Single toast entry for one demo export.
 *
 * @param {{ id: number, label: string, phase: "loading"|"done"|"error", blob?: Blob, filename?: string, error?: string, onClose: (id: number) => void }} props
 */
export default function RivalHubExportToast({ id, label, phase, blob, filename, error, onClose }) {
  const cleanupRef = useRef(null);

  // Auto-close successful toasts after 30s
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => onClose(id), 30_000);
    return () => clearTimeout(t);
  }, [phase, id, onClose]);

  // Release blob URL on unmount
  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  function handleDownload() {
    if (!blob || !filename) return;
    cleanupRef.current?.();
    cleanupRef.current = downloadBlob(blob, filename);
  }

  const base =
    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm text-[12px] min-w-[260px] max-w-[320px]";

  const variants = {
    loading: "border-cs2-border bg-cs2-bg-card/95 text-cs2-text-secondary",
    done:    "border-cs2-highlight/40 bg-cs2-bg-card/95 text-cs2-text-primary",
    error:   "border-cs2-fail/40 bg-cs2-bg-card/95 text-cs2-text-primary",
  };

  return (
    <div className={`${base} ${variants[phase] ?? variants.loading}`}>
      {/* icon */}
      <div className="mt-0.5 shrink-0">
        {phase === "loading" && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-cs2-accent" />
        )}
        {phase === "done" && (
          <CheckCircle2 className="h-3.5 w-3.5 text-cs2-highlight" />
        )}
        {phase === "error" && (
          <AlertCircle className="h-3.5 w-3.5 text-cs2-fail" />
        )}
      </div>

      {/* content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium">{label}</span>
        {phase === "loading" && (
          <span className="text-cs2-text-muted">正在导出…</span>
        )}
        {phase === "error" && (
          <span className="text-cs2-red-on-surface line-clamp-2">{error}</span>
        )}
        {phase === "done" && (
          <button
            type="button"
            onClick={handleDownload}
            className="flex w-fit items-center gap-1 rounded border border-cs2-highlight/40 bg-cs2-highlight/10 px-2 py-0.5 text-[11px] font-semibold text-cs2-highlight hover:bg-cs2-highlight/20"
          >
            <Download className="h-3 w-3" />
            下载 zip
          </button>
        )}
      </div>

      {/* close */}
      {phase !== "loading" && (
        <button
          type="button"
          onClick={() => onClose(id)}
          className="mt-0.5 shrink-0 text-cs2-text-muted hover:text-cs2-text-primary"
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
