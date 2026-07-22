import { useState, useCallback, useRef } from "react";
import { Upload, FileCode2, Loader2 } from "lucide-react";
import { useT } from "../i18n/useT.js";
import { desktopBridge } from "../desktop/desktopBridge.js";

function collectDemFiles(fileList) {
  if (!fileList?.length) return [];
  return Array.from(fileList).filter((f) => f.name?.toLowerCase().endsWith(".dem"));
}

/** @param {{ onUpload: (files: File[] | string[]) => void, loading?: boolean, loadingText?: string }} props */
export default function DemoUpload({ onUpload, loading = false, loadingText = "" }) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      if (loading) return;
      const dems = collectDemFiles(e.dataTransfer.files);
      if (dems.length) onUpload(dems);
    },
    [loading, onUpload]
  );

  const handleFileInput = useCallback(
    (e) => {
      const dems = collectDemFiles(e.target.files);
      if (dems.length) onUpload(dems);
      e.target.value = "";
    },
    [onUpload]
  );

  const handleBrowse = useCallback(async () => {
    if (loading) return;
    if (desktopBridge?.chooseDemoFiles) {
      const paths = await desktopBridge.chooseDemoFiles();
      if (paths?.length) onUpload(paths);
      return;
    }
    inputRef.current?.click();
  }, [loading, onUpload]);

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
        dragOver
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
          <span className="text-cs2-text-primary">正在处理 Demo</span>
        ) : dragOver ? (
          <span className="text-cs2-accent">{t("upload.dragReleaseMsg")}</span>
        ) : (
          t("upload.dragDropMsg")
        )}
      </p>
      <p className="max-w-2xl px-6 text-center text-xs leading-5 text-cs2-text-secondary">
        {loading ? (loadingText || "正在上传并解析所选 Demo，请稍候…") : t("upload.clickBrowse")}
      </p>

      {loading && (
        <div className="mt-5 h-1.5 w-[min(32rem,72%)] overflow-hidden rounded-full bg-cs2-bg-input" aria-hidden>
          <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-accent to-cs2-accent-light" />
        </div>
      )}

      <div className="mt-6 flex items-center gap-2">
        <div className="h-px w-12 bg-cs2-border" />
        <span className="font-mono text-[10px] tracking-widest text-cs2-text-secondary">{t("upload.pipelineLabel")}</span>
        <div className="h-px w-12 bg-cs2-border" />
      </div>
    </div>
  );
}
