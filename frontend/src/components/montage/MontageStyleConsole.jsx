import { useState } from "react";
import {
  Copy,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Music,
  Film,
  Trash2,
  X,
} from "lucide-react";
import { CollapsibleSection } from "./MontageWorkbenchPanels";
import { MontagePlayerAssetsPanel } from "./MontagePlayerAssetsPanel";
import { useT } from "../../i18n/useT.js";

function pathBasename(path) {
  const s = String(path || "").trim();
  if (!s) return "";
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"]);

function isImagePath(p) {
  const s = String(p || "").trim().toLowerCase();
  const dot = s.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(s.slice(dot));
}

function MediaVideoSlotCard({
  label,
  path,
  onPathChange,
  onClear,
  placeholder,
  onVideoDrop,
  onBrowse,
  imageDuration,
  onImageDurationChange,
}) {
  const t = useT();
  const filled = Boolean(path.trim());
  const base = pathBasename(path);
  const isImg = filled && isImagePath(path);
  return (
    <div
      className={`rounded-xl border p-3 transition-all ${filled ? "border-cs2-border bg-cs2-surface-1" : "border-dashed border-cs2-border-subtle bg-cs2-surface-1/40"}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        const type = String(f.type || "");
        const name = String(f.name || "");
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        if (!type.startsWith("video/") && !type.startsWith("image/") && !IMAGE_EXTS.has(ext)) {
          onVideoDrop?.(null, t("montage.consoleMediaVideoDropHintError"));
          return;
        }
        onVideoDrop?.(f.name, null);
      }}
    >
      <div className="flex items-center gap-2">
        <Film className="h-4 w-4 shrink-0 text-cs2-text-muted" aria-hidden />
        <p className="text-xs font-bold text-cs2-text-secondary">{label}</p>
        {filled ? (
          <p className="ml-auto max-w-[12rem] truncate font-mono text-xs text-cs2-text-secondary" title={path}>
            {base || path}
          </p>
        ) : (
          <p className="ml-1 text-xs text-cs2-text-muted">{t("montage.consoleMediaSlotDropHint")}</p>
        )}
      </div>
      {isImg ? (
        <div className="mt-2.5 flex items-center gap-2">
          <p className="text-xs text-violet-300 font-medium">{t("montage.consoleMediaSlotImgDuration")}</p>
          <input
            type="number"
            min={1}
            max={60}
            step={0.5}
            value={imageDuration ?? 3}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v >= 1) onImageDurationChange?.(v);
            }}
            className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-violet-400"
          />
          <span className="text-xs text-cs2-text-muted">{t("montage.consoleMediaSlotSec")}</span>
        </div>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent transition-all"
        />
        {onBrowse ? (
          <button
            type="button"
            onClick={onBrowse}
            title={t("montage.consoleMediaSlotBrowseTitle")}
            className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {filled ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-muted hover:border-rose-500/30 hover:text-rose-400 transition-all"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ExportCheckRow({ ok, optional, label }) {
  const t = useT();
  const dot =
    ok === true ? "bg-emerald-400" : optional ? "bg-amber-400" : "bg-zinc-500";
  const text = ok === true
    ? t("montage.exportCheckDone")
    : optional
      ? t("montage.exportCheckOptionalEmpty")
      : t("montage.exportCheckRequiredEmpty");
  return (
    <div className="flex items-center gap-2.5 text-xs text-cs2-text-secondary py-0.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} title={text} />
      <span className="text-cs2-text-secondary font-medium">{label}</span>
      <span className="ml-auto text-cs2-text-muted">{text}</span>
    </div>
  );
}

export function MontageStyleConsole({
  // media
  bgmPath,
  onBgmPathChange,
  onBgmClear,
  bgmVolume,
  onBgmVolumeChange,
  bgmStartSec,
  onBgmStartSecChange,
  introPath,
  onIntroPathChange,
  onIntroClear,
  introDuration,
  onIntroDurationChange,
  outroPath,
  onOutroPathChange,
  onOutroClear,
  outroDuration,
  onOutroDurationChange,
  onMediaDropHint,
  onFilePick,
  // export footer
  clipCount,
  durationText,
  resolutionLabel,
  exporting,
  onExport,
  onSaveDraft,
  savingDraft,
  exportReady,
  fullOutputPathPreview,
  // technical / collapsed
  outputFilename,
  onOutputFilenameChange,
  defaultFilenamePlaceholder,
  draftName,
  onDraftNameChange,
  draftNamePlaceholder,
  outputDir,
  onOutputDirChange,
  onOutputDirClear,
  effectiveOutputDirHint,
  exportingBanner,
  exportOk,
  lastExport,
  exportDirForButton,
  onCopyText,
  onDismissExportSuccess,
  // player assets
  clips,
  playerAvatars,
  nameCardsEnabled,
  onPlayerAvatarChange,
  onNameCardsEnabledChange,
}) {
  const t = useT();
  const dirOk = Boolean(String(outputDir || "").trim()) || Boolean(String(effectiveOutputDirHint || "").trim());
  const nameOk = Boolean(String(outputFilename || "").trim());
  const bgmFilled = Boolean(String(bgmPath || "").trim());
  const introFilled = Boolean(String(introPath || "").trim());
  const outroFilled = Boolean(String(outroPath || "").trim());
  const nameCardsFilled = Boolean(nameCardsEnabled);
  const readyTag =
    exportReady !== undefined && exportReady !== null ? Boolean(exportReady) : dirOk && nameOk && Number(clipCount) > 0;

  const [activeTab, setActiveTab] = useState("media");
  const tabItems = [
    { id: "media", label: t("montage.consoleTabMedia") },
    { id: "players", label: t("montage.consoleTabPlayers") },
    { id: "export", label: t("montage.consoleTabExport") },
  ];

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col border-cs2-border bg-cs2-surface-1 xl:border-l">
      <div className="shrink-0 border-b border-cs2-border-subtle p-4">
        <p className="text-sm font-bold text-cs2-text-primary tracking-wide">{t("montage.consoleTitle")}</p>
        <div className="mt-3 flex gap-1.5">
          {tabItems.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                activeTab === tab.id
                  ? "bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                  : "text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-5">
          {exportingBanner ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-medium text-amber-300">
              {t("montage.consoleExportingBanner")}
            </div>
          ) : null}
          {!exportingBanner && exportOk ? (
            <div className="relative rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-200">
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {t("montage.consoleExportSuccess")}
              </div>
              <button
                type="button"
                onClick={() => onDismissExportSuccess?.()}
                className="absolute right-3 top-3 rounded-lg p-1 text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary"
                aria-label={t("montage.consoleExportSuccessClose")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              <p className="mt-3 text-xs text-cs2-text-muted">{t("montage.consoleExportOutputPath")}</p>
              <p className="mt-1 break-all font-mono text-xs font-semibold text-cs2-text-primary p-2 bg-cs2-surface-2 rounded-lg select-all border border-cs2-border-subtle">{lastExport.output_path}</p>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void onCopyText(lastExport.output_path)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-dynamic-white hover:bg-emerald-600 transition-all shadow-sm"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("montage.consoleCopyFilePath")}
                </button>
                {exportDirForButton ? (
                  <button
                    type="button"
                    onClick={() => void onCopyText(exportDirForButton)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-1.5 text-xs font-bold text-cs2-text-primary hover:border-cs2-border-focus transition-all"
                    title={t("montage.consoleCopyParentDirTitle")}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("montage.consoleCopyParentDir")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {!exportingBanner && lastExport && !lastExport.ok ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-medium text-rose-300">
              {t("montage.consoleExportError")}{String(lastExport.err)}
            </div>
          ) : null}

          {activeTab === "media" && (<CollapsibleSection
            title={t("montage.consoleBgmSectionTitle")}
            hint={t("montage.consoleBgmSectionHint")}
            defaultOpen
          >
            <div
              className={`rounded-xl border p-3 transition-all ${bgmPath.trim() ? "border-violet-500/40 bg-violet-500/[0.08]" : "border-dashed border-cs2-border-subtle bg-cs2-surface-1/40"}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (!f) return;
                if (!String(f.type || "").startsWith("audio/")) {
                  onMediaDropHint?.(t("montage.consoleMediaDropHintAudio"));
                  return;
                }
                onMediaDropHint?.(t("montage.consoleMediaDropHintRecognized", { name: f.name }));
              }}
            >
              <div className="flex items-center gap-2">
                <Music className="h-4 w-4 shrink-0 text-violet-400" aria-hidden />
                <p className="text-xs font-bold text-cs2-text-secondary">{t("montage.consoleBgmTitle")}</p>
                {bgmPath.trim() ? (
                  <p className="ml-auto max-w-[14rem] truncate font-mono text-xs text-cs2-text-secondary" title={bgmPath}>
                    {pathBasename(bgmPath)}
                  </p>
                ) : (
                  <p className="ml-1 text-xs text-cs2-text-muted">{t("montage.consoleBgmDropHint")}</p>
                )}
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between gap-2 text-xs text-cs2-text-muted">
                  <span>{t("montage.consoleBgmVolume")}</span>
                  <span className="font-mono font-bold text-violet-400">{bgmVolume}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bgmVolume}
                  onChange={(e) => onBgmVolumeChange(Number(e.target.value))}
                  className="mt-1.5 h-2 w-full rounded-lg bg-cs2-bg-input accent-violet-400 cursor-pointer"
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-cs2-text-muted">{t("montage.consoleBgmStartSec")}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={bgmStartSec || ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    onBgmStartSecChange?.(Number.isFinite(v) && v >= 0 ? v : 0);
                  }}
                  className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-violet-400 transition-all"
                />
                <span className="text-xs text-cs2-text-muted">{t("montage.consoleBgmSec")}</span>
              </div>
              <div className="mt-2.5 flex gap-2">
                <input
                  value={bgmPath}
                  onChange={(e) => onBgmPathChange(e.target.value)}
                  placeholder={t("montage.consoleBgmPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2.5 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
                />
                {onFilePick ? (
                  <button
                    type="button"
                    onClick={() => onFilePick("audio", onBgmPathChange)}
                    title={t("montage.consoleBgmBrowseTitle")}
                    className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {bgmPath.trim() ? (
                  <button
                    type="button"
                    onClick={onBgmClear}
                    className="inline-flex shrink-0 items-center rounded-lg border border-cs2-border-subtle px-2.5 py-1.5 text-xs text-cs2-text-muted hover:border-rose-500/30 hover:text-rose-400 transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>

            <MediaVideoSlotCard
              label={t("montage.consoleIntroLabel")}
              path={introPath}
              onPathChange={onIntroPathChange}
              onClear={onIntroClear}
              placeholder={t("montage.consoleIntroPlaceholder")}
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(t("montage.consoleMediaVideoDropHintOk", { name }));
              }}
              onBrowse={onFilePick ? () => onFilePick("video_or_image", onIntroPathChange) : undefined}
              imageDuration={introDuration}
              onImageDurationChange={onIntroDurationChange}
            />
            <MediaVideoSlotCard
              label={t("montage.consoleOutroLabel")}
              path={outroPath}
              onPathChange={onOutroPathChange}
              onClear={onOutroClear}
              placeholder={t("montage.consoleOutroPlaceholder")}
              onVideoDrop={(name, err) => {
                if (err) onMediaDropHint?.(err);
                else if (name) onMediaDropHint?.(t("montage.consoleMediaVideoDropHintOk", { name }));
              }}
              onBrowse={onFilePick ? () => onFilePick("video_or_image", onOutroPathChange) : undefined}
              imageDuration={outroDuration}
              onImageDurationChange={onOutroDurationChange}
            />
          </CollapsibleSection>)}

          {activeTab === "players" && (
            <MontagePlayerAssetsPanel
              clips={clips || []}
              playerAvatars={playerAvatars || {}}
              nameCardsEnabled={nameCardsEnabled || false}
              onPlayerAvatarChange={onPlayerAvatarChange}
              onNameCardsEnabledChange={onNameCardsEnabledChange}
            />
          )}

          {activeTab === "export" && (<CollapsibleSection
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{t("montage.consoleExportSectionTitle")}</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-bold tracking-wide ${
                    readyTag
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-amber-500/10 text-amber-300"
                  }`}
                >
                  {readyTag ? t("montage.consoleExportReady") : t("montage.consoleExportNotReady")}
                </span>
              </span>
            }
            hint={t("montage.consoleExportSectionHint")}
            defaultOpen
          >
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3">
                <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleExportQueueCount")}</p>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-mono text-base font-bold text-cs2-text-primary">{Number(clipCount) || 0}</span>
                  <span className="text-xs text-cs2-text-muted">{t("montage.consoleExportQueueUnit")}</span>
                </div>
              </div>
              <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3">
                <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleExportTotalDuration")}</p>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-mono text-base font-bold text-cs2-accent">{durationText}</span>
                  <span className="text-xs text-cs2-text-muted">{t("montage.consoleExportDurationUnit")}</span>
                </div>
              </div>
            </div>

            <label className="mt-4 block space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleExportFilenameLabel")}</span>
              <input
                value={outputFilename}
                onChange={(e) => onOutputFilenameChange(e.target.value)}
                placeholder={defaultFilenamePlaceholder}
                className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
              />
            </label>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-secondary">{t("montage.consoleExportDirLabel")}</span>
              <div className="flex gap-2">
                <input
                  value={outputDir}
                  onChange={(e) => onOutputDirChange(e.target.value)}
                  placeholder={t("montage.consoleExportDirPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
                />
                {outputDir ? (
                  <button
                    type="button"
                    onClick={onOutputDirClear}
                    className="shrink-0 rounded-lg border border-cs2-border-subtle px-3 py-2 text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-secondary transition-all"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              {effectiveOutputDirHint ? (
                <p className="text-xs text-cs2-text-muted mt-1 bg-cs2-surface-1/60 p-2 rounded-lg border border-cs2-border-subtle">
                  <span>{t("montage.consoleExportDirTarget")}</span>
                  <span className="break-all font-mono text-cs2-text-secondary select-all">{effectiveOutputDirHint}</span>
                </p>
              ) : null}
            </div>

            <div className="mt-4 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
              <p className="text-xs font-bold text-cs2-text-primary border-b border-cs2-border-subtle pb-2 mb-2">{t("montage.consoleExportCheckTitle")}</p>
              <div className="space-y-1">
                <ExportCheckRow ok={dirOk} optional={false} label={t("montage.consoleExportCheckDir")} />
                <ExportCheckRow ok={nameOk} optional={false} label={t("montage.consoleExportCheckName")} />
                <ExportCheckRow ok={bgmFilled} optional label={t("montage.consoleExportCheckBgm")} />
                <ExportCheckRow ok={introFilled} optional label={t("montage.consoleExportCheckIntro")} />
                <ExportCheckRow ok={outroFilled} optional label={t("montage.consoleExportCheckOutro")} />
                <ExportCheckRow ok={nameCardsFilled} optional label={t("montage.consoleExportCheckNameCards")} />
              </div>
            </div>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-secondary">{t("montage.consoleExportDraftLabel")}</span>
              <input
                value={draftName}
                onChange={(e) => onDraftNameChange(e.target.value)}
                placeholder={draftNamePlaceholder}
                className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
              />
            </div>

            <button
              type="button"
              disabled={savingDraft}
              onClick={() => onSaveDraft?.()}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-4 py-2.5 text-xs font-bold text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all shadow-sm disabled:opacity-45"
            >
              {t("montage.consoleExportSaveDraftBtn")}
            </button>

            <button
              type="button"
              disabled={exporting}
              onClick={onExport}
              className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-accent px-4 py-3 text-sm font-bold text-cs2-text-on-accent shadow-glow-accent hover:opacity-95 transition-all disabled:opacity-45"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("montage.consoleExportStartBtn")}
            </button>

            <div className="mt-4 space-y-1.5">
              <span className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleExportPathPreviewLabel")}</span>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={fullOutputPathPreview || ""}
                  placeholder={t("montage.consoleExportPathPreviewPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-surface-2 px-3 py-2 font-mono text-xs text-cs2-text-muted select-all outline-none"
                />
                <button
                  type="button"
                  disabled={!fullOutputPathPreview}
                  onClick={() => fullOutputPathPreview && onCopyText?.(fullOutputPathPreview)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-3 py-2 text-xs font-bold text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all shadow-sm disabled:opacity-35"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("montage.consoleExportCopyBtn")}
                </button>
              </div>
            </div>
          </CollapsibleSection>)}
        </div>
      </div>

      <div className="shrink-0 border-t border-cs2-border-subtle bg-cs2-surface-1 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleFooterDuration")}</p>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="font-mono text-sm font-bold text-cs2-text-primary">{durationText}</span>
              <span className="text-xs text-cs2-text-muted font-medium">{t("montage.consoleFooterClipCount", { n: clipCount })}</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleFooterQuality")}</p>
            <p className="text-xs font-bold text-cs2-text-secondary mt-0.5">{resolutionLabel}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
