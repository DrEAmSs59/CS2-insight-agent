import { useState, useEffect, useCallback, useRef } from "react";
import API from "../../../api/api";
import { useT } from "../../../i18n/useT.js";
import {
  X,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Database,
  RefreshCcw,
  Plus,
  HardDrive,
} from "lucide-react";

// Source labels that should NOT be translated (proper names / abbreviations)
const SOURCE_LABELS_FIXED = new Set(["Faceit", "5E", "ESL", "ESEA", "Blast"]);
// i18n keys for platform display labels
const SOURCE_I18N_KEYS = {
  "Perfect World": "ingest.sourcePerfectWorld",
  "Matchmaking": "ingest.sourceMatchmaking",
};
const SEARCH_DEBOUNCE_MS = 250;

export default function IngestModal({ isOpen, onClose, onIngest }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState(null);
  const [listError, setListError] = useState(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const activeRequestRef = useRef(null);

  const limit = 10;

  const fetchDiscovered = useCallback(async () => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setListLoading(true);
    setListError(null);
    try {
      const params = { limit, offset: (page - 1) * limit };
      if (debouncedSearch) params.q = debouncedSearch;

      const { data } = await API.get("/demos/discovered", {
        params,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const nextTotal = Number(data.total) || 0;
      const lastPage = Math.max(1, Math.ceil(nextTotal / limit));
      setTotal(nextTotal);
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setItems(data.items || []);
    } catch (e) {
      if (controller.signal.aborted) return;
      console.error("Failed to fetch discovered demos", e);
      setListError(t("dialog.ingestListError"));
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setListLoading(false);
      }
    }
  }, [debouncedSearch, page, t]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isOpen, search]);

  useEffect(() => {
    if (isOpen) {
      setIngestError(null);
      setIngesting(false);
      void fetchDiscovered();
    }
    return () => activeRequestRef.current?.abort();
  }, [isOpen, fetchDiscovered]);

  useEffect(() => {
    if (isOpen) return;
    setItems([]);
    setListError(null);
    setSearch("");
    setDebouncedSearch("");
    setPage(1);
    setTotal(0);
    setSelectedIds(new Set());
  }, [isOpen]);

  if (!isOpen) return null;

  const totalPages = Math.ceil(total / limit) || 1;
  const allPageSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  const handleToggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleIngestSelected = async () => {
    if (selectedIds.size === 0 || ingesting || !onIngest) return;
    const ids = Array.from(selectedIds);
    setIngestError(null);
    setIngesting(true);
    try {
      const result = await onIngest(ids);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      if (failed.length > 0) {
        const failedIds = new Set(failed.map((item) => Number(item?.demo_id)).filter(Number.isFinite));
        const details = failed
          .slice(0, 3)
          .map((item) => `${item?.filename || `#${item?.demo_id ?? "?"}`}: ${item?.error || t("dialog.ingestFallbackError")}`)
          .join("；");
        const remaining = failed.length - 3;
        setSelectedIds(failedIds);
        setIngestError(t("dialog.ingestPartialError", {
          ingested: Number(result?.ingested) || 0,
          failed: failed.length,
          details: details + (remaining > 0 ? t("dialog.ingestPartialMore", { count: remaining }) : ""),
        }));
        await fetchDiscovered();
        return;
      }
      setSelectedIds(new Set());
      onClose();
    } catch (e) {
      const d = e?.response?.data?.detail;
      const msg = Array.isArray(d)
        ? d.map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x))).join("；")
        : typeof d === "string"
          ? d
          : e?.message || t("dialog.ingestFallbackError");
      setIngestError(msg);
    } finally {
      setIngesting(false);
    }
  };

  const handleSelectAll = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const item of items) {
        if (allPageSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-cs2-bg-overlay px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ingest-modal-title"
        className="relative flex h-full max-h-[600px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl"
      >
        {ingesting ? (
          <div
            className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-[1px]"
            aria-busy="true"
            aria-label={t("dialog.ingestIngesting")}
          >
            <Loader2 className="h-8 w-8 animate-spin text-cs2-accent" />
            <p className="text-xs font-semibold text-cs2-text-primary">
              {t("dialog.ingestIngestingMsg", { count: selectedIds.size })}
            </p>
          </div>
        ) : null}
        {/* Header */}
        <div className="flex items-start justify-between border-b border-cs2-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-cs2-accent" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="ingest-modal-title" className="text-sm font-bold text-cs2-text-primary">{t("dialog.ingestTitle")}</h2>
                <span className="rounded bg-cs2-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-cs2-accent">{total}</span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">{t("dialog.ingestSubtitle")}</p>
            </div>
          </div>
          <button type="button" aria-label={t("dialog.ingestClose")} disabled={ingesting} onClick={onClose} className="rounded-full p-1.5 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-cs2-border bg-cs2-bg-input/30 px-5 py-3">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-cs2-text-muted" />
            <input
              type="text"
              placeholder={t("dialog.ingestSearchPlaceholder")}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="flex-1 bg-transparent text-xs text-cs2-text-primary outline-none placeholder:text-cs2-text-muted"
            />
          </div>
          <button
            type="button"
            aria-label={t("dialog.ingestRefresh")}
            disabled={ingesting}
            onClick={() => void fetchDiscovered()}
            className="flex items-center justify-center rounded-md border border-cs2-border p-1.5 text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCcw className={`h-4 w-4 ${listLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Selection bar */}
        {items.length > 0 && (
          <div className="flex items-center gap-2 border-b border-cs2-border bg-cs2-bg-input/30 px-5 py-2 text-[10px]">
            <button type="button" disabled={ingesting} onClick={handleSelectAll} className="text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-40">
              {allPageSelected
                ? t("dialog.ingestDeselectPage", { count: items.length })
                : t("dialog.ingestSelectAll", { count: items.length })}
            </button>
            <span className="text-cs2-text-muted">|</span>
            <button type="button" disabled={ingesting} onClick={handleClearSelection} className="text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-40">
              {t("dialog.ingestClear")}
            </button>
            <span className="ml-auto text-cs2-text-muted">{t("dialog.ingestSelected", { sel: selectedIds.size })}</span>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2">
          {listLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-cs2-text-muted" />
            </div>
          ) : listError ? (
            <div className="flex h-32 flex-col items-center justify-center gap-3 text-cs2-text-muted">
              <p className="text-xs text-cs2-text-error">{listError}</p>
              <button
                type="button"
                onClick={() => void fetchDiscovered()}
                className="rounded-md border border-cs2-border px-3 py-1.5 text-xs hover:bg-cs2-bg-hover"
              >
                {t("dialog.ingestRetry")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-cs2-text-muted">
              <HardDrive className="h-8 w-8 opacity-20" />
              <p className="text-xs">
                {search
                  ? t("dialog.ingestEmptySearch")
                  : t("dialog.ingestEmptyNoDemo")}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((it) => {
                const sourceLabel = SOURCE_LABELS_FIXED.has(it.source)
                  ? it.source
                  : SOURCE_I18N_KEYS[it.source]
                    ? t(SOURCE_I18N_KEYS[it.source])
                    : t("dialog.ingestSourceLocal");
                const sizeMB = it.file_size != null ? (it.file_size / (1024 * 1024)).toFixed(1) : "?";
                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => !ingesting && handleToggleSelect(it.id)}
                    onKeyDown={(e) => {
                      if (ingesting) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleToggleSelect(it.id);
                      }
                    }}
                    className={`flex items-center justify-between rounded-md border p-2.5 transition-colors ${ingesting ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${selectedIds.has(it.id) ? "border-cs2-accent/40 bg-cs2-accent/5" : "border-transparent hover:bg-cs2-bg-hover"}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        readOnly
                        checked={selectedIds.has(it.id)}
                        className="h-3.5 w-3.5 rounded border-cs2-border bg-transparent text-cs2-accent focus:ring-offset-0"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-mono text-cs2-text-secondary" title={it.path}>{it.filename}</p>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-cs2-text-muted">
                          <span>{sourceLabel}</span>
                          <span>•</span>
                          <span>{sizeMB} MB</span>
                          <span>•</span>
                          <span>{t("dialog.ingestDiscoveredAt", { date: new Date(it.added_at).toLocaleDateString() })}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 border-t border-cs2-border bg-cs2-bg-page px-5 py-3">
          {ingestError ? (
            <p className="text-center text-[12px] leading-snug text-cs2-text-error">{ingestError}</p>
          ) : null}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={t("dialog.ingestPreviousPage")}
                disabled={page <= 1 || ingesting}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-md border border-cs2-border p-1 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-secondary disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[11px] text-cs2-text-muted">
                {t("dialog.ingestPageOf", { page, totalPages })}
              </span>
              <button
                type="button"
                aria-label={t("dialog.ingestNextPage")}
                disabled={page >= totalPages || ingesting}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-cs2-border p-1 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-secondary disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={selectedIds.size === 0 || ingesting}
                onClick={() => void handleIngestSelected()}
                className="flex items-center gap-1.5 rounded-lg bg-cs2-accent px-4 py-2 text-xs font-extrabold text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20 transition-all hover:bg-cs2-accent-light disabled:opacity-50 disabled:grayscale"
              >
                {ingesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {t("dialog.ingestConfirmBtn", { count: selectedIds.size })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
