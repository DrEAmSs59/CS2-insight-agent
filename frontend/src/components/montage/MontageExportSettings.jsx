import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Save } from "lucide-react";
import { useT } from "../../i18n/useT.js";

function PathField({ label, hint, value, onChange, onClear, placeholder, example }) {
  const t = useT();
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-cs2-text-secondary">{label}</span>
        {value ? (
          <button type="button" onClick={onClear} className="text-[10px] text-cs2-text-muted hover:text-cs2-text-secondary">
            {t("montage.exportClearBtn")}
          </button>
        ) : null}
      </div>
      <p className="text-[11px] leading-relaxed text-cs2-text-muted">{hint}</p>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-cs2-border bg-cs2-bg-input/80 px-2 py-2 font-mono text-[11px] text-cs2-text-primary placeholder:text-cs2-text-muted"
      />
      {example ? <p className="text-[11px] text-cs2-text-muted">{t("montage.exportExamplePrefix")}{example}</p> : null}
    </div>
  );
}

function CheckRow({ ok, optional, label }) {
  const t = useT();
  const dot =
    ok === true ? "bg-emerald-400" : optional ? "bg-amber-400/90" : "bg-zinc-500";
  const text = ok === true
    ? t("montage.exportCheckDone")
    : optional
      ? t("montage.exportCheckOptionalEmpty")
      : t("montage.exportCheckRequiredEmpty");
  return (
    <div className="flex items-center gap-2 text-[11px] text-cs2-text-secondary">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} title={text} />
      <span className="text-cs2-text-secondary">{label}</span>
      <span className="ml-auto font-medium text-cs2-text-muted">{text}</span>
    </div>
  );
}

export default function MontageExportSettings({
  videoName,
  onVideoNameChange,
  outputDir,
  onOutputDirChange,
  bgmPath,
  onBgmChange,
  introPath,
  onIntroChange,
  outroPath,
  onOutroChange,
  draftName,
  onDraftNameChange,
  draftNamePlaceholder,
  onSaveDraft,
  savingDraft,
  clipCount,
  totalDurationText,
  exportReady,
  fullOutputPath,
  onCopyOutputPath,
  onStartExport,
  exporting,
}) {
  const t = useT();
  const [open, setOpen] = useState(true);

  const checklist = useMemo(() => {
    const dirOk = Boolean(String(outputDir || "").trim());
    const nameOk = Boolean(String(videoName || "").trim());
    const bgmOk = Boolean(String(bgmPath || "").trim());
    const introOk = Boolean(String(introPath || "").trim());
    const outroOk = Boolean(String(outroPath || "").trim());
    return {
      dirOk,
      nameOk,
      bgmOk,
      introOk,
      outroOk,
    };
  }, [outputDir, videoName, bgmPath, introPath, outroPath]);

  const ready = exportReady !== undefined ? Boolean(exportReady) : checklist.dirOk && checklist.nameOk && Number(clipCount) > 0;

  return (
    <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-cs2-bg-input/50"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-cs2-text-primary">{t("montage.exportSettingsTitle")}</span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
              ready ? "border-emerald-500/40 bg-emerald-500/10 text-cs2-emerald-on-surface" : "border-amber-500/40 bg-amber-500/10 text-cs2-amber-on-surface"
            }`}
          >
            {ready ? t("montage.exportSettingsReady") : t("montage.exportSettingsNotReady")}
          </span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-cs2-text-muted" /> : <ChevronDown className="h-4 w-4 shrink-0 text-cs2-text-muted" />}
      </button>
      {open ? (
        <div className="space-y-4 border-t border-cs2-border px-3 py-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/60 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-cs2-text-muted">{t("montage.exportStatArranged")}</p>
              <p className="mt-0.5 font-mono text-[15px] font-bold tabular-nums text-cs2-text-primary">{Number(clipCount) || 0}</p>
              <p className="text-[9px] text-cs2-text-muted">{t("montage.exportStatArrangedUnit")}</p>
            </div>
            <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/60 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-cs2-text-muted">{t("montage.exportStatDuration")}</p>
              <p className="mt-0.5 font-mono text-[14px] font-bold tabular-nums text-cs2-accent">{totalDurationText || "—"}</p>
              <p className="text-[9px] text-cs2-text-muted">{t("montage.exportStatDurationUnknown")}</p>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[12px] font-medium text-cs2-text-secondary">{t("montage.exportVideoNameLabel")}</span>
            <p className="text-[11px] text-cs2-text-muted">{t("montage.exportVideoNameHint")}</p>
            <input
              value={videoName}
              onChange={(e) => onVideoNameChange(e.target.value)}
              className="w-full rounded border border-cs2-border bg-cs2-bg-input/80 px-2 py-2 font-mono text-[11px] text-cs2-text-primary"
              placeholder="CS2-Highlights-2026-05-02"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[12px] font-medium text-cs2-text-secondary">{t("montage.exportOutputDirLabel")}</span>
            <p className="text-[11px] text-cs2-text-muted">{t("montage.exportOutputDirHint")}</p>
            <input
              value={outputDir}
              onChange={(e) => onOutputDirChange(e.target.value)}
              placeholder="C:\Users\YourName\Videos"
              className="w-full rounded border border-cs2-border bg-cs2-bg-input/80 px-2 py-2 font-mono text-[11px] text-cs2-text-primary"
            />
          </div>

          <PathField
            label={t("montage.exportBgmLabel")}
            hint={t("montage.exportBgmHint")}
            value={bgmPath}
            onChange={onBgmChange}
            onClear={() => onBgmChange("")}
            placeholder="C:\Users\YourName\Music\bgm.mp3"
            example="C:\Users\YourName\Music\bgm.mp3"
          />
          <PathField
            label={t("montage.exportIntroLabel")}
            hint={t("montage.exportIntroHint")}
            value={introPath}
            onChange={onIntroChange}
            onClear={() => onIntroChange("")}
            placeholder="C:\Users\YourName\Videos\intro.mp4"
            example="C:\Users\YourName\Videos\intro.mp4"
          />
          <PathField
            label={t("montage.exportOutroLabel")}
            hint={t("montage.exportOutroHint")}
            value={outroPath}
            onChange={onOutroChange}
            onClear={() => onOutroChange("")}
            placeholder="C:\Users\YourName\Videos\outro.mp4"
            example="C:\Users\YourName\Videos\outro.mp4"
          />

          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/70 px-2.5 py-2">
            <p className="text-[11px] font-semibold text-cs2-text-secondary">{t("montage.exportChecklistTitle")}</p>
            <div className="mt-2 space-y-1.5">
              <CheckRow ok={checklist.dirOk} optional={false} label={t("montage.exportChecklistDir")} />
              <CheckRow ok={checklist.nameOk} optional={false} label={t("montage.exportChecklistName")} />
              <CheckRow ok={checklist.bgmOk} optional label={t("montage.exportChecklistBgm")} />
              <CheckRow ok={checklist.introOk} optional label={t("montage.exportChecklistIntro")} />
              <CheckRow ok={checklist.outroOk} optional label={t("montage.exportChecklistOutro")} />
            </div>
          </div>

          <div className="space-y-1 border-t border-cs2-border pt-4">
            <span className="text-[12px] font-medium text-cs2-text-secondary">{t("montage.exportDraftNameLabel")}</span>
            <p className="text-[11px] text-cs2-text-muted">{t("montage.exportDraftNameHint")}</p>
            <input
              value={draftName}
              onChange={(e) => onDraftNameChange(e.target.value)}
              placeholder={draftNamePlaceholder || t("montage.exportDraftNamePlaceholderDefault")}
              className="w-full rounded border border-cs2-border bg-cs2-bg-input/80 px-2 py-2 text-[11px] text-cs2-text-primary"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={savingDraft}
              onClick={() => onSaveDraft?.()}
              className="inline-flex flex-1 min-w-[120px] items-center justify-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-hover px-3 py-2 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-border disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingDraft ? t("montage.exportSavingDraft") : t("montage.exportSaveDraft")}
            </button>
          </div>

          <button
            type="button"
            disabled={exporting}
            onClick={() => onStartExport?.()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-accent/50 bg-cs2-accent/15 px-3 py-2.5 text-[12px] font-bold text-cs2-accent shadow-sm hover:bg-cs2-accent/22 disabled:opacity-45"
          >
            {t("montage.exportStartBtn")}
          </button>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-cs2-text-muted">{t("montage.exportFullPathLabel")}</span>
            <div className="flex gap-2">
              <input
                readOnly
                value={fullOutputPath || ""}
                placeholder={t("montage.exportFullPathPlaceholder")}
                className="min-w-0 flex-1 rounded border border-cs2-border bg-black/60 px-2 py-2 font-mono text-[10px] text-cs2-text-secondary"
              />
              <button
                type="button"
                disabled={!fullOutputPath}
                onClick={() => onCopyOutputPath?.(fullOutputPath)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-cs2-border bg-cs2-bg-input/70 px-2.5 py-2 text-[10px] font-medium text-cs2-text-secondary hover:border-cs2-accent/35 disabled:opacity-35"
              >
                <Copy className="h-3.5 w-3.5" />
                {t("montage.exportCopyBtn")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
