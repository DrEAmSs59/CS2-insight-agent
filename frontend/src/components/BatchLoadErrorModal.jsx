// frontend/src/components/BatchLoadErrorModal.jsx
import { X, AlertCircle } from "lucide-react";
import { useT } from "../i18n/useT.js";

/**
 * @param {{
 *   open: boolean;
 *   failed: Array<{ id: number | string; filename: string; reason: string }>;
 *   mode?: "load" | "analysis";
 *   onClose: () => void;
 * }} props
 */
export default function BatchLoadErrorModal({ open, failed = [], mode = "load", onClose }) {
  const t = useT();
  if (!open) return null;
  const analyzing = mode === "analysis";

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md rounded-xl bg-cs2-bg-card border border-cs2-border shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-cs2-border">
          <div className="flex items-center gap-2 text-cs2-rose-on-surface">
            <AlertCircle size={18} />
            <span className="font-semibold text-sm">
              {t(analyzing ? "dialog.batchAnalysisErrorTitle" : "dialog.batchLoadErrorTitle")}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-cs2-text-muted hover:text-cs2-text-primary transition-colors"
            aria-label={t("dialog.batchLoadErrorClose")}
          >
            <X size={18} />
          </button>
        </div>

        {analyzing ? (
          <p className="px-5 pt-4 text-xs leading-relaxed text-cs2-text-secondary">
            {t("dialog.batchAnalysisErrorHint")}
          </p>
        ) : null}

        <ul className="px-5 py-4 space-y-2 max-h-60 overflow-y-auto">
          {failed.map((item) => (
            <li key={`${item.id}-${item.filename}`} className="text-sm">
              <span className="text-cs2-text-primary font-medium">{item.filename}</span>
              <span className="text-cs2-text-muted ml-2">— {item.reason}</span>
            </li>
          ))}
        </ul>

        <div className="px-5 pb-5 pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-cs2-bg-active hover:bg-cs2-bg-hover text-sm text-cs2-text-primary transition-colors"
          >
            {t(analyzing ? "dialog.batchAnalysisErrorClose" : "dialog.batchLoadErrorReselect")}
          </button>
        </div>
      </div>
    </div>
  );
}
