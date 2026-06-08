// frontend/src/components/BatchLoadErrorModal.jsx
import { X, AlertCircle } from "lucide-react";
import { useT } from "../i18n/useT.js";

/**
 * @param {{
 *   open: boolean;
 *   failed: Array<{ id: number; filename: string; reason: string }>;
 *   onClose: () => void;
 * }} props
 */
export default function BatchLoadErrorModal({ open, failed = [], onClose }) {
  const t = useT();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-700">
          <div className="flex items-center gap-2 text-red-400">
            <AlertCircle size={18} />
            <span className="font-semibold text-sm">{t("dialog.batchLoadErrorTitle")}</span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label={t("dialog.batchLoadErrorClose")}
          >
            <X size={18} />
          </button>
        </div>

        <ul className="px-5 py-4 space-y-2 max-h-60 overflow-y-auto">
          {failed.map((item) => (
            <li key={item.id} className="text-sm">
              <span className="text-zinc-200 font-medium">{item.filename}</span>
              <span className="text-zinc-500 ml-2">— {item.reason}</span>
            </li>
          ))}
        </ul>

        <div className="px-5 pb-5 pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm text-zinc-200 transition-colors"
          >
            {t("dialog.batchLoadErrorReselect")}
          </button>
        </div>
      </div>
    </div>
  );
}
