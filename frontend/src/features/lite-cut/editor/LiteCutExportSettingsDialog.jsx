import { useEffect } from "react";
import { Download, X } from "lucide-react";
import { useT } from "../../../i18n/useT.js";

export default function LiteCutExportSettingsDialog({ open, onClose, children }) {
  const t = useT();

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="litecut-export-settings-title"
          className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-cs2-border px-5 py-4">
            <Download className="h-5 w-5 shrink-0 text-cs2-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="litecut-export-settings-title" className="text-[15px] font-bold text-cs2-text-primary">
                {t("liteCut.inspector.export")}
              </h2>
              <p className="mt-0.5 text-xs text-cs2-text-muted">
                {t("liteCut.inspector.exportDescription")}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭导出设置"
              className="rounded-lg p-2 text-cs2-text-muted transition-colors hover:bg-cs2-surface-2 hover:text-cs2-text-primary"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </div>
        </section>
      </div>
    </>
  );
}
