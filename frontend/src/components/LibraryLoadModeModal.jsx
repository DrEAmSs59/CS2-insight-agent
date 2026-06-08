import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { useT } from "../i18n/useT.js";

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   onConfirm: (payload: { mode: "none" | "expected" | "manual"; manualLines: string[] }) => void;
 *   expectedPreviewLines: string[];
 * }} props
 */
export default function LibraryLoadModeModal({ open, onClose, onConfirm, expectedPreviewLines = [] }) {
  const t = useT();
  const [mode, setMode] = useState("none");
  const [manualText, setManualText] = useState("");

  useEffect(() => {
    if (open) {
      setMode("none");
      setManualText("");
    }
  }, [open]);

  if (!open) return null;

  const manualLines = manualText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const submit = () => {
    onConfirm({
      mode,
      manualLines: mode === "manual" ? manualLines : [],
    });
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lib-load-mode-title"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-cs2-border bg-cs2-bg-card p-4 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 id="lib-load-mode-title" className="text-sm font-bold text-cs2-text-primary">
            {t("dialog.libLoadTitle")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-cs2-text-muted">
          {t("dialog.libLoadDescPre")}<strong className="text-cs2-text-secondary">{t("dialog.libLoadDescStrong")}</strong>{t("dialog.libLoadDescPost")}
        </p>

        <div className="mb-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/30 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "none"}
              onChange={() => setMode("none")}
            />
            <span>
              <span className="block text-xs font-semibold text-cs2-text-primary">{t("dialog.libLoadModeNoneTitle")}</span>
              <span className="text-[11px] text-cs2-text-muted">{t("dialog.libLoadModeNoneDesc")}</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/30 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "expected"}
              onChange={() => setMode("expected")}
            />
            <span>
              <span className="block text-xs font-semibold text-cs2-text-primary">{t("dialog.libLoadModeExpectedTitle")}</span>
              <span className="text-[11px] text-cs2-text-muted">
                {t("dialog.libLoadModeExpectedDesc")}
              </span>
              {expectedPreviewLines.length > 0 ? (
                <span className="mt-1 block font-mono text-[10px] text-cs2-accent/90">
                  {expectedPreviewLines.slice(0, 8).join(" · ")}
                  {expectedPreviewLines.length > 8 ? " …" : ""}
                </span>
              ) : (
                <span className="mt-1 block text-[10px] text-cs2-amber-on-surface/90">{t("dialog.libLoadModeExpectedEmpty")}</span>
              )}
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/30 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "manual"}
              onChange={() => setMode("manual")}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-cs2-text-primary">{t("dialog.libLoadModeManualTitle")}</span>
              <span className="text-[11px] text-cs2-text-muted">{t("dialog.libLoadModeManualDesc")}</span>
              <textarea
                rows={4}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={"PlayerOne\nPlayerTwo"}
                className="mt-2 w-full resize-y rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-cs2-text-primary placeholder:text-cs2-text-muted"
                spellCheck={false}
              />
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-cs2-border px-3 py-1.5 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/40"
          >
            {t("dialog.libLoadCancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md border border-cs2-accent/50 bg-cs2-accent/15 px-3 py-1.5 text-xs font-bold text-cs2-accent hover:bg-cs2-accent/25"
          >
            {t("dialog.libLoadConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
