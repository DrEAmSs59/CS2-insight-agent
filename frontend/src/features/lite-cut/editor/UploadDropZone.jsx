import { Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useT } from "../../../i18n/useT.js";

/** Generic drag/drop file picker used by LiteCut asset upload flows. */
export default function UploadDropZone({
  acceptHint,
  formats = "MP4 · WebM · PNG · TTF",
  onFiles,
  compact = false,
}) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const [hint, setHint] = useState("");

  const handleFiles = useCallback(
    (files) => {
      if (!files?.length) return;
      const names = [...files].map((f) => f.name).join(", ");
      setHint(t("liteCut.media.filesAdded", { names }));
      onFiles?.([...files]);
    },
    [onFiles, t],
  );

  return (
    <label
      className={`group flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed transition-all ${
        dragOver
          ? "border-cs2-accent bg-cs2-accent-soft shadow-[inset_0_0_0_1px_rgba(255,140,0,.25)]"
          : "border-cs2-border bg-cs2-bg-card hover:border-cs2-accent/50 hover:bg-cs2-accent-soft"
      } ${compact ? "px-3 py-3" : "px-4 py-4"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-cs2-border bg-cs2-bg-input text-cs2-text-muted transition-colors group-hover:border-cs2-accent/35 group-hover:text-cs2-accent"><Upload className={compact ? "h-4 w-4" : "h-4.5 w-4.5"} /></span>
      <span className={`mt-1.5 font-semibold text-cs2-text-secondary ${compact ? "text-[10px]" : "text-[11px]"}`}>
        {acceptHint || t("liteCut.media.dropHint")}
      </span>
      <span className="mt-0.5 text-[9px] text-cs2-text-muted">{formats}</span>
      <input
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {hint ? <p className="mt-2 max-w-full truncate text-[9px] text-cs2-accent">{hint}</p> : null}
    </label>
  );
}
