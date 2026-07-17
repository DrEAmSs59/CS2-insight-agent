import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../../i18n/useT.js";

const SIZE_PRESETS = [
  { id: "16:9", width: 1920, height: 1080 },
  { id: "9:16", width: 1080, height: 1920 },
  { id: "1:1", width: 1080, height: 1080 },
  { id: "4:3", width: 1440, height: 1080 },
  { id: "custom", width: null, height: null },
];
const FPS_OPTIONS = [24, 25, 30, 60, 120];

export default function LiteCutNewProjectDialog({ open, onClose, onCreate }) {
  const t = useT();
  const [name, setName] = useState("");
  const [sizePreset, setSizePreset] = useState("16:9");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(60);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(t("liteCut.project.untitled"));
    setSizePreset("16:9");
    setWidth(1920);
    setHeight(1080);
    setFps(60);
    setCreating(false);
  }, [open, t]);

  if (!open) return null;

  const chooseSize = (id) => {
    setSizePreset(id);
    const preset = SIZE_PRESETS.find((item) => item.id === id);
    if (preset?.width) setWidth(preset.width);
    if (preset?.height) setHeight(preset.height);
  };

  const submit = async (event) => {
    event.preventDefault();
    setCreating(true);
    try {
      const result = await onCreate?.({
        isCustomProject: true,
        name: name.trim() || t("liteCut.project.untitled"),
        width: Math.max(320, Math.min(7680, Number(width) || 1920)),
        height: Math.max(180, Math.min(4320, Number(height) || 1080)),
        fps: Number(fps) || 60,
      });
      if (result?.ok !== false) onClose?.();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-label={t("liteCut.project.newDialogTitle")}>
      <form onSubmit={submit} className="w-full max-w-lg overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-cs2-border px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-cs2-text-primary">{t("liteCut.project.newDialogTitle")}</h2>
            <p className="mt-1 text-[11px] text-cs2-text-muted">{t("liteCut.project.newDialogHint")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-2 text-cs2-text-muted hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-5 p-5">
          <label className="block text-xs font-semibold text-cs2-text-secondary">
            {t("liteCut.project.name")}
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2.5 text-sm text-cs2-text-primary outline-none focus:border-cs2-accent" />
          </label>
          <div>
            <p className="text-xs font-semibold text-cs2-text-secondary">{t("liteCut.project.canvasSize")}</p>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {SIZE_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => chooseSize(preset.id)} className={`rounded-lg border px-2 py-2 text-xs font-semibold ${sizePreset === preset.id ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border text-cs2-text-muted hover:text-white"}`}>{preset.id === "custom" ? t("liteCut.project.customSize") : preset.id}</button>)}
            </div>
            <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <input type="number" min="320" max="7680" value={width} onChange={(event) => { setWidth(event.target.value); setSizePreset("custom"); }} className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm outline-none focus:border-cs2-accent" aria-label={t("liteCut.project.width")} />
              <span className="text-cs2-text-muted">×</span>
              <input type="number" min="180" max="4320" value={height} onChange={(event) => { setHeight(event.target.value); setSizePreset("custom"); }} className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm outline-none focus:border-cs2-accent" aria-label={t("liteCut.project.height")} />
            </div>
          </div>
          <label className="block text-xs font-semibold text-cs2-text-secondary">
            {t("liteCut.project.frameRate")}
            <select value={fps} onChange={(event) => setFps(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2.5 text-sm outline-none focus:border-cs2-accent">
              {FPS_OPTIONS.map((value) => <option key={value} value={value}>{value} FPS</option>)}
            </select>
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-cs2-border px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-lg border border-cs2-border px-4 py-2 text-xs font-semibold text-cs2-text-secondary hover:text-white">{t("common.cancel")}</button>
          <button type="submit" disabled={creating} className="rounded-lg bg-cs2-accent px-5 py-2 text-xs font-bold text-black hover:bg-cs2-accent-light disabled:opacity-50">{creating ? t("liteCut.project.creating") : t("liteCut.project.createConfirm")}</button>
        </footer>
      </form>
    </div>
  );
}
