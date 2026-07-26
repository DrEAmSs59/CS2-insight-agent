import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FolderPlus, Loader2, ScanSearch, X } from "lucide-react";
import API from "../../api/api";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { useT } from "../../i18n/useT.js";

function pathKey(value) {
  return String(value || "").trim().replace(/[\\/]+$/, "").toLocaleLowerCase();
}

export default function DemoWatchPathsModal({
  open,
  onClose,
  demoWatchPaths = [],
  demoWatchScanDepth = 2,
  onDemoWatchPathsChange,
  onDemoWatchScanDepthChange,
  onSaveConfig,
  onScan,
  onOpenIngest,
}) {
  const t = useT();
  const [watchPathInput, setWatchPathInput] = useState("");
  const [inspections, setInspections] = useState({});
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const depth = Math.max(0, Math.min(32, Number(demoWatchScanDepth) || 0));

  const inspectPath = useCallback(async (rawPath, nextDepth = depth) => {
    const key = pathKey(rawPath);
    if (!key) return null;
    setInspections((prev) => ({ ...prev, [key]: { loading: true } }));
    try {
      const { data } = await API.post("/demos/watch-path/inspect", {
        path: String(rawPath).trim(),
        max_depth: nextDepth,
      });
      setInspections((prev) => ({ ...prev, [key]: data }));
      return data;
    } catch (error) {
      const failed = { valid: false, error: error?.response?.data?.detail || error?.message || t("library.watchPathsInspectFail") };
      setInspections((prev) => ({ ...prev, [key]: failed }));
      return failed;
    }
  }, [depth, t]);

  useEffect(() => {
    if (!open) return;
    setWatchPathInput("");
    setScanResult(null);
    (demoWatchPaths || []).forEach((path) => void inspectPath(path, depth));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = async (patch) => {
    const saved = await onSaveConfig?.(patch);
    return saved !== false;
  };

  const addPath = async (candidate = watchPathInput) => {
    const raw = String(candidate || "").trim();
    if (!raw || adding) return;
    setAdding(true);
    try {
      const inspected = await inspectPath(raw, depth);
      if (!inspected?.valid) return;
      const normalized = inspected.path || raw;
      const existing = new Set((demoWatchPaths || []).map(pathKey));
      const next = existing.has(pathKey(normalized))
        ? [...(demoWatchPaths || [])]
        : [...(demoWatchPaths || []), normalized];
      if (await persist({ demo_watch_paths: next, demo_watch_scan_depth: depth })) {
        onDemoWatchPathsChange?.(next);
        setWatchPathInput("");
        setInspections((prev) => ({ ...prev, [pathKey(normalized)]: inspected }));
      }
    } finally {
      setAdding(false);
    }
  };

  const choosePath = async () => {
    const selected = await desktopBridge?.chooseDirectory?.(
      demoWatchPaths[0] || "",
      t("library.watchPathsPickerTitle")
    );
    if (selected) await addPath(selected);
  };

  const removePath = async (path) => {
    const next = (demoWatchPaths || []).filter((item) => item !== path);
    if (await persist({ demo_watch_paths: next })) {
      onDemoWatchPathsChange?.(next);
      setInspections((prev) => {
        const copy = { ...prev };
        delete copy[pathKey(path)];
        return copy;
      });
    }
  };

  const changeDepth = async (value) => {
    const nextDepth = Math.max(0, Math.min(32, Number(value) || 0));
    onDemoWatchScanDepthChange?.(nextDepth);
    await persist({ demo_watch_scan_depth: nextDepth });
    (demoWatchPaths || []).forEach((path) => void inspectPath(path, nextDepth));
  };

  const runScan = async () => {
    if (scanning || demoWatchPaths.length === 0) return;
    setScanning(true);
    setScanResult(null);
    try {
      const result = await onScan?.();
      if (result) setScanResult(result);
    } finally {
      setScanning(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-cs2-bg-page/85 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-watch-paths-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-cs2-border px-5 py-4">
          <div>
            <h2 id="demo-watch-paths-title" className="text-sm font-bold text-cs2-text-primary">
              {t("library.watchPathsTitle")}
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
              {t("library.watchPathsHint")}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary" aria-label={t("library.watchPathsClose")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/35 p-3">
            <button
              type="button"
              onClick={() => void choosePath()}
              disabled={!desktopBridge || adding}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-cs2-accent/45 bg-cs2-accent/10 px-4 py-3 text-xs font-bold text-cs2-accent hover:bg-cs2-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              {t("library.watchPathsChoose")}
            </button>
            <div className="my-3 flex items-center gap-3 text-[10px] uppercase tracking-wider text-cs2-text-muted">
              <span className="h-px flex-1 bg-cs2-border" />
              {t("library.watchPathsManual")}
              <span className="h-px flex-1 bg-cs2-border" />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={watchPathInput}
                onChange={(event) => setWatchPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addPath();
                  }
                }}
                placeholder="D:\\SteamLibrary\\...\\replays"
                className="min-w-0 flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent/50"
              />
              <button type="button" onClick={() => void addPath()} disabled={!watchPathInput.trim() || adding} className="rounded-md border border-cs2-border bg-cs2-bg-hover px-3 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-40">
                {t("library.watchPathsAdd")}
              </button>
            </div>
            {watchPathInput.trim() && inspections[pathKey(watchPathInput)] ? (
              <p className={[
                "mt-2 flex items-center gap-1.5 text-[10px]",
                inspections[pathKey(watchPathInput)]?.valid ? "text-cs2-emerald-on-surface" : "text-cs2-fail",
              ].join(" ")}>
                {inspections[pathKey(watchPathInput)]?.loading ? <Loader2 className="h-3 w-3 animate-spin text-cs2-accent" /> : inspections[pathKey(watchPathInput)]?.valid ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                {inspections[pathKey(watchPathInput)]?.loading
                  ? t("library.watchPathsInspecting")
                  : inspections[pathKey(watchPathInput)]?.valid
                    ? t("library.watchPathsFound", { demos: inspections[pathKey(watchPathInput)]?.demo_count || 0, zips: inspections[pathKey(watchPathInput)]?.zip_count || 0 })
                    : inspections[pathKey(watchPathInput)]?.error || t("library.watchPathsInspectFail")}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-cs2-text-secondary">{t("library.watchPathsDepth")}</p>
              <p className="mt-0.5 text-[10px] text-cs2-text-muted">{t("library.watchPathsDepthHint")}</p>
            </div>
            <select value={depth} onChange={(event) => void changeDepth(event.target.value)} className="rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50">
              {[0, 1, 2, 3, 5, 10].map((value) => (
                <option key={value} value={value}>{value === 0 ? t("library.watchPathsDepthRoot") : t("library.watchPathsDepthLevel", { n: value })}</option>
              ))}
            </select>
          </div>

          <div className="mt-3 space-y-2">
            {demoWatchPaths.length === 0 ? (
              <div className="rounded-lg border border-dashed border-cs2-border px-3 py-6 text-center text-[11px] text-cs2-text-muted">{t("library.watchPathsEmpty")}</div>
            ) : demoWatchPaths.map((path) => {
              const state = inspections[pathKey(path)];
              return (
                <div key={path} className="rounded-lg border border-cs2-border bg-cs2-bg-input/45 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {state?.loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cs2-accent" /> : state?.valid ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cs2-emerald-on-surface" /> : <AlertCircle className="h-3.5 w-3.5 shrink-0 text-cs2-fail" />}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cs2-text-secondary" title={path}>{path}</span>
                    <button type="button" className="shrink-0 text-[10px] font-semibold text-cs2-fail hover:opacity-80" onClick={() => void removePath(path)}>{t("library.watchPathsRemove")}</button>
                  </div>
                  <p className="mt-1 pl-[22px] text-[10px] text-cs2-text-muted">
                    {state?.loading
                      ? t("library.watchPathsInspecting")
                      : state?.valid
                        ? t("library.watchPathsFound", { demos: state.demo_count || 0, zips: state.zip_count || 0 })
                        : state?.error || t("library.watchPathsInspectFail")}
                  </p>
                </div>
              );
            })}
          </div>

          {scanResult ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-cs2-emerald-surface bg-cs2-emerald-surface px-3 py-2 text-[11px] text-cs2-text-secondary">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-cs2-emerald-on-surface" />
              <span className="flex-1">{t("library.watchPathsScanResult", { scanned: scanResult.scanned || 0, pending: scanResult.discovered_count || 0 })}</span>
              {(scanResult.discovered_count || 0) > 0 ? <button type="button" className="font-semibold text-cs2-accent hover:underline" onClick={onOpenIngest}>{t("library.watchPathsReviewPending")}</button> : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-cs2-border bg-cs2-bg-page/45 px-5 py-3">
          <p className="text-[10px] text-cs2-text-muted">{t("library.watchPathsNextStep")}</p>
          <button type="button" disabled={demoWatchPaths.length === 0 || scanning} onClick={() => void runScan()} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-40">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {scanning ? t("library.btnScanning") : t("library.watchPathsScanNow")}
          </button>
        </div>
      </div>
    </div>
  );
}
