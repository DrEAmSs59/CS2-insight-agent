import { useState } from "react";
import {
  Copy,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileOutput,
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
import { humanizeMontageError } from "../../utils/formatMontageApiError.js";
import { summarizeFrameMeldSources } from "../../utils/framemeld.js";

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

function ExportCheckRow({ ok, label }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
      ) : (
        <CircleAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
      )}
      <span className={ok ? "font-medium text-cs2-text-secondary" : "font-medium text-cs2-text-primary"}>{label}</span>
      <span className={`ml-auto shrink-0 ${ok ? "text-emerald-400" : "text-amber-300"}`}>
        {ok ? t("montage.exportCheckDone") : t("montage.exportCheckRequiredEmpty")}
      </span>
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
  exportReady,
  fullOutputPathPreview,
  // technical / collapsed
  outputFilename,
  onOutputFilenameChange,
  defaultFilenamePlaceholder,
  outputDir,
  onOutputDirChange,
  onOutputDirCommit,
  onOutputDirBrowse,
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
  framemeldEnabled,
  framemeldRuntimeAvailable = false,
  framemeldSourceSummary: providedFrameMeldSourceSummary,
  onFrameMeldEnabledChange,
}) {
  const t = useT();
  const framemeldSourceSummary = providedFrameMeldSourceSummary || summarizeFrameMeldSources(clips || []);
  const framemeldAvailable = framemeldRuntimeAvailable && framemeldSourceSummary.compatible;
  const framemeldActive = framemeldAvailable && Boolean(framemeldEnabled);
  const framemeldBlockedReason = !framemeldRuntimeAvailable
    ? t("montage.consoleFrameMeldUnavailable")
    : framemeldSourceSummary.hasUnknownFps
      ? t("montage.consoleFrameMeldBlockedUnknownFps")
      : framemeldSourceSummary.hasMixedFrameRates
        ? t("montage.consoleFrameMeldBlockedMixedFps")
        : null;
  const dirOk = Boolean(String(outputDir || "").trim()) || Boolean(String(effectiveOutputDirHint || "").trim());
  const nameOk = Boolean(String(outputFilename || "").trim());
  const bgmFilled = Boolean(String(bgmPath || "").trim());
  const introFilled = Boolean(String(introPath || "").trim());
  const outroFilled = Boolean(String(outroPath || "").trim());
  const nameCardsFilled = Boolean(nameCardsEnabled);
  const readyTag =
    exportReady !== undefined && exportReady !== null ? Boolean(exportReady) : dirOk && nameOk && Number(clipCount) > 0;
  const requiredChecks = [
    { id: "clips", ok: Number(clipCount) > 0, label: t("montage.consoleExportCheckClips") },
    { id: "name", ok: nameOk, label: t("montage.consoleExportCheckName") },
    { id: "dir", ok: dirOk, label: t("montage.consoleExportCheckDir") },
  ];
  const requiredDone = requiredChecks.filter((item) => item.ok).length;
  const optionalItems = [
    { id: "bgm", active: bgmFilled, label: t("montage.exportChecklistBgm") },
    { id: "intro", active: introFilled, label: t("montage.exportChecklistIntro") },
    { id: "outro", active: outroFilled, label: t("montage.exportChecklistOutro") },
    { id: "cards", active: nameCardsFilled, label: t("montage.consoleExportOptionalNameCards") },
  ];
  const optionalActiveCount = optionalItems.filter((item) => item.active).length;

  const [activeTab, setActiveTab] = useState("media");
  const tabItems = [
    { id: "media", label: t("montage.consoleTabMedia") },
    { id: "players", label: t("montage.consoleTabPlayers") },
    { id: "export", label: t("montage.consoleTabExport") },
  ];

  return (
    <aside className="flex min-h-0 w-full min-w-0 flex-col bg-transparent">
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
              {t("montage.consoleExportError")}
              {humanizeMontageError(lastExport.err, t)}
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
                <Music className="h-4 w-4 shrink-0 text-cs2-accent" aria-hidden />
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
                  <span className="font-mono font-bold text-cs2-accent">{bgmVolume}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bgmVolume}
                  onChange={(e) => onBgmVolumeChange(Number(e.target.value))}
                  className="cs2-data-slider mt-1.5"
                  style={{
                    "--cs2-range-progress": `${Math.min(100, Math.max(0, Number(bgmVolume) || 0))}%`,
                    "--cs2-range-accent": "var(--cs2-accent)",
                  }}
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

          {activeTab === "export" && (<div>
            <section
              className={`rounded-xl border p-3.5 ${
                readyTag
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-cs2-accent/25 bg-cs2-accent-soft"
              }`}
            >
              <div className="flex items-start gap-2.5">
                {readyTag ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-cs2-accent" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className={`text-sm font-bold ${readyTag ? "text-cs2-text-primary" : "text-cs2-accent"}`}>
                    {readyTag ? t("montage.consoleExportSummaryReady") : t("montage.consoleExportSummaryPending")}
                  </p>
                  <p className={`mt-1 text-xs ${readyTag ? "text-cs2-text-muted" : "text-cs2-accent"}`}>
                    {t("montage.consoleExportSummary", { clips: Number(clipCount) || 0, duration: durationText })}
                  </p>
                </div>
                <span className={`ml-auto shrink-0 rounded-md px-2 py-1 text-[10px] font-bold ${readyTag ? "bg-emerald-500/15 text-emerald-300" : "bg-cs2-accent/15 text-cs2-accent"}`}>
                  {requiredDone}/{requiredChecks.length}
                </span>
              </div>
            </section>

            <section className="mt-3 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
              <div className="mb-3 flex items-center gap-2">
                <FileOutput className="h-4 w-4 text-cs2-accent" aria-hidden />
                <p className="text-xs font-bold text-cs2-text-primary">{t("montage.consoleExportOutputTitle")}</p>
              </div>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-cs2-text-muted">{t("montage.consoleExportFilenameLabel")}</span>
              <input
                value={outputFilename}
                onChange={(e) => onOutputFilenameChange(e.target.value)}
                placeholder={defaultFilenamePlaceholder}
                className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
              />
            </label>

            <div className="mt-3 space-y-1.5">
              <span className="text-xs font-medium text-cs2-text-muted">{t("montage.consoleExportDirLabel")}</span>
              <div className="flex gap-2">
                <input
                  value={outputDir}
                  onChange={(e) => onOutputDirChange(e.target.value)}
                  onBlur={() => onOutputDirCommit?.()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  placeholder={t("montage.consoleExportDirPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent transition-all"
                />
                {onOutputDirBrowse ? (
                  <button
                    type="button"
                    aria-label={t("montage.consoleExportDirBrowse")}
                    title={t("montage.consoleExportDirBrowse")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onOutputDirBrowse}
                    className="inline-flex shrink-0 items-center justify-center rounded-lg border border-cs2-border-subtle px-2.5 text-cs2-text-secondary transition-all hover:border-cs2-border-focus hover:bg-cs2-surface-2 hover:text-cs2-text-primary"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
                {outputDir ? (
                  <button
                    type="button"
                    aria-label={t("montage.consoleExportDirClear")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onOutputDirClear}
                    className="inline-flex shrink-0 items-center justify-center rounded-lg border border-cs2-border-subtle px-2.5 text-cs2-text-muted transition-all hover:bg-cs2-surface-2 hover:text-cs2-text-secondary"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
              {effectiveOutputDirHint ? (
                <p className="mt-1 rounded-lg bg-cs2-bg-input/60 p-2 text-[11px] text-cs2-text-muted">
                  <span>{t("montage.consoleExportDirTarget")}</span>
                  <span className="break-all font-mono text-cs2-text-secondary select-all">{effectiveOutputDirHint}</span>
                </p>
              ) : null}
            </div>
            {fullOutputPathPreview ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input/70 px-2.5 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cs2-text-muted" title={fullOutputPathPreview}>
                  {fullOutputPathPreview}
                </span>
                <button
                  type="button"
                  aria-label={t("montage.consoleExportCopyBtn")}
                  onClick={() => onCopyText?.(fullOutputPathPreview)}
                  className="shrink-0 text-cs2-text-muted transition-colors hover:text-cs2-text-primary"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
            </section>

            <details className="group mt-3 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-xs font-bold text-cs2-text-secondary">
                <span>{t("montage.consoleExportAdvancedTitle")}</span>
                <span className="ml-auto text-[10px] font-medium text-cs2-text-muted">{t("montage.consoleExportAdvancedOptional")}</span>
                <ChevronDown className="h-4 w-4 text-cs2-text-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-cs2-border-subtle p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-cs2-text-primary">
                    {t("montage.consoleFrameMeldTitle")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-cs2-text-muted">
                    {t("montage.consoleFrameMeldHint")}
                  </p>
                </div>
                <button
                  type="button"
                  aria-pressed={framemeldActive}
                  aria-label={t("montage.consoleFrameMeldTitle")}
                  disabled={!framemeldAvailable}
                  onClick={() => onFrameMeldEnabledChange?.(!framemeldActive)}
                  className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                    framemeldActive
                      ? "border-cs2-accent bg-cs2-accent text-white shadow-sm"
                      : "border-cs2-border bg-cs2-bg-input text-transparent hover:border-cs2-accent/70 hover:bg-cs2-surface-2"
                  }`}
                >
                  <Check size={17} strokeWidth={3} aria-hidden="true" />
                </button>
              </div>
              {framemeldBlockedReason ? (
                <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">
                  {framemeldBlockedReason}
                </p>
              ) : framemeldActive ? (
                <p className="mt-3 rounded-lg border border-cs2-accent/25 bg-cs2-accent-soft px-3 py-2 text-[11px] leading-relaxed text-cs2-accent">
                  {t("montage.consoleFrameMeldLockedPlan")}
                </p>
              ) : null}
              </div>
            </details>

            <div className="mt-3 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold text-cs2-text-primary">{t("montage.consoleExportCheckTitle")}</p>
                <span className="text-[10px] font-medium text-cs2-text-muted">{requiredDone}/{requiredChecks.length}</span>
              </div>
              <div className="mt-2 space-y-0.5">
                {requiredChecks.map((item) => (
                  <ExportCheckRow key={item.id} ok={item.ok} label={item.label} />
                ))}
              </div>
              <div className="mt-3 border-t border-cs2-border-subtle pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-cs2-text-muted">{t("montage.consoleExportOptionalTitle")}</span>
                  <span className="text-[10px] text-cs2-text-muted">{optionalActiveCount}/{optionalItems.length}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {optionalItems.map((item) => (
                    <span
                      key={item.id}
                      className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                        item.active
                          ? "bg-emerald-500/10 text-emerald-300"
                          : "bg-cs2-bg-input text-cs2-text-muted"
                      }`}
                    >
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

          </div>)}
        </div>
      </div>

      <div className="shrink-0 border-t border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        {activeTab === "export" ? (
          <div>
            {!readyTag ? (
              <p className="mb-2.5 text-center text-[11px] font-medium text-amber-300">
                {t("montage.consoleExportBlockedCount", { n: requiredChecks.length - requiredDone })}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!readyTag || exporting}
              onClick={onExport}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-accent px-4 py-3 text-sm font-bold text-cs2-text-on-accent shadow-glow-accent transition-all hover:opacity-95 disabled:cursor-not-allowed disabled:shadow-none disabled:opacity-40"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("montage.consoleExportStartBtn")}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleFooterDuration")}</p>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="font-mono text-sm font-bold text-cs2-text-primary">{durationText}</span>
                <span className="text-xs font-medium text-cs2-text-muted">{t("montage.consoleFooterClipCount", { n: clipCount })}</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold text-cs2-text-muted">{t("montage.consoleFooterQuality")}</p>
              <p className="mt-0.5 text-xs font-bold text-cs2-text-secondary">{resolutionLabel}</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
