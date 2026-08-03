import { useState, useCallback, useRef } from "react";
import { Upload, FileCode2, Loader2, AlertCircle } from "lucide-react";
import { useT } from "../i18n/useT.js";
import { desktopBridge } from "../desktop/desktopBridge.js";
import DemoLoadingCopy from "./DemoLoadingCopy.jsx";

function entryName(entry) {
  const raw = typeof entry === "string" ? entry : entry?.name;
  return String(raw || "").split(/[\\/]/).pop() || String(raw || "");
}

function partitionDemFiles(fileList) {
  const valid = [];
  const invalid = [];
  for (const entry of Array.from(fileList || [])) {
    if (entryName(entry).toLowerCase().endsWith(".dem")) valid.push(entry);
    else invalid.push(entry);
  }
  return { valid, invalid };
}

/** @param {{ onUpload: (files: File[] | string[]) => void, loading?: boolean, loadingText?: string, aiEnabled?: boolean }} props */
export default function DemoUpload({ onUpload, loading = false, loadingText = "", aiEnabled = false }) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const [validationError, setValidationError] = useState("");
  const inputRef = useRef(null);

  const validateAndUpload = useCallback(
    (entries) => {
      const { valid, invalid } = partitionDemFiles(entries);
      if (invalid.length) {
        const names = invalid.map(entryName);
        const shown = names.slice(0, 3).join("、");
        const suffix = names.length > 3 ? ` +${names.length - 3}` : "";
        setValidationError(t("upload.invalidExtension", { files: `${shown}${suffix}` }));
        return;
      }
      setValidationError("");
      if (valid.length) onUpload(valid);
    },
    [onUpload, t],
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      if (loading) return;
      validateAndUpload(e.dataTransfer.files);
    },
    [loading, validateAndUpload]
  );

  const handleFileInput = useCallback(
    (e) => {
      validateAndUpload(e.target.files);
      e.target.value = "";
    },
    [validateAndUpload]
  );

  const handleBrowse = useCallback(async () => {
    if (loading) return;
    if (desktopBridge?.chooseDemoFiles) {
      const paths = await desktopBridge.chooseDemoFiles();
      if (paths?.length) validateAndUpload(paths);
      return;
    }
    inputRef.current?.click();
  }, [loading, validateAndUpload]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (loading) return;
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={handleBrowse}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleBrowse();
        }
      }}
      role={loading ? "status" : "button"}
      aria-busy={loading || undefined}
      tabIndex={loading ? -1 : 0}
      className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed py-14 transition-all duration-200 sm:py-16 ${loading ? "cursor-wait" : "cursor-pointer"} ${
        validationError
          ? "border-red-500/60 bg-cs2-red-surface shadow-[0_0_30px_rgba(239,68,68,0.08)]"
          : dragOver
          ? "border-cs2-accent bg-cs2-accent/5 shadow-[0_0_30px_rgba(255,140,0,0.1)]"
          : "border-cs2-border hover:border-cs2-accent/40 bg-cs2-bg-card"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".dem"
        multiple
        onChange={handleFileInput}
        onClick={(e) => e.stopPropagation()}
        className="hidden"
      />

      <div
        className={`mb-4 flex h-16 w-16 items-center justify-center rounded-xl transition-colors ${
          dragOver ? "bg-cs2-accent/20" : "bg-cs2-bg-input"
        }`}
      >
        {loading ? (
          <Loader2 className="h-8 w-8 animate-spin text-cs2-accent" aria-hidden />
        ) : dragOver ? (
          <FileCode2 className="h-8 w-8 text-cs2-accent" />
        ) : (
          <Upload className="h-8 w-8 text-cs2-text-secondary" />
        )}
      </div>

      <p className="mb-1 text-sm font-semibold">
        {loading ? (
          <span className="text-cs2-text-secondary">{t("upload.processingTitle")}</span>
        ) : dragOver ? (
          <span className="text-cs2-accent">{t("upload.dragReleaseMsg")}</span>
        ) : (
          t("upload.dragDropMsg")
        )}
      </p>
      {loading ? (
        <DemoLoadingCopy
          aiEnabled={aiEnabled}
          detail={loadingText || t("upload.processingFallback")}
        />
      ) : (
        <p className="max-w-2xl px-6 text-center text-xs leading-5 text-cs2-text-secondary">
          {t("upload.clickBrowse")}
        </p>
      )}

      {loading && (
        <div className="mt-5 h-1.5 w-[min(32rem,72%)] overflow-hidden rounded-full bg-cs2-bg-input" aria-hidden>
          <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-accent to-cs2-accent-light" />
        </div>
      )}

      {!loading && validationError ? (
        <div
          role="alert"
          className="mx-6 mt-4 flex max-w-2xl items-start gap-2 rounded border border-red-500/45 bg-cs2-red-surface px-3 py-2 text-left text-xs leading-5 text-cs2-red-on-surface"
          onClick={(event) => event.stopPropagation()}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{validationError}</span>
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-2">
        <div className="h-px w-12 bg-cs2-border" />
        <span className="font-mono text-[10px] tracking-widest text-cs2-text-secondary">{t("upload.pipelineLabel")}</span>
        <div className="h-px w-12 bg-cs2-border" />
      </div>
    </div>
  );
}
