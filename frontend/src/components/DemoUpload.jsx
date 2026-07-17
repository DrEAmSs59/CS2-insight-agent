import { useState, useCallback, useRef } from "react";
import { Upload, FileCode2 } from "lucide-react";
import { useT } from "../i18n/useT.js";

function collectDemFiles(fileList) {
  if (!fileList?.length) return [];
  return Array.from(fileList).filter((f) => f.name?.toLowerCase().endsWith(".dem"));
}

/** @param {{ onUpload: (files: File[] | string[]) => void }} props */
export default function DemoUpload({ onUpload }) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const dems = collectDemFiles(e.dataTransfer.files);
      if (dems.length) onUpload(dems);
    },
    [onUpload]
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
    if (window.electron?.chooseDemoFiles) {
      const paths = await window.electron.chooseDemoFiles();
      if (paths?.length) onUpload(paths);
      return;
    }
    inputRef.current?.click();
  }, [onUpload]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
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
      role="button"
      tabIndex={0}
      className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer py-14 sm:py-16 ${
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
        {dragOver ? (
          <FileCode2 className="h-8 w-8 text-cs2-accent" />
        ) : (
          <Upload className="h-8 w-8 text-cs2-text-secondary" />
        )}
      </div>

      <p className="mb-1 text-sm font-semibold">
        {dragOver ? (
          <span className="text-cs2-accent">{t("upload.dragReleaseMsg")}</span>
        ) : (
          t("upload.dragDropMsg")
        )}
      </p>
      <p className="text-xs text-cs2-text-secondary">{t("upload.clickBrowse")}</p>

      <div className="mt-6 flex items-center gap-2">
        <div className="h-px w-12 bg-cs2-border" />
        <span className="font-mono text-[10px] tracking-widest text-cs2-text-secondary">{t("upload.pipelineLabel")}</span>
        <div className="h-px w-12 bg-cs2-border" />
      </div>
    </div>
  );
}
