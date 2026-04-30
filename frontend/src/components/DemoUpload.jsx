import { useState, useCallback } from "react";
import { Upload, FileCode2 } from "lucide-react";

function collectDemFiles(fileList) {
  if (!fileList?.length) return [];
  return Array.from(fileList).filter((f) => f.name?.toLowerCase().endsWith(".dem"));
}

/** @param {{ onUpload: (files: File[]) => void }} props */
export default function DemoUpload({ onUpload }) {
  const [dragOver, setDragOver] = useState(false);

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

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer py-14 sm:py-16 ${
        dragOver
          ? "border-cs2-orange bg-cs2-orange/5 shadow-[0_0_30px_rgba(255,140,0,0.1)]"
          : "border-cs2-border hover:border-cs2-orange/40 bg-cs2-bg-card"
      }`}
    >
      <input
        type="file"
        accept=".dem"
        multiple
        onChange={handleFileInput}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />

      <div
        className={`mb-4 flex h-16 w-16 items-center justify-center rounded-xl transition-colors ${
          dragOver ? "bg-cs2-orange/20" : "bg-cs2-bg-input"
        }`}
      >
        {dragOver ? (
          <FileCode2 className="h-8 w-8 text-cs2-orange" />
        ) : (
          <Upload className="h-8 w-8 text-cs2-text-secondary" />
        )}
      </div>

      <p className="mb-1 text-sm font-semibold">
        {dragOver ? (
          <span className="text-cs2-orange">松开即可上传</span>
        ) : (
          "拖拽一个或多个 .dem 到此处"
        )}
      </p>
      <p className="text-xs text-cs2-text-secondary">或点击浏览 — 支持多选 / 批量导入</p>

      <div className="mt-6 flex items-center gap-2">
        <div className="h-px w-12 bg-cs2-border" />
        <span className="font-mono text-[10px] tracking-widest text-cs2-text-secondary">.DEM 批量流水线</span>
        <div className="h-px w-12 bg-cs2-border" />
      </div>
    </div>
  );
}
